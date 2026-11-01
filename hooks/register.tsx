import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

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
import { hasInlineMath, inlineTexes, layoutProse } from './flow'

// Pixels per terminal row the formulas are typeset at; the terminal scales
// the picture to its cells, so this only sets how crisp they are.
const ROW_PX = 40
const VERSION = 1
// The most rows the live band above the prompt takes.
const LIVE_ROWS = 40
// What can open math, a figure or a LaTeX environment: the held part of a block starts at its line.
const MATH_OPENER = /\$|\\[\[(]|\\begin\{|```tikz/

type Display = Segment & { kind: 'display' }
type Figure = Segment & { kind: 'figure' }
type Drawn = Display | Figure
type Palette = { ink: string; paper?: string }
type Typeset = { path: string; width: number; height: number }
type Picture = { path: string; columns: number; rows: number }

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
}

// What the module learns once per load: its options, whether pictures can be
// drawn, the cache folder, the colors, and every formula and figure typeset so far.
let settings: Settings = { images: 'auto', color: 'auto', scale: 1.25, cellAspect: 2.1, preamble: '', background: 'auto', live: true, inline: true, inlineScale: 1, inlineBaseline: 0.8 }
let canDraw: Promise<boolean> | undefined
let canDrawFigures: Promise<boolean> | undefined
let cacheDir: Promise<string> | undefined
let colors: Promise<Palette> | undefined
// `/latex` flips this; in `source` every reply is drawn as written.
const mode = atom({ plugin: 'latex-render', key: 'mode' } as const, 'render' as Mode)
// The part of the block being streamed that is held back, drawn above the prompt until it ends.
const live = atom({ plugin: 'latex-render', key: 'live' } as const, { text: '', bullet: false, v: 0 } as Live)
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

  // While a reply streams, its text from the first character that could open
  // math is held back from the engine until just before the block's end, so
  // raw LaTeX never shows in the streaming row. The held text is drawn live,
  // typeset, in the band above the prompt, right under the reply it continues;
  // at the block's end it is released whole (the transcript keeps the same
  // text) and the engine draws the finished block in place.
  on('turn.step', async function* ($, e, next) {
    const onTerminal = e.agentId === undefined && (await $.session.surfaces()).includes('terminal')
    if (!onTerminal || !settings.live || (await read($, mode)) === 'source') return yield* next(e)
    let held: { first: any; text: string; index: number; bullet: boolean } | undefined
    let streamedIn = new Map<number, number>() // characters passed through per block
    let settled = 0
    const release = function* () {
      if (!held) return
      const chunk = { ...held.first, text: held.text }
      held = undefined
      settled = 0
      yield chunk
      void update($, live, () => ({ text: '', bullet: false, v: 0 })).catch(() => undefined)
    }
    try {
      for await (const chunk of next(e)) {
        if (chunk.kind !== 'text') {
          yield* release()
          yield chunk
          continue
        }
        if (held && held.index !== chunk.index) yield* release()
        if (!held) {
          const at = chunk.text.search(MATH_OPENER)
          if (at < 0) {
            streamedIn.set(chunk.index, (streamedIn.get(chunk.index) ?? 0) + chunk.text.length)
            yield chunk
            continue
          }
          // Cut back to the start of the line, so a sentence is never split between the row and the band.
          const before = chunk.text.slice(0, at)
          const nl = before.lastIndexOf('\n')
          const cut = nl >= 0 ? nl + 1 : (streamedIn.get(chunk.index) ?? 0) === 0 ? 0 : at
          if (cut > 0) {
            streamedIn.set(chunk.index, (streamedIn.get(chunk.index) ?? 0) + cut)
            yield { ...chunk, text: chunk.text.slice(0, cut) }
          }
          held = { first: cut > 0 ? { kind: 'text', index: chunk.index } : chunk, text: chunk.text.slice(cut), index: chunk.index, bullet: (streamedIn.get(chunk.index) ?? 0) === 0 }
        } else {
          held.text += chunk.text
        }
        const text = held.text
        const upTo = settledLength(text)
        if (upTo > settled) {
          void prepareLive($, text.slice(settled, upTo))
          settled = upTo
        }
        const bullet = held.bullet
        void update($, live, cur => ({ text, bullet, v: cur.v + 1 })).catch(() => undefined)
      }
    } catch (err) {
      // An interrupted stream still records the text it held.
      yield* release()
      throw err
    }
    yield* release()
  })

  // Above the prompt, while Claude writes: the held part of the block being
  // written, drawn as the finished block will be, its newest rows when it is long.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [state, current] = await Promise.all([read($, live), read($, mode)])
    const { hasSurvey, maxRows, bodyColumns, view } = e.props
    const budget = Math.min(maxRows - 2, LIVE_ROWS)
    if (!state.text || current === 'source' || hasSurvey || view.agentId !== undefined || e.surface !== 'terminal' || budget < 2) return next(e)
    const room = lastRoom ?? Math.max(10, bodyColumns - 4)
    const { stable, pending } = splitPending(state.text)
    const segments = splitMath(stable)
    const draws = await imagesOn($)
    const els = $.ui.resolve(e)
    const { Box, Text, Image } = els
    // Each piece with the rows it is expected to take, newest kept when over budget.
    const pieces: { el: JSX.Element; rows: number }[] = []
    let pendingText = ''
    let keyer = 0
    const bump = () => update($, live, cur => ({ ...cur, v: cur.v + 1 })).catch(() => undefined)
    const flushText = () => {
      const md = pendingText.replace(/^\s*\n/, '').replace(/\n\s*$/, '')
      if (md.trim() !== '') {
        const pic = (tex: string) => {
          const ready = inlineReady.get(inlineId(tex, room))
          if (!ready && draws && settings.inline) void fitInline($, tex, room).then(p => (p ? bump() : undefined))
          return ready
        }
        const drawn = draws ? drawProse(els, md, pic, () => `l${keyer++}`) : [<els.Markdown text={inlineToUnicode(md)} />]
        const rows = estimateRows(inlineToUnicode(md), room)
        drawn.forEach((el, k) => pieces.push({ el, rows: k === 0 ? rows : 0 }))
      }
      pendingText = ''
    }
    segments.forEach((s, index) => {
      if (s.kind === 'markdown') { pendingText += s.text; return }
      const picture = draws ? readyPicture(s, room) : undefined
      if (!picture) {
        if (draws) void fit($, s, room).then(() => update($, live, cur => ({ ...cur, v: cur.v + 1 }))).catch(() => undefined)
        pendingText += segmentsToUnicode([s])
        return
      }
      flushText()
      pieces.push({
        el: (
          <Box marginLeft={2}>
            <Image key={`live-${index}`} source={{ file: picture.path, format: 'png' }} columns={picture.columns} rows={picture.rows} alt={s.kind === 'figure' ? 'TikZ figure' : texToUnicode(s.tex) || ' '} />
          </Box>
        ),
        rows: picture.rows,
      })
    })
    flushText()
    if (pending) pieces.push({ el: <Box marginLeft={2}><Text dimColor>{pending}</Text></Box>, rows: 1 })
    let left = budget
    const shown: JSX.Element[] = []
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i]!
      if (piece.rows > left && shown.length > 0) break
      shown.unshift(piece.el)
      left -= piece.rows
    }
    if (shown.length === 0) return next(e)
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{state.bullet ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {shown}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Read before anything else, so every reply is drawn again when it changes.
    if ((await read($, mode)) === 'source') return next(e)
    const text = e.props.text
    if (!hasMath(text)) return next(e)

    const segments = splitMath(text)
    const hasDisplay = segments.some(s => s.kind !== 'markdown')
    // A summary row stays one line of text: its math in Unicode, never a picture.
    const drawsPictures = !e.props.isSummary && e.surface === 'terminal' && hasDisplay && (await imagesOn($))

    if (!drawsPictures) {
      const rewritten = segmentsToUnicode(segments)
      return rewritten === text ? next(e) : next({ ...e, props: { ...e.props, text: rewritten } })
    }

    const room = Math.max(10, (e.viewport?.columns ?? 80) - 4)
    lastRoom = room
    const pictures = await Promise.all(
      segments.map(s => (s.kind === 'markdown' ? Promise.resolve(undefined) : fit($, s, room))),
    )

    const els = $.ui.resolve(e)
    const { Box, Text, Image } = els
    const prose = segments.filter(s => s.kind === 'markdown').map(s => s.text).join('\n\n')
    const inlinePics = new Map<string, Picture | undefined>()
    if (settings.inline) {
      const texes = [...new Set(inlineTexes(prose))]
      const fitted = await Promise.all(texes.map(tex => fitInline($, tex, room)))
      texes.forEach((tex, k) => inlinePics.set(tex, fitted[k]))
    }
    const children: JSX.Element[] = []
    let pendingText = ''
    let keyer = 0
    const flushText = () => {
      const md = pendingText.replace(/^\s*\n/, '').replace(/\n\s*$/, '')
      if (md.trim() !== '') children.push(...drawProse(els, md, tex => inlinePics.get(tex), () => `m${keyer++}`))
      pendingText = ''
    }

    segments.forEach((s, index) => {
      const picture = pictures[index]
      if (s.kind === 'markdown') {
        pendingText += s.text
      } else if (!picture) {
        pendingText += segmentsToUnicode([s])
      } else {
        flushText()
        children.push(
          <Box marginLeft={2}>
            <Image
              key={`${s.kind === 'figure' ? 'figure' : 'math'}-${index}`}
              source={{ file: picture.path, format: 'png' }}
              columns={picture.columns}
              rows={picture.rows}
              alt={s.kind === 'figure' ? 'TikZ figure' : texToUnicode(s.tex) || ' '}
            />
          </Box>,
        )
      }
    })
    flushText()

    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    )
  })
}

function drawnIn(text: string): Drawn[] {
  return splitMath(text).filter((s): s is Drawn => s.kind !== 'markdown')
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

// The held text's typesettable part, and a placeholder for a formula or figure still open at its end.
function splitPending(text: string): { stable: string; pending?: string } {
  const opens: number[] = []
  const dollars = [...text.matchAll(/\$\$/g)].map(m => m.index ?? 0)
  if (dollars.length % 2 === 1) opens.push(dollars[dollars.length - 1]!)
  const bracket = text.lastIndexOf('\\[')
  if (bracket > text.lastIndexOf('\\]')) opens.push(bracket)
  const begin = text.lastIndexOf('\\begin{')
  if (begin >= 0) {
    const env = /^\\begin\{([^}]*)\}/.exec(text.slice(begin))?.[1]
    if (env && !text.slice(begin).includes(`\\end{${env}}`)) opens.push(begin)
  }
  const fence = [...text.matchAll(/^```/gm)].map(m => m.index ?? 0)
  if (fence.length % 2 === 1 && /^```tikz/.test(text.slice(fence[fence.length - 1]!))) opens.push(fence[fence.length - 1]!)
  if (opens.length > 0) {
    const at = Math.min(...opens)
    const kind = text.slice(at).startsWith('```') || text.slice(at).includes('tikzpicture') ? 'figure' : 'formula'
    return { stable: text.slice(0, at), pending: `⋯ ${kind}` }
  }
  // An inline formula still open on the last line is left for the next piece.
  const lastLine = text.slice(text.lastIndexOf('\n') + 1)
  const singles = [...lastLine.replace(/\$\$/g, '').matchAll(/(?<!\\)\$/g)]
  if (singles.length % 2 === 1) {
    const cut = text.length - lastLine.length + lastLine.lastIndexOf('$')
    return { stable: text.slice(0, cut) }
  }
  return { stable: text }
}

function estimateRows(markdown: string, columns: number): number {
  return markdown.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(10, columns))), 0)
}

function readyPicture(segment: Drawn, room: number): Picture | undefined {
  return ready.get(fitId(segment, room))
}


// Markdown drawn as Claude Code draws it, save that a paragraph, list item,
// heading or quote holding inline math is laid out as a wrapping row of words,
// each word still drawn by the engine's Markdown element, each formula an image.
function drawProse(els: any, md: string, picture: (tex: string) => Picture | undefined, key: () => string): JSX.Element[] {
  const { Box, Text, Markdown, Image } = els
  if (!settings.inline || !Image || !hasInlineMath(md)) return [<Markdown text={inlineToUnicode(md)} />]
  const out: JSX.Element[] = []
  layoutProse(md).forEach((block, n) => {
    const marginTop = block.gap && n > 0 ? 1 : 0
    if (block.kind === 'markdown') {
      out.push(<Box marginTop={marginTop}><Markdown text={inlineToUnicode(block.text)} /></Box>)
      return
    }
    const words = block.tokens.map(token => {
      const parts = token.map(part => {
        if (part.kind === 'md') return <Markdown text={part.text} />
        const pic = picture(part.tex)
        const alt = texToUnicode(part.tex) || ' '
        return pic ? (
          <Image key={key()} source={{ file: pic.path, format: 'png' }} columns={pic.columns} rows={pic.rows} alt={alt} />
        ) : (
          <Markdown text={escapeMarkdown(alt)} />
        )
      })
      return parts.length === 1 ? parts[0]! : <Box flexDirection="row" flexShrink={0}>{parts}</Box>
    })
    out.push(
      <Box flexDirection="row" marginTop={marginTop} marginLeft={block.indent}>
        {block.marker ? <Box flexShrink={0} marginRight={1}><Text>{block.marker}</Text></Box> : null}
        {block.quote ? <Box flexShrink={0} marginRight={1}><Text dimColor>▎</Text></Box> : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="flex-start" flexGrow={1} flexShrink={1}>
          {words}
        </Box>
      </Box>,
    )
  })
  return out
}

// Inline formulas: typeset in text style with their baseline found, then
// placed in whole cells so the baseline sits where the terminal's text has its own.
type InlineSet = { path: string; width: number; height: number; above: number; below: number }
const inlineTypeset = new Map<string, Promise<InlineSet | undefined>>()
const inlineFitted = new Map<string, Promise<Picture | undefined>>()
const inlineReady = new Map<string, Picture | undefined>()

function inlineId(tex: string, room: number): string {
  return `${tex}\u0000${room}`
}

function fitInline($: EngineInterface, tex: string, room: number): Promise<Picture | undefined> {
  const id = inlineId(tex, room)
  let pending = inlineFitted.get(id)
  if (!pending) {
    pending = padInline($, tex, room).catch(() => undefined)
    pending.then(picture => inlineReady.set(id, picture))
    inlineFitted.set(id, pending)
  }
  return pending
}

function typesetInline($: EngineInterface, tex: string): Promise<InlineSet | undefined> {
  let pending = inlineTypeset.get(tex)
  if (!pending) {
    pending = slot(() => runInlineLatex($, tex)).catch(() => undefined)
    inlineTypeset.set(tex, pending)
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

async function runInlineLatex($: EngineInterface, tex: string): Promise<InlineSet | undefined> {
  if (!isSafeTex(tex)) return undefined
  const dir = await cache($)
  const { ink } = await palette($)
  const fg = dvipngColor(ink) ?? 'rgb 0.9 0.9 0.9'
  const doc = [
    '\\documentclass[10pt]{article}',
    '\\usepackage{amsmath,amssymb,amsfonts,mathtools,bm,xcolor}',
    settings.preamble,
    `\\definecolor{black}{HTML}{${ink.replace('#', '')}}`,
    '\\usepackage[active,tightpage]{preview}',
    '\\begin{document}',
    `\\begin{preview}\\color{black}$${tex}$\\end{preview}`,
    '\\end{document}',
    '',
  ].join('\n')
  const dpi = Math.round((0.98 * ROW_PX * settings.inlineScale * 72.27) / 10)
  const key = hashKey([VERSION, 'inline', doc, fg, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const meta = `${dir}/${key}.json`
  const failed = `${dir}/${key}.err`
  if (await $.fs.exists(failed)) return undefined
  if (!(await $.fs.exists(meta))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 15000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return undefined
    }
    const dvipng = await $.process.run(
      ['dvipng', '-D', String(dpi), '-T', 'tight', '--depth', '--height', '-bg', 'Transparent', '-fg', fg, '-o', `${key}.png`, `${key}.dvi`],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.dvi`], { cwd: dir }).catch(() => undefined)
    const m = /depth=(-?\d+) height=(-?\d+)/.exec(dvipng.stdout)
    if (dvipng.exitCode !== 0 || !m) {
      await $.fs.write(failed, dvipng.stderr || 'dvipng failed')
      return undefined
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
  const cellW = ROW_PX / settings.cellAspect
  // Shrunk to fit above the baseline and within the line; a little more to stay one row, else the line grows.
  let shrink = Math.min(1, base / Math.max(1, t.above), (room * cellW) / Math.max(1, t.width))
  let rows = 1
  if (t.below * shrink > under) {
    const oneRow = under / Math.max(1, t.below)
    if (oneRow >= 0.8 * shrink) shrink = oneRow
    else rows = 1 + Math.ceil((t.below * shrink - under) / ROW_PX)
  }
  const width = Math.max(1, Math.round(t.width * shrink))
  const height = Math.max(1, Math.round(t.height * shrink))
  const columns = clamp(Math.ceil(width / cellW), 1, 255)
  const canvasW = Math.round(columns * cellW)
  const canvasH = rows * ROW_PX
  const top = Math.max(0, Math.round(base - t.above * shrink))
  const dx = Math.max(0, Math.floor((canvasW - width) / 2))
  const out = t.path.replace(/\.png$/, `-i${columns}x${rows}t${top}w${width}.png`)
  if (!(await $.fs.exists(out))) {
    const offset = `${dx > 0 ? `-${dx}` : '+0'}${top > 0 ? `-${top}` : '+0'}`
    const args = ['magick', t.path, '-resize', `${width}x${height}!`, '-background', 'none', '-gravity', 'northwest', '-extent', `${canvasW}x${canvasH}${offset}`, out]
    const padded = await $.process.run(args, { timeoutMs: 15000 }).catch(() => undefined)
    if (padded?.exitCode !== 0) return undefined
  }
  return { path: out, columns, rows }
}

function showMode($: EngineInterface, current: Mode): void {
  $.ui.status(current === 'source' ? 'LaTeX: source (/latex to render)' : undefined)
}

function imagesOn($: EngineInterface): Promise<boolean> {
  canDraw ??= detectImages($, settings.images)
  return canDraw
}

async function detectImages($: EngineInterface, option: string): Promise<boolean> {
  if (option === 'off') return false
  const tools = await Promise.all([
    $.process.run(['latex', '--version']).then(r => r.exitCode === 0, () => false),
    $.process.run(['dvipng', '--version']).then(r => r.exitCode === 0, () => false),
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
  canDrawFigures ??= imagesOn($).then(async on => {
    if (!on) return false
    const tools = await Promise.all(
      ['pdflatex', 'pdftocairo'].map(tool => $.process.run([tool, '-v']).then(r => r.exitCode === 0, () => false)),
    )
    return tools.every(Boolean)
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

// Typesets one formula or figure to a tight transparent PNG, cached on disk by content.
function typesetSegment($: EngineInterface, segment: Drawn): Promise<Typeset | undefined> {
  const id = segment.kind === 'figure' ? `figure\u0000${segment.tex}` : `${segment.env}\u0000${segment.tex}`
  let pending = typeset.get(id)
  if (!pending) {
    pending = (segment.kind === 'figure' ? runTikz($, segment) : runLatex($, segment)).catch(() => undefined)
    typeset.set(id, pending)
  }
  return pending
}

async function runLatex($: EngineInterface, segment: Display): Promise<Typeset | undefined> {
  if (!isSafeTex(segment.tex)) return undefined
  const dir = await cache($)
  const { ink, paper } = await palette($)
  const fg = dvipngColor(ink) ?? 'rgb 0.9 0.9 0.9'
  const doc = texDocument(segment, settings.preamble, ink, paper)
  const dpi = dpiFor()
  const key = hashKey([VERSION, doc, fg, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const failed = `${dir}/${key}.err`

  if (await $.fs.exists(failed)) return undefined
  if (!(await $.fs.exists(png))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['latex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 15000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return undefined
    }
    const dvipng = await $.process.run(
      ['dvipng', '-q', '-D', String(dpi), '-T', 'tight', '-bg', 'Transparent', '-fg', fg, '-o', `${key}.png`, `${key}.dvi`],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.dvi`], { cwd: dir }).catch(() => undefined)
    if (dvipng.exitCode !== 0) {
      await $.fs.write(failed, dvipng.stderr || 'dvipng failed')
      return undefined
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
  if (!isSafeTex(segment.tex) || !(await figuresOn($))) return undefined
  const dir = await cache($)
  const { ink, paper } = await palette($)
  const doc = figureDocument(segment.tex, settings.preamble, ink, paper)
  const dpi = dpiFor()
  const key = hashKey([VERSION, doc, dpi].join('\u0000'))
  const png = `${dir}/${key}.png`
  const failed = `${dir}/${key}.err`

  if (await $.fs.exists(failed)) return undefined
  if (!(await $.fs.exists(png))) {
    await $.fs.write(`${dir}/${key}.tex`, doc)
    const latex = await $.process.run(
      ['pdflatex', '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `${key}.tex`],
      { cwd: dir, env: { openout_any: 'p', openin_any: 'p' }, timeoutMs: 30000 },
    )
    if (latex.exitCode !== 0) {
      await $.fs.write(failed, latexError(latex.stdout))
      return undefined
    }
    // pdftocairo names the picture itself, adding `.png` to the stem.
    const cairo = await $.process.run(
      ['pdftocairo', '-png', '-transp', '-singlefile', '-r', String(dpi), `${key}.pdf`, key],
      { cwd: dir, timeoutMs: 15000 },
    )
    await $.process.run(['rm', '-f', `${key}.aux`, `${key}.log`, `${key}.pdf`], { cwd: dir }).catch(() => undefined)
    if (cairo.exitCode !== 0) {
      await $.fs.write(failed, cairo.stderr || 'pdftocairo failed')
      return undefined
    }
  }
  return measure($, png)
}

// Pads (and if needed shrinks) a typeset formula or figure to a whole number
// of cells, so the terminal's scaling to the box keeps its proportions.
// Within `room` columns and, when given, `rowLimit` rows.
function fitId(segment: Drawn, room: number, rowLimit?: number): string {
  return `${segment.kind === 'figure' ? 'figure' : segment.env}\u0000${segment.tex}\u0000${room}\u0000${rowLimit ?? ''}`
}

function fit($: EngineInterface, segment: Drawn, room: number, rowLimit?: number): Promise<Picture | undefined> {
  const id = fitId(segment, room, rowLimit)
  let pending = fitted.get(id)
  if (!pending) {
    pending = padToCells($, segment, room, rowLimit).catch(() => undefined)
    pending.then(picture => ready.set(id, picture))
    fitted.set(id, pending)
  }
  return pending
}

async function padToCells($: EngineInterface, segment: Drawn, room: number, rowLimit?: number): Promise<Picture | undefined> {
  const base = await typesetSegment($, segment)
  if (!base) return undefined
  const cellW = ROW_PX / settings.cellAspect
  const tall = rowLimit === undefined ? 1 : (rowLimit * ROW_PX) / base.height
  const shrink = Math.min(1, (room * cellW) / base.width, tall)
  const width = Math.max(1, Math.round(base.width * shrink))
  const height = Math.max(1, Math.round(base.height * shrink))
  const columns = clamp(Math.ceil(width / cellW), 1, 255)
  const rows = clamp(Math.ceil(height / ROW_PX), 1, 255)
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
