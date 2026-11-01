"""Diffs two folders of same-named screenshots (scroll_perf.sh SHOTS mode).

usage: python3 diff_shots.py DIR_A DIR_B
Prints, per shot, the share of pixels that differ in the transcript area and
the rows (in pixels) where they do, so a blank or shifted region shows up.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

a_dir, b_dir = Path(sys.argv[1]), Path(sys.argv[2])
TOP, BOTTOM = 0, 900  # transcript area, above the prompt and footer
for a in sorted(a_dir.glob('*.png')):
    b = b_dir / a.name
    if not b.exists():
        print(a.name, 'missing in', b_dir)
        continue
    x = np.asarray(Image.open(a).convert('L'), np.int16)[TOP:BOTTOM]
    y = np.asarray(Image.open(b).convert('L'), np.int16)[TOP:BOTTOM]
    d = np.abs(x - y) > 24
    rows = np.where(d.any(axis=1))[0]
    span = f'rows {rows.min()}-{rows.max()}' if len(rows) else ''
    print(f'{a.name}: {100 * d.mean():.3f}% differ {span}')
