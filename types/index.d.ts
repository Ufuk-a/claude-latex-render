/** How replies are drawn: LaTeX typeset as pictures, or left as written. */
export type Mode = 'render' | 'source'

/** The held-back part of the block being streamed, drawn live in a placed transcript row (`id`); `v` bumps to redraw. */
export type Live = { id: string; text: string; v: number }

declare module 'claude-code' {
  interface PluginState {
    'latex-render': { mode: Mode; live: Live }
  }
}
