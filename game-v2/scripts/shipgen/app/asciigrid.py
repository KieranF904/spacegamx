# The lettered ASCII grid a model draws a ship's right half on: x = 0 the centre column, y = 0 the nose row.
# '.' is empty, a letter is a part (A, B, C ... in build order), T is a turret on a filled cell. No Qt here: the
# designer reads and writes it, and a later pipeline can use the same functions.
#
#      0  1  2  3
#  0   .  .  .  .
#  1   A  .  .  .
#  2   A  B  B  .
#  3   T  B  .  .
import re
from collections import Counter

HALF_W, HEIGHT = 11, 32
EMPTY, TURRET = '.', 'T'


def render(parts: list[list[str]], turrets: set[tuple[int, int]] = frozenset()) -> str:
    """The grid as a prompt shows it: labelled rows and columns, a space between cells, turrets as T"""
    w = len(parts[0]) if parts else HALF_W
    lines = ['    ' + ' '.join(f'{x:>2}' for x in range(w))]
    for y, row in enumerate(parts):
        cells = [TURRET if (y, x) in turrets else row[x] for x in range(w)]
        lines.append(f'{y:>2}  ' + ' '.join(f'{c:>2}' for c in cells))
    return '\n'.join(lines)


def looks_like_grid(text: str) -> bool:
    """At least three lines that start with a row number and go on with cells (not Block[...] commands)"""
    rows = [l for l in text.splitlines() if re.match(r'^\s*\d{1,2}\s*[:|]?\s+[^\s\d\[]', l) and '[' not in l]
    return len(rows) >= 3


def parse(text: str, width: int = 0, height: int = 0) -> dict:
    """Read a model's grid, tolerantly: fences, prose, a header line, missing spaces, lowercase and short rows are
    all survivable. Returns {parts: rows of symbols, turrets: {(y, x)}, names: {symbol: name}, problems: [...]}.
    A row with the wrong number of cells is left empty and reported; a missing row is empty. Given a width or height,
    the grid is that size (rows past it are reported and dropped); else it is read from the reply"""
    problems, rows, names = [], {}, {}
    header_w = 0
    for raw in text.splitlines():
        line = raw.replace('|', ' ').rstrip()
        k = re.match(r'^\s*([A-Za-z])\s*[=:-]\s*(\S.*)$', line)
        if k and k.group(1).upper() not in (EMPTY, TURRET):
            names[k.group(1).upper()] = k.group(2).strip()
            continue
        m = re.match(r'^\s*(\d{1,2})\s*:?\s+(.*)$', line)
        if not m:
            continue
        toks = m.group(2).split()
        if toks and all(t.isdigit() for t in toks):
            header_w = len(toks) + 1
            continue
        rows[int(m.group(1))] = toks
    if not rows:
        return {'parts': [], 'turrets': set(), 'names': names, 'problems': ['no grid rows found (a row is: its number, then its cells)']}
    if not width:
        counts = Counter(len(t) for t in rows.values() if len(t) > 1)
        width = header_w or (counts.most_common(1)[0][0] if counts else HALF_W)
    if height:
        off = [y for y in rows if y >= height]
        if off:
            problems.append(f'rows {span(off)} are off the grid (rows 0 to {height - 1}); dropped')
        rows = {y: t for y, t in rows.items() if y < height}
    else:
        height = max(HEIGHT, max(rows) + 1)
    parts = [[EMPTY] * width for _ in range(height)]
    turrets: set[tuple[int, int]] = set()
    odd = set()
    for y, toks in sorted(rows.items()):
        if len(toks) == 1 and len(toks[0]) == width:
            toks = list(toks[0])
        if len(toks) != width:
            problems.append(f'row {y}: {len(toks)} cells, not {width} (left empty)')
            continue
        for x, t in enumerate(toks):
            c = t[:1].upper()
            if c == EMPTY:
                continue
            if c == TURRET:
                turrets.add((y, x))
                continue
            if not c.isalpha():
                odd.add(t)
                c = '#'
            parts[y][x] = c
    under_turrets(parts, turrets)
    if odd:
        problems.append(f'read {", ".join(sorted(odd))} as filled cells of part #')
    missing = [y for y in range(max(rows) + 1) if y not in rows] if rows else []
    if missing:
        problems.append(f'rows missing (left empty): {span(missing)}')
    return {'parts': parts, 'turrets': turrets, 'names': names, 'problems': problems}


def under_turrets(parts: list[list[str]], turrets: set[tuple[int, int]]) -> None:
    """A T hides the part under it: give it the part of the cell below, else beside, else above ('#' if alone)"""
    h, w = len(parts), len(parts[0]) if parts else 0
    for y, x in sorted(turrets):
        near = [(y + 1, x), (y, x - 1), (y, x + 1), (y - 1, x)]
        parts[y][x] = next((parts[a][b] for a, b in near if 0 <= a < h and 0 <= b < w and parts[a][b] not in (EMPTY, '#')), '#')


def rows_cols(ys, xs) -> str:
    """'row 26, column 4' or 'rows 3-5, columns 1-2'"""
    return f'row{"s" if len(ys) > 1 else ""} {span(ys)}, column{"s" if len(xs) > 1 else ""} {span(xs)}'


def span(ys: list[int]) -> str:
    """1,2,3,7 -> '1-3, 7'"""
    out, run = [], []
    for y in sorted(ys):
        if run and y != run[-1] + 1:
            out.append(f'{run[0]}-{run[-1]}' if len(run) > 1 else f'{run[0]}')
            run = []
        run.append(y)
    if run:
        out.append(f'{run[0]}-{run[-1]}' if len(run) > 1 else f'{run[0]}')
    return ', '.join(out)


def filled(parts: list[list[str]], turrets: set[tuple[int, int]]) -> set[tuple[int, int]]:
    """Every filled cell; a turret on an empty cell counts as filled (the turret check reports it)"""
    return {(y, x) for y, row in enumerate(parts) for x, c in enumerate(row) if c != EMPTY} | set(turrets)


def groups(cells: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    """4-connected groups, largest first"""
    left, out = set(cells), []
    while left:
        todo, g = [left.pop()], set()
        while todo:
            y, x = todo.pop()
            g.add((y, x))
            for nb in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if nb in left:
                    left.discard(nb)
                    todo.append(nb)
        out.append(g)
    return sorted(out, key=len, reverse=True)


def check(parts: list[list[str]], turrets: set[tuple[int, int]], names: dict[str, str] | None = None) -> list[str]:
    """A finished ship's rules: it reaches the centre column, it is one connected shape (so the mirrored ship is too),
    there are 1 or 2 turrets a side, and each turret is the top filled cell of its column"""
    names = names or {}
    nm = lambda s: f'{names[s]} ({s})' if s in names else s
    cells = filled(parts, turrets)
    if not cells:
        return ['nothing is drawn']
    out = []
    if not any(x == 0 for _y, x in cells):
        out.append('Nothing is in column 0 (the centre line), so the two halves do not meet.')
    for g in groups(cells)[1:]:
        ys = sorted({y for y, _x in g})
        xs = sorted({x for _y, x in g})
        syms = sorted({parts[y][x] if parts[y][x] != EMPTY else TURRET for y, x in g})
        out.append(f'{" and ".join(nm(s) for s in syms)} at {rows_cols(ys, xs)} do{"es" if len(g) == 1 else ""} not touch the rest of the ship.')
    if not 1 <= len(turrets) <= 2:
        out.append(f'{len(turrets)} turrets a side; the ship wants 1 or 2.')
    for y, x in sorted(turrets):
        if parts[y][x] in (EMPTY, '#'):
            out.append(f'Turret at row {y}, column {x} is not on a part.')
        above = [yy for yy in range(y) if parts[yy][x] != EMPTY or (yy, x) in turrets]
        if above:
            out.append(f'Turret at row {y}, column {x} has filled cells above it in column {x} (rows {span(above)}). A turret must be the top filled cell of its column.')
    return out


def rectangles(parts: list[list[str]]) -> list[tuple[str, int, int, int, int]]:
    """Each part's cells as rectangles, greedily: the next free cell (top to bottom, left to right), as wide as it
    goes, then as deep as that whole width goes. (symbol, y, x, w, h), parts in the order they first appear"""
    taken: set[tuple[int, int]] = set()
    out = []
    order = []
    for row in parts:
        for c in row:
            if c != EMPTY and c not in order:
                order.append(c)
    for s in order:
        for y, row in enumerate(parts):
            for x, c in enumerate(row):
                if c != s or (y, x) in taken:
                    continue
                w = 1
                while x + w < len(row) and row[x + w] == s and (y, x + w) not in taken:
                    w += 1
                h = 1
                while y + h < len(parts) and all(parts[y + h][xx] == s and (y + h, xx) not in taken for xx in range(x, x + w)):
                    h += 1
                taken |= {(yy, xx) for yy in range(y, y + h) for xx in range(x, x + w)}
                out.append((s, y, x, w, h))
    return out


def pieces(parts: list[list[str]], turrets: set[tuple[int, int]], names: dict[str, str] | None = None) -> str:
    """Block[y,x,w,h] per rectangle under a '# A = Name' line per part, then Turret[y,x] per turret"""
    names = names or {}
    lines, last = [], None
    for s, y, x, w, h in rectangles(parts):
        if s != last:
            lines.append(f'# {s} = {names.get(s, "part " + s)}')
            last = s
        lines.append(f'Block[{y},{x},{w},{h}]')
    if turrets:
        lines.append('# T = Turret')
        lines += [f'Turret[{y},{x}]' for y, x in sorted(turrets)]
    return '\n'.join(lines)
