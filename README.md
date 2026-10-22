# chris-claude-mods

Mods for [Claude Code](https://claude.com/claude-code), shared as a plugin marketplace.

## Install

Inside Claude Code:

```
/plugin marketplace add blueneogeo/chris-claude-mods
/plugin install cls@christian-mods
```

## Mods

### `cls` — a mental reset

Type `/cls` and the screen clears to a short, colour-coded status of the session, so you can pick up where you were after a break. The conversation itself is kept (unlike `/clear`); older history is just scrolled out of view.

The status box shows:

| Section | What it says |
| --- | --- |
| ◎ GOAL | What is being worked on, and why |
| ✓ DONE | What has been finished |
| ● NOW | What is happening right now, and what is waiting on whom |
| ! ISSUES | Real, still-open problems; only shown when there are any |
| → NEXT | The concrete next steps |
| ◆ AGENTS | Each running subagent and what it is working on; only while some run |
| $ SHELLS | Each background shell and what it is for; only while some run |

The summary is written by the session's own model over the conversation so far, told to be brief, grounded in what actually happened, and readable by someone coming back cold. Each `/cls` costs one extra model call, mostly served from the prompt cache.

## License

[MIT](LICENSE)
