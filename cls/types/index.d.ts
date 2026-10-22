export type Shell = { id: string; command: string; description?: string }

declare module 'claude-code' {
  interface PluginState {
    cls: { shells: Shell[] }
  }
}
