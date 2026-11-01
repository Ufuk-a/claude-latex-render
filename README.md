# claude-latex-render

> **This fork** (of [Ramlaoui/claude-latex-render](https://github.com/Ramlaoui/claude-latex-render), itself a fork of [arthgirard/claude-latex-render](https://github.com/arthgirard/claude-latex-render)) renders math **in place while Claude is still writing**, typesets **inline math as images** too, and lays text and formulas out on the terminal's own cell grid. What it changes:
>
> - **Live, in-place streaming.** Claude Code draws a text block that is still streaming without any hook a mod can reach, so raw LaTeX used to flash by until the block ended. This fork holds each text block back from the engine (the engine's own block-start item included, passed on unchanged, only later) and draws it, typeset, in a row placed in the transcript where the reply is being written. It scrolls like any reply. At the block's end the text is released whole (the transcript keeps exactly what Claude wrote), every picture is already made, and the finished block takes the row's place. A formula still being written simply is not shown until it closes.
> - **Inline math as images.** `$…$` is typeset by LaTeX in text style and drawn inside the line, baseline-aligned with the terminal font. Words are still drawn by Claude Code's own Markdown element, each re-wrapped in the formatting around it, so bold, italics, code and links keep working.
> - **Cell packing.** Lines with inline math are broken by the mod and packed onto a grid: each line sits as high as it fits, a tall formula reaching into rows above and below wherever those cells are free (paragraph gaps included), so a fraction does not space out the whole paragraph. A formula may shrink a little or sit a little off the baseline to spare a row, scored per formula. Tall formulas are cut into one-row strips, so they scroll and clip like text.
> - **Native pixels.** The terminal's real cell size is read from its pty, and every picture is made at exactly that size, so the terminal never rescales (and blurs) it. Shrunk formulas are typeset again at their final size rather than resampled.
> - **Failed LaTeX shows as written**, in the theme's error color, copyable. `mathrsfs`, `cancel` and `braket` are loaded.
>
> The demo below is the upstream version (with its preview strip, which this fork replaces).

A Claude Code mod that renders LaTeX math and TikZ figures in Claude's replies, right in the terminal.

![Claude deriving the Fourier series of a square wave: the reply streams in with a live LaTeX preview, then shows typeset equations, a pgfplots figure of the first three partial sums with the Gibbs overshoot, and a tikz-cd square for the convolution theorem; /latex switches it to source and back](assets/demo.gif)

- **Display math** (`$$…$$`, `\[…\]`, `equation`, `align`, `gather`, …) is typeset with `latex` + `dvipng` and drawn as a crisp image through the kitty graphics protocol.
- **TikZ figures** (a ` ```tikz ` fenced block, or a bare `tikzpicture` or `tikzcd` environment) are compiled with `pdflatex` + `pdftocairo` and drawn the same way. A fence may hold bare commands (`\draw …;`), which are wrapped in a `tikzpicture`. `pgfplots`, `tikz-cd` and the common TikZ libraries are loaded. On a dark theme `black` is the theme's ink and `white`, along with tints like `blue!20`, turns dark. Named colors too dim for a dark background (`blue`, `navy`, `violet`, `purple`, `brown`, `teal`, `darkgray`, …) are lightened; `navy`, `darkblue`, `maroon` and the other lowercase SVG names are defined on either theme.
- **Inline math** (`$…$`, `\(…\)`) is typeset as images inside the line where pictures can be drawn, and converted to Unicode elsewhere: `$\forall x \in \mathbb{R}$` becomes `∀x ∈ ℝ`, `$x_{n+1}^2$` becomes `xₙ₊₁²`.
- Code blocks, inline code and prices like `$5 and $10` are left alone.
- **Live, in place.** The reply streams typeset where it is being written; raw LaTeX never shows.
- Anything that fails to compile is shown as written, in the error color. A terminal without image support gets Unicode text (figures as their TikZ code).
- **Claude is told how to write for it.** A section added to the system prompt in terminal sessions asks for `$…$` and `$$…$$` math, ` ```tikz ` figures, bare numbers as plain text (`0` rather than `$0$`, though both show as `0`), and named colors that read on the theme. It follows the settings: without image support Claude is told math shows as text.

## Install

```
/plugin install latex-render --marketplace Ufuk-a/claude-latex-render
```

Answer `y` to add the marketplace, then pick the user scope to have it in every session.

## Requirements

- A terminal with the kitty graphics protocol: kitty, Ghostty or WezTerm. Inside tmux or over ssh, display math falls back to Unicode text.
- `latex` and `dvipng` on `PATH` (TeX Live: `texlive-scheme-basic` plus `dvipng`, or your distribution's equivalents), with `amsmath`, `amssymb`, `mathtools` and `bm`.
- For figures, `pdflatex` and `pdftocairo` (poppler-utils), with `pgfplots` and `tikz-cd`.
- ImageMagick (`magick`), optional: pads each picture to whole terminal cells so it keeps its proportions.

Without `latex` or `dvipng` the mod still converts all math to Unicode.

## Rendered or as written

`/latex` flips every reply between rendered and the LaTeX as Claude wrote it (`$$…$$`, `\begin{tikzpicture}`, …), ready to copy; `/latex source` and `/latex render` set it directly. While source is on, the status line says so. It works mid-reply and lasts for the session.

LaTeX inside an ordinary code block (` ```latex `, ` ```tex `) is never rendered, so asking Claude for LaTeX code to paste gets code either way.

## Settings

In `/config`:

| Setting | Default | What it does |
| --- | --- | --- |
| `images` | `auto` | `auto` draws pictures in kitty, Ghostty and WezTerm outside tmux/ssh; `on` always; `off` Unicode only |
| `color` | `auto` | Formula color as hex (`#e6e6e6`), or `auto` to follow the light or dark theme |
| `scale` | `1.25` | Terminal rows one line of LaTeX takes |
| `cellAspect` | `2.1` | Cell height ÷ width, used only where the terminal's cell size cannot be read; raise it if formulas look squashed, lower it if stretched |
| `preamble` | empty | Extra LaTeX preamble, e.g. `\usepackage{physics}` |
| `preview` | `on` | `on`: each text block streams typeset, in place; `off`: the reply streams raw and is typeset when its block ends |
| `inlineImages` | `on` | `on`: inline math typeset as images in the line; `off`: inline math as Unicode |
| `inlineScale` | `1` | Size of inline formulas relative to the terminal text |
| `inlineBaseline` | `0.8` | Where the font's baseline sits in a cell, as a fraction of its height from the top |
| `background` | `auto` | On a dark theme, the terminal background as hex, which figures' `white` and tints become (`auto` is `#1e1e1e`) |

Rendered formulas and figures are cached in `~/.cache/claude-latex-render/`.

## Safety

LaTeX can read any file it can name, even with `openin_any=p`. Formulas and figures that use file or macro primitives (`\input`, `\read`, `\write`, `\catcode`, `\csname`, `\def`, `^^` escapes, …) are never compiled and are shown as Unicode instead. `latex` and `pdflatex` run with `-no-shell-escape` and `openout_any=p`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/register.tsx` holds the streaming hold-back (`turn.step`), the live row (`ui.render` on `Placed`), the drawing of finished blocks (`AssistantMessage`), the cell packing and the typesetting; `hooks/flow.ts` cuts prose with inline math into words that keep their formatting; `hooks/latex.ts` holds the parsing, Unicode conversion and document building. `hooks/stream.test.tsx` streams a reply through the mod and watches the live row; `hooks/flow.test.ts` covers the word cutting.

## License

MIT
