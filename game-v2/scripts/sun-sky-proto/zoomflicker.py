"""Flicker in a zoom sweep (scenes.ts set `zoomsweep`): each frame scaled about the screen's middle to the next frame's
zoom and compared with it, in a band round the limb (the middle column). What's left is change that isn't the zoom's
own scaling: the edge's pattern re-rolling, popping or aliasing. Mean absolute difference, 0-255, per variant.
    python scripts/sun-sky-proto/zoomflicker.py <out dir> [star ...]
"""
import sys, os, math
from PIL import Image
import numpy as np

out = sys.argv[1]
stars = sys.argv[2:] or ['sol', 'borealis', 'nebula_prime', 'cinder_reach']
N = 48
zooms = [0.04 * (2 / 0.04) ** (f / (N - 1)) for f in range(N)]
zooms = zooms + zooms[::-1]
for star in stars:
    row = []
    for variant in ['plasma5@0.5', 'ship@0.5']:
        diffs = []
        for f in range(len(zooms) - 1):
            a = Image.open(os.path.join(out, 'zoomsweep', f'{star}.{variant}.{f}.png')).convert('RGB')
            b = np.asarray(Image.open(os.path.join(out, 'zoomsweep', f'{star}.{variant}.{f + 1}.png')).convert('RGB'), dtype=np.float32)
            k = zooms[f + 1] / zooms[f]
            w, h = a.size
            big = a.resize((max(1, round(w * k)), max(1, round(h * k))), Image.BICUBIC)
            bw, bh = big.size
            x0, y0 = (bw - w) // 2, (bh - h) // 2
            if k >= 1:
                a2 = np.asarray(big.crop((x0, y0, x0 + w, y0 + h)), dtype=np.float32)
                region = (slice(20, h - 20), slice(w // 2 - 40, w // 2 + 40))
            else:
                a2 = np.zeros((h, w, 3), np.float32)
                a2[-y0:-y0 + bh, -x0:-x0 + bw] = np.asarray(big, dtype=np.float32)
                region = (slice(-y0 + 20, -y0 + bh - 20), slice(w // 2 - min(40, bw // 2 - 2), w // 2 + min(40, bw // 2 - 2)))
            diffs.append(float(np.abs(a2[region] - b[region]).mean()))
        d = np.array(diffs)
        row.append(f'{variant}: mean {d.mean():.2f}  p95 {np.percentile(d, 95):.2f}  max {d.max():.2f}')
    print(f'{star:14s} ' + '   '.join(row))
