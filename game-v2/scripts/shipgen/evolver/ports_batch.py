# Evolve every ports scenario (ports_scenarios.json) side by side, each in its own process with its own scorer, and
# write a gallery: prototypes/energy-lab/evolved/index.html lists each scenario's best ship (a picture, its numbers and
# a link that opens it live in the lab), and evolved/<scenario>.json is the ship itself. Each run's folder
# (out/ports-batch-<stamp>/) keeps best.json, lab.json and the score curve.
#   python ports_batch.py [generations] [scenario name start ...] [--seeds N] [--plateau K]
# With --seeds N each scenario runs N times from different seeds and the best is kept (the others are in the folder).
# With --plateau K a run stops early once its best hasn't improved for K generations (generations is then the most).
import html
import json
import sys
import time
from multiprocessing import Pool
from pathlib import Path

from model import GAME, HERE, Silhouette

OUT = HERE / 'out'
EVOLVED = GAME / 'prototypes' / 'energy-lab' / 'evolved'


def slug(name: str) -> str:
    return ''.join(ch if ch.isalnum() else '-' for ch in name.lower())[:30].strip('-')


def run_one(job):
    from ports_evolve import PortsEvolver, PortsScorer, lab_design, ship_json
    sc, gens, seed, folder, plateau = job
    sil = Silhouette.load(HERE / 'samples' / sc.get('silhouette', 'gunship.json'))
    scorer = PortsScorer()
    try:
        ev = PortsEvolver(scorer, sil, sc, population=50, elite=5, seed=seed)
        t0 = time.time()
        top, since = float('-inf'), 0
        for g in range(gens):
            best, s = ev.step()
            if s['fit'] > top + 1e-6:
                top, since = s['fit'], 0
            else:
                since += 1
            if plateau and since >= plateau:
                break
        gens = g + 1
        m = s['m']
        about = (f"Evolved ({sc['name']}, {gens} generations, seed {seed}): score {s['fit']:.2f}; {m['sustained_dps']:.0f} damage a second, "
                 f"{m['damage_before_down']:.0f} dealt before the core went ({m['alive_s']:.0f} s); {m['cost']:.0f} credits.")
        lab = lab_design(ev, best, f"Evolved: {sc['name']}", about)
        d = ship_json(ev, best)
        meas = {k: v for k, v in m.items() if not isinstance(v, (dict, list))}
        d.update(scenario=sc['name'], seed=seed, generations=gens, score=s['fit'], seconds=round(time.time() - t0), history=ev.history,
                 terms=[list(t) for t in s['terms']], measures=meas)
        sub = Path(folder) / f"{slug(sc['name'])}-seed{seed}"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / 'best.json').write_text(json.dumps(d, indent=1), encoding='utf-8')
        (sub / 'lab.json').write_text(json.dumps(lab), encoding='utf-8')
        start = ev.score(ev.start)['m']
        return {'scenario': sc['name'], 'about': sc.get('about', ''), 'seed': seed, 'score': s['fit'], 'measures': meas, 'terms': d['terms'],
                'lab': lab, 'T': {k: {'col': v['col'], 'kind': v['kind'], 'name': v['name']} for k, v in ev.T.items()},
                'start': {k: v for k, v in start.items() if not isinstance(v, (dict, list))}, 'seconds': d['seconds'], 'folder': str(sub)}
    finally:
        scorer.close()


def write_gallery(results: list, folder: Path):
    EVOLVED.mkdir(parents=True, exist_ok=True)
    cards = []
    for r in sorted(results, key=lambda r: r['scenario']):
        name = slug(r['scenario'])
        (EVOLVED / f'{name}.json').write_text(json.dumps(r['lab']), encoding='utf-8')
        m = r['measures']
        from collections import Counter
        counts = Counter(r['T'][p[0]]['name'] for p in r['lab']['parts'] if r['T'][p[0]]['kind'] != 'inert')
        rows = [('Score', f"{r['score']:.2f}"), ('Damage a second', f"{m['sustained_dps']:.0f}"), ('Dealt before the core went', f"{m['damage_before_down']:.0f} in {m['alive_s']:.0f} s"),
                ('Shots carrying an effect', f"{m.get('fx_share', 0) * 100:.0f}%"), ('Feed used (power phase)', f"{m.get('feed_used', 0):.0f}"),
                ('Guns: links straight from a generator / within a blast', f"{m.get('guns', 0)}: {m.get('direct_share', 0) * 100:.0f}% / {m.get('guns_near_blast', 0)}"),
                ('Thrust for its mass', f"{m['thrust_to_mass']:.3f}"), ('Live conduits / idle parts', f"{m['live_conduits']} / {m.get('idle', 0)}"),
                ('Cost / build points', f"{m['cost']:.0f} / {m['points']}")]
        cards.append(f"""<article class="card">
  <h2>{html.escape(r['scenario'])}</h2>
  <p class="about">{html.escape(r['about'])}</p>
  <div class="row"><div class="pic">{svg_ship(r)}</div>
  <table>{''.join(f'<tr><th>{html.escape(k)}</th><td>{html.escape(v)}</td></tr>' for k, v in rows)}</table></div>
  <p class="parts">{html.escape(', '.join(f'{n} {c}' for n, c in counts.most_common()))}</p>
  <p><a class="open" href="../ports.html#file=evolved/{name}.json">Open it live in the lab</a> <span class="sub">seed {r['seed']}, {r['seconds']} s</span></p>
</article>""")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evolved ships</title>
<style>
:root {{ --bg: #0e1317; --panel: #151c22; --line: #2a3742; --ink: #dde5ea; --mute: #8b9ba7; --accent: #f5a83a; color-scheme: dark; }}
body {{ background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 16px max(16px, env(safe-area-inset-left, 0px)); }}
h1 {{ font-size: 18px; margin: 0 0 4px; }} h2 {{ font-size: 15px; margin: 0 0 4px; }}
.sub, .about, .parts {{ color: var(--mute); font-size: 12.5px; }}
.grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-top: 12px; }}
.card {{ background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }}
.row {{ display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }}
.pic svg {{ display: block; background: #0a0e11; border-radius: 4px; max-width: 100%; height: auto; }}
table {{ border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }}
th {{ text-align: left; color: var(--mute); font-weight: 400; padding: 2px 10px 2px 0; }} td {{ padding: 2px 0; }}
a.open {{ color: var(--accent); }}
</style></head><body>
<h1>Evolved ships</h1>
<p class="sub">The ports evolver's best ship for each scenario ({time.strftime('%Y-%m-%d %H:%M')}). Open one to run it in the lab: hover parts, break them, fire in bursts. Run files: {html.escape(str(folder))}</p>
<div class="grid">{''.join(cards)}</div>
</body></html>"""
    (EVOLVED / 'index.html').write_text(page, encoding='utf-8')


def svg_ship(r: dict, cell=8) -> str:
    """The ship as a small picture: each part's cells in its colour, a darker edge round each part"""
    lab, T = r['lab'], r['T']
    T_full = ports_evolve_T()
    rects = []
    xs, ys = [], []
    for t, x, y, rot, flip in lab['parts']:
        tw, th = T_full[t]['w'], T_full[t]['h']
        w, h = (th, tw) if rot % 2 else (tw, th)
        xs += [x, x + w]
        ys += [y, y + h]
        col = T[t]['col']
        op = 0.55 if T[t]['kind'] == 'inert' else 0.95
        rects.append(f'<rect x="{x * cell + 0.5}" y="{y * cell + 0.5}" width="{w * cell - 1}" height="{h * cell - 1}" rx="1.5" fill="{col}" fill-opacity="{op}" stroke="#0a0e11"/>')
    if not xs:
        return ''
    x0, y0, x1, y1 = min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1
    return f'<svg width="{(x1 - x0) * cell}" height="{(y1 - y0) * cell}" viewBox="{x0 * cell} {y0 * cell} {(x1 - x0) * cell} {(y1 - y0) * cell}">{"".join(rects)}</svg>'


_T = None


def ports_evolve_T():
    global _T
    if _T is None:
        from ports_evolve import PortsScorer
        sc = PortsScorer()
        _T = sc.T
        sc.close()
    return _T


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    seeds = int(sys.argv[sys.argv.index('--seeds') + 1]) if '--seeds' in sys.argv else 1
    plateau = int(sys.argv[sys.argv.index('--plateau') + 1]) if '--plateau' in sys.argv else 0
    for flag in ('--seeds', '--plateau'):
        if flag in sys.argv:
            v = sys.argv[sys.argv.index(flag) + 1]
            args.remove(v)
    gens = int(args[0]) if args and args[0].isdigit() else 300
    names = [a.lower() for a in args[1:]] if args and args[0].isdigit() else [a.lower() for a in args]
    scs = json.loads((HERE / 'ports_scenarios.json').read_text(encoding='utf-8'))['scenarios']
    if names:
        scs = [s for s in scs if any(s['name'].lower().startswith(n) for n in names)]
    folder = OUT / f"ports-batch-{time.strftime('%Y%m%d-%H%M%S')}"
    folder.mkdir(parents=True, exist_ok=True)
    jobs = [(sc, gens, 1000 + 97 * k, str(folder), plateau) for sc in scs for k in range(seeds)]
    t0 = time.time()
    with Pool(min(len(jobs), 6)) as pool:
        results = pool.map(run_one, jobs)
    best = {}
    for r in results:
        if r['scenario'] not in best or r['score'] > best[r['scenario']]['score']:
            best[r['scenario']] = r
    write_gallery(list(best.values()), folder)
    summary = [{'scenario': r['scenario'], 'seed': r['seed'], 'score': round(r['score'], 3), **{k: round(v, 3) if isinstance(v, float) else v for k, v in r['measures'].items()}}
               for r in results]
    (folder / 'summary.json').write_text(json.dumps(summary, indent=1), encoding='utf-8')
    for r in sorted(results, key=lambda r: (r['scenario'], -r['score'])):
        m = r['measures']
        print(f"{r['scenario'][:28]:28} seed {r['seed']}: score {r['score']:.2f}  dps {m['sustained_dps']:.0f}  dealt {m['damage_before_down']:.0f}  alive {m['alive_s']:.0f}s  "
              f"fx {m.get('fx_share', 0):.2f}  feed {m.get('feed_used', 0):.0f}  live {m['live_conduits']}  idle {m.get('idle', 0)}  t/m {m['thrust_to_mass']:.3f}  "
              f"guns {m.get('guns', 0)} direct {m.get('direct_share', 0):.2f} near-blast {m.get('guns_near_blast', 0)}", flush=True)
    print(f'{time.time() - t0:.0f}s; gallery: {EVOLVED / "index.html"}')


if __name__ == '__main__':
    main()
