# python -m pytest scripts/shipgen/app/test_asciigrid.py   (or run it directly)
import random

import asciigrid as ag


def blank(w=11, h=32):
    return [['.'] * w for _ in range(h)]


def ship():
    p = blank()
    for y in range(4, 20):
        p[y][0] = 'A'
    for y in range(6, 18):
        p[y][1] = 'A'
    for y in range(10, 15):
        for x in range(2, 6 - (y - 10) // 2):
            p[y][x] = 'B'
    return p


def test_round_trip():
    p, t = ship(), {(10, 2)}
    g = ag.parse(ag.render(p, t))
    assert g['parts'] == p and g['turrets'] == t and not g['problems']


def test_messy_model_output():
    text = """Sure! Here is the grid:
```
     0  1  2
 0   .  .  .
 1   a  .  .
 2   AB.
 3   A  B  T
 4   A
```
A = Fuselage
B: Wing
Hope that helps."""
    g = ag.parse(text)
    assert g['parts'][1][:3] == ['A', '.', '.']
    assert g['parts'][2][:3] == ['A', 'B', '.']
    assert g['turrets'] == {(3, 2)}
    assert g['parts'][4] == ['.'] * 3
    assert g['names'] == {'A': 'Fuselage', 'B': 'Wing'}
    assert any('row 4' in p for p in g['problems'])


def test_checks():
    p = ship()
    assert ag.check(p, {(6, 1)}) == []
    off = [row[:] for row in p]
    off[25][7] = 'C'
    assert 'C at row 25, column 7 does not touch the rest of the ship.' in ag.check(off, {(6, 1)})
    assert any('above it' in e for e in ag.check(p, {(12, 1)}))
    shifted = [['.'] + row[:-1] for row in p]
    assert any('column 0' in e for e in ag.check(shifted, {(6, 2)}))
    assert any('turrets a side' in e for e in ag.check(p, set()))


def test_rectangles_cover_exactly():
    rnd = random.Random(3)
    for _ in range(200):
        p = [[rnd.choice('..AB') for _ in range(6)] for _ in range(7)]
        seen = {}
        for s, y, x, w, h in ag.rectangles(p):
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    assert p[yy][xx] == s and (yy, xx) not in seen
                    seen[(yy, xx)] = s
        assert set(seen) == {(y, x) for y, row in enumerate(p) for x, c in enumerate(row) if c != '.'}


def test_enforce():
    before = [list('A..'), list('AB.'), list('...')]
    after = [list('AA.'), list('.BC'), list('Z..')]
    names = {'A': 'Hull', 'B': 'Wing'}
    # everything allowed, A and B editable; C and Z not in the key
    out, t, probs = ag.enforce(before, set(), after, set(), {'A', 'B'}, {'A', 'B'}, set(ag.ACTIONS), names)
    assert out == [list('AA.'), list('.B.'), list('...')]
    assert sorted(p.split(' ')[0] for p in probs) == ['C', 'Z']
    # add only, and only A: the emptied A comes back
    out, t, probs = ag.enforce(before, set(), after, set(), {'A', 'B', 'C', 'Z'}, {'A'}, {'add'}, names)
    assert out == [list('AA.'), list('AB.'), list('...')]
    assert any(p.startswith('Removing cells is not allowed') for p in probs)
    assert any(p.startswith('You may not draw C') for p in probs)
    # turrets locked
    out, t, probs = ag.enforce(before, {(0, 0)}, before, {(1, 1)}, {'A', 'B'}, {'A', 'B'}, {'add'}, names)
    assert t == {(0, 0)} and any('turrets' in p for p in probs)


def test_l_shape():
    p = [list('A..'), list('A..'), list('AAA')]
    assert ag.rectangles(p) == [('A', 0, 0, 1, 3), ('A', 2, 1, 2, 1)]


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn()
    print('ok')
