import { describe, it, expect } from 'vitest';
import { placeGeometry, gunFacing, partNeedsFacing } from '@space-game/common';
import type { PlacedPart } from '@space-game/common';
import { testCatalog } from '../../../../common/src/ships/testData';
import { escapeStep, partUnder, tryTurn, turnProblem } from './editPlaced';

const catalog = testCatalog();
const part = (over: Partial<PlacedPart> & { uid: number }): PlacedPart => ({ piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false, ...over });
const cellsOf = (p: PlacedPart) => placeGeometry(catalog, p).cells.map((c) => `${c[0]},${c[1]}`);
const twin = (piece = 'rect2') => part({ uid: 1, piece, fn: 'cannon_twinlink', facing: gunFacing(catalog, { fn: 'cannon_twinlink', piece, rot: 0, flip: false })! });

describe('partUnder', () => {
  it('finds the part whose footprint holds the point, and -1 elsewhere', () => {
    const parts = [part({ uid: 1, piece: 'rect2', x: 3, y: 3 }), part({ uid: 2, x: 0, y: 0 })];
    expect(partUnder(catalog, parts, [3.5, 3.5])).toBe(0);
    expect(partUnder(catalog, parts, [4.5, 3.5])).toBe(0);
    expect(partUnder(catalog, parts, [0.4, 0.6])).toBe(1);
    expect(partUnder(catalog, parts, [9, 9])).toBe(-1);
  });
});

describe('turning a part in place keeps the cell under the cursor', () => {
  for (const piece of ['sq', 'rect2', 'block2', 'block3']) {
    for (const op of ['rot', 'flip'] as const) {
      it(`${piece} ${op}: every cell stays put when the cursor is on it, in all eight orientations`, () => {
        const base = part({ uid: 1, piece, x: 7, y: -4 });
        for (const flip of [false, true]) for (const rot of [0, 1, 2, 3] as const) {
          const p = { ...base, rot, flip };
          for (const c of cellsOf(p)) {
            const [cx, cy] = c.split(',').map(Number);
            const r = tryTurn(catalog, [p], 0, op, [cx + 0.5, cy + 0.5]);
            if ('problem' in r) throw new Error(r.problem);
            expect(r.part.uid).toBe(1);
            expect(cellsOf(r.part)).toContain(c);
            expect(r.part.rot).toBe(op === 'rot' ? (rot + 1) % 4 : rot);
            expect(r.part.flip).toBe(op === 'flip' ? !flip : flip);
          }
        }
      });
    }
  }

  it('a quarter turn of a 2-wide piece about its origin cell leaves the origin; about the far cell the far cell stays', () => {
    const p = part({ uid: 1, piece: 'rect2', x: 0, y: 0 });
    const a = tryTurn(catalog, [p], 0, 'rot', [0.5, 0.5]);
    const b = tryTurn(catalog, [p], 0, 'rot', [1.5, 0.5]);
    if ('problem' in a || 'problem' in b) throw new Error('refused');
    expect([a.part.x, a.part.y]).toEqual([0, 0]);
    expect(cellsOf(a.part)).toEqual(['0,0', '0,1']);
    expect(cellsOf(b.part)).toContain('1,0');
  });
});

describe('refusals', () => {
  it('a turn whose new footprint overlaps another part is refused and says why', () => {
    const p = part({ uid: 1, piece: 'rect2', x: 0, y: 0 });
    const parts = [p, part({ uid: 2, x: 0, y: 1 })];
    expect(tryTurn(catalog, parts, 0, 'rot', [0.5, 0.5])).toEqual({ problem: expect.stringContaining('overlaps another part') });
    // (Mirroring it keeps the same footprint: nothing in the way)
    expect('part' in tryTurn(catalog, parts, 0, 'flip', [0.5, 0.5])).toBe(true);
  });

  it('a part joined to the ship may not turn into a place where it joins nothing', () => {
    const a = part({ uid: 1, piece: 'rect2', x: 0, y: 0 }), b = part({ uid: 2, x: 2, y: 0 });
    // (turned about its left cell it stands up and no longer touches b)
    expect(tryTurn(catalog, [a, b], 0, 'rot', [0.5, 0.5])).toEqual({ problem: expect.stringContaining('no longer join') });
  });

  it('T on a part with no facing says so, and on a gun points at R', () => {
    expect(tryTurn(catalog, [part({ uid: 1 })], 0, 'face', [0.5, 0.5])).toEqual({ problem: expect.stringContaining('no facing') });
    expect(tryTurn(catalog, [twin()], 0, 'face', [0.5, 0.5])).toEqual({ problem: expect.stringContaining('turn it with R') });
  });
});

describe('facing rules', () => {
  it("a fixed-barrel gun's facing follows its turn and mirror", () => {
    let g = twin();
    for (const op of ['rot', 'flip', 'rot', 'rot', 'flip'] as const) {
      const r = tryTurn(catalog, [g], 0, op, [g.x + 0.5, g.y + 0.5]);
      if ('problem' in r) throw new Error(r.problem);
      g = r.part;
      expect(g.facing).toBe(gunFacing(catalog, g));
    }
  });

  it('a free facing turns with the part, and T moves it to a side that is open', () => {
    const t = part({ uid: 1, piece: 'rect2', fn: 'thruster', facing: 'S' });
    expect(partNeedsFacing('thruster')).toBe(true);
    const r = tryTurn(catalog, [t], 0, 'rot', [0.5, 0.5]);
    if ('problem' in r) throw new Error(r.problem);
    expect(r.part.facing).toBe('W');
    const m = tryTurn(catalog, [t], 0, 'flip', [0.5, 0.5]);
    if ('problem' in m) throw new Error(m.problem);
    expect(m.part.facing).toBe('S');
    const f = tryTurn(catalog, [t], 0, 'face', [0.5, 0.5]);
    if ('problem' in f) throw new Error(f.problem);
    expect(f.part.facing).not.toBe('S');
    expect(turnProblem(catalog, [t], 0, f.part)).toBeNull();
  });

  it("a turn that walls up a gun's clear lane is refused, never accepted", () => {
    const gun = part({ uid: 1, piece: 'rect2', fn: 'cannon_longbarrel', x: 0, y: 0, facing: gunFacing(catalog, { fn: 'cannon_longbarrel', piece: 'rect2', rot: 0, flip: false })! });
    const back = part({ uid: 2, x: 0, y: 1 });
    const lane = new Set(['0,-1', '0,-2', '0,-3', '1,-1', '1,-2', '1,-3']);
    let refused = 0;
    for (let hx = -4; hx <= 4; hx++) for (let hy = -6; hy <= -1; hy++) for (const rot of [0, 1, 2, 3] as const) {
      const hull = part({ uid: 3, piece: 'rect2', x: hx, y: hy, rot });
      if (cellsOf(hull).some((c) => lane.has(c))) continue;
      const r = tryTurn(catalog, [gun, back, hull], 2, 'rot', [hx + 0.5, hy + 0.5]);
      if ('part' in r) expect(cellsOf(r.part).some((c) => lane.has(c))).toBe(false);
      else if (!r.problem.includes('overlaps')) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe('Escape', () => {
  it('puts a part in hand away first, then closes', () => {
    let empty = false, closed = false;
    const esc = () => { if (escapeStep(empty) === 'close') closed = true; else empty = true; };
    esc();
    expect([empty, closed]).toEqual([true, false]);
    esc();
    expect([empty, closed]).toEqual([true, true]);
  });
});
