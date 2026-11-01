import { describe, expect, test } from 'claude-code/testing'
import type { Chunk, On } from 'claude-code'

const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }
const ran = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

// Stands for a session whose processes all succeed and write nothing, and
// records each command's program and when, counted in chunks the engine had streamed.
function world(on: On, surfaces: ('terminal' | 'desktop')[]) {
  const streamed = { count: 0 }
  const runs: { program: string; at: number }[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push({ program: e.argv[0] ?? '', at: streamed.count })
    return { value: ran }
  })
  return { streamed, runs }
}

// The engine's stream: these chunks, then the stop, counting each as it goes.
function engine(on: On, streamed: { count: number }, chunks: Chunk<'turn.step'>[]) {
  on('turn.step', async function* () {
    for (const chunk of [...chunks, { kind: 'stop', stopReason: 'end_turn', usage: null } as const]) {
      streamed.count += 1
      yield chunk
      // Gives work the hooks above started a moment to run, as the network would.
      for (let i = 0; i < 50; i++) await Promise.resolve()
    }
    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
}

async function collect(stream: AsyncIterable<Chunk<'turn.step'>>): Promise<Chunk<'turn.step'>[]> {
  const out: Chunk<'turn.step'>[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

const reply: Chunk<'turn.step'>[] = [
  { kind: 'text', index: 0, text: 'Take\n$$x^' },
  { kind: 'text', index: 0, text: '2$$\n\nso it ' },
  { kind: 'text', index: 0, text: 'grows, and more' },
  { kind: 'text', index: 0, text: ' text follows.' },
  { kind: 'tool', index: 1, id: 'tu1', name: 'Read' },
]

describe('turn.step', () => {
  test('held text reaches the engine whole, before the block ends', { options: { images: 'on' } }, async ($, on) => {
    const { streamed } = world(on, ['terminal'])
    engine(on, streamed, reply)
    const chunks = await collect($.turn.step(step))
    const texts = chunks.filter(c => c.kind === 'text').map(c => (c as { text: string }).text)
    // The line before the formula streams; from the formula's line on, the block is held and released in one piece.
    expect(texts).toEqual(['Take\n', '$$x^2$$\n\nso it grows, and more text follows.'])
    expect(chunks.map(c => c.kind)).toEqual(['text', 'text', 'tool', 'stop'])
  })

  test('a run with no terminal holds nothing back', { options: { images: 'on' } }, async ($, on) => {
    const { streamed, runs } = world(on, [])
    engine(on, streamed, reply)
    const chunks = await collect($.turn.step(step))
    expect(chunks).toEqual([...reply, { kind: 'stop', stopReason: 'end_turn', usage: null }])
    expect(runs.filter(r => r.at > 0)).toEqual([])
  })
})

// The head of a 200×50 PNG, all a picture's size is read from.
const PNG = btoa(
  String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 200, 0, 0, 0, 50),
)

const band = { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 19 }, view: {} }

describe('live band', () => {
  test('held text shows above the prompt while its block streams, and goes when it ends', { options: { images: 'on' } }, async ($, on) => {
    on('session.surfaces', () => ({ value: ['terminal'] as const }))
    on('env.get', () => ({ value: undefined }))
    on('process.run', () => ({ value: ran }))
    on('fs.exists', (_$, e) => ({ value: e.path.endsWith('.png') }))
    on('fs.read', () => ({ value: { base64: PNG } }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>prompt band</Text>
    })
    let open!: () => void
    const gate = new Promise<void>(resolve => (open = resolve))
    on('turn.step', async function* () {
      yield { kind: 'text', index: 0, text: 'Take\n$$x^2$$\n' } as const
      yield { kind: 'text', index: 0, text: '\nso it grows' } as const
      await gate
      yield { kind: 'tool', index: 1, id: 'tu1', name: 'Read' } as const
      yield { kind: 'stop', stopReason: 'tool_use', usage: null } as const
      return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
    })
    const view = await $.ui.mount({ plugin: 'latex-render', surface: 'terminal', component: 'AbovePrompt', props: band })
    const showing = async () => JSON.stringify(await view.drawn()).includes('so it grows')

    const stream = $.turn.step(step)[Symbol.asyncIterator]()
    await stream.next() // 'Take\n' streams; the rest is held
    const released = stream.next() // waits on the gate, holding the formula and the text after it
    for (let i = 0; i < 200; i++) await Promise.resolve()
    expect(await showing()).toBe(true)
    open()
    expect(((await released).value as { text: string }).text).toBe('$$x^2$$\n\nso it grows')
    while (!(await stream.next()).done);
    expect(await showing()).toBe(false)
  })
})
