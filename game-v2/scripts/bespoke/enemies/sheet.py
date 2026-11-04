"""
Contact sheets for the custom enemy roster (DESIGN ONLY), from the stills scripts/bespoke/enemies/render.mjs wrote.
Nothing is drawn on them (docs/panels/README.md): the panel entries say what is where.

  <id>.png              one design: the live grid enemy it replaces (if any), the design intact, the design damaged
  roster.png            every design intact, in docs/enemies/custom-roster.md's order
  roster-damaged.png    every design damaged, same order

  python scripts/bespoke/enemies/sheet.py [dir]   (dir default docs/panels/2026-11-04/enemies)
"""
import json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
D = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'docs', 'panels', '2026-11-04', 'enemies')
ORDER = ['scrap_crawler', 'rivet_sower', 'slag_ray', 'clinker', 'censer', 'maw_lurker', 'hookboat', 'rime_bell']
GAP, BG = 8, (10, 11, 14)


def tile(path, size, crop=0.06):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    c = int(w * crop)
    return im.crop((c, c, w - c, h - c)).resize((size, size), Image.LANCZOS)


def sheet(paths, cols, size, out):
    rows = (len(paths) + cols - 1) // cols
    M = Image.new('RGB', (cols * size + (cols + 1) * GAP, rows * size + (rows + 1) * GAP), BG)
    for i, p in enumerate(paths):
        M.paste(tile(p, size), (GAP + (i % cols) * (size + GAP), GAP + (i // cols) * (size + GAP)))
    M.save(out, optimize=True)
    print(os.path.basename(out), M.size)


for id in ORDER:
    shots = [f'{id}-before.png', f'{id}-after.png', f'{id}-damaged.png']
    paths = [os.path.join(D, s) for s in shots if os.path.exists(os.path.join(D, s))]
    sheet(paths, len(paths), 720, os.path.join(D, f'{id}.png'))
sheet([os.path.join(D, f'{id}-after.png') for id in ORDER], 4, 600, os.path.join(D, 'roster.png'))
sheet([os.path.join(D, f'{id}-damaged.png') for id in ORDER], 4, 600, os.path.join(D, 'roster-damaged.png'))
