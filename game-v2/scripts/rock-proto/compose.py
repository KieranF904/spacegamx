"""
The asteroid harness's before/after panels: each scene's two stills (scenes.ts `stills`) cropped alike and set side by
side, 4 px apart, nothing drawn on them (docs/panels/README.md).

    python compose.py <stills dir> <panels dir>
"""

import os
import sys

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
# scene: (panel name, crop box in the 1280 x 800 still)
PANELS = {
    'close': ('close-rock', (280, 40, 1000, 760)),
    'close-ice': ('close-ice', (280, 40, 1000, 760)),
    'rich': ('rich-ore', (280, 40, 1000, 760)),
    'belt': ('dense-belt', (0, 0, 1280, 800)),
    'glasswater': ('glasswater', (0, 0, 1280, 800)),
    'taenite-pair': ('taenite-pair', (60, 120, 1140, 680)),
    'taenite-belt': ('taenite-belt', (0, 0, 1280, 800)),
}
for scene, (name, box) in PANELS.items():
    if not os.path.exists(os.path.join(src, f'{scene}-before.png')):
        continue
    a = Image.open(os.path.join(src, f'{scene}-before.png')).crop(box)
    b = Image.open(os.path.join(src, f'{scene}-after.png')).crop(box)
    a.save(os.path.join(dst, f'{name}-before.png'))
    b.save(os.path.join(dst, f'{name}-after.png'))
    both = Image.new('RGB', (a.width * 2 + 4, a.height), (24, 26, 32))
    both.paste(a, (0, 0))
    both.paste(b, (a.width + 4, 0))
    both.save(os.path.join(dst, f'{name}.png'))
    print(os.path.join(dst, f'{name}.png'))
