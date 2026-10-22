import { atom, read, update } from 'claude-code'
import type { Register, SessionMessage } from 'claude-code'

import type { Shell } from '../types'

const PROMPT = `Mental reset. The reader looked away for a while and is coming back to this session cold. Write a status they can take in at a glance.

These sections, plain text, no preamble, each heading on its own line:
GOAL: one sentence: what is being built or worked on, and why it matters to the reader. If the goal changed during the session, say "Was: ... Now: ...".
DONE: what has been finished so far (2-3 bullets)
NOW: what is happening at this moment, and what is waiting on whom (1-2 bullets)
ISSUES: optional, see below
NEXT: the concrete next steps (1-3 bullets)
Each bullet starts with "- ".

Rules:
- Plain text only: no markdown tables, headings or bold; bullets only.
- Brief: one short sentence per bullet, at most about 15 words. Under 130 words in total.
- Grounded: only state what actually happened in this session. Name the real file, command, decision or result; never guess or pad. If something is unclear or undecided, say so.
- Easy to read: plain everyday words, active voice, no jargon or internal ids unless the reader needs them. Lead each bullet with the point, not the background.
- Self-contained: someone who missed the last hour should understand every bullet without scrolling up.
- ISSUES: leave the section out entirely unless there is a real, still-open problem the reader must know about: a bug or failing test seen in this session, a limitation that breaks what the user asked for, or a blocker. Something said in the conversation must back it up. Fixed problems belong in DONE. Never include routine development steps, nice-to-haves, hypothetical risks or things merely untested. At most 3 bullets, most serious first, each saying what is wrong and what it affects. When in doubt, leave it out: no ISSUES section is the normal case.
- Name the subject: every bullet says what it is about ("the colours of the /cls status box", not "the look"). If a bullet only makes sense after reading the one above, rewrite it.`

// The rows above the prompt and the card's height, measured per /cls output
// and terminal size.
const room = new Map<string, { room: number; card: number }>()

// The background shells Claude Code reported in flight when a turn last
// stopped: its own list, so a shell from before a resume or one that ended
// never shows.
const inFlight = atom({ plugin: 'cls', key: 'shells' } as const, [])

// The shells of that list still running: one whose end reached the
// transcript since (a task notification or a stop naming it) is left out.
const runningShells = (known: readonly Shell[], messages: readonly SessionMessage[]): Shell[] => {
  const ended = new Set<string>()
  for (const message of messages) {
    for (const use of message.toolUses) {
      const input = use.input as { task_id?: string; shell_id?: string }
      if (use.tool === 'TaskStop' && !use.isError) ended.add(input.task_id ?? input.shell_id ?? '')
    }
    for (const shell of known) {
      if (message.text.includes(shell.id) && /<task-id>|completed|failed|killed|stopped/.test(message.text)) {
        ended.add(shell.id)
      }
    }
  }

  return known.filter(shell => !ended.has(shell.id))
}

// Other mods restyle a command's output: skins draws two "key: value" lines
// in a row, or a markdown table, as a table card of its own, and the status
// box is never drawn. So a bullet's first ": " becomes " — ", and a table's
// rows become bullets.
const plain = (text: string): string =>
  text
    .split('\n')
    .filter(line => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line))
    .map(line => {
      const row = /^\s*\|(.*)\|\s*$/.exec(line)
      const bullet = row
        ? `- ${(row[1] ?? "").split('|').map(cell => cell.trim()).filter(Boolean).join(' — ')}`
        : line
      return /^\s*(GOAL|DONE|NOW|ISSUES|NEXT|AGENTS|SHELLS)\b/.test(bullet) ? bullet : bullet.replace(/:\s+/, ' — ')
    })
    .join('\n')

// The conversation as plain text for a summary, newest kept when too long.
const LIMIT = 150_000
const digest = (messages: readonly SessionMessage[]): string => {
  const lines = messages.map(message => {
    const tools = message.toolUses
      .map(use => `[${use.tool}: ${JSON.stringify(use.input).slice(0, 200)}]`)
      .join(' ')
    const text = message.text.length > 4000 ? `${message.text.slice(0, 4000)} …` : message.text

    return `${message.role.toUpperCase()}: ${text} ${tools}`.trim()
  })
  const all = lines.join('\n\n')

  return all.length > LIMIT ? `… (earlier part left out)\n${all.slice(-LIMIT)}` : all
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cls',
      description: 'Clear the screen and show a short status of the session',
    })

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const shells = (e.background_tasks ?? [])
      .filter(task => task.type === 'shell' && ['running', 'pending'].includes(task.status))
      .map(task => ({ id: task.id, command: task.command ?? '', description: task.description }))
    await update($, inFlight, () => shells)

    return next(e)
  })

  on('command.run', { command: 'cls' }, async $ => {
    $.ui.status('cls: summarising…')
    let reply
    try {
      const agents = (await $.agent.list()).filter(a =>
        ['pending', 'running', 'waiting'].includes(a.status),
      )
      const messages = await $.session.messages()
      const shells = runningShells(await read($, inFlight), messages)
      const extra = [
        agents.length > 0 &&
          `AGENTS: one bullet per agent below, in this form: "<name>: <what it is actually working on and why, in plain words>":\n` +
            agents.map(a => `- ${a.name ?? a.type} (${a.type}, id ${a.id}): "${a.description}"`).join('\n'),
        shells.length > 0 &&
          `SHELLS: one bullet per background shell below, in this form: "<short name>: <what it is for, the intention behind it, not its output>":\n` +
            shells
              .map(sh => `- ${sh.description ?? 'shell'} (id ${sh.id}): ${sh.command.slice(0, 300)}`)
              .join('\n'),
      ].filter(Boolean)
      const prompt =
        extra.length === 0
          ? PROMPT
          : `${PROMPT}\nAfter NEXT, add these sections as well (they don't count towards the word limit):\n${extra.join('\n')}`
      reply = await $.model.fork({ prompt })
      // Right after a resume (--continue) the transcript is loaded but no
      // request has gone out yet, so there is nothing to fork: summarise the
      // transcript itself instead.
      if (!reply.isAnswered && reply.reason === 'nothing-to-fork' && messages.length > 0) {
        reply = await $.model.complete({
          model: 'sonnet',
          system: 'You summarise a Claude Code session for the person who ran it.',
          prompt: `<transcript>\n${digest(messages)}\n</transcript>\n\n${prompt}`,
        })
      }
    } finally {
      $.ui.status(undefined)
    }
    if (!reply.isAnswered) {
      return {
        text:
          reply.reason === 'nothing-to-fork'
            ? 'Fresh session: nothing to summarise yet.'
            : `Could not summarise (${reply.reason}).`,
      }
    }

    return { text: plain(reply.text.trim()) }
  })

  // Draw the status as three segments at the top, padded with blank rows to
  // the terminal's height so everything before it scrolls out of view.
  on('ui.render', { component: 'CommandOutput', props: { command: 'cls' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // The row's text may carry the plugin's name in front ("cls: DONE:").
    const text = e.props.text.replace(/^cls:\s*/, '')
    const sections = parse(text)
    if (sections.length === 0) return next(e)

    const rows = e.viewport?.rows ?? 24
    // Neither the transcript's height above the prompt and status lines nor
    // the card's own wrapped height is told, but where the row lands is. So
    // the first draw is a screen taller than the card: the rows that show are
    // the room there is, the row's whole height less that screen is the card,
    // and the next draw pads the card to fill just that room.
    const shown = e.props.onScreen
    const at = `${e.viewport?.columns}x${rows}:${e.props.text}`
    let fit = room.get(at)
    if (fit === undefined && shown && shown.first > 0) {
      fit = { room: shown.last - shown.first + 1, card: shown.of - rows }
      room.set(at, fit)
    }
    const filler = fit === undefined ? rows : Math.max(0, fit.room - fit.card)

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {sections.map((one, i) => (
            <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Text>
                <Text bold color="whiteBright" backgroundColor={one.color}> {one.icon} {one.title} </Text>
              </Text>
              {one.items.map(item => (
                <Box flexDirection="row">
                  <Text color={one.color === 'black' ? 'gray' : one.color}>{'▸ '}</Text>
                  <Text>{item}</Text>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
        {filler > 0 && <Box height={filler} />}
      </Box>
    )
  })
}

const LOOK = {
  GOAL: { title: 'GOAL', icon: '◎', color: 'black' },
  DONE: { title: 'DONE', icon: '✓', color: 'green' },
  NOW: { title: 'NOW', icon: '●', color: 'cyan' },
  ISSUES: { title: 'ISSUES', icon: '!', color: 'red' },
  NEXT: { title: 'NEXT', icon: '→', color: 'magenta' },
  AGENTS: { title: 'AGENTS', icon: '◆', color: 'blue' },
  SHELLS: { title: 'SHELLS', icon: '$', color: 'gray' },
} as const

type Section = { title: string; icon: string; color: 'black' | 'red' | 'green' | 'cyan' | 'magenta' | 'blue' | 'gray'; items: string[] }

// Splits "DONE:\n- a\n- b\nNOW: ..." into its three sections.
const parse = (text: string): Section[] => {
  const sections: Section[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const head = /^\**(GOAL|DONE|NOW|ISSUES|NEXT|AGENTS|SHELLS)\**:?\**\s*(.*)$/.exec(line)
    if (head) {
      sections.push({ ...LOOK[head[1] as keyof typeof LOOK], items: [] })
      if (head[2]) sections.at(-1)!.items.push(head[2])
      continue
    }
    sections.at(-1)?.items.push(line.replace(/^[-*•]\s*/, ''))
  }

  return sections
}
