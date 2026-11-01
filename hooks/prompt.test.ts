import { describe, expect, test } from 'claude-code/testing'

// The facts a session would fill in itself.
const facts = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', tools: [], outputStyle: null, traits: [] }

describe('prompt.compose', () => {
  test('a terminal session gets the style section last', { options: { images: 'off' } }, async ($, on) => {
    // Stands for the engine's own composition.
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
    const { sections } = await $.prompt.compose({ ...facts, surfaces: ['terminal'] })
    expect(sections.map(s => s.id)).toEqual(['intro', 'latex-render:style'])
    expect(sections[1]?.scope).toBe('session')
    expect(sections[1]?.text).toContain('shows no images')
  })

  test('a session with nothing drawn gets none', { options: { images: 'off' } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
    const { sections } = await $.prompt.compose({ ...facts, surfaces: [] })
    expect(sections.map(s => s.id)).toEqual(['intro'])
  })
})
