import { describe, expect, test } from 'claude-code/testing'
import { layoutProse, tokenize } from './flow'

const words = (text: string) => tokenize(text).map(t => t.map(p => (p.kind === 'md' ? p.text : `<${p.tex}>`)).join(''))

describe('flow', () => {
  test('formatting is re-wrapped per word', async () => {
    expect(words('a **very important** *thing* with `x y` and [two words](https://x.org)')).toEqual([
      'a', '**very**', '**important**', '*thing*', 'with', '`x\u00a0y`', 'and', '[two](https://x.org)', '[words](https://x.org)',
    ])
  })
  test('math sticks to punctuation around it', async () => {
    expect(words('so ($\\frac{a}{b}$), and $x$.')).toEqual(['so', '(<\\frac{a}{b}>),', 'and', '<x>.'])
  })
  test('a number as math is text, a price is not math, snake_case stays', async () => {
    expect(words('$0$ costs $5 and $10 in my_var')).toEqual(['0', 'costs', '$5', 'and', '$10', 'in', 'my\\_var'])
  })
  test('lists and headings get their markers', async () => {
    const blocks = layoutProse('## Title $x$\n\n- one $a$\n- two\n  more\n\nplain text')
    expect(blocks.map(b => (b.kind === 'flow' ? `${b.marker ?? ''}|${b.tokens.length}|${b.gap}` : `md:${b.text}`))).toEqual([
      '|2|true', '•|2|true', '•|2|false', 'md:plain text',
    ])
  })
  test('block markers are left to the row drawing (the engine shows \\= as written)', async () => {
    expect(words('step 1. then - and # x = y + z [$y$]')).toEqual(['step', '1.', 'then', '-', 'and', '#', 'x', '=', 'y', '+', 'z', '\\[<y>]'])
  })
})
