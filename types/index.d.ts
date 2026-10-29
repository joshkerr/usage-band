/** One usage window: which one, how much is used (0 to 100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * The prompt cache as the band last saw it: when the main thread last sent a
 * request (clock milliseconds) and how many tokens the next request re-sends.
 */
export type CacheFacts = { lastAt: number; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { windows: Window[]; cache: CacheFacts | null }
  }
}
