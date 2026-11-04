"""
Contact sheets for the custom enemy roster (DESIGN ONLY), from the stills scripts/bespoke/enemies/render.mjs wrote.
Nothing is drawn on them (docs/panels/README.md): the panel entries say what is where.

  <id>.png              one design: the live grid enemy it replaces (if any), the design intact, the design damaged
  roster.png            every design intact, in docs/enemies/custom-roster.md's order
  roster-damaged.png    every design damaged, same order
  play-zoom.png         every design as big as it is on screen: at the game's default zoom (top) and zoomed out (bottom)
  <id>-v1-vs-v2.png     a reworked design: its first draft (v1-<id>-after/-damaged) over the rework (after, damaged)

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

# At flight zoom: not resized, as big as they are on screen
plays = [Image.open(os.path.join(D, f'{id}-play.png')).convert('RGB') for id in ORDER]
fars = [Image.open(os.path.join(D, f'{id}-far.png')).convert('RGB') for id in ORDER]
pw, fw = plays[0].size[0], fars[0].size[0]
M = Image.new('RGB', (len(ORDER) * (pw + GAP) + GAP, pw + fw + 3 * GAP), BG)
for i, (p, f) in enumerate(zip(plays, fars)):
    x = GAP + i * (pw + GAP)
    M.paste(p, (x, GAP)); M.paste(f, (x + (pw - fw) // 2, pw + 2 * GAP))
M.save(os.path.join(D, 'play-zoom.png'), optimize=True)
print('play-zoom.png', M.size)
# The reworked ones, first draft over rework
for id in ORDER:
    v1 = [os.path.join(D, f'v1-{id}-{s}.png') for s in ('after', 'damaged')]
    if all(os.path.exists(p) for p in v1):
        sheet(v1 + [os.path.join(D, f'{id}-{s}.png') for s in ('after', 'damaged')], 2, 600, os.path.join(D, f'{id}-v1-vs-v2.png'))
