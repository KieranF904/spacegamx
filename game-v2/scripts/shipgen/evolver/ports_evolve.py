# Evolution under the ports rules (docs/design/energy-ports-2026-11.md): the lab's parts (prototypes/energy-lab), scored
# by the lab's own model (ports_score.cjs). No router: the wiring is evolved like everything else. Changes are random
# but some are aimed where power is: a conduit put across an open out port or in front of an open in port, a part
# turned. The score rewards conduits on the shortest path to an unfed port (more once power reaches them) and conduits
# still carrying power, so a line can be built up a cell at a time.
#
# A ship is its right half (and its centre column); the left half is the mirror. A part on the centre column must sit
# evenly across it and has no twin, so it may face any way.
import json
import random
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from model import HERE, Silhouette
from score import ZERO_SCALE, fitness

SCORER = HERE / 'ports_score.cjs'
ZERO_SCALE.update({'wiring': 1.0, 'live_conduits': 10.0, 'sustained_dps': 50.0, 'feed_wiring': 1.0, 'fx_share': 1.0})
SIDES = ['N', 'E', 'S', 'W']
SIDE_V = {'N': (0, -1), 'E': (1, 0), 'S': (0, 1), 'W': (-1, 0)}
OPP = {'N': 'S', 'S': 'N', 'E': 'W', 'W': 'E'}
CHANGES = ('place', 'place', 'swap', 'clear', 'turn', 'turn', 'extend_out', 'extend_out', 'extend_in', 'extend_in', 'grow', 'shrink', 'feed', 'feed', 'move')
# (An aimed change puts a conduit there most times, another part the rest)
CONDUIT_SHARE = 0.6


def place_cell(lx: int, ly: int, w: int, h: int, rot: int, flip: bool) -> tuple:
    """A cell of a w x h part in its own frame to its offset in the placed footprint, as the lab's placeCell"""
    if flip:
        lx = w - 1 - lx
    x, y, W, H = lx, ly, w, h
    for _ in range(rot):
        x, y = H - 1 - y, x
        W, H = H, W
    return x, y


def port_offsets(t: dict, rot: int, flip: bool) -> list:
    """Each port of a part placed so: (dir, world side, dx, dy from the footprint's top-left)"""
    out = []
    for q in t['ports']:
        side, c = q['side'], q['cell']
        lx, ly = {'N': (c, 0), 'S': (c, t['h'] - 1), 'W': (0, c), 'E': (t['w'] - 1, c)}[side]
        dx, dy = place_cell(lx, ly, t['w'], t['h'], rot, flip)
        out.append((q['dir'], place_side(side, rot, flip), dx, dy))
    return out


def feed_offsets(t: dict, rot: int, flip: bool) -> list:
    """Each feed point of a part placed so: (world side, dx, dy from the footprint's top-left)"""
    out = []
    for q in t.get('feed', []):
        side, c = q['side'], q['cell']
        lx, ly = {'N': (c, 0), 'S': (c, t['h'] - 1), 'W': (0, c), 'E': (t['w'] - 1, c)}[side]
        dx, dy = place_cell(lx, ly, t['w'], t['h'], rot, flip)
        out.append((place_side(side, rot, flip), dx, dy))
    return out


def place_side(side: str, rot: int, flip: bool) -> str:
    """A side in the part's own frame to the world, as the lab's placeSide (flip mirrors W/E, then turn clockwise)"""
    if flip and side in ('E', 'W'):
        side = OPP[side]
    return SIDES[(SIDES.index(side) + rot) % 4]


@dataclass
class PPart:
    type: str
    x: int
    y: int
    rot: int = 0
    flip: bool = False


@dataclass
class PShip:
    sil: Silhouette
    parts: list = field(default_factory=list)

    def copy(self) -> 'PShip':
        return PShip(self.sil, [PPart(p.type, p.x, p.y, p.rot, p.flip) for p in self.parts])

    def key(self) -> tuple:
        return tuple(sorted((p.type, p.x, p.y, p.rot, p.flip) for p in self.parts))


class PortsScorer:
    """ports_score.cjs in a node process kept open"""

    def __init__(self):
        flags = 0x08000000 if sys.platform == 'win32' else 0
        self.proc = subprocess.Popen(['node', str(SCORER)], cwd=str(HERE), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, encoding='utf-8', creationflags=flags)
        if 'ready' not in self.proc.stdout.readline():
            raise RuntimeError('the ports scorer did not start')
        self.n = 0
        self.T = self.ask({'cmd': 'catalogue'})['T']

    def ask(self, req: dict) -> dict:
        self.proc.stdin.write(json.dumps(req) + '\n')
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def measure(self, full: list, w: int, h: int, scenario: dict) -> dict:
        self.n += 1
        m = self.ask({'id': self.n, 'w': w, 'h': h, 'parts': [[p.type, p.x, p.y, p.rot, p.flip] for p in full], 'scenario': scenario})
        if 'error' in m:
            raise RuntimeError(m['error'])
        return m

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


class PortsEvolver:
    def __init__(self, scorer: PortsScorer, sil: Silhouette, scenario: dict, population=30, elite=4, seed=1, start: PShip | None = None):
        self.sc, self.sil, self.scorer, self.T = scenario, sil, scorer, scorer.T
        self.population, self.elite = population, elite
        self.rng = random.Random(seed)
        level = scenario.get('level', 99)
        allow = set(scenario.get('allow') or [])
        self.choices = [t for t in self.T.values() if t['id'] != 'core' and t['kind'] != 'inert' and t['lvl'] <= level and (not allow or t['id'] in allow)]
        self.store_ids = [t['id'] for t in self.choices if t['kind'] == 'store' and t.get('conduit')]
        self.margin = int((scenario.get('shape') or {}).get('margin', 0))
        self.area = sil.allowed(self.margin)
        self.mid = sil.mid
        self.points_cell = lambda t: 1 if t['lvl'] < 10 else 1.6 if t['lvl'] < 24 else 2.5
        self.cache: dict = {}
        # (Each measure is scored against the scenario's fixed scale (scales: what counts as 1), not against the start:
        # a weak start would make every gain look huge and every penalty negligible)
        self.ref = dict(scenario.get('scales') or {})
        # (The scenario's start parts are fixed, like the core: the ship is built round them, never without them)
        self.fixed = {(spec[0], spec[1], spec[2], spec[3] if len(spec) > 3 else 0, bool(spec[4]) if len(spec) > 4 else False) for spec in scenario.get('start_parts', [])}
        self.start = start or self.seed_ship()
        self.base = self.score(self.start)['m']
        self.gen = 0
        self.pop = [self.start] + [self.child(self.start) for _ in range(population - 1)]
        self.history: list = []

    # ---- geometry
    def dims(self, t: dict, rot: int) -> tuple:
        return (t['h'], t['w']) if rot % 2 else (t['w'], t['h'])

    def cells(self, p: PPart) -> list:
        w, h = self.dims(self.T[p.type], p.rot)
        return [(p.x + dx, p.y + dy) for dy in range(h) for dx in range(w)]

    def mirror(self, p: PPart) -> PPart | None:
        w, _h = self.dims(self.T[p.type], p.rot)
        x2 = self.sil.w - 1 - (p.x + w - 1)
        return None if x2 == p.x else PPart(p.type, x2, p.y, (4 - p.rot) % 4, not p.flip)

    def full(self, s: PShip) -> list:
        out = []
        for p in s.parts:
            out.append(p)
            m = self.mirror(p)
            if m:
                out.append(m)
        return out

    def owner(self, s: PShip) -> dict:
        return {c: i for i, p in enumerate(s.parts) for c in self.cells(p)}

    def fits(self, t: dict, x: int, y: int, rot: int) -> bool:
        """In the allowed area on the right half, and on the centre column only evenly across it"""
        w, h = self.dims(t, rot)
        if x <= self.mid <= x + w - 1:
            if 2 * x + w - 1 != 2 * self.mid:
                return False
        elif x < self.mid:
            return False
        return all((y + dy, x + dx) in self.area for dy in range(h) for dx in range(w))

    def orientations(self, t: dict) -> list:
        """Guns and engines point forward and back, so only flip; everything else any way"""
        if t['kind'] in ('weapon', 'engine'):
            return [(0, False), (0, True)]
        return [(r, f) for r in range(4) for f in (False, True)]

    def is_fixed(self, p: PPart) -> bool:
        return p.type == 'core' or (p.type, p.x, p.y, p.rot, p.flip) in self.fixed

    def put(self, s: PShip, np: PPart, keep_core=True) -> bool:
        """Place np, taking away the parts wholly under it (never the core). False if it can't go there"""
        t = self.T[np.type]
        if not self.fits(t, np.x, np.y, np.rot):
            return False
        cells = set(self.cells(np))
        own = self.owner(s)
        under = {own[c] for c in cells if c in own}
        for i in under:
            o = s.parts[i]
            if (keep_core and self.is_fixed(o)) or not all(c in cells for c in self.cells(o)):
                return False
        s.parts = [p for i, p in enumerate(s.parts) if i not in under] + [np]
        return True

    # ---- the start
    def seed_ship(self) -> PShip:
        """Hull over the outline's right half; a core turned upright on the centre line with a reactor above and below
        feeding it; Pips on the turret marks and Ion Drives on the engine marks; the scenario's start parts over that"""
        s = PShip(self.sil, [])
        hull = self.T['hull']
        for (r, c) in sorted(self.sil.cells):
            if c >= self.mid:
                s.parts.append(PPart('hull', c, r))
        rows = sorted({r for r, c in self.sil.cells if c == self.mid})
        cy = rows[len(rows) // 2]
        self.put(s, PPart('core', self.mid, cy, 1, False), keep_core=False)
        self.put(s, PPart('cell_reactor', self.mid, cy - 1, 2, False))
        self.put(s, PPart('cell_reactor', self.mid, cy + 2, 0, False))
        for (r, c) in self.sil.turrets:
            if c >= self.mid:
                self.put(s, PPart('pip', c, r))
        for (r, c) in self.sil.engines:
            if c >= self.mid:
                self.put(s, PPart('ion', c, r))
        for spec in self.sc.get('start_parts', []):
            self.put(s, PPart(spec[0], spec[1], spec[2], spec[3] if len(spec) > 3 else 0, bool(spec[4]) if len(spec) > 4 else False))
        del hull
        self.seed_lines(s)
        return s

    def seed_lines(self, s: PShip):
        """The most basic connections, only for the start (evolution has no router): the core's two right-hand lines run
        as conduits to the nearest gun and the nearest engine; every other gun or engine on the right gets a Cell Reactor
        straight behind it, where the cell is free. Evolution takes it from there"""
        core = next(p for p in s.parts if p.type == 'core')
        srcs = [((core.x + dx, core.y + dy), side) for d, side, dx, dy in port_offsets(self.T['core'], core.rot, core.flip) if d == 'out' and side == 'E']
        cons = []
        for p in s.parts:
            t = self.T[p.type]
            if t['kind'] in ('weapon', 'engine') and p.x > self.mid:
                for d, side, dx, dy in port_offsets(t, p.rot, p.flip):
                    if d == 'in':
                        cons.append((t['kind'], p, (p.x + dx, p.y + dy), side))
        dist = lambda c: abs(c[2][0] - core.x) + abs(c[2][1] - core.y)
        order = sorted([c for c in cons if c[0] == 'weapon'], key=dist)[:1] + sorted([c for c in cons if c[0] == 'engine'], key=dist)[:1]
        served = set()
        for c in order:
            for i, (cell, side) in enumerate(srcs):
                if self.route(s, cell, side, c[2], c[3]):
                    served.add(id(c))
                    srcs.pop(i)
                    break
        for c in cons:
            if id(c) in served:
                continue
            (x, y), side = c[2], c[3]
            vx, vy = SIDE_V[side]
            # (A reactor across the port, its out port facing it: rot so that its N (out) faces back)
            rot = {'S': 0, 'W': 1, 'N': 2, 'E': 3}[OPP[side]]
            self.put(s, PPart('cell_reactor', x + vx, y + vy, rot, False))

    def route(self, s: PShip, src_cell, src_side, dst_cell, dst_side) -> bool:
        """Conduits from across a giver's out port to across a taker's in port, through hull or empty cells right of
        the centre line (a breadth-first shortest path); False when there's no way"""
        from collections import deque
        sv, dv = SIDE_V[src_side], SIDE_V[dst_side]
        start = (src_cell[0] + sv[0], src_cell[1] + sv[1])
        goal = (dst_cell[0] + dv[0], dst_cell[1] + dv[1])
        own = self.owner(s)
        free = lambda c: c[0] > self.mid and (c[1], c[0]) in self.area and (c not in own or self.T[s.parts[own[c]].type]['kind'] == 'inert')
        if not free(start) or not free(goal):
            return False
        prev = {start: None}
        q = deque([start])
        while q:
            c = q.popleft()
            if c == goal:
                break
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (c[0] + dx, c[1] + dy)
                if n not in prev and free(n):
                    prev[n] = c
                    q.append(n)
        if goal not in prev:
            return False
        path, c = [], goal
        while c is not None:
            path.append(c)
            c = prev[c]
        path.reverse()
        toward = lambda a, b: {(1, 0): 'E', (-1, 0): 'W', (0, 1): 'S', (0, -1): 'N'}[(b[0] - a[0], b[1] - a[1])]
        for i, c in enumerate(path):
            back = src_cell if i == 0 else path[i - 1]
            ahead = dst_cell if i == len(path) - 1 else path[i + 1]
            ins, outs = toward(c, back), toward(c, ahead)
            if ins == outs:
                return False
            cand = self.conduit_for(ins, outs)
            if not cand:
                return False
            cid, r, f = cand[0]
            if not self.put(s, PPart(cid, c[0], c[1], r, f)):
                return False
        return True

    # ---- scoring
    def score(self, s: PShip) -> dict:
        k = s.key()
        if k not in self.cache:
            full = self.full(s)
            m = self.scorer.measure(full, self.sil.w, self.sil.h, self.sc)
            occupied = {(y, x) for p in full for (x, y) in self.cells(p)}
            m['shape_off'] = len(occupied ^ self.sil.cells)
            m['cost'] = sum(self.T[p.type]['cost'] for p in full)
            m['points'] = round(sum(self.points_cell(self.T[p.type]) * self.T[p.type]['w'] * self.T[p.type]['h'] for p in full if p.type != 'core'), 1)
            m['parts'] = len(full)
            m['valid'] = True
            f, terms = fitness(self.sc, m, self.ref)
            self.cache[k] = {'m': m, 'fit': f, 'terms': terms}
        return self.cache[k]

    def step(self) -> tuple:
        scored = sorted(((self.score(s)['fit'], i, s) for i, s in enumerate(self.pop)), key=lambda t: -t[0])
        best = scored[0]
        self.history.append((best[0], sum(t[0] for t in scored) / len(scored)))
        nxt = [t[2] for t in scored[:self.elite]]
        while len(nxt) < self.population:
            a, b = self.rng.sample(scored, 2)
            nxt.append(self.child(a[2] if a[0] >= b[0] else b[2]))
        self.pop = nxt
        self.gen += 1
        if len(self.cache) > 6000:
            keep = {s.key() for s in self.pop}
            self.cache = {k: v for k, v in self.cache.items() if k in keep}
        return best[2], self.score(best[2])

    # ---- changes
    def child(self, parent: PShip) -> PShip:
        s = parent.copy()
        for _ in range(self.rng.choice((1, 1, 2, 3))):
            for _try in range(12):
                if getattr(self, self.rng.choice(CHANGES))(s):
                    break
        return s

    def place(self, s: PShip) -> bool:
        t = self.rng.choice(self.choices)
        r, f = self.rng.choice(self.orientations(t))
        y, x = self.rng.choice([c for c in self.area if c[1] >= self.mid])
        w, _h = self.dims(t, r)
        if w % 2 and x == self.mid:
            x -= (w - 1) // 2
        return self.put(s, PPart(t['id'], x, y, r, f))

    def swap(self, s: PShip) -> bool:
        idx = [i for i, p in enumerate(s.parts) if not self.is_fixed(p)]
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.parts[i]
        t0 = self.T[p.type]
        opts = [t for t in self.choices if (t['w'], t['h']) == (t0['w'], t0['h']) and t['id'] != p.type and (p.rot, p.flip) in self.orientations(t)]
        if not opts:
            return False
        s.parts[i] = PPart(self.rng.choice(opts)['id'], p.x, p.y, p.rot, p.flip)
        return True

    def clear(self, s: PShip) -> bool:
        idx = [i for i, p in enumerate(s.parts) if p.type != 'hull' and not self.is_fixed(p)]
        if not idx:
            return False
        p = s.parts.pop(self.rng.choice(idx))
        s.parts += [PPart('hull', x, y) for (x, y) in self.cells(p) if x >= self.mid]
        return True

    def turn(self, s: PShip) -> bool:
        idx = [i for i, p in enumerate(s.parts) if self.T[p.type]['ports'] and (p.type == 'core' or not self.is_fixed(p))]
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.parts[i]
        opts = [o for o in self.orientations(self.T[p.type]) if o != (p.rot, p.flip)]
        # (Only turns that keep the footprint: the part stays on its own cells. A 2x1 part changes between lying and
        # standing by being placed again)
        opts = [(r, f) for r, f in opts if self.dims(self.T[p.type], r) == self.dims(self.T[p.type], p.rot)]
        if not opts:
            return False
        r, f = self.rng.choice(opts)
        s.parts[i] = PPart(p.type, p.x, p.y, r, f)
        return True

    def open_ports(self, s: PShip) -> list:
        return [o for o in self.score(s)['m']['open'] if o[5] >= self.mid and (o[6], o[5]) in self.area]

    def conduit_for(self, in_side: str | None, out_side: str | None) -> list:
        """Every conduit orientation with its in port on in_side and/or its out port on out_side (world sides)"""
        out = []
        for cid in self.store_ids:
            t = self.T[cid]
            pin = next(q for q in t['ports'] if q['dir'] == 'in')
            pout = next(q for q in t['ports'] if q['dir'] == 'out')
            for r in range(4):
                for f in (False, True):
                    si, so = place_side(pin['side'], r, f), place_side(pout['side'], r, f)
                    if (in_side is None or si == in_side) and (out_side is None or so == out_side):
                        out.append((cid, r, f))
        return out

    def free_for_conduit(self, s: PShip, x: int, y: int) -> bool:
        """Empty, hull, armour or a conduit: what an aimed conduit may go over"""
        own = self.owner(s)
        if (x, y) not in own:
            return True
        t = self.T[s.parts[own[(x, y)]].type]
        return t['kind'] == 'inert' or bool(t.get('conduit'))

    def aimed(self, s: PShip, want: str) -> bool:
        """Across an open port, a part with a port of the other direction facing it. want 'out': something to feed an
        open in port; 'in': something to take from an open out port. A conduit most times, else any part that fits
        (a generator or store to feed a line; a gun, engine or store to take from one)"""
        opts = [o for o in self.open_ports(s) if o[0] == ('in' if want == 'out' else 'out')]
        if not opts:
            return False
        _d, _k, _c, _x, _y, nx, ny, side = self.rng.choice(opts)
        if not self.free_for_conduit(s, nx, ny):
            return False
        if self.rng.random() < CONDUIT_SHARE:
            cand = self.conduit_for(OPP[side], None) if want == 'in' else self.conduit_for(None, OPP[side])
            cid, r, f = self.rng.choice(cand)
            return self.put(s, PPart(cid, nx, ny, r, f))
        kinds = ('gen', 'store') if want == 'out' else ('store', 'weapon', 'engine', 'util')
        pool = [t for t in self.choices if t['kind'] in kinds and not t.get('conduit')]
        if not pool:
            return False
        t = self.rng.choice(pool)
        fits = []
        for r, f in self.orientations(t):
            for d, ws, dx, dy in port_offsets(t, r, f):
                if d == want and ws == OPP[side]:
                    fits.append((r, f, nx - dx, ny - dy))
        if not fits:
            return False
        r, f, x, y = self.rng.choice(fits)
        # (It may cover only empty cells, hull, armour and conduits)
        if not all(self.free_for_conduit(s, cx, cy) for cx, cy in self.cells(PPart(t['id'], x, y, r, f))):
            return False
        return self.put(s, PPart(t['id'], x, y, r, f))

    def feed(self, s: PShip) -> bool:
        """Across a feed point joined to nothing: a pipe most times, else a tank (of a consumable the level allows); or,
        where a straight Conduit is in the way at right angles, that Conduit made a Passthrough (same turn)"""
        opts = [o for o in self.score(s)['m'].get('open_feed', []) if o[3] >= self.mid and (o[4], o[3]) in self.area]
        if not opts:
            return False
        _k, _x, _y, nx, ny, side = self.rng.choice(opts)
        own = self.owner(s)
        if (nx, ny) in own:
            i = own[(nx, ny)]
            q = s.parts[i]
            t = self.T[q.type]
            if q.type == 'conduit' and 'passthrough' in self.T and self.T['passthrough']['lvl'] <= self.sc.get('level', 99):
                if place_side('E', q.rot, q.flip) in (side, OPP[side]):
                    s.parts[i] = PPart('passthrough', q.x, q.y, q.rot, q.flip)
                    return True
                return False
            if t['kind'] != 'inert':
                return False
        tanks = [t for t in self.choices if t['kind'] == 'tank']
        pipe = [t for t in self.choices if t['kind'] == 'pipe']
        pick = self.rng.choice(tanks) if (tanks and (not pipe or self.rng.random() < 0.3)) else (pipe[0] if pipe else None)
        if pick is None:
            return False
        return self.put(s, PPart(pick['id'], nx, ny))

    def move(self, s: PShip) -> bool:
        """A part shifted a cell (hull left where it was), so a layout can shuffle without being rebuilt"""
        idx = [i for i, p in enumerate(s.parts) if self.T[p.type]['kind'] not in ('inert',) and not self.is_fixed(p)]
        if not idx:
            return False
        i = self.rng.choice(idx)
        p = s.parts[i]
        dx, dy = self.rng.choice(((1, 0), (-1, 0), (0, 1), (0, -1)))
        np = PPart(p.type, p.x + dx, p.y + dy, p.rot, p.flip)
        rest = PShip(s.sil, [q for j, q in enumerate(s.parts) if j != i])
        new_cells = set(self.cells(np))
        own = self.owner(rest)
        if any(self.T[rest.parts[own[c]].type]['kind'] != 'inert' for c in new_cells if c in own):
            return False
        if not self.put(rest, np):
            return False
        rest.parts += [PPart('hull', x, y) for (x, y) in self.cells(p) if x >= self.mid and (x, y) not in new_cells]
        s.parts = rest.parts
        return True

    def extend_out(self, s: PShip) -> bool:
        return self.aimed(s, 'in')

    def extend_in(self, s: PShip) -> bool:
        return self.aimed(s, 'out')

    def grow(self, s: PShip) -> bool:
        if not self.margin:
            return False
        own = self.owner(s)
        spots = [(x, y) for (y, x) in self.area if x >= self.mid and (x, y) not in own and any(n in own for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))]
        if not spots:
            return False
        x, y = self.rng.choice(spots)
        return self.put(s, PPart(self.rng.choice(('hull', 'armor')), x, y))

    def shrink(self, s: PShip) -> bool:
        own = self.owner(s)
        idx = [i for i, p in enumerate(s.parts) if self.T[p.type]['kind'] == 'inert'
               and any(n not in own and n[0] >= self.mid for n in ((p.x + 1, p.y), (p.x - 1, p.y), (p.x, p.y + 1), (p.x, p.y - 1)))]
        if not idx:
            return False
        s.parts.pop(self.rng.choice(idx))
        return True


def lab_design(ev: PortsEvolver, s: PShip, name: str, about: str) -> dict:
    """The ship as an Energy Lab design (Save, share, reset > Load design from the box)"""
    return {'v': 1, 'name': name, 'about': about, 'grid': [ev.sil.w, ev.sil.h], 'parts': [[p.type, p.x, p.y, p.rot, p.flip] for p in ev.full(s)], 'params': {},
            'settings': {'fireMode': 'b35' if (ev.sc.get('fire') or {}).get('off') else 'hold'}}


def ship_json(ev: PortsEvolver, s: PShip) -> dict:
    return {'silhouette': ev.sil.name, 'width': ev.sil.w, 'height': ev.sil.h, 'parts': [[p.type, p.x, p.y, p.rot, p.flip] for p in s.parts]}


def ship_from_json(sil: Silhouette, d: dict) -> PShip:
    return PShip(sil, [PPart(t, x, y, r, bool(f)) for t, x, y, r, f in d['parts']])


if __name__ == '__main__':
    # A headless run: python ports_evolve.py "<scenario>" [generations]
    import time
    scs = json.loads((HERE / 'ports_scenarios.json').read_text(encoding='utf-8'))['scenarios']
    sc = next(x for x in scs if x['name'].lower().startswith(sys.argv[1].lower())) if len(sys.argv) > 1 else scs[0]
    sil = Silhouette.load(HERE / 'samples' / sc.get('silhouette', 'gunship.json'))
    scorer = PortsScorer()
    ev = PortsEvolver(scorer, sil, sc, seed=int(time.time()) % 100000)
    t0 = time.time()
    G = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    for g in range(G):
        best, s = ev.step()
        if g % 10 == 9 or g == G - 1:
            m = s['m']
            print(f"{g + 1} {time.time() - t0:.0f}s fit {s['fit']:.2f} dps {m['sustained_dps']:.0f} dbd {m['damage_before_down']:.0f} wiring {m['wiring']:.2f} live {m['live_conduits']} unpowered {m['unpowered']} feed {m['feed_wiring']:.2f}/{m['feed_users']} fx {m['fx_share']:.2f} t/m {m['thrust_to_mass']:.3f} cost {m['cost']:.0f} pts {m['points']}", flush=True)
    print('TERMS', [(t[0], round(t[2], 2), round(t[3], 2)) for t in s['terms']])
    scorer.close()
