# Scores from part stats alone: no physics. Three measures, and a scenario (scenarios.json) that weighs them.
#
#   Power: a flow over the parts that touch. Reactors make E/s; relays (conduits, diodes, stores, the core) pass up to
#   what they can give (a Diode only out of its facing edge); weapons, engines and shields take what they use, all at
#   the same priority (shared max-min fairly). Sustained is reactors alone; a burst (10 s) adds what the stores hold.
#   A part's "fed" share is what reaches it over what it uses, so its damage per second (or thrust) is its catalogue
#   number times that.
#   Hits: shots from the scenario's directions travel in straight lines across the grid and land on the first part
#   still standing, for damage × the game's penetration table (weapon pen − block armour) × the material's resist.
#   A part is gone when its HP is; the power is worked out again then. The run ends when the core goes.
#   Damage before going down: the ship's damage per second, as it stands after each hit, added up over the time the
#   hits took. A glass cannon dies fast; a well-armoured ship with starved guns barely shoots; one whose power lines
#   are behind armour keeps firing.
import math
import random
from collections import defaultdict, deque

from model import CONSUMER_ROLES, RELAY_ROLES, SIDES, SOURCE_ROLES, Catalogue, Ship

INF = float('inf')
BURST_S = 10.0


def neighbours_of(parts: list, cell_owner: dict) -> list[set]:
    """For each part, the parts touching it (sharing an edge)"""
    out = [set() for _ in parts]
    for i, p in enumerate(parts):
        for (r, c) in p.cells():
            for n in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                j = cell_owner.get(n)
                if j is not None and j != i:
                    out[i].add(j)
    return out


def max_flow(cap: dict, s, t, flow=None) -> tuple[float, dict]:
    """Edmonds-Karp on cap {u: {v: capacity}}, from a flow already in place if given. Returns the flow added and
    the flow on each edge"""
    flow = flow if flow is not None else defaultdict(lambda: defaultdict(float))
    total = 0.0
    while True:
        prev, q = {s: None}, deque([s])
        while q and t not in prev:
            u = q.popleft()
            for v, c in cap.get(u, {}).items():
                if v not in prev and c - flow[u][v] > 1e-9:
                    prev[v] = u
                    q.append(v)
        if t not in prev:
            return total, flow
        # (The bottleneck along the path, then push it)
        v, b = t, INF
        while prev[v] is not None:
            u = prev[v]
            b = min(b, cap[u][v] - flow[u][v])
            v = u
        v = t
        while prev[v] is not None:
            u = prev[v]
            flow[u][v] += b
            flow[v][u] -= b
            v = u
        total += b


def power(cat: Catalogue, parts: list, alive: list, nbrs: list, burst: bool, cell_owner: dict | None = None) -> dict:
    """Fed share per consumer, and the flow through each relay or reactor. Every consumer has the same priority: the
    power is shared max-min fairly (each gets the same share of what it uses, unless what feeds it runs out first; then
    the rest share what is left). So a gun starves an engine only through the ship's layout, never by rank.
    A Diode gives only across its facing edge and takes from every other (power/layout.ts's oneWay)"""
    S, T = 'S', 'T'
    role = [cat.role(p.pid) for p in parts]
    # (A Diode's out side: the part across its facing edge)
    out = {}
    if cell_owner is not None:
        for i, p in enumerate(parts):
            if role[i] == 'diode' and p.facing:
                dr, dc = SIDES[p.facing]
                for (r, c) in p.cells():
                    j = cell_owner.get((r + dr, c + dc))
                    if j is not None and j != i:
                        out[i] = j
                        break
    may = lambda x, y: (role[x] != 'diode' or out.get(x) == y) and (role[y] != 'diode' or out.get(y) != x)
    base = defaultdict(dict)
    uses = {}
    for i, p in enumerate(parts):
        if not alive[i]:
            continue
        pw = cat.parts[p.pid].get('power') or {}
        rl = role[i]
        if rl in SOURCE_ROLES:
            base[S][('o', i)] = pw.get('makes', 0) or 0
        elif rl in RELAY_ROLES:
            base[('i', i)][('o', i)] = pw.get('gives', 0) or 0
            if burst and pw.get('holds'):
                base[S][('i', i)] = pw['holds'] / BURST_S
        elif rl in CONSUMER_ROLES:
            if (pw.get('uses') or 0) > 0:
                uses[i] = pw['uses']
            continue
        else:
            continue
        for j in nbrs[i]:
            if alive[j] and (role[j] in RELAY_ROLES or role[j] in CONSUMER_ROLES) and may(i, j):
                base[('o', i)][('i', j)] = INF

    def run(level: dict):
        cap = defaultdict(dict, {u: dict(v) for u, v in base.items()})
        for i, amt in level.items():
            cap[('i', i)][T] = amt
        for u in list(cap):
            for v in list(cap[u]):
                cap[v].setdefault(u, 0.0)
        total, flow = max_flow(cap, S, T)
        return total, flow, cap

    # (Progressive filling: raise everyone still growing together; whoever can't grow past a level stays there)
    frozen: dict = {}
    active = set(uses)
    lam = 0.0
    flow = cap = None
    while active:
        want = lambda x: {**frozen, **{i: x * uses[i] for i in active}}
        need = lambda x: sum(want(x).values())
        tot, f, c = run(want(1.0))
        if tot >= need(1.0) - 1e-6:
            flow, cap = f, c
            frozen.update({i: uses[i] for i in active})
            break
        lo, hi = lam, 1.0
        best = run(want(lo))
        for _ in range(7):
            mid = (lo + hi) / 2
            tot, f, c = run(want(mid))
            if tot >= need(mid) - 1e-6:
                lo, best = mid, (tot, f, c)
            else:
                hi = mid
        _t, flow, cap = best
        # (Who can still grow: reachable from the sources in what is left of the graph)
        seen, q = {S}, deque([S])
        while q:
            u = q.popleft()
            for v, cv in cap.get(u, {}).items():
                if v not in seen and cv - flow[u][v] > 1e-9:
                    seen.add(v)
                    q.append(v)
        stuck = [i for i in active if ('i', i) not in seen] or list(active)
        for i in stuck:
            frozen[i] = lo * uses[i]
            active.discard(i)
        lam = lo
    if flow is None:
        _t, flow, cap = run(frozen)
    fed, through = {}, {}
    for i, p in enumerate(parts):
        if not alive[i]:
            continue
        if role[i] in CONSUMER_ROLES:
            fed[i] = 1.0 if i not in uses else min(1.0, flow[('i', i)][T] / uses[i])
        elif role[i] in RELAY_ROLES:
            through[i] = flow[('i', i)][('o', i)]
        elif role[i] in SOURCE_ROLES:
            through[i] = flow[S][('o', i)]
    return {'fed': fed, 'through': through}


def output(cat: Catalogue, parts: list, fed: dict) -> tuple[float, float]:
    """Damage per second and thrust, each part at its fed share"""
    dps = thrust = 0.0
    for i, f in fed.items():
        p = cat.parts[parts[i].pid]
        dps += (p.get('dps') or 0) * f
        thrust += (p.get('thrust') or 0) * f
    return dps, thrust


def directions(spec: str, spread: float, rng: random.Random) -> tuple[float, float]:
    """A shot's travel direction (x right, y down: row 0 is the nose). 'front': coming at the nose (travelling down)"""
    base = {'front': 90, 'rear': 270, 'left': 0, 'right': 180, 'sides': rng.choice((0, 180))}.get(spec)
    a = rng.uniform(0, 360) if base is None else base + rng.uniform(-spread, spread)
    return math.cos(math.radians(a)), math.sin(math.radians(a))


def hits_run(cat: Catalogue, parts: list, nbrs: list, cell_owner: dict, inc: dict, seed: int, base_dps: float) -> dict:
    """One run of incoming hits until the core goes (or the cap). Returns seconds alive, seconds until the guns are
    down to half, and the damage dealt meanwhile"""
    rng = random.Random(seed)
    hp = [cat.parts[p.pid]['hp'] for p in parts]
    alive = [True] * len(parts)
    owner = dict(cell_owner)
    core = [i for i, p in enumerate(parts) if cat.parts[p.pid]['fn'] == 'core']
    dmg, pen, kind = inc.get('damage', 40), inc.get('pen', 2), inc.get('type', 'kinetic')
    dt = dmg / max(1e-6, inc.get('dps', 100))
    cells = list(owner)
    cy = sum(r for r, _c in cells) / len(cells) + 0.5
    cx = sum(c for _r, c in cells) / len(cells) + 0.5
    reach = max(math.hypot(r + 0.5 - cy, c + 0.5 - cx) for r, c in cells) + 2
    cur_dps = base_dps
    t = dealt = 0.0
    half_at = None
    for n in range(inc.get('max_hits', 3000)):
        dx, dy = directions(inc.get('from', 'all'), inc.get('spread', 45), rng)
        off = rng.uniform(-reach, reach)
        x, y = cx - dx * reach - dy * off, cy - dy * reach + dx * off
        hit = None
        for _k in range(int(reach * 2 / 0.4) + 2):
            j = owner.get((math.floor(y), math.floor(x)))
            if j is not None:
                hit = j
                break
            x += dx * 0.4
            y += dy * 0.4
        t += dt
        dealt += cur_dps * dt
        if hit is None:
            continue
        p = cat.parts[parts[hit].pid]
        hp[hit] -= dmg * cat.pen_mul(pen - p['armour']) * (p.get('resist') or {}).get(kind, 1)
        if hp[hit] > 0:
            continue
        alive[hit] = False
        for c in parts[hit].cells():
            if owner.get(c) == hit:
                del owner[c]
        if hit in core:
            break
        if cat.role(parts[hit].pid) != 'none':
            cur_dps, _th = output(cat, parts, power(cat, parts, alive, nbrs, False, cell_owner)['fed'])
            if half_at is None and cur_dps < base_dps * 0.5:
                half_at = t
    return {'alive_s': t, 'half_s': half_at if half_at is not None else t, 'dealt': dealt}


def measure(cat: Catalogue, ship: Ship, scenario: dict, check: dict | None = None, seeds=(1, 2, 3)) -> dict:
    """Everything a scenario can weigh, for one ship. check: the game validator's answer (Validator.check)"""
    parts = ship.full()
    cell_owner = {}
    for i, p in enumerate(parts):
        for c in p.cells():
            cell_owner[c] = i
    nbrs = neighbours_of(parts, cell_owner)
    alive = [True] * len(parts)
    sus = power(cat, parts, alive, nbrs, False, cell_owner)
    bur = power(cat, parts, alive, nbrs, True, cell_owner)
    s_dps, s_thrust = output(cat, parts, sus['fed'])
    b_dps, _b = output(cat, parts, bur['fed'])
    mass = sum(cat.parts[p.pid]['mass'] for p in parts)
    cargo = sum(cat.parts[p.pid].get('cargo') or 0 for p in parts)
    cost = sum(cat.parts[p.pid]['cost'] or 0 for p in parts)
    # (Not doing anything: a gun, engine or shield that gets under a quarter of its power even in a burst, and a
    # relay or reactor no power goes through)
    unpowered = [i for i, f in bur['fed'].items() if f < 0.25]
    idle = [i for i, f in bur['through'].items() if f <= 1e-6]
    inc = scenario.get('incoming', {})
    runs = [hits_run(cat, parts, nbrs, cell_owner, inc, s, s_dps) for s in seeds] if inc else []
    avg = lambda k: sum(r[k] for r in runs) / len(runs) if runs else 0.0
    return {
        'sustained_dps': s_dps, 'burst_dps': b_dps, 'thrust': s_thrust, 'thrust_to_mass': s_thrust / mass if mass else 0,
        'mass': mass, 'cargo': cargo, 'cost': cost, 'parts': len(parts),
        'alive_s': avg('alive_s'), 'half_s': avg('half_s'), 'damage_before_down': avg('dealt'),
        'unpowered': len(unpowered), 'idle': len(idle),
        'fed': {i: f for i, f in sus['fed'].items()}, 'unpowered_ids': unpowered, 'idle_ids': idle,
        'points': (check or {}).get('points', sum(cat.parts[p.pid].get('points', 1) for p in parts)),
        'valid': (check or {}).get('valid', True), 'errors': (check or {}).get('errors', []),
    }


METRICS = {
    'damage_before_down': 'damage dealt before the core goes',
    'alive_s': 'seconds until the core goes',
    'half_s': 'seconds until its guns are down to half',
    'sustained_dps': 'damage per second, reactors alone',
    'burst_dps': 'damage per second over a 10 s burst',
    'thrust_to_mass': 'thrust for its mass',
    'cargo': 'cargo space',
}


# (What counts as 1 for a measure the starting ship has none of)
ZERO_SCALE = {'cargo': 100.0, 'sustained_dps': 50.0, 'burst_dps': 50.0, 'damage_before_down': 1000.0, 'thrust_to_mass': 0.5}


def fitness(scenario: dict, m: dict, base: dict) -> tuple[float, list]:
    """The scenario's weighted sum, each measure against the starting ship's (so 1 = as good as the start), less the
    penalties. Over the budget (credits) or the level's build points costs heavily, and a ship the game's validator
    turns down scores below any it accepts. Returns the score and its terms for the panel"""
    terms = []
    total = 0.0
    for k, w in scenario.get('weights', {}).items():
        if not w or k not in m:
            continue
        # (Against the start; a measure the start has none of (a hauler's cargo) against a fixed scale)
        ref = base.get(k) or ZERO_SCALE.get(k, 1.0)
        v = w * m[k] / ref
        terms.append((k, w, m[k], v))
        total += v
    for k, w in scenario.get('penalties', {}).items():
        if w and k in m:
            v = -w * m[k]
            terms.append((k, -w, m[k], v))
            total += v
    for name, have, limit in (('over budget', m['cost'], scenario.get('budget')), ('over build points', m['points'], scenario.get('points'))):
        if limit and have > limit:
            v = -10 * (have / limit - 1) - 1
            terms.append((name, 0, have, v))
            total += v
    if not m.get('valid', True):
        v = -5 - 0.2 * len(m.get('errors', []))
        terms.append(('not valid in the game', 0, len(m.get('errors', [])), v))
        total += v
    return total, terms
