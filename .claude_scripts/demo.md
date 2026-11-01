# A tour of $\mathcal{L}$aTeX in the terminal

## Inline math inside formatting

**Bold with math: the Euler identity $e^{i\pi}+1=0$ inside a bold sentence.** *Italics with $\hat{H}\lvert\psi\rangle = E\lvert\psi\rangle$ in the middle.* A [link next to math](https://en.wikipedia.org/wiki/Residue_theorem) right before $\oint_\gamma f\,dz = 2\pi i\sum_k \operatorname{Res}_{z_k} f$, with punctuation hugging it: ($\alpha$), [$\beta$]; and $\delta$! `Code with $x$ inside` stays raw, and the prices $5 and $10 stay prices.

Tall inline: $\frac{\partial^2 u}{\partial t^2} = c^2 \nabla^2 u$, a continued fraction $1+\cfrac{1}{1+\cfrac{1}{1+\cdots}}$, a binomial $\binom{n}{k}$, an inline matrix $\left(\begin{smallmatrix} a & b \\ c & d \end{smallmatrix}\right)$, and limits $\lim_{n\to\infty}\left(1+\tfrac{1}{n}\right)^n = e$.

## Lists with $\mathbb{R}^n$ in the heading

- Sets: $\mathbb{N}\subset\mathbb{Z}\subset\mathbb{Q}\subset\mathbb{R}\subset\mathbb{C}$
- Fraktur and script: $\mathfrak{g}=\mathfrak{su}(2)$, $\mathscr{F}$, $\mathcal{O}(n\log n)$
  - nested: $\vec{F} = -\nabla V$, $\dot{x}$, $\ddot{x}$, $\overline{z}$, $\widetilde{xyz}$
1. Ordered: $\aleph_0 < 2^{\aleph_0}$
2. Dirac and cancel: $\braket{\psi|\phi}$, $\cancel{x}\,y$

> The sophomore's dream: $\int_0^1 x^{x}\,dx = \sum_{n\ge1}(-1)^{n+1}n^{-n}$.

## Display math

$$
|x| = \begin{cases} x, & x \ge 0 \\ -x, & x < 0 \end{cases}
\qquad
\underbrace{1 + 2 + \cdots + n}_{n \text{ terms}} = \overbrace{\frac{n(n+1)}{2}}^{\text{Gauss}}
$$

$$
\begin{aligned}
\int_{-\infty}^{\infty} e^{-x^2}\,dx
  &\xrightarrow{\ \text{square}\ } \iint_{\mathbb{R}^2} e^{-(x^2+y^2)}\,dx\,dy \\
  &\overset{\text{polar}}{=} \int_0^{2\pi}\!\!\int_0^\infty e^{-r^2}\, r\,dr\,d\theta = \boxed{\pi}
\end{aligned}
$$

$$
\det\begin{pmatrix} \lambda - a & -b \\ -c & \lambda - d \end{pmatrix} = 0,
\qquad
\nabla\times\mathbf{B} = \mu_0\mathbf{J} + \mu_0\varepsilon_0\frac{\partial\mathbf{E}}{\partial t}
$$

## TikZ

```tikz
\begin{tikzcd}
  & A \arrow[r] \arrow[d, "\alpha"] & B \arrow[r] \arrow[d, "\beta"] & C \arrow[r] \arrow[d, "\gamma"] & 0 \\
  0 \arrow[r] & A' \arrow[r] & B' \arrow[r] & C' &
\end{tikzcd}
```

```tikz
\begin{axis}[view={50}{35}, colormap/viridis, width=9cm, height=6cm, xlabel=$x$, ylabel=$y$]
  \addplot3[surf, domain=-3:3, samples=25, shader=interp] {sin(deg(x))*cos(deg(y))};
\end{axis}
```
