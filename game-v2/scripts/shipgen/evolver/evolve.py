# Evolution inside a fixed outline. The turrets, engines and outline never change; everything else may. A child is a
# parent with 1-3 changes:
#   swap     a part for another of the same size (hull -> armour, conduit -> battery, ...)
#   place    a part (1x1 to 3x3, either way round) over the plain parts under it
#   clear    a part back to plain hull, cell by cell
#   regrade  hull, armour, cargo or the core to another material (Mk I-V)
# Only the categories the scenario allows are placed (the core stays a core). Each generation keeps the best few
# as they are and fills the rest from tournament picks, changed.
import random

from model import Catalogue, Place, Ship
from score import fitness, measure

PLAIN = ('hull',)


class Evolver:
    def __init__(self, cat: Catalogue, start: Ship, scenario: dict, population=30, elite=4, seed=1):
        self.cat, self.start, self.sc = cat, start, scenario
        self.population, self.elite = population, elite
        self.rng = random.Random(seed)
        self.allow = set(scenario.get('allow') or ['structure', 'power', 'shields'])
        self.choices = [p for p in cat.parts.values() if p['category'] in self.allow and p['fn'] != 'core']
        self.hull = min(cat.of(fn='hull', size=(1, 1)), key=lambda p: p['cost'] or 0)['id']
        self.cache: dict = {}
        self.base = measure(cat, start, scenario)
        self.gen = 0
        self.pop: list[Ship] = [start] + [self.child(start) for _ in range(population - 1)]
        self.history: list[tuple[float, float]] = []

    # ---- scoring
    def key(self, s: Ship) -> tuple:
        return tuple(sorted((p.pid, p.x, p.y) for p in s.half))

    def score(self, s: Ship) -> dict:
        k = self.key(s)
        if k not in self.cache:
            m = measure(self.cat, s, self.sc)
            f, terms = fitness(self.sc, m, self.base)
            self.cache[k] = {'m': m, 'fit': f, 'terms': terms}
        return self.cache[k]

    def step(self) -> tuple[Ship, dict]:
        """One generation. Returns the best ship and its score"""
        scored = sorted(((self.score(s)['fit'], i, s) for i, s in enumerate(self.pop)), key=lambda t: -t[0])
        best = scored[0]
        self.history.append((best[0], sum(t[0] for t in scored) / len(scored)))
        keep = [t[2] for t in scored[:self.elite]]
        nxt = list(keep)
        while len(nxt) < self.population:
            a, b = self.rng.sample(scored, 2) if len(scored) > 1 else (scored[0], scored[0])
            nxt.append(self.child(a[2] if a[0] >= b[0] else b[2]))
        self.pop = nxt
        self.gen += 1
        if len(self.cache) > 20000:
            self.cache.clear()
        return best[2], self.score(best[2])

    # ---- changes
    def child(self, parent: Ship) -> Ship:
        s = parent.copy()
        for _ in range(self.rng.choice((1, 1, 2, 3))):
            for _try in range(12):
                if getattr(self, self.rng.choice(('swap', 'swap', 'place', 'place', 'clear', 'regrade')))(s):
                    break
        return s

    def free(self, s: Ship) -> list[int]:
        return [i for i, p in enumerate(s.half) if not p.fixed]

    def swap(self, s: Ship) -> bool:
        idx = self.free(s)
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.half[i]
        if self.cat.parts[p.pid]['fn'] == 'core':
            opts = [q for q in self.cat.of(fn='core') if (q['w'], q['h']) == (p.w, p.h)]
        else:
            opts = [q for q in self.choices if (q['w'], q['h']) in ((p.w, p.h), (p.h, p.w))]
        if not opts:
            return False
        q = self.rng.choice(opts)
        s.half[i] = Place(q['id'], p.x, p.y, p.w, p.h)
        return q['id'] != p.pid

    def place(self, s: Ship) -> bool:
        q = self.rng.choice(self.choices)
        w, h = (q['w'], q['h']) if self.rng.random() < 0.5 else (q['h'], q['w'])
        cells = list(s.sil.half())
        r, c = self.rng.choice(cells)
        # (Across the centre line it must sit evenly: shift it there half the time when it is odd-wide)
        x = c - (w - 1) // 2 if (w % 2 and c == s.sil.mid and self.rng.random() < 0.7) else c
        if not s.fits(x, r, w, h):
            return False
        owner = s.owner()
        under = {owner.get(cell) for cell in Place('', x, r, w, h).cells() if cell[1] >= s.sil.mid}
        if None in under:
            return False
        for i in under:
            o = s.half[i]
            # (Only plain or loose parts go under it, and only whole ones)
            if o.fixed or self.cat.parts[o.pid]['fn'] == 'core':
                return False
            if not all(cell in set(Place('', x, r, w, h).cells()) for cell in o.cells() if cell[1] >= s.sil.mid):
                return False
        s.half = [p for i, p in enumerate(s.half) if i not in under] + [Place(q['id'], x, r, w, h)]
        return True

    def clear(self, s: Ship) -> bool:
        idx = [i for i in self.free(s) if self.cat.parts[s.half[i].pid]['fn'] not in PLAIN + ('core',)]
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.half.pop(i)
        s.half += [Place(self.hull, cc, rr, 1, 1) for rr, cc in p.cells() if cc >= s.sil.mid]
        return True

    def regrade(self, s: Ship) -> bool:
        idx = [i for i in self.free(s) if not self.cat.parts[s.half[i].pid]['model']]
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.half[i]
        base = self.cat.parts[p.pid]
        opts = [q for q in self.cat.parts.values() if q['fn'] == base['fn'] and q['piece'] == base['piece'] and q['id'] != p.pid
                and (q['category'] in self.allow or q['fn'] == 'core')]
        if not opts:
            return False
        s.half[i] = Place(self.rng.choice(opts)['id'], p.x, p.y, p.w, p.h)
        return True
