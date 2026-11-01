"""Measures how a recording scrolls, frame to frame, to catch snap-backs.

usage: python3 scroll_check.py raw.mp4 [start_s] [end_s]
For each pair of consecutive frames it finds the vertical shift (in pixels)
that best lines the transcript area up: positive = content moved down (the
view scrolled up, toward older text), negative = it jumped back toward the
bottom. Prints every frame's shift and flags the backward jumps.
"""
import subprocess
import sys

import numpy as np

path = sys.argv[1]
start = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
end = float(sys.argv[3]) if len(sys.argv) > 3 else 1e9
W, H = 1464, 1032
TOP, BOTTOM = 0, 880  # the transcript area, above the prompt and footer

raw = subprocess.run(
    ['ffmpeg', '-loglevel', 'error', '-ss', str(start), '-to', str(end), '-i', path,
     '-vf', f'crop={W}:{H}:0:0,format=gray', '-f', 'rawvideo', '-'],
    capture_output=True, check=True,
).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W)[:, TOP:BOTTOM, :].astype(np.float32)
fps = 15


def shift(a, b, limit=400):
    """Shift s (pixels) so that b[y] ~ a[y - s]: positive when content moved down."""
    pa, pb = a.mean(axis=1), b.mean(axis=1)
    pa, pb = pa - pa.mean(), pb - pb.mean()
    best, best_s = None, 0
    for s in range(-limit, limit + 1):
        if s >= 0:
            x, y = pa[: len(pa) - s], pb[s:]
        else:
            x, y = pa[-s:], pb[: len(pb) + s]
        if len(x) < 200:
            continue
        err = float(np.mean((x - y) ** 2))
        if best is None or err < best:
            best, best_s = err, s
    return best_s


total = 0
for i in range(1, len(frames)):
    if np.abs(frames[i] - frames[i - 1]).mean() < 0.05:
        continue  # nothing changed
    s = shift(frames[i - 1], frames[i])
    total += s
    t = start + i / fps
    flag = '  <-- BACK toward the bottom' if s < -15 else ''
    print(f'{t:6.2f}s shift {s:+5d}px  cumulative {total:+6d}{flag}')
