import { atom, read, update } from 'claude-code'
import type { Chunk, EngineInterface, Register } from 'claude-code'

import type { Live, Mode } from '../types'

import {
  dvipngColor,
  escapeMarkdown,
  figureDocument,
  hashKey,
  hasMath,
  inlineToUnicode,
  isSafeTex,
  latexError,
  nextMode,
  pngSize,
  segmentsToUnicode,
  settledLength,
  splitMath,
  styleGuide,
  texDocument,
  texToUnicode,
} from './latex'
import type { Segment } from './latex'
import { escapeWord, hasInlineMath, inlineTexes, layoutProse, textWidth } from './flow'
import type { Token } from './flow'

// Pixels per terminal row the formulas are typeset at; the terminal scales
// the picture to its cells, so this only sets how crisp they are.
// Pixels per terminal row and column. Pictures are drawn at exactly the
// terminal's cell size, read from its window when it can be, so the terminal
// never rescales them (rescaling is what makes them jagged); 40 and the
// cellAspect setting stand in where it cannot.
let ROW_PX = 40
let CELL_W: number | undefined
// The terminal's width in columns, for where the engine does not say (outside fullscreen).
let TERM_COLS: number | undefined
let cellsFor: { columns: number; pending: Promise<void> } | undefined
const CELL_PROBE = [
  'import os, fcntl, termios, struct',
  'p = os.getpid()',
  'while p > 1:',
  '    for fd in (0, 1, 2):',
  '        try:',
  '            t = os.readlink(f"/proc/{p}/fd/{fd}")',
  '        except OSError:',
  '            continue',
  '        if t.startswith("/dev/pts/") or t.startswith("/dev/tty"):',
  '            h = os.open(t, os.O_RDONLY | os.O_NOCTTY)',
  '            r, c, x, y = struct.unpack("HHHH", fcntl.ioctl(h, termios.TIOCGWINSZ, bytes(8)))',
  '            if x and y:',
  '                print(x / c, y / r, c)',
  '                raise SystemExit',
  '    p = int(open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()[1])',
].join('\n')

// Reads the cell size again whenever the terminal's width changes (a resize or a font zoom).
function cells($: EngineInterface, columns: number | undefined): Promise<void> {
  const key = columns ?? 0
  if (cellsFor?.columns === key) return cellsFor.pending
  const pending = $.process
    .run(['python3', '-c', CELL_PROBE], { timeoutMs: 3000 })
    .then(r => {
      const [w, h, c] = r.stdout.trim().split(/\s+/).map(Number)
      if (r.exitCode === 0 && w && h && w > 2 && h > 4) {
        ROW_PX = Math.round(h)
        CELL_W = w
      }
      if (c && c > 10) TERM_COLS = c
    })
    .catch(err => {
      if (isAbort(err)) {
        cellsFor = undefined
        redrawLater($)
      }
    })
  cellsFor = { columns: key, pending }
  return pending
}

function cellWidth(): number {
  return CELL_W ?? ROW_PX / settings.cellAspect
}
const VERSION = 1

type Display = Segment & { kind: 'display' }
type Figure = Segment & { kind: 'figure' }
type Drawn = Display | Figure
type Palette = { ink: string; paper?: string }
type Typeset = { path: string; width: number; height: number }
type Picture = { path: string; columns: number; rows: number; rowsAbove?: number; slices?: string[] }

type Settings = {
  images: string
  color: string
  scale: number
  cellAspect: number
  preamble: string
  background: string
  live: boolean
  inline: boolean
  inlineScale: number
  inlineBaseline: number
  displayAlign: string
}

// What the module learns once per load: its options, whether pictures can be
// drawn, the cache folder, the colors, and every formula and figure typeset so far.
let settings: Settings = { images: 'auto', color: 'auto', scale: 1.25, cellAspect: 2.1, preamble: '', background: 'auto', live: true, inline: true, inlineScale: 1, inlineBaseline: 0.8, displayAlign: 'center' }
let canDraw: Promise<boolean> | undefined
let canDrawFigures: Promise<boolean> | undefined
let cacheDir: Promise<string> | undefined
let colors: Promise<Palette> | undefined
// `/latex` flips this; in `source` every reply is drawn as written.
const mode = atom({ plugin: 'latex-render', key: 'mode' } as const, 'render' as Mode)
// The part of the block being streamed that is held back, drawn above the prompt until it ends.
const live = atom({ plugin: 'latex-render', key: 'live' } as const, { id: '', text: '', v: 0 } as Live)
// Why a formula or figure could not be typeset, by its kind and TeX: it is then
// shown as written, in the error color, with this under it.
const failures = new Map<string, string>()
const failureId = (kind: string, tex: string) => `${kind}\u0000${tex}`
const UNSAFE_NOTE = 'not compiled: it uses a macro or file command (\\def, \\newcommand, \\input, ...)'
async function recordFailure($: EngineInterface, id: string, file: string): Promise<undefined> {
  failures.set(id, await $.fs.read(file).catch(() => 'LaTeX failed'))
  return undefined
}
// Pictures already fitted, by fitId, so the band draws without waiting on TeX.
const ready = new Map<string, Picture | undefined>()
const typeset = new Map<string, Promise<Typeset | undefined>>()
const fitted = new Map<string, Promise<Picture | undefined>>()
// The width the last reply was drawn at, so a formula is fitted to it while still streaming.
let lastRoom: number | undefined

export const register: Register = (on, options) => {
  settings = {
    images: String(options.images ?? 'auto'),
    color: String(options.color ?? 'auto'),
    scale: clamp(Number(options.scale) || 1.25, 0.5, 4),
    cellAspect: clamp(Number(options.cellAspect) || 2.1, 1, 4),
    preamble: String(options.preamble ?? ''),
    background: String(options.background ?? 'auto'),
    live: String(options.preview ?? 'on') !== 'off',
    inline: String(options.inlineImages ?? 'on') !== 'off',
    inlineScale: clamp(Number(options.inlineScale) || 1, 0.5, 2),
    inlineBaseline: clamp(Number(options.inlineBaseline) || 0.8, 0.5, 0.95),
    displayAlign: String(options.displayAlign ?? 'center') === 'left' ? 'left' : 'center',
  }
  // What was found for the previous options no longer holds.
  canDraw = canDrawFigures = colors = undefined

  // Tells the model how to write math and figures so they are drawn well here.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.surfaces.includes('terminal')) return composed
    const [pictures, figures, { paper }] = await Promise.all([imagesOn($), figuresOn($), palette($)])
    const section = { id: 'latex-render:style', text: styleGuide({ pictures, figures, paper, inlinePictures: pictures && settings.inline }), scope: 'session' } as const
    return { sections: [...composed.sections, section] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'latex',
      description: 'Toggle LaTeX in replies between rendered and as written',
      argumentHint: '[render|source]',
      immediate: true,
    })
    // A reload keeps the mode; the status line has to say so again.
    showMode($, await read($, mode))
    return next(e)
  })

  on('command.run', { command: 'latex' }, async ($, e) => {
    const chosen = nextMode(await read($, mode), e.args)
    if (!chosen) return { text: 'Usage: /latex [render|source]' }
    await update($, mode, () => chosen)
    showMode($, chosen)
    return { text: chosen === 'source' ? 'LaTeX is shown as written.' : 'LaTeX is rendered.' }
  })

  // While a reply streams, each text block is held back from the engine,
  // with the engine's own start-of-block item, until the block ends, so the
  // engine's raw streaming row never shows. The held text is drawn live,
  // typeset, in a row placed in the transcript where the reply is being
  // written; it scrolls with the conversation like any reply. At the block's
  // end everything is released in order (the transcript keeps the same text),
  // the engine draws the finished block in place, and the placed row empties.
  on('turn.step', async function* ($, e, next) {
    const onTerminal = e.agentId === undefined && (await $.session.surfaces()).includes('terminal')
    if (!onTerminal || !settings.live || (await read($, mode)) === 'source') return yield* next(e)
    type Held = { before: Chunk<'turn.step'>[]; first: Chunk<'turn.step'>; text: string; index: number; after: Chunk<'turn.step'>[] }
    let waiting: Chunk<'turn.step'>[] = [] // engine items not yet known to open a text block
    let held: Held | undefined
    let settled = 0
    let blocks = 0
    const release = async function* () {
      if (held) {
        const block = held
        held = undefined
        settled = 0
        // Everything in the block is typeset before the engine draws it, so the
        // finished message comes out at its final height and nothing moves after.
        await Promise.race([readyAll($, block.text), $.clock.sleep(3000)]).catch(() => undefined)
        yield* block.before
        yield { ...(block.first as object), text: block.text } as Chunk<'turn.step'>
        yield* block.after
        void update($, live, () => ({ id: '', text: '', v: 0 })).catch(() => undefined)
      }
      yield* waiting
      waiting = []
    }
    try {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'engine') {
          ;(held ? held.after : waiting).push(chunk)
          continue
        }
        if (chunk.kind === 'text' && held && held.index === chunk.index && held.after.length === 0) {
          held.text += chunk.text
        } else if (chunk.kind === 'text') {
          yield* release()
          const id = `live-${e.turnId}-${e.index}-${blocks++}`
          held = { before: waiting, first: chunk, text: chunk.text, index: chunk.index, after: [] }
          waiting = []
          void $.ui.place({ id }).catch(() => undefined)
          const text = held.text
          void update($, live, () => ({ id, text, v: 1 })).catch(() => undefined)
          continue
        } else {
          yield* release()
          yield chunk
          continue
        }
        const text = held.text
        const upTo = settledLength(text)
        if (upTo > settled) {
          void prepareLive($, text.slice(settled, upTo))
          settled = upTo
        }
        void update($, live, cur => ({ ...cur, text, v: cur.v + 1 })).catch(() => undefined)
      }
    } catch (err) {
      // An interrupted stream still records the text it held.
      yield* release()
      throw err
    }
    yield* release()
  })

  // The live row: the held block drawn as the finished block will be.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const state = await read($, live)
    if (e.props.plugin !== $.plugin.name || e.props.id !== state.id || !state.text || e.surface !== 'terminal') return next(e)
    await cells($, lastRoom === undefined ? undefined : lastRoom + 4)
    lastRoom ??= TERM_COLS === undefined ? undefined : Math.max(10, TERM_COLS - 4)
    const tree = await drawReply($, e, splitPending(state.text), { wait: false, bullet: true })
    return tree ?? next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Read before anything else, so every reply is drawn again when it changes.
    if ((await read($, mode)) === 'source') return next(e)
    const text = e.props.text
    if (!hasMath(text)) return next(e)
    if (e.props.isSummary || e.surface !== 'terminal' || !(await imagesOn($))) {
      const rewritten = segmentsToUnicode(splitMath(text))
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }
    await cells($, e.viewport?.columns)
    lastRoom = Math.max(10, (e.viewport?.columns ?? TERM_COLS ?? 80) - 4)
    const tree = await drawReply($, e, text, { wait: true, bullet: e.props.isFirstOfReply })
    return tree ?? next(e)
  })
}

// A block of a reply, its formulas and figures as pictures and its prose as
// the engine's Markdown. Waiting, it typesets everything first; not waiting
// (the live row), it draws what is ready and redraws as the rest arrives.
async function drawReply(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  text: string,
  opts: { wait: boolean; bullet: boolean },
): Promise<JSX.Element | undefined> {
  const room = lastRoom ?? 76
  const segments = splitMath(text)
  const els = $.ui.resolve(e)
  const { Box, Text, Image, Markdown } = els as any
  const bump = () => update($, live, cur => ({ ...cur, v: cur.v + 1 })).catch(() => undefined)
  const prose = segments.filter(s => s.kind === 'markdown').map(s => s.text).join('\n\n')

  const pictures: (Picture | undefined)[] = opts.wait
    ? await Promise.all(segments.map(s => (s.kind === 'markdown' ? undefined : fit($, s, room))))
    : segments.map(s => {
        if (s.kind === 'markdown') return undefined
        const ready = readyPicture(s, room)
        if (!ready) void fit($, s, room).then(() => bump())
        return ready
      })
  const inlinePics = new Map<string, Picture | undefined>()
  if (settings.inline) {
    const texes = [...new Set(inlineTexes(prose))]
    if (opts.wait) {
      const fitted = await Promise.all(texes.map(tex => fitInline($, tex, room)))
      texes.forEach((tex, k) => inlinePics.set(tex, fitted[k]))
    } else {
      for (const tex of texes) {
        const ready = inlineReady.get(inlineId(tex, room))
        if (!ready) void fitInline($, tex, room).then(() => bump())
        inlinePics.set(tex, ready)
      }
    }
  }

  const children: JSX.Element[] = []
  let pendingText = ''
  let keyer = 0
  let bulletRow = 0
  let afterPicture = false
  const flushText = () => {
    const md = pendingText.replace(/^\s*\n/, '').replace(/\n\s*$/, '')
    if (md.trim() === '') return void (pendingText = '')
    const drawn = drawProse(els, md, tex => inlinePics.get(tex), () => `p${keyer++}`)
    if (children.length === 0) bulletRow = firstRow
    if (children.length > 0 && afterPicture && /^\s{0,3}#/.test(md)) children.push(<Box height={1} />)
    children.push(...drawn)
    afterPicture = false
    pendingText = ''
  }
  segments.forEach((s, index) => {
    const picture = pictures[index]
    if (s.kind === 'markdown') {
      pendingText += s.text
    } else if (!picture && failures.has(failureId(s.kind, s.tex))) {
      flushText()
      children.push(errorBlock(els, asWritten(s), failures.get(failureId(s.kind, s.tex))!))
    } else if (!picture) {
      pendingText += segmentsToUnicode([s])
    } else {
      flushText()
      children.push(
        <Box {...(settings.displayAlign === 'center' ? { justifyContent: 'center' } : { marginLeft: 2 })}>
          <Image
            key={`${s.kind === 'figure' ? 'figure' : 'math'}-${index}`}
            source={{ file: picture.path, format: 'png' }}
            columns={picture.columns}
            rows={picture.rows}
            alt={s.kind === 'figure' ? 'TikZ figure' : texToUnicode(s.tex) || ' '}
          />
        </Box>,
      )
      afterPicture = true
    }
  })
  flushText()
  if (children.length === 0) return undefined
  void Markdown
  // The blank row the engine leaves above each message, which a drawing of our own must keep.
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box width={2} flexShrink={0} marginTop={bulletRow}>
        <Text>{opts.bullet ? '●' : ' '}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  )
}

function drawnIn(text: string): Drawn[] {
  return splitMath(text).filter((s): s is Drawn => s.kind !== 'markdown')
}

// A formula or figure that failed: as written, copyable, in the error color.
// The reason stays in the cache's .err file, for a tool to read when asked.
function errorBlock(els: any, source: string, _reason: string): JSX.Element {
  const { Box, Text } = els
  return (
    <Box marginLeft={2} marginY={1}>
      <Text color="error">{source}</Text>
    </Box>
  )
}

function asWritten(s: Drawn): string {
  if (s.kind === 'figure') return '```tikz\n' + s.tex.trim() + '\n```'
  return s.env ? `\\begin{${s.env}}\n${s.tex.trim()}\n\\end{${s.env}}` : `$$\n${s.tex.trim()}\n$$`
}

// Typesets every formula and figure of a block, display and inline, at the sizes it will be drawn.
async function readyAll($: EngineInterface, text: string): Promise<void> {
  const room = lastRoom ?? 76
  const segments = splitMath(text)
  const prose = segments.filter(s => s.kind === 'markdown').map(s => s.text).join('\n\n')
  await Promise.all([
    ...drawnIn(text).map(s => fit($, s, room)),
    ...(settings.inline ? [...new Set(inlineTexes(prose))].map(tex => fitInline($, tex, room)) : []),
  ]).catch(() => undefined)
}

// Typesets the formulas and figures that closed in a held piece, redrawing the band as each is ready.
async function prepareLive($: EngineInterface, text: string): Promise<void> {
  await Promise.all(
    drawnIn(text).map(async seg => {
      if (lastRoom !== undefined) await fit($, seg, lastRoom)
      else await typesetSegment($, seg)
      await update($, live, cur => ({ ...cur, v: cur.v + 1 })).catch(() => undefined)
    }),
  )
}

// The held text without a formula or figure still open at its end, which shows
// once it closes. Cutting at one opening can leave another open before it (an
// environment begun inside an inline formula), so it cuts until nothing is open.
function splitPending(text: string): string {
  for (;;) {
    const cut = openAt(text)
    if (cut === undefined) return text
    text = text.slice(0, cut)
  }
}

function openAt(text: string): number | undefined {
  const opens: number[] = []
  const dollars = [...text.matchAll(/(?<!\\)\$\$/g)].map(m => m.index ?? 0)
  if (dollars.length % 2 === 1) opens.push(dollars[dollars.length - 1]!)
  const bracket = text.lastIndexOf('\\[')
  if (bracket > text.lastIndexOf('\\]')) opens.push(bracket)
  const paren = text.lastIndexOf('\\(')
  if (paren > text.lastIndexOf('\\)')) opens.push(paren)
  const begin = text.lastIndexOf('\\begin{')
  if (begin >= 0) {
    const env = /^\\begin\{([^}]*)\}/.exec(text.slice(begin))?.[1]
    if (!env || !text.slice(begin).includes(`\\end{${env}}`)) opens.push(begin)
  }
  const fence = [...text.matchAll(/^```/gm)].map(m => m.index ?? 0)
  if (fence.length % 2 === 1 && /^```tikz/.test(text.slice(fence[fence.length - 1]!))) opens.push(fence[fence.length - 1]!)
  // An inline formula still open on the last line waits for its closing dollar.
  const lineStart = text.lastIndexOf('\n') + 1
  const singles = [...text.slice(lineStart).matchAll(/(?<![\\$])\$(?!\$)/g)].map(m => lineStart + (m.index ?? 0))
  if (singles.length % 2 === 1) opens.push(singles[singles.length - 1]!)
  return opens.length > 0 ? Math.min(...opens) : undefined
}


function readyPicture(segment: Drawn, room: number): Picture | undefined {
  return ready.get(fitId(segment, room))
}


// Markdown drawn as Claude Code draws it, save that paragraphs, list items,
// headings and quotes holding inline math are set here: broken into lines,
// then packed onto a canvas of cells, each line as high as it fits. A line's
// text keeps one row below the last (two across a paragraph break); its
// formulas reach into rows above and below wherever those cells are free, so
// a tall formula uses the blank space around it instead of spacing out lines.
// Every word is still drawn by the engine's Markdown element.
// The row the first drawn line of text sits on, for the reply's bullet.
let firstRow = 0
function drawProse(els: any, md: string, picture: (tex: string) => Picture | undefined, key: () => string): JSX.Element[] {
  const { Box, Text, Markdown, Image } = els
  if (!settings.inline || !Image || !hasInlineMath(md)) return [<Markdown text={inlineToUnicode(md)} />]
  const out: JSX.Element[] = []
  const room = lastRoom ?? 76
  type Placed = { x: number; width: number; cells: (row: number) => [number, JSX.Element][]; up: number; down: number; isText: boolean }
  type Line = { items: Placed[]; gap: number; starts: boolean; heading: boolean; marker?: { x: number; text: string }; quote?: number }
  let group: Line[] = []
  let overhang = 0
  const failed = new Map<string, string>() // inline formulas shown as written, and why
  firstRow = 0

  const flushGroup = (marginTop: number) => {
    if (group.length === 0) return
    // Rows each cell is taken in, as column ranges.
    const taken = new Map<number, [number, number][]>()
    const free = (row: number, x0: number, x1: number) => !(taken.get(row) ?? []).some(([a, b]) => x0 < b && a < x1)
    const take = (row: number, x0: number, x1: number) => taken.set(row, [...(taken.get(row) ?? []), [x0, x1]])
    // Air kept around hanging formulas, which only other formulas stay out of.
    const air = new Map<number, [number, number][]>()
    const hold = (row: number, x0: number, x1: number) => air.set(row, [...(air.get(row) ?? []), [x0, x1]])
    const clear = (row: number, x0: number, x1: number) => !(air.get(row) ?? []).some(([a, b]) => x0 < b && a < x1)
    const placed: { line: Line; row: number }[] = []
    let last = -1
    let blockBottom = -1 // lowest row the block being placed reaches
    let prevBottom = -1 // and the block before it
    for (const line of group) {
      if (line.starts) {
        prevBottom = blockBottom
        blockBottom = -1
      }
      const up = Math.max(0, ...line.items.map(i => i.up))
      const texts = line.items.filter(i => i.isText || i.up + i.down === 0)
      const textFrom = Math.min(...line.items.map(i => i.x), line.marker?.x ?? Infinity, line.quote ?? Infinity)
      const textTo = Math.max(...line.items.map(i => i.x + i.width))
      const fits = (row: number) =>
        row - up >= 0 &&
        free(row, textFrom, textTo) &&
        line.items.every(i => {
          for (let r = row - i.up; r <= row + i.down; r++) {
            if (r !== row && !free(r, i.x, i.x + i.width)) return false
            if (!i.isText && i.up + i.down > 0 && !clear(r, i.x, i.x + i.width)) return false
          }
          return true
        })
      // A block's text starts below everything the block before reaches: a heading
      // a full gap below it, other text a gap below the last text (formulas
      // hanging into that gap count toward it).
      let row = Math.max(up, last < 0 ? 0 : last + 1 + (line.starts ? line.gap : 0))
      if (line.starts && prevBottom >= 0) row = Math.max(row, prevBottom + 1 + (line.heading ? line.gap : 0))
      while (!fits(row)) row++
      blockBottom = Math.max(blockBottom, row + Math.max(0, ...line.items.map(i => i.down)))
      take(row, textFrom, textTo)
      for (const i of line.items) {
        for (let r = row - i.up; r <= row + i.down; r++) if (r !== row) take(r, i.x, i.x + i.width)
        // A formula hanging below its line keeps a little air from later lines'
        // formulas: a row under it and a column either side (text may still tuck in).
        if (i.down > 0) {
          for (let r = row + 1; r <= row + i.down + 1; r++) hold(r, i.x - 1, i.x + i.width + 1)
        }
      }
      placed.push({ line, row })
      last = row
    }
    const height = Math.max(...[...taken.keys()]) + 1
    // Laid out row by row in the normal flow (no absolute positions, which do
    // not clip when scrolled): each row holds its pieces left to right, a
    // formula taller than a row contributing one strip to each row it covers.
    const grid: { x: number; width: number; el: JSX.Element }[][] = Array.from({ length: height }, () => [])
    for (const { line, row } of placed) {
      if (line.marker) grid[row]!.push({ x: line.marker.x, width: textWidth(line.marker.text), el: <Text>{line.marker.text}</Text> })
      if (line.quote !== undefined) grid[row]!.push({ x: line.quote, width: 1, el: <Text dimColor>▎</Text> })
      for (const item of line.items) item.cells(row).forEach(([r, el]) => grid[r]?.push({ x: item.x, width: item.width, el }))
    }
    const children = grid.map(pieces => {
      pieces.sort((p, q) => p.x - q.x)
      let at = 0
      const row: JSX.Element[] = []
      for (const piece of pieces) {
        if (piece.x > at) row.push(<Box width={piece.x - at} flexShrink={0} />)
        row.push(<Box flexShrink={0}>{piece.el}</Box>)
        at = Math.max(at, piece.x + piece.width)
      }
      return <Box flexDirection="row" height={1}>{row}</Box>
    })
    // Rows the first line's formulas reach above its text count toward the gap before the canvas.
    const lead = placed[0]?.row ?? 0
    const top = Math.max(0, marginTop - lead)
    if (out.length === 0) firstRow = top + lead
    // Rows under the last line of text hold only overhanging formulas: they count toward the next gap.
    overhang = height - 1 - (placed[placed.length - 1]?.row ?? height - 1)
    out.push(<Box marginTop={top} flexDirection="column" flexShrink={0}>{children}</Box>)
    group = []
  }

  let pendingGap = 0
  layoutProse(md).forEach((block, n) => {
    const gap = block.gap && n > 0 ? 1 : 0
    if (block.kind === 'markdown') {
      flushGroup(pendingGap)
      pendingGap = 0
      const isHeading = /^\s{0,3}#/.test(block.text)
      out.push(<Box marginTop={isHeading ? gap : Math.max(0, gap - overhang)}><Markdown text={inlineToUnicode(block.text)} /></Box>)
      overhang = 0
      return
    }
    if (group.length === 0) {
      pendingGap = Math.max(0, gap - overhang)
      overhang = 0
    }
    const markerWidth = block.marker ? textWidth(block.marker) + 1 : 0
    const left = block.indent + markerWidth + (block.quote ? 2 : 0)
    const avail = Math.max(10, room - left)
    const measured = block.tokens.map(token => {
      const parts = token.map(part => {
        if (part.kind === 'md') return { part, width: part.width, pic: undefined as Picture | undefined }
        const pic = picture(part.tex)
        const width = pic ? pic.columns : failures.has(failureId('inline', part.tex)) ? textWidth(`$${part.tex}$`) : textWidth(texToUnicode(part.tex) || ' ')
        return { part, width, pic }
      })
      return { parts, width: parts.reduce((w, p) => w + p.width, 0) }
    })
    const lines: (typeof measured)[] = []
    let line: typeof measured = []
    let used = 0
    for (const token of measured) {
      if (line.length > 0 && used + 1 + token.width > avail) {
        lines.push(line)
        line = []
      }
      used = line.length === 0 ? token.width : used + 1 + token.width
      line.push(token)
    }
    if (line.length > 0) lines.push(line)

    lines.forEach((tokens, k) => {
      const items: Placed[] = []
      let x = left
      for (const token of tokens) {
        for (const { part, width, pic } of token.parts) {
          const at = x
          if (part.kind === 'md') {
            items.push({ x: at, width, up: 0, down: 0, isText: true, cells: row => [[row, <Markdown text={part.text} />]] })
          } else if (pic) {
            const up = pic.rowsAbove ?? 0
            const id = key()
            const alt = texToUnicode(part.tex) || ' '
            const slices = pic.slices ?? [pic.path]
            items.push({
              x: at, width, up, down: pic.rows - 1 - up, isText: false,
              // The text row's strip carries the alt text where no picture can be drawn.
              cells: row => slices.map((file, r) => [row - up + r, <Image key={`${id}-${r}`} source={{ file, format: 'png' }} columns={pic.columns} rows={1} alt={r === up ? alt : ' '} />]),
            })
          } else if (failures.has(failureId('inline', part.tex))) {
            const written = `$${part.tex}$`
            failed.set(written, failures.get(failureId('inline', part.tex))!)
            items.push({ x: at, width: textWidth(written), up: 0, down: 0, isText: true, cells: row => [[row, <Text color="error">{written}</Text>]] })
          } else {
            const alt = escapeWord(texToUnicode(part.tex) || ' ')
            items.push({ x: at, width, up: 0, down: 0, isText: true, cells: row => [[row, <Markdown text={alt} />]] })
          }
          x += width
        }
        x += 1
      }
      group.push({
        items,
        gap: k === 0 && group.length > 0 ? gap : 0,
        starts: k === 0,
        heading: block.heading === true,
        ...(k === 0 && block.marker ? { marker: { x: block.indent, text: block.marker } } : {}),
        ...(block.quote ? { quote: block.indent } : {}),
      })
    })
  })
  flushGroup(pendingGap)
  return out
}

// Inline formulas: typeset in text style with their baseline found, then
// placed in whole cells so the baseline sits where the terminal's text has its own.
type InlineSet = { path: string; width: number; height: number; above: number; below: number }
const inlineTypeset = new Map<string, Promise<InlineSet | undefined>>()
const inlineFitted = new Map<string, Promise<Picture | undefined>>()
const inlineReady = new Map<string, Picture | undefined>()

function inlineId(tex: string, room: number): string {
  return `${ROW_PX}\u0000${cellWidth()}\u0000${tex}\u0000${room}`
}

function fitInline($: EngineInterface, tex: string, room: number): Promise<Picture | undefined> {
  const id = inlineId(tex, room)
  let pending = inlineFitted.get(id)
  if (!pending) {
    pending = retryable($, inlineFitted, id, padInline($, tex, room))
    pending.then(picture => inlineReady.set(id, picture))
    inlineFitted.set(id, pending)
  }
  return pending
}

// `size` scales the type: a formula shrunk to spare a row is typeset again at
// its final size, so its glyphs are drawn crisp rather than resampled.
function typesetInline($: EngineInterface, tex: string, size = 1): Promise<InlineSet | undefined> {
  const id = `${ROW_PX}\u0000${size.toFixed(3)}\u0000${tex}`
  let pending = inlineTypeset.get(id)
  if (!pending) {
    pending = retryable($, inlineTypeset, id, slot(() => runInlineLatex($, tex, size)), true)
    inlineTypeset.set(id, pending)
  }
  return pending
}

let running = 0
const waiting: (() => void)[] = []
async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= 6) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await job()
  } finally {
    running--
    waiting.shift()?.()
  }
}

async function runInlineLatex($: EngineInterface, tex: string, scale: number): Promise<InlineSet | undefined> {
  const fid = failureId('inline', tex)
  if (!isSafeTex(tex)) return void failures.set(fid, UNSAFE_NOTE)
  const dir = await cache($)
  const { ink } = await palette($)
  const fg = dvipngColor(ink) ?? 'rgb 0.9 0.9 0.9'
  const doc = [
    '\\documentclass[10pt]{article}',
    '\\usepackage{amsmath,amssymb,amsfonts,mathtools,bm,xcolor,mathrsfs,cancel,braket}',
    settings.preamble,
    `\\definecolor{black}{HTML}{${ink.replace('#', '')}}`,
    '\\usepackage[active,tightpage]{preview}',
    '\\begin{document}',
    `\\begin{preview}\\color{black}$${tex}$\\end{preview}`,
    '\\end{document}',
    '',
  ].join('\n')
  const dpi = Math.round((0.98 * ROW_PX * settings.inlineScale * scale * 72.27) / 10)
  const key = hashKey([VERSION, 'inline', doc, fg, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const meta = `${dir}/${key}.json`
  const failed = `${dir}/${key}.err`
  if (await $.fs.exists(failed)) return recordFailure($, fid, failed)
  if (!(await $.fs.exists(meta))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 15000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return recordFailure($, fid, failed)
    }
    const dvipng = await $.process.run(
      ['dvipng', '-D', String(dpi), '-T', 'tight', '--depth', '--height', '-bg', 'Transparent', '-fg', fg, '-o', `${key}.png`, `${key}.dvi`],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.dvi`], { cwd: dir }).catch(() => undefined)
    const m = /depth=(-?\d+) height=(-?\d+)/.exec(dvipng.stdout)
    if (dvipng.exitCode !== 0 || !m) {
      await $.fs.write(failed, dvipng.stderr || 'dvipng failed')
      return recordFailure($, fid, failed)
    }
    await $.fs.write(meta, JSON.stringify({ below: Number(m[1]), above: Number(m[2]) }))
  }
  const [size, read] = await Promise.all([measure($, png), $.fs.read(meta)])
  if (!size) return undefined
  const { above, below } = JSON.parse(read) as { above: number; below: number }
  return { path: png, width: size.width, height: size.height, above, below }
}

async function padInline($: EngineInterface, tex: string, room: number): Promise<Picture | undefined> {
  const t = await typesetInline($, tex)
  if (!t) return undefined
  const base = settings.inlineBaseline * ROW_PX
  const under = ROW_PX - base
  const cellW = cellWidth()
  // The line grows rows above and below its text row as far as the formula
  // reaches. To spare a row, a formula may shrink a little and sit a little off
  // the baseline: each choice is scored as its rows plus what it costs to look
  // at, so a row is given up for small compromises and kept for big ones.
  const widest = Math.min(1, (room * cellW) / Math.max(1, t.width))
  const maxShift = 0.2 * ROW_PX
  let best = { cost: Infinity, shrink: widest, shift: 0, up: 0, down: 0 }
  for (let k = widest; k >= widest * 0.8 - 1e-9; k -= widest * 0.025) {
    for (let shift = -maxShift; shift <= maxShift; shift += 1) {
      const up = Math.ceil(Math.max(0, t.above * k + shift - base) / ROW_PX - 1e-9)
      const down = Math.ceil(Math.max(0, t.below * k - shift - under) / ROW_PX - 1e-9)
      const cost = up + down + 3 * (1 - k / widest) + (2 * Math.abs(shift)) / ROW_PX
      if (cost < best.cost - 1e-9) best = { cost, shrink: k, shift, up, down }
    }
  }
  const { up, down } = best
  const rows = 1 + up + down
  const sized = best.shrink < 0.999 ? await typesetInline($, tex, Math.round(best.shrink * 1000) / 1000) : t
  if (!sized) return undefined
  const columns = clamp(Math.ceil(sized.width / cellW), 1, 255)
  const canvasW = Math.round(columns * cellW)
  const top = Math.max(0, Math.round(up * ROW_PX + base - best.shift - sized.above))
  const dx = Math.max(0, Math.floor((canvasW - sized.width) / 2))
  // Cut into one strip per row: each strip is ordinary one-row content, which
  // scrolls and clips as text does, and at the terminal's own cell size the
  // strips meet without a seam.
  const stem = sized.path.replace(/\.png$/, `-i${columns}x${rows}t${top}c${ROW_PX}`)
  const slices = Array.from({ length: rows }, (_, r) => `${stem}-${r}.png`)
  if (!(await $.fs.exists(slices[rows - 1]!))) {
    const offset = `${dx > 0 ? `-${dx}` : '+0'}${top > 0 ? `-${top}` : '+0'}`
    const args = ['magick', sized.path, '-background', 'none', '-gravity', 'northwest', '-extent', `${canvasW}x${rows * ROW_PX}${offset}`,
      '-crop', `${canvasW}x${ROW_PX}`, '+repage', `${stem}-%d.png`]
    const cut = await $.process.run(args, { timeoutMs: 15000 }).catch(() => undefined)
    if (cut?.exitCode !== 0) return undefined
  }
  void down
  return { path: slices[0]!, columns, rows, rowsAbove: up, slices }
}

function showMode($: EngineInterface, current: Mode): void {
  $.ui.status(current === 'source' ? 'LaTeX: source (/latex to render)' : undefined)
}

function imagesOn($: EngineInterface): Promise<boolean> {
  canDraw ??= detectImages($, settings.images).catch(err => {
    canDraw = undefined
    if (isAbort(err)) redrawLater($)
    return false
  })
  return canDraw
}

// A tool check: whether the program ran fine; an aborted run is passed on, to be asked again.
const works = (run: Promise<{ exitCode: number }>) =>
  run.then(
    r => r.exitCode === 0,
    err => {
      if (isAbort(err)) throw err
      return false
    },
  )

async function detectImages($: EngineInterface, option: string): Promise<boolean> {
  if (option === 'off') return false
  const tools = await Promise.all([
    works($.process.run(['latex', '--version'])),
    works($.process.run(['dvipng', '--version'])),
  ])
  if (!tools.every(Boolean)) return false
  if (option === 'on') return true

  const [term, program, kitty, tmux, ssh] = await Promise.all([
    $.env.get('TERM'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('KITTY_WINDOW_ID'),
    $.env.get('TMUX'),
    $.env.get('SSH_CONNECTION'),
  ])
  // The terminal reads the picture from this machine's files over the kitty
  // graphics protocol, which tmux does not pass and ssh cannot reach.
  if (tmux || ssh) return false
  const name = `${term ?? ''} ${program ?? ''}`.toLowerCase()
  return Boolean(kitty) || /kitty|ghostty|wezterm/.test(name)
}

// Figures take pdflatex and pdftocairo besides what formulas take.
function figuresOn($: EngineInterface): Promise<boolean> {
  canDrawFigures ??= imagesOn($)
    .then(async on => {
      if (!on) return false
      const tools = await Promise.all(['pdflatex', 'pdftocairo'].map(tool => works($.process.run([tool, '-v']))))
      return tools.every(Boolean)
    })
    .catch(err => {
      canDrawFigures = undefined
      if (isAbort(err)) redrawLater($)
      return false
    })
  return canDrawFigures
}

function cache($: EngineInterface): Promise<string> {
  cacheDir ??= findCacheDir($)
  return cacheDir
}

async function findCacheDir($: EngineInterface): Promise<string> {
  const [xdg, home] = await Promise.all([$.env.get('XDG_CACHE_HOME'), $.env.get('HOME')])
  return `${xdg || `${home ?? '/tmp'}/.cache`}/claude-latex-render`
}

function palette($: EngineInterface): Promise<Palette> {
  colors ??= pickPalette($)
  return colors
}

// The ink, and on a dark theme the paper figures' `white` stands for.
async function pickPalette($: EngineInterface): Promise<Palette> {
  const rows = await $.config.list().catch(() => [])
  const light = String(rows.find(row => row.key === 'theme')?.value ?? 'dark').includes('light')
  const hex = (option: string, fallback: string) => (dvipngColor(option) ? option.replace('#', '') : fallback)
  return {
    ink: hex(settings.color, light ? '1f1f1f' : 'e6e6e6'),
    paper: light ? undefined : hex(settings.background, '1e1e1e'),
  }
}

// Just after a (re)load the engine aborts the processes a module starts. An
// aborted run is no answer: every cache it passes through forgets it (inner
// layers rethrow, the outermost returns nothing), and a redraw is asked for
// once things have settled. Other errors, and LaTeX's own, stay cached.
const isAbort = (err: unknown) => /aborted/i.test(String(err))
let redrawSoon = false
function redrawLater($: EngineInterface): void {
  if (redrawSoon) return
  redrawSoon = true
  void $.clock
    .sleep(500)
    .then(() => $.ui.invalidate('ui.render'))
    .catch(() => undefined)
    .finally(() => (redrawSoon = false))
}
function retryable<T>(
  $: EngineInterface,
  cache: Map<string, Promise<T | undefined>>,
  id: string,
  run: Promise<T | undefined>,
  inner = false,
): Promise<T | undefined> {
  return run.catch(err => {
    if (!isAbort(err)) return undefined
    cache.delete(id)
    redrawLater($)
    if (inner) throw err
    return undefined
  })
}

// Typesets one formula or figure to a tight transparent PNG, cached on disk by content.
function typesetSegment($: EngineInterface, segment: Drawn): Promise<Typeset | undefined> {
  const id = `${ROW_PX}\u0000` + (segment.kind === 'figure' ? `figure\u0000${segment.tex}` : `${segment.env}\u0000${segment.tex}`)
  let pending = typeset.get(id)
  if (!pending) {
    pending = retryable($, typeset, id, segment.kind === 'figure' ? runTikz($, segment) : runLatex($, segment), true)
    typeset.set(id, pending)
  }
  return pending
}

async function runLatex($: EngineInterface, segment: Display): Promise<Typeset | undefined> {
  const fid = failureId('display', segment.tex)
  if (!isSafeTex(segment.tex)) return void failures.set(fid, UNSAFE_NOTE)
  const dir = await cache($)
  const { ink, paper } = await palette($)
  const fg = dvipngColor(ink) ?? 'rgb 0.9 0.9 0.9'
  const doc = texDocument(segment, settings.preamble, ink, paper)
  const dpi = dpiFor()
  const key = hashKey([VERSION, doc, fg, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const failed = `${dir}/${key}.err`

  if (await $.fs.exists(failed)) return recordFailure($, fid, failed)
  if (!(await $.fs.exists(png))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 15000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return recordFailure($, fid, failed)
    }
    const dvipng = await $.process.run(
      ['dvipng', '-q', '-D', String(dpi), '-T', 'tight', '-bg', 'Transparent', '-fg', fg, '-o', `${key}.png`, `${key}.dvi`],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.dvi`], { cwd: dir }).catch(() => undefined)
    if (dvipng.exitCode !== 0) {
      await $.fs.write(failed, dvipng.stderr || 'dvipng failed')
      return recordFailure($, fid, failed)
    }
  }

  return measure($, png)
}

// A figure's text is typeset at the same size as a formula's.
function dpiFor(): number {
  return Math.round((settings.scale * ROW_PX * 72.27) / 12)
}

async function measure($: EngineInterface, png: string): Promise<Typeset | undefined> {
  const { base64 } = await $.fs.read(png, { as: 'bytes' })
  const size = pngSize(base64)
  return size ? { path: png, ...size } : undefined
}

async function runTikz($: EngineInterface, segment: Figure): Promise<Typeset | undefined> {
  const fid = failureId('figure', segment.tex)
  if (!(await figuresOn($))) return undefined
  if (!isSafeTex(segment.tex)) return void failures.set(fid, UNSAFE_NOTE)
  const dir = await cache($)
  const { ink, paper } = await palette($)
  const doc = figureDocument(segment.tex, settings.preamble, ink, paper)
  const dpi = dpiFor()
  const key = hashKey([VERSION, doc, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const failed = `${dir}/${key}.err`

  if (await $.fs.exists(failed)) return recordFailure($, fid, failed)
  if (!(await $.fs.exists(png))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 30000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return recordFailure($, fid, failed)
    }
    // pdftocairo names the picture itself, adding `.png` to the stem.
    const cairo = await $.process.run(
      ['pdftocairo', '-png', '-transp', '-singlefile', '-r', String(dpi), `${key}.pdf`, key],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.pdf`], { cwd: dir }).catch(() => undefined)
    if (cairo.exitCode !== 0) {
      await $.fs.write(failed, cairo.stderr || 'pdftocairo failed')
      return recordFailure($, fid, failed)
    }
  }
  return measure($, png)
}

// Pads (and if needed shrinks) a typeset formula or figure to a whole number
// of cells, so the terminal's scaling to the box keeps its proportions.
// Within `room` columns and, when given, `rowLimit` rows.
function fitId(segment: Drawn, room: number, rowLimit?: number): string {
  return `${ROW_PX}\u0000${cellWidth()}\u0000${segment.kind === 'figure' ? 'figure' : segment.env}\u0000${segment.tex}\u0000${room}\u0000${rowLimit ?? ''}`
}

function fit($: EngineInterface, segment: Drawn, room: number, rowLimit?: number): Promise<Picture | undefined> {
  const id = fitId(segment, room, rowLimit)
  let pending = fitted.get(id)
  if (!pending) {
    pending = retryable($, fitted, id, padToCells($, segment, room, rowLimit))
    pending.then(picture => ready.set(id, picture))
    fitted.set(id, pending)
  }
  return pending
}

async function padToCells($: EngineInterface, segment: Drawn, room: number, rowLimit?: number): Promise<Picture | undefined> {
  const base = await typesetSegment($, segment)
  if (!base) return undefined
  const cellW = cellWidth()
  const tall = rowLimit === undefined ? 1 : (rowLimit * ROW_PX) / base.height
  const shrink = Math.min(1, (room * cellW) / base.width, tall)
  const width = Math.max(1, Math.round(base.width * shrink))
  const height = Math.max(1, Math.round(base.height * shrink))
  const columns = clamp(Math.ceil(width / cellW), 1, 255)
  // A little air above and below: at least ~0.3 row each side, the picture centred in its rows.
  const rows = clamp(Math.ceil(height / ROW_PX + 0.6), 1, 255)
  const out = base.path.replace(/\.png$/, `-${columns}x${rows}.png`)

  if (!(await $.fs.exists(out))) {
    const args = ['magick', base.path]
    if (shrink < 1) args.push('-resize', `${width}x${height}!`)
    args.push('-background', 'none', '-gravity', 'west', '-extent', `${Math.round(columns * cellW)}x${rows * ROW_PX}`, out)
    const padded = await $.process.run(args, { timeoutMs: 15000 }).catch(() => undefined)
    // Without ImageMagick the picture is drawn unpadded, a little stretched.
    if (padded?.exitCode !== 0) return { path: base.path, columns, rows }
  }
  return { path: out, columns, rows }
}

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n))
}
