"""
The Sol performance panel (r5-panel-sol-perf.png): the r5-panel-sol tiles with each one's cost over it, from the
harness's timings of that exact framing (panel5.results.json, best of the runs given) and the cold compile times the
lab measured in Chrome (compile-times-r5.json).

    python panel5perf.py <out dir> <panel5.results.json> [more results files...]
"""

import json
import os
import subprocess
import sys

here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1]
# Best of the runs given
ms = {}
for f in sys.argv[2:]:
    for l in json.load(open(f, encoding='utf8')):
        if 'ms' in l:
            ms[l['id']] = min(ms.get(l['id'], 1e9), l['total'])
compile_ms = {k: v['ms'] for k, v in json.load(open(os.path.join(out, 'compile-times-r5.json'), encoding='utf8')).items()}

PANEL = [
    ('cur', 'Current (original)'), ('plasma4@0.5', 'R4 plasma, ½ res (reference)'), ('plasma5', 'R5 plasma, full res'),
    ('plasma5@0.5', 'R5 plasma, ½ res'), ('plasma5@0.33', 'R5 plasma, ⅓ res (proposed Low)'), ('plasma5.low@0.5', 'R5 low, ½ res (proposed Low)'),
    ('plasma5.rainbow@0.5', 'R5 rainbow, ½ res'), ('plasma5.aurora@0.5', 'R5 aurora, ½ res'), ('plasma5.lite', 'R5 lite (kept, not a candidate)'),
]


def program_of(variant):
    look = variant.split('@')[0]
    if look == 'cur':
        return None
    base = 'plasma5' if look.startswith('plasma5') else 'plasma4'
    return base + ('.lite' if '.lite' in look else '.low' if '.low' in look else '')


def vs(base, t):
    k = base / t
    return 'about the same as current' if 0.9 < k < 1.1 else f'{k:.1f}× cheaper than current' if k >= 1 else f'{1 / k:.1f}× more expensive than current'


cells = []
for variant, label in PANEL:
    a, b = ms[f'panel|{variant}|1'], ms[f'panel|{variant}|2']
    res = {'0.5': '½ res', '0.33': '⅓ res'}.get(variant.split('@')[1], variant.split('@')[1]) if '@' in variant else 'full res'
    if variant == 'cur':
        comp = f"compile {compile_ms['sun.cur']:,} ms (disc) + glow, rays"
        note = [f'{a:.3f} ms at 1080p · {b:.3f} ms at 4K', 'the baseline', comp, 'full res (3 quads: glow, rays, disc)']
    else:
        ca, cb = ms['panel|cur|1'], ms['panel|cur|2']
        note = [f'{a:.3f} ms at 1080p · {b:.3f} ms at 4K', f'{vs(ca, a)} (1080p) · {vs(cb, b)} (4K)'.replace(' than current (1080p)', ' (1080p)'),
                f"compile {compile_ms[program_of(variant)]} ms", res + ' (1 quad)']
    cells.append({'file': f'panel5/sol.{variant}.png', 'label': label, 'note': note})

scenes = {
    'programs': {}, 'textures': {}, 'jobs': [],
    'composites': [{
        'out': 'r5-panel-sol-perf.png', 'cols': 3, 'cells': cells, 'noteSize': 18,
        'title': 'Sol, the whole sun, with each option\'s cost for this view (sun, glow and corona; 1920×1080 and 3840×2160).',
        'footnote': 'Method: native OpenGL GPU timer queries (moderngl) on an RTX 5070 Ti, best of two runs of 5×10 draws; compile: cold, Chrome (ANGLE/D3D11), fresh profile.',
    }],
}
path = os.path.join(out, 'panel5perf.json')
json.dump(scenes, open(path, 'w', encoding='utf8'))
subprocess.run([sys.executable, os.path.join(here, 'harness.py'), path, out], check=True)
