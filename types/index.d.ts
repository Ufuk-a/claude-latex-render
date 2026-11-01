/** How replies are drawn: LaTeX typeset as pictures, or left as written. */
export type Mode = 'render' | 'source'

/** The held-back part of the block being streamed, drawn live above the prompt; `v` bumps to redraw. */
export type Live = { text: string; bullet: boolean; v: number }

declare module 'claude-code' {
  interface PluginState {
    'latex-render': { mode: Mode; live: Live }
  }
}
