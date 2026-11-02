# The evolver's ship: parts from the catalogue (catalogue.json, export.ts: the game's own numbers) placed on a grid
# inside a fixed outline (a silhouette from the designer). Only the right half is kept; the left is its mirror, so a
# part on the centre line must sit across it evenly. Placements are whole parts: (part id, x, y, w, h), x = column,
# y = row (row 0 the nose).
#
# The cheapest working ship (cheapest_build): the turrets and engines where the silhouette puts them, a core as deep
# in the outline as it goes on the centre line, one small reactor beside it, the shortest conduit runs from each
# turret and engine to that, and cheap hull in every other cell of the outline.
import json
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOGUE = HERE / 'catalogue.json'
# (Designer palette indices: what a silhouette's cells mean here)
ENGINE_COLOUR = 6
POWER_ROLES_RELAY = ('conduit', 'diode', 'store', 'core')
CONSUMER_ROLES = ('weapon', 'thruster', 'tool')


class Catalogue:
    def __init__(self, path: Path = CATALOGUE):
        d = json.loads(path.read_text(encoding='utf-8'))
        self.parts: dict[str, dict] = {p['id']: p for p in d['parts']}
        self.penetration = {int(k): v for k, v in d.get('penetration', {}).items()} or {-4: 0.05, -3: 0.1, -2: 0.25, -1: 0.55, 0: 1, 1: 1.15}
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

    def role(self, pid: str) -> str:
        p = self.parts[pid]
        return (p.get('power') or {}).get('role') or 'none'

    def of(self, *, category=None, fn=None, role=None, size=None, full=True) -> list[dict]:
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
    fixed: bool = False

    def cells(self):
        return [(self.y + dy, self.x + dx) for dy in range(self.h) for dx in range(self.w)]


@dataclass
class Silhouette:
    """The outline and what is fixed in it: full grid size, every filled cell, turret cells and engine cells"""
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
        return Ship(self.sil, [Place(p.pid, p.x, p.y, p.w, p.h, p.fixed) for p in self.half])

    def mirror_of(self, p: Place) -> Place | None:
        """The left-half twin of a right-half part (None for a part across the centre line: it is its own twin)"""
        x2 = self.sil.w - 1 - (p.x + p.w - 1)
        return None if x2 == p.x else Place(p.pid, x2, p.y, p.w, p.h, p.fixed)

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
        """Inside the outline's right half, and across the centre line only evenly"""
        mid = self.sil.mid
        if x < mid:
            # (Across the centre: it must be symmetric about it)
            if x + x + w - 1 != 2 * mid:
                return False
        cells = {(y + dy, x + dx) for dy in range(h) for dx in range(w)}
        return all(c in self.sil.cells for c in cells)

    def cost(self, cat: Catalogue) -> float:
        return sum(cat.parts[p.pid]['cost'] or 0 for p in self.full())

    def to_json(self) -> dict:
        return {'silhouette': self.sil.name, 'width': self.sil.w, 'height': self.sil.h,
                'half': [[p.pid, p.x, p.y, p.w, p.h, p.fixed] for p in self.half]}


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


def cheapest_build(sil: Silhouette, cat: Catalogue, turret: str, engine: str) -> tuple[Ship, list[str]]:
    """The cheapest working ship in the outline. Returns it and notes (what could not be done)"""
    notes = []
    mid = sil.mid
    half = sil.half()
    ship = Ship(sil)
    taken = set()

    def put(pid, cell, fixed=False):
        p = cat.parts[pid]
        ship.half.append(Place(pid, cell[1], cell[0], p['w'], p['h'], fixed))
        taken.add(cell)

    for cell in sorted(c for c in sil.turrets if c[1] >= mid):
        put(turret, cell, True)
    for cell in sorted(c for c in sil.engines if c[1] >= mid):
        put(engine, cell, True)
    # (Line of sight: a turret wants open space above it, an engine below)
    for r, c in sil.turrets:
        if c >= mid and any((rr, c) in sil.cells for rr in range(r)):
            notes.append(f'Turret at row {r}, column {c - mid} has cells above it.')
    for r, c in sil.engines:
        if c >= mid and any((rr, c) in sil.cells and (rr, c) not in sil.engines for rr in range(r + 1, sil.h)):
            notes.append(f'Engine at row {r}, column {c - mid} has cells behind it.')
    depth = depth_map(sil.cells)
    centre = [c for c in half if c[1] == mid and c not in taken]
    if not centre:
        notes.append('No free cell on the centre line for the core.')
        return ship, notes
    core_cell = max(centre, key=lambda c: (depth.get(c, 0), -abs(c[0] - sil.h / 2)))
    cheapest = lambda lst: min(lst, key=lambda p: p['cost'] or 0)['id']
    put(cheapest(cat.of(fn='core', size=(1, 1))), core_cell)
    net = {core_cell}
    reactor = cheapest(cat.of(role='generator', size=(1, 1)))
    r, c = core_cell
    spot = next((n for n in ((r + 1, c), (r - 1, c), (r, c + 1)) if n in half and n not in taken), None)
    if spot:
        put(reactor, spot)
        net.add(spot)
    else:
        notes.append('No room beside the core for a reactor.')
    conduit = cheapest(cat.of(role='conduit', size=(1, 1)))
    # (Shortest runs: each consumer, nearest first, joins the network through free outline cells)
    consumers = [p for p in ship.half if p.fixed]
    consumers.sort(key=lambda p: abs(p.y - r) + abs(p.x - c))
    for p in consumers:
        start = (p.y, p.x)
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
            notes.append(f'No way to link the part at row {p.y}, column {p.x - mid} to the core.')
            continue
        cur = end
        while cur != start:
            put(conduit, cur)
            net.add(cur)
            cur = prev[cur]
    hull = cheapest(cat.of(fn='hull', size=(1, 1)))
    for cell in sorted(half - taken):
        put(hull, cell)
    return ship, notes
