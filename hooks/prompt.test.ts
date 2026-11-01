import { describe, expect, test } from 'claude-code/testing'

describe('prompt.context', () => {
  test('a terminal session gets the style guide as a context block', { options: { images: 'off' } }, async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] }))
    // Stands for the engine's own context.
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }], instructionFiles: [] })
    expect(blocks.map(b => b.name)).toEqual(['currentDate', 'latexRender'])
    expect(blocks[1]?.text).toContain('shows no images')
  })

  test('a session with nothing drawn gets none', { options: { images: 'off' } }, async ($, on) => {
    on('session.surfaces', () => ({ value: [] }))
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }], instructionFiles: [] })
    expect(blocks.map(b => b.name)).toEqual(['currentDate'])
  })
})
