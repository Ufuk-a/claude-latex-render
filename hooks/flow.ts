// Prose with inline math, cut into words for a wrapping row.
//
// Claude Code's own Markdown element still draws every word: a word keeps its
// formatting by being re-wrapped in the delimiters open around it (`**very
// important**` becomes `**very**` `**important**`), so bold, italics, code,
// strikethrough and links come out as the engine draws them. Only the cutting,
// and the list, heading and quote markers of a block that has inline math,
// are done here. A block without inline math is handed over whole.

import { inlineSpans, splitFences } from './latex'

export type Part = { kind: 'md'; text: string; width: number } | { kind: 'math'; tex: string }
/** One word: the pieces drawn side by side with no space between them. */
export type Token = Part[]
export type ProseBlock =
  | { kind: 'markdown'; text: string; gap: boolean }
  | { kind: 'flow'; tokens: Token[]; marker?: string; quote?: boolean; heading?: boolean; indent: number; gap: boolean }

type Style = { b: boolean; i: boolean; s: boolean; c: boolean; link?: string }
type Item = { ch: string; style: Style } | { math: string } | { space: true }

export function hasInlineMath(md: string): boolean {
  return splitFences(md).some(block => !block.isCode && inlineSpans(block.text).some(span => span.plain === undefined))
}

/** Every inline formula in a stretch of markdown, in order. */
export function inlineTexes(md: string): string[] {
  return splitFences(md).flatMap(block =>
    block.isCode ? [] : inlineSpans(block.text).filter(span => span.plain === undefined).map(span => span.tex),
  )
}

export function layoutProse(md: string): ProseBlock[] {
  const out: ProseBlock[] = []
  for (const block of splitFences(md)) {
    if (block.isCode) {
      out.push({ kind: 'markdown', text: block.text.replace(/\n+$/, ''), gap: true })
      continue
    }
    for (const para of block.text.split(/\n[ \t]*\n/)) {
      const text = para.replace(/^\s*\n/, '').replace(/\s+$/, '')
      if (!text.trim()) continue
      if (!hasInlineMath(text) || /^\s*\|/.test(text)) {
        out.push({ kind: 'markdown', text, gap: true })
        continue
      }
      paragraphItems(text).forEach((item, n) => {
        out.push({
          kind: 'flow',
          tokens: tokenize(item.text, item.heading === true),
          ...(item.marker ? { marker: item.marker } : {}),
          ...(item.quote ? { quote: true } : {}),
          ...(item.heading ? { heading: true } : {}),
          indent: item.indent,
          gap: n === 0,
        })
      })
    }
  }
  return out
}

type ParaItem = { text: string; indent: number; marker?: string; heading?: boolean; quote?: boolean }

function paragraphItems(text: string): ParaItem[] {
  const items: ParaItem[] = []
  for (const line of text.split('\n')) {
    const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line)
    const last = items[items.length - 1]
    if (list) {
      const mark = list[2]!
      items.push({ text: list[3]!, indent: list[1]!.length, marker: /^[-*+]$/.test(mark) ? '•' : mark })
    } else if (heading) {
      items.push({ text: heading[1]!, indent: 0, heading: true })
    } else if (quote) {
      if (last?.quote) last.text += ' ' + quote[1]!
      else items.push({ text: quote[1]!, indent: 0, quote: true })
    } else if (last && !last.heading) {
      last.text += ' ' + line.trim()
    } else {
      items.push({ text: line.trim(), indent: 0 })
    }
  }
  return items
}

const PUNCT = /[\s!-\/:-@\[-`{-~]/

/** Cuts one paragraph of inline markdown into words, each its formatting re-wrapped. */
export function tokenize(text: string, bold = false): Token[] {
  const spans = inlineSpans(text)
  const items: Item[] = []
  const style: Style = { b: bold, i: false, s: false, c: false }
  let linkEnd = -1
  let linkResume = -1
  let next = 0
  const lit = (ch: string, c = style.c) => items.push({ ch, style: { ...style, c } })

  for (let i = 0; i < text.length; ) {
    if (i === linkEnd) {
      delete style.link
      i = linkResume
      linkEnd = -1
      continue
    }
    const span = spans[next]
    if (span && span.start === i) {
      next++
      if (span.plain !== undefined) for (const ch of span.plain) lit(ch)
      else items.push({ math: span.tex })
      i = span.end
      continue
    }
    const ch = text[i]!
    const prev = i > 0 ? text[i - 1]! : ' '
    const after = text[i + 1] ?? ' '
    if (ch === '\\' && i + 1 < text.length && /[!-\/:-@\[-`{-~]/.test(after)) {
      lit(after)
      i += 2
    } else if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0]
      const close = text.indexOf(run, i + run.length)
      if (close < 0) {
        for (const c of run) lit(c)
        i += run.length
        continue
      }
      // A code span is one word: its spaces do not break it.
      for (const c of text.slice(i + run.length, close).replace(/^ (.*) $/, '$1')) lit(c === ' ' ? '\u00a0' : c, true)
      i = close + run.length
    } else if (text.startsWith('**', i) || (text.startsWith('__', i) && (PUNCT.test(prev) || PUNCT.test(text[i + 2] ?? ' ')))) {
      style.b = !style.b
      i += 2
    } else if (text.startsWith('~~', i)) {
      style.s = !style.s
      i += 2
    } else if (ch === '*' || (ch === '_' && (PUNCT.test(prev) || PUNCT.test(after)))) {
      style.i = !style.i
      i += 1
    } else if (ch === '[' && style.link === undefined) {
      const m = /^\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(text.slice(i))
      if (m) {
        style.link = m[2]!
        linkEnd = i + 1 + m[1]!.length
        linkResume = i + m[0].length
        i += 1
      } else {
        lit(ch)
        i += 1
      }
    } else if (/\s/.test(ch)) {
      items.push({ space: true })
      i += 1
    } else {
      lit(ch)
      i += 1
    }
  }

  const tokens: Token[] = []
  let token: Token = []
  let run = ''
  let runStyle: Style | undefined
  const flushRun = () => {
    if (run) token.push({ kind: 'md', text: wrap(run, runStyle!), width: textWidth(run) })
    run = ''
    runStyle = undefined
  }
  const flushToken = () => {
    flushRun()
    if (token.length > 0) tokens.push(token)
    token = []
  }
  for (const item of items) {
    if ('space' in item) flushToken()
    else if ('math' in item) {
      flushRun()
      token.push({ kind: 'math', tex: item.math })
    } else {
      if (runStyle && !sameStyle(runStyle, item.style)) flushRun()
      runStyle ??= item.style
      run += item.ch
    }
  }
  flushToken()
  return tokens
}

function sameStyle(a: Style, b: Style): boolean {
  return a.b === b.b && a.i === b.i && a.s === b.s && a.c === b.c && a.link === b.link
}

function wrap(run: string, style: Style): string {
  let out: string
  if (style.c) {
    out = run.includes('`') ? '`` ' + run + ' ``' : '`' + run + '`'
  } else {
    // Escaped only where an escape is both needed and removed by the engine's
    // renderer (it shows `\]`, `1\.`, `\=` and `\+` as written). A run that would
    // open as a block (`+ x`, `# x`) is guarded where runs are drawn, in register.tsx.
    out = run.replace(/[\\`*_[<>|~]/g, c => '\\' + c)
  }
  if (style.s) out = `~~${out}~~`
  if (style.i) out = `*${out}*`
  if (style.b) out = `**${out}**`
  if (style.link) out = `[${out}](${style.link})`
  return out
}

/** Terminal columns a string takes: wide East Asian and emoji 2, combining marks 0. */
export function textWidth(text: string): number {
  let width = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (/\p{Mn}|\p{Me}|​|‍|️/u.test(ch)) continue
    width += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
      ? 2
      : 1
  }
  return width
}
