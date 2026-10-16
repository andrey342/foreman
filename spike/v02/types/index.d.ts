export type SpikePresses = number

declare module 'claude-code' {
  interface PluginState {
    'foreman-spike': { presses: SpikePresses; typed: string; picked: string }
  }
}
