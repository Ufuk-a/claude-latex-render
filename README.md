# claude-latex-render

A Claude Code mod that typesets the LaTeX in Claude's replies, right in the terminal: display math, inline math and TikZ figures, drawn as crisp images while the reply is still being written.

![Claude Code in Ghostty streaming a LaTeX tour: inline math typeset inside bold and italic sentences, a continued fraction and a binomial in running text, lists with blackboard-bold and script letters, display math (cases, underbraces, an aligned Gaussian-integral derivation, a determinant), a tikz-cd diagram and a pgfplots surface, each appearing typeset as soon as it is written; then a scroll back to the top](assets/demo.gif)

## What it does

- **Display math** (`$$…$$`, `\[…\]`, `equation`, `align`, `gather`, …) is typeset with `latex` + `dvipng` and drawn as an image through the kitty graphics protocol.
- **Inline math** (`$…$`, `\(…\)`) is typeset too and drawn inside the line, on the same baseline as the terminal's text. Bold, italics, code and links around it keep their formatting.
- **TikZ figures** (a ` ```tikz ` fenced block, or a bare `tikzpicture` or `tikzcd` environment) are compiled with `pdflatex` + `pdftocairo`. A fence may hold bare commands (`\draw …;`). `pgfplots`, `tikz-cd` and the common TikZ libraries are loaded. On a dark theme `black` is the theme's ink, `white` and tints like `blue!20` turn dark, and named colors too dim for the background are lightened.
- **Live and in place.** Each text block is typeset while it streams, in the spot where the reply is being written; raw LaTeX never shows. A formula still being written appears once it is complete.
- **Sharp at any size.** Pictures are made at exactly the terminal's cell size, read from the terminal itself, so the terminal never rescales them.
- **Compact lines.** A tall inline formula (a fraction, a binomial) takes the rows above and below its line only where they are free, may shrink slightly or sit slightly off the baseline to spare a row, and leaves a little air around itself.
- **Mistakes show as written.** A formula that fails to compile is shown exactly as Claude wrote it, in the theme's error color, ready to copy.
- **Fallbacks.** Without image support (tmux, ssh, other terminals) math is converted to Unicode: `$\forall x \in \mathbb{R}$` becomes `∀x ∈ ℝ`, `$x_{n+1}^2$` becomes `xₙ₊₁²`. Code blocks, inline code and prices like `$5 and $10` are left alone.
- **Claude is told how to write for it.** A short section in the system prompt asks for `$…$` and `$$…$$` math, ` ```tikz ` figures and colors that read on the theme, and says what the terminal can and cannot show.

## Install

```
/plugin install latex-render --marketplace Ufuk-a/claude-latex-render
```

Answer `y` to add the marketplace, then pick the user scope to have it in every session.

## Requirements

- Claude Code with mods (function hooks).
- A terminal with the kitty graphics protocol: kitty, Ghostty or WezTerm. Inside tmux or over ssh, math falls back to Unicode text.
- `latex` and `dvipng` (TeX Live: `texlive-scheme-basic` plus `dvipng`), with `amsmath`, `amssymb`, `mathtools`, `bm`, `mathrsfs`, `cancel`, `braket` and `preview`.
- For figures, `pdflatex` and `pdftocairo` (poppler-utils), with `pgfplots` and `tikz-cd`.
- ImageMagick (`magick`), which fits each picture to whole terminal cells.
- `python3`, which reads the terminal's cell size.

Without `latex` or `dvipng` the mod still converts all math to Unicode.

Fullscreen mode (`"tui": "fullscreen"`) is where it works best: there each finished block stays exactly where it streamed. Outside fullscreen it works too, with the finished block drawn by Claude Code in the usual place.

## Rendered or as written

`/latex` flips every reply between rendered and the LaTeX as Claude wrote it, ready to copy; `/latex source` and `/latex render` set it directly. While source is on, the status line says so. It works mid-reply and lasts for the session.

LaTeX inside an ordinary code block (` ```latex `, ` ```tex `) is never rendered, so asking Claude for LaTeX code to paste gets code either way.

## Settings

In `/config`:

| Setting | Default | What it does |
| --- | --- | --- |
| `images` | `auto` | `auto` draws pictures in kitty, Ghostty and WezTerm outside tmux/ssh; `on` always; `off` Unicode only |
| `preview` | `on` | `on`: each text block streams typeset, in place; `off`: the reply streams raw and is typeset when its block ends |
| `inlineImages` | `on` | `on`: inline math typeset in the line; `off`: inline math as Unicode |
| `displayAlign` | `left` | `left`: display math and figures at the left margin; `center`: centred across the reply |
| `scale` | `1.25` | Terminal rows one line of display math takes |
| `inlineScale` | `1` | Size of inline formulas relative to the terminal text |
| `inlineBaseline` | `0.8` | Where the font's baseline sits in a cell, as a fraction of its height from the top; nudge it if inline formulas sit high or low |
| `color` | `auto` | Formula color as hex (`#e6e6e6`), or `auto` to follow the light or dark theme |
| `background` | `auto` | On a dark theme, the terminal background as hex, which figures' `white` and tints become (`auto` is `#1e1e1e`) |
| `cellAspect` | `2.1` | Cell height ÷ width, used only where the terminal's cell size cannot be read |
| `preamble` | empty | Extra LaTeX preamble, e.g. `\usepackage{physics}` |

Rendered formulas and figures are cached in `~/.cache/claude-latex-render/`, along with the reason for any that failed (`.err` files).

## How it works

Claude Code draws a text block that is still streaming in a way no mod can reach, so the mod holds each text block back from the engine until the block ends, passing everything on unchanged, only later. While it is held, the block is drawn typeset in a row placed in the transcript where the reply is being written. At the block's end every picture is ready, the text is released whole (the transcript keeps exactly what Claude wrote), and in fullscreen the placed row goes on showing the finished block.

Prose with inline math is cut into words, each drawn by Claude Code's own Markdown element with its formatting re-wrapped around it, and the lines are packed onto the terminal's cell grid. A formula taller than one row is cut into one-row strips, so it scrolls and clips like text.

## Safety

LaTeX can read any file it can name, even with `openin_any=p`. Formulas and figures that use file or macro primitives (`\input`, `\read`, `\write`, `\catcode`, `\csname`, `\def`, `^^` escapes, …) are never compiled; they are shown as written. `latex` and `pdflatex` run with `-no-shell-escape` and `openout_any=p`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` holds the streaming hold-back (`turn.step`), the live row (`ui.render` on `Placed`), the drawing of finished blocks (`AssistantMessage`), the line packing and the typesetting; `hooks/flow.ts` cuts prose with inline math into words that keep their formatting; `hooks/latex.ts` holds the parsing, Unicode conversion and document building.

`.claude_scripts/record_demo.sh` records the demo above in a real Ghostty on a virtual display; `.claude_scripts/scroll_check.py` measures a recording's scrolling frame by frame.

## Credits and license

Builds on [arthgirard/claude-latex-render](https://github.com/arthgirard/claude-latex-render), by way of [Ramlaoui/claude-latex-render](https://github.com/Ramlaoui/claude-latex-render). MIT.
