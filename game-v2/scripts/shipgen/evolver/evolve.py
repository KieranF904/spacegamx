# Evolution inside a fixed outline: only the outline is fixed. A child is a parent with 1-3 changes:
#   swap     a part for another of the same size (hull -> armour, conduit -> battery, a gun for another gun, ...)
#   place    a part (1x1 to 3x3, either way round) over the parts wholly under it
#   clear    a part back to plain hull, cell by cell
#   regrade  hull, armour, cargo or the core to another material (Mk I-V)
#   turn     a Diode to face another way
# Any part the level has unlocked may be used (in the categories the scenario allows), anywhere: a gun with outline in
# front of it or an engine with outline behind it is legal but does nothing, and the score punishes it (score.py).
# Each child goes through the game's validator.
# Each generation keeps the best few as they are and fills the rest from tournament picks, changed.
import random

from model import SIDES, Catalogue, Place, Ship, Validator
from score import fitness, measure

CHANGES = ('swap', 'swap', 'place', 'place', 'clear', 'regrade', 'turn')


class Evolver:
    def __init__(self, cat: Catalogue, start: Ship, scenario: dict, validator: Validator | None = None, population=30, elite=4, seed=1):
        self.cat, self.start, self.sc, self.val = cat, start, scenario, validator
        self.population, self.elite = population, elite
        self.rng = random.Random(seed)
        level = scenario.get('level', 99)
        self.allow = set(scenario.get('allow') or ['structure', 'power', 'shields', 'weapons', 'engines'])
        # (Parts that fill their box: wedge and round pieces don't join on every side, so they wait for a shapes pass)
        self.choices = [p for p in cat.parts.values() if p['category'] in self.allow and p['fn'] != 'core' and p.get('unlock', 0) <= level and p['full']]
        self.cores = [p for p in cat.of(fn='core', level=level)]
        self.hull = min(cat.of(fn='hull', size=(1, 1), level=level), key=lambda p: p['cost'] or 0)['id']
        self.level = level
        self.cache: dict = {}
        self.base = self.measure(start)
        self.gen = 0
        self.pop: list[Ship] = [start] + [self.child(start) for _ in range(population - 1)]
        self.history: list[tuple[float, float]] = []

    # ---- scoring
    def measure(self, s: Ship) -> dict:
        return measure(self.cat, s, self.sc, self.val.check(s, self.cat) if self.val else None)

    def score(self, s: Ship) -> dict:
        k = s.key()
        if k not in self.cache:
            m = self.measure(s)
            f, terms = fitness(self.sc, m, self.base)
            self.cache[k] = {'m': m, 'fit': f, 'terms': terms}
        return self.cache[k]

    def step(self) -> tuple[Ship, dict]:
        """One generation. Returns the best ship and its score"""
        scored = sorted(((self.score(s)['fit'], i, s) for i, s in enumerate(self.pop)), key=lambda t: -t[0])
        best = scored[0]
        self.history.append((best[0], sum(t[0] for t in scored) / len(scored)))
        nxt = [t[2] for t in scored[:self.elite]]
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
                if getattr(self, self.rng.choice(CHANGES))(s):
                    break
        return s

    def allowed_at(self, s: Ship, q: dict, cells) -> bool:
        """Anywhere: line of sight is the score's to punish, not a rule here"""
        return True

    def facing_for(self, q: dict, s: Ship, cells) -> str | None:
        """A Diode faces a side with outline across it (its out edge must be joined)"""
        if q.get('facing') != 'joined':
            return None
        cells = set(cells)
        sides = [f for f, (dr, dc) in SIDES.items() if all((r + dr, c + dc) in s.sil.cells and (r + dr, c + dc) not in cells for r, c in cells if (r + dr, c + dc) not in cells)]
        return self.rng.choice(sides) if sides else None

    def swap(self, s: Ship) -> bool:
        if not s.half:
            return False
        i = self.rng.randrange(len(s.half))
        p = s.half[i]
        pool = self.cores if self.cat.parts[p.pid]['fn'] == 'core' else self.choices
        opts = [q for q in pool if (q['w'], q['h']) in ((p.w, p.h), (p.h, p.w)) and q['id'] != p.pid and self.allowed_at(s, q, p.cells())]
        if not opts:
            return False
        q = self.rng.choice(opts)
        s.half[i] = Place(q['id'], p.x, p.y, p.w, p.h, self.facing_for(q, s, p.cells()))
        return True

    def place(self, s: Ship) -> bool:
        q = self.rng.choice(self.choices)
        w, h = (q['w'], q['h']) if self.rng.random() < 0.5 else (q['h'], q['w'])
        r, c = self.rng.choice(list(s.sil.half()))
        # (Across the centre line it must sit evenly: put an odd-wide part there most times it lands on it)
        x = c - (w - 1) // 2 if (w % 2 and c == s.sil.mid and self.rng.random() < 0.7) else c
        if not s.fits(x, r, w, h):
            return False
        foot = Place(q['id'], x, r, w, h)
        cells = set(foot.cells())
        foot.facing = self.facing_for(q, s, cells)
        if not self.allowed_at(s, q, cells):
            return False
        owner = s.owner()
        under = {owner.get(cell) for cell in cells if cell[1] >= s.sil.mid}
        if None in under:
            return False
        for i in under:
            o = s.half[i]
            # (Only whole parts go under it, and never the core)
            if self.cat.parts[o.pid]['fn'] == 'core' or not all(cell in cells for cell in o.cells() if cell[1] >= s.sil.mid):
                return False
        s.half = [p for i, p in enumerate(s.half) if i not in under] + [foot]
        return True

    def clear(self, s: Ship) -> bool:
        idx = [i for i, p in enumerate(s.half) if self.cat.parts[p.pid]['fn'] not in ('hull', 'core')]
        if not idx:
            return False
        p = s.half.pop(self.rng.choice(idx))
        s.half += [Place(self.hull, cc, rr, 1, 1) for rr, cc in p.cells() if cc >= s.sil.mid]
        return True

    def regrade(self, s: Ship) -> bool:
        idx = [i for i, p in enumerate(s.half) if not self.cat.parts[p.pid]['model']]
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.half[i]
        d = self.cat.parts[p.pid]
        opts = [q for q in (self.cores if d['fn'] == 'core' else self.choices) if q['fn'] == d['fn'] and q['piece'] == d['piece'] and q['id'] != p.pid]
        if not opts:
            return False
        s.half[i] = Place(self.rng.choice(opts)['id'], p.x, p.y, p.w, p.h)
        return True

    def turn(self, s: Ship) -> bool:
        idx = [i for i, p in enumerate(s.half) if self.cat.parts[p.pid].get('facing') == 'joined']
        if not idx:
            return False
        p = s.half[self.rng.choice(idx)]
        f = self.facing_for(self.cat.parts[p.pid], s, p.cells())
        if f is None or f == p.facing:
            return False
        p.facing = f
        return True
