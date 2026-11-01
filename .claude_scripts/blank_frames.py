"""Counts frames of a scroll recording with a tall blank band in the transcript.

usage: python3 blank_frames.py video.mp4 [band_px]
A band is a run of pixel rows, in the transcript area, with no ink at all; one
taller than band_px (default 170, about 8 text rows) is more than the reply's
own spacing, so it is rows the windowing has not drawn yet.
"""
import subprocess, sys
import numpy as np

path, band = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 170
W, H, TOP, BOTTOM = 1480, 1060, 30, 900
raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-vf', 'format=gray', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W)[:, TOP:BOTTOM, 20:1460]
bad = []
for i, f in enumerate(frames):
    bg = np.median(f)
    inked = (np.abs(f.astype(np.int16) - bg) > 30).any(axis=1)
    run = best = 0
    for v in inked:
        run = 0 if v else run + 1
        best = max(best, run)
    if best > band:
        bad.append((i, best))
print(f'{len(frames)} frames, {len(bad)} with a blank band over {band}px')
for i, b in bad[:20]:
    print(f'  frame {i} ({i / 30:.2f}s): {b}px')
