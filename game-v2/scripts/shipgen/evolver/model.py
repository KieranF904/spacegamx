# The evolver's ship: parts from the catalogue (catalogue.json, export.ts: the game's own numbers) placed on a grid
# inside a fixed outline (a silhouette from the designer). Only the right half is kept; the left is its mirror, so a
# part on the centre line must sit across it evenly. Placements are whole parts: (part id, x, y, w, h, facing),
# x = column, y = row (row 0 the nose); facing only matters for a Diode (the edge power leaves by).
#
# What a ship may use is set by a level (a part's unlock level, a material's) and its build points (unlocks.json
# complexity at that level), and its cost by a budget in credits.
#
# The cheapest working ship (cheapest_build): the cheapest gun the level allows where the silhouette marks turrets,
# the cheapest engine where it marks engines, a core as deep in the outline as it goes on the centre line, one small
# reactor beside it, the shortest conduit runs from each gun and engine to that, and cheap hull in every other cell.
# None of that is fixed: it is only where evolution starts.
import json
import os
import subprocess
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
GAME = HERE.parents[2]
CATALOGUE = HERE / 'catalogue.json'
# (Designer palette index: engine-green cells are engines)
ENGINE_COLOUR = 6
RELAY_ROLES = ('conduit', 'diode', 'store', 'core')
SOURCE_ROLES = ('generator', 'dynamo')
CONSUMER_ROLES = ('weapon', 'thruster', 'tool')
SIDES = {'N': (-1, 0), 'E': (0, 1), 'S': (1, 0), 'W': (0, -1)}
MIRROR_SIDE = {'N': 'N', 'S': 'S', 'E': 'W', 'W': 'E', None: None}


class Catalogue:
    def __init__(self, path: Path = CATALOGUE):
        d = json.loads(path.read_text(encoding='utf-8'))
        self.parts: dict[str, dict] = {p['id']: p for p in d['parts']}
        self.penetration = {int(k): v for k, v in d.get('penetration', {}).items()} or {-4: 0.05, -3: 0.1, -2: 0.25, -1: 0.55, 0: 1, 1: 1.15}
        self.pieces: dict[str, list] = d.get('pieces', {})
        self.complexity = d.get('complexity', {'base': 60, 'levels': {}})
        self.version = d.get('catalogVersion', 1)
        self.made = d.get('made', '')

    def pen_mul(self, gap: float) -> float:
        """Damage × this at (weapon pen − block armour), interpolated, as damage.ts does"""
        ks = sorted(self.penetration)
        if gap <= ks[0]:
            return self.penetration[ks[0]]
        if gap >= ks[-1]:
            return self.penetration[ks[-1]]
        lo, hi = int(gap // 1), int(-(-gap // 1))
        a, b = self.penetration.get(lo, 1), self.penetration.get(hi, 1)
        return a if lo == hi else a + (b - a) * (gap - lo)

    def points_limit(self, level: int) -> int:
        """Build points a pilot of this level has (unlocks.json complexity)"""
        return self.complexity.get('base', 60) + sum(v for k, v in self.complexity.get('levels', {}).items() if level >= int(k))

    def role(self, pid: str) -> str:
        return (self.parts[pid].get('power') or {}).get('role') or 'none'

    def of(self, *, category=None, fn=None, role=None, size=None, level=None, full=True) -> list[dict]:
        out = []
        for p in self.parts.values():
            if category and p['category'] not in (category if isinstance(category, (list, tuple, set)) else [category]):
                continue
            if fn and p['fn'] != fn:
                continue
            if role and self.role(p['id']) != role:
                continue
            if size and (p['w'], p['h']) not in (size, size[::-1]):
                continue
            if level is not None and p.get('unlock', 0) > level:
                continue
            if full and not p['full']:
                continue
            out.append(p)
        return out


@dataclass
class Place:
    pid: str
    x: int
    y: int
    w: int
    h: int
    facing: str | None = None

    def cells(self):
        return [(self.y + dy, self.x + dx) for dy in range(self.h) for dx in range(self.w)]


@dataclass
class Silhouette:
    """The outline: full grid size, every filled cell, and the cells marked for turrets and engines"""
    w: int
    h: int
    cells: set
    turrets: set
    engines: set
    name: str = ''

    @property
    def mid(self) -> int:
        return self.w // 2

    def half(self) -> set:
        return {(r, c) for r, c in self.cells if c >= self.mid}

    def clear_above(self, cells) -> bool:
        """Nothing of the outline in front of these cells (towards the nose): a gun may fire from them"""
        top = {}
        for r, c in cells:
            top[c] = min(r, top.get(c, r))
        return all(not any((rr, c) in self.cells for rr in range(r)) for c, r in top.items())

    def clear_below(self, cells) -> bool:
        """Nothing of the outline behind these cells: an engine may push from them"""
        bottom = {}
        for r, c in cells:
            bottom[c] = max(r, bottom.get(c, r))
        return all(not any((rr, c) in self.cells for rr in range(r + 1, self.h)) for c, r in bottom.items())

    @staticmethod
    def load(path: Path) -> 'Silhouette':
        """A designer JSON (Save... in the silhouette designer): turret components are turrets, engine-green cells
        (palette 'engine') are engines, every filled cell is outline"""
        d = json.loads(Path(path).read_text(encoding='utf-8'))
        cells = {(r, c) for r, c, _col, _sh in d['cells']}
        turrets = {(r, c) for r, c, k in d.get('components', []) if k == 'turret'}
        engines = {(r, c) for r, c, col, _sh in d['cells'] if col == ENGINE_COLOUR and (r, c) not in turrets}
        return Silhouette(int(d['width']), int(d['height']), cells, turrets, engines, Path(path).stem)


@dataclass
class Ship:
    sil: Silhouette
    half: list = field(default_factory=list)

    def copy(self) -> 'Ship':
        return Ship(self.sil, [Place(p.pid, p.x, p.y, p.w, p.h, p.facing) for p in self.half])

    def mirror_of(self, p: Place) -> Place | None:
        """The left-half twin of a right-half part (None for a part across the centre line: it is its own twin)"""
        x2 = self.sil.w - 1 - (p.x + p.w - 1)
        return None if x2 == p.x else Place(p.pid, x2, p.y, p.w, p.h, MIRROR_SIDE[p.facing])

    def full(self) -> list:
        out = []
        for p in self.half:
            out.append(p)
            m = self.mirror_of(p)
            if m:
                out.append(m)
        return out

    def owner(self) -> dict:
        """Right-half cell -> index into half"""
        o = {}
        for i, p in enumerate(self.half):
            for c in p.cells():
                if c[1] >= self.sil.mid:
                    o[c] = i
        return o

    def fits(self, x: int, y: int, w: int, h: int) -> bool:
        """Inside the outline's right half, and on the centre column only evenly across it (else it overlaps its own
        mirror image)"""
        if x <= self.sil.mid <= x + w - 1 and x + x + w - 1 != 2 * self.sil.mid:
            return False
        if x + w - 1 < self.sil.mid:
            return False
        return all((y + dy, x + dx) in self.sil.cells for dy in range(h) for dx in range(w))

    def key(self) -> tuple:
        return tuple(sorted((p.pid, p.x, p.y, p.w, p.facing or '') for p in self.half))

    def blueprint_parts(self, cat: Catalogue) -> list[dict]:
        """The whole ship as the game's PlacedParts: a rotation whose cells make the footprint, its origin cell, and
        a facing (guns forward, engines back, a Diode its own)"""
        out = []
        for uid, p in enumerate(self.full()):
            d = cat.parts[p.pid]
            rot, ox, oy = 0, p.x, p.y
            for r, cells in enumerate(cat.pieces.get(d['piece'], [[[0, 0]]])):
                xs, ys = [c[0] for c in cells], [c[1] for c in cells]
                if (max(xs) - min(xs) + 1, max(ys) - min(ys) + 1) == (p.w, p.h):
                    rot, ox, oy = r, p.x - min(xs), p.y - min(ys)
                    break
            part = {'uid': uid, 'piece': d['piece'], 'fn': d['fn'], 'material': d['material'], 'x': ox, 'y': oy, 'rot': rot, 'flip': False}
            if d.get('facing') == 'free':
                part['facing'] = 'S' if cat.role(p.pid) == 'thruster' else 'N'
            elif d.get('facing') == 'joined':
                part['facing'] = p.facing or 'N'
            out.append(part)
        return out

    def to_json(self) -> dict:
        return {'silhouette': self.sil.name, 'width': self.sil.w, 'height': self.sil.h,
                'half': [[p.pid, p.x, p.y, p.w, p.h, p.facing] for p in self.half]}


class Validator:
    """The game's validateBlueprint in a node process kept open (validate.ts). check(ship) -> {valid, errors, points}"""

    def __init__(self):
        loader = GAME / 'server' / 'node_modules' / 'tsx' / 'dist' / 'loader.mjs'
        flags = 0x08000000 if sys.platform == 'win32' else 0
        self.proc = subprocess.Popen(['node', '--import', loader.as_uri(), str(HERE / 'validate.ts')], cwd=str(GAME), stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8', creationflags=flags)
        ready = self.proc.stdout.readline()
        if 'ready' not in ready:
            raise RuntimeError(f'the validator did not start: {ready!r}')
        self.n = 0

    def check(self, ship: Ship, cat: Catalogue) -> dict:
        self.n += 1
        self.proc.stdin.write(json.dumps({'id': self.n, 'parts': ship.blueprint_parts(cat)}) + '\n')
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


def depth_map(cells: set) -> dict:
    """Each cell's steps to the outside of the shape (4-neighbour)"""
    dist, q = {}, deque()
    for r, c in cells:
        if any(n not in cells for n in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1))):
            dist[(r, c)] = 0
            q.append((r, c))
    while q:
        r, c = q.popleft()
        for n in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
            if n in cells and n not in dist:
                dist[n] = dist[(r, c)] + 1
                q.append(n)
    return dist


def cheapest(lst: list) -> str:
    return min(lst, key=lambda p: p['cost'] or 0)['id']


def cheapest_build(sil: Silhouette, cat: Catalogue, level: int) -> tuple[Ship, list[str]]:
    """The cheapest working ship in the outline at this level. Returns it and notes (what could not be done)"""
    notes = []
    mid = sil.mid
    half = sil.half()
    ship = Ship(sil)
    taken = set()

    def put(pid, cell):
        p = cat.parts[pid]
        ship.half.append(Place(pid, cell[1], cell[0], p['w'], p['h']))
        taken.add(cell)

    guns = [p for p in cat.of(category='weapons', size=(1, 1), level=level) if p['dps'] > 0]
    engines = [p for p in cat.of(role='thruster', size=(1, 1), level=level) if p['thrust'] > 0]
    consumers = []
    for cell in sorted(c for c in sil.turrets if c[1] >= mid):
        if not sil.clear_above([cell]):
            notes.append(f'Turret mark at row {cell[0]}, column {cell[1] - mid} has outline in front of it: left as hull.')
        elif guns:
            put(cheapest(guns), cell)
            consumers.append(cell)
    for cell in sorted(c for c in sil.engines if c[1] >= mid):
        if not sil.clear_below([cell]):
            notes.append(f'Engine mark at row {cell[0]}, column {cell[1] - mid} has outline behind it: left as hull.')
        elif engines:
            put(cheapest(engines), cell)
            consumers.append(cell)
    depth = depth_map(sil.cells)
    centre = [c for c in half if c[1] == mid and c not in taken]
    if not centre:
        notes.append('No free cell on the centre line for the core.')
        return ship, notes
    core_cell = max(centre, key=lambda c: (depth.get(c, 0), -abs(c[0] - sil.h / 2)))
    put(cheapest(cat.of(fn='core', size=(1, 1), level=level)), core_cell)
    net = {core_cell}
    r, c = core_cell
    spot = next((n for n in ((r + 1, c), (r - 1, c), (r, c + 1)) if n in half and n not in taken), None)
    if spot:
        put(cheapest(cat.of(role='generator', size=(1, 1), level=level)), spot)
        net.add(spot)
    else:
        notes.append('No room beside the core for a reactor.')
    conduit = cheapest(cat.of(role='conduit', size=(1, 1), level=level))
    # (Shortest runs: each gun and engine, nearest first, joins the network through free outline cells)
    for start in sorted(consumers, key=lambda s: abs(s[0] - r) + abs(s[1] - c)):
        prev, q, end = {start: None}, deque([start]), None
        while q:
            cur = q.popleft()
            nbrs = ((cur[0] + 1, cur[1]), (cur[0] - 1, cur[1]), (cur[0], cur[1] + 1), (cur[0], cur[1] - 1))
            if any(n in net for n in nbrs):
                end = cur
                break
            for n in nbrs:
                if n in half and n not in taken and n not in prev:
                    prev[n] = cur
                    q.append(n)
        if end is None:
            notes.append(f'No way to link the part at row {start[0]}, column {start[1] - mid} to the core.')
            continue
        cur = end
        while cur != start:
            put(conduit, cur)
            net.add(cur)
            cur = prev[cur]
    hull = cheapest(cat.of(fn='hull', size=(1, 1), level=level))
    for cell in sorted(half - taken):
        put(hull, cell)
    return ship, notes
