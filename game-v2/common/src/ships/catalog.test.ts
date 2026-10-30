import { describe, it, expect } from 'vitest';
import type { PieceDef, PlacedPart, Rot, Vec2 } from './types.js';
import { CatalogError, loadCatalog, transformPoint, getVariant } from './catalog.js';
import { computeJoins, partsOverlap, placeGeometry } from './grid.js';
import { readCatalogFiles, testCatalog } from './testData.js';

const catalog = testCatalog();

let uid = 0;
function part(piece: string, x: number, y: number, rot: Rot = 0, flip = false): PlacedPart {
  return { uid: uid++, piece, fn: 'hull', material: 'alloy', x, y, rot, flip };
}
const geom = (p: PlacedPart) => placeGeometry(catalog, p);
const overlap = (a: PlacedPart, b: PlacedPart) => partsOverlap(geom(a), geom(b));
const joined = (a: PlacedPart, b: PlacedPart) => computeJoins([geom(a), geom(b)]).length === 1;

const EXPECTED_AREA: Record<string, number> = {
  sq: 1, rect2: 2, tri: 0.5, slope2: 1, cap: Math.PI / 2, round: Math.PI / 4,
  fillet: 1 - Math.PI / 4, block2: 4, block3: 9, round2: Math.PI, fillet2: 4 - Math.PI, nose2: 2,
};

describe('catalog loader (M1)', () => {
  it('loads every piece in all 8 variants with the catalog areas', () => {
    // (Designs' own bespoke pieces aren't the pilots' catalogue: bespoke.test.ts)
    expect([...catalog.pieceIds].sort()).toEqual(Object.keys(EXPECTED_AREA).sort());
    for (const [id, variants] of catalog.variants) {
      if (catalog.pieces.get(id)!.bespoke) continue;
      expect(variants).toHaveLength(8);
      for (const v of variants) {
        expect(v.area).toBeCloseTo(EXPECTED_AREA[id], 9);
        expect(v.convexShrunk.length).toBeGreaterThan(0);
        expect(v.cells).toHaveLength(catalog.pieces.get(id)!.cells.length);
      }
    }
  });

  it('variant round-trip: inverse transform restores the base shape', () => {
    const key = (p: Vec2) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    for (const [, variants] of catalog.variants) {
      const base = new Set(variants[0].polygon.map(key));
      const baseCells = new Set(variants[0].cells.map(key));
      for (const v of variants) {
        // Forward is mirror-then-rotate, so the inverse is rotate-back-then-mirror.
        const back = (p: Vec2) => transformPoint(transformPoint(p, ((4 - v.rot) % 4) as Rot, false), 0, v.flip);
        expect(new Set(v.polygon.map((p) => key(back(p))))).toEqual(base);
        const cellsBack = v.cells.map((c) => {
          const centre = back([c[0] + 0.5, c[1] + 0.5]);
          return [Math.floor(centre[0]), Math.floor(centre[1])] as Vec2;
        });
        expect(new Set(cellsBack.map(key))).toEqual(baseCells);
      }
    }
  });

  it('four quarter turns and two mirrors are the identity', () => {
    const p: Vec2 = [0.25, 0.75];
    let q = p;
    for (let i = 0; i < 4; i++) q = transformPoint(q, 1, false);
    expect(q).toEqual(p);
    expect(transformPoint(transformPoint(p, 0, true), 0, true)).toEqual(p);
  });

  it('every connector is still a straight outline edge in every variant', () => {
    for (const [, variants] of catalog.variants) {
      for (const v of variants) {
        expect(v.connectors.length).toBe(catalog.pieces.get(v.pieceId)!.connectors.length);
      }
    }
  });
});

describe('overlap test (M1)', () => {
  it('two triangles share a cell along the diagonal and join through it', () => {
    const a = part('tri', 0, 0, 0);       // lower-left half
    const b = part('tri', 0, 0, 2);       // upper-right half
    expect(overlap(a, b)).toBe(false);
    expect(joined(a, b)).toBe(true);
    expect(geom(a).area + geom(b).area).toBeCloseTo(1, 9);
  });

  it('a quarter-round and its fillet make a full square', () => {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      for (const flip of [false, true]) {
        const r = part('round', 3, 3, rot, flip);
        const f = part('fillet', 3, 3, rot, flip);
        expect(overlap(r, f)).toBe(false);
        expect(geom(r).area + geom(f).area).toBeCloseTo(1, 9);
      }
    }
    const r2 = part('round2', 0, 0);
    const f2 = part('fillet2', 0, 0);
    expect(overlap(r2, f2)).toBe(false);
    expect(geom(r2).area + geom(f2).area).toBeCloseTo(4, 9);
  });

  it('same-side pieces do overlap', () => {
    expect(overlap(part('tri', 0, 0, 0), part('tri', 0, 0, 0))).toBe(true);
    expect(overlap(part('tri', 0, 0, 0), part('tri', 0, 0, 1))).toBe(true);
    expect(overlap(part('round', 0, 0), part('round', 0, 0))).toBe(true);
    expect(overlap(part('fillet', 0, 0), part('fillet', 0, 0))).toBe(true);
    expect(overlap(part('sq', 0, 0), part('tri', 0, 0))).toBe(true);
    expect(overlap(part('round', 0, 0), part('fillet', 0, 0, 2))).toBe(true);
    expect(overlap(part('rect2', 0, 0), part('sq', 1, 0))).toBe(true);
    expect(overlap(part('cap', 0, 0), part('round', 1, 0))).toBe(true);
  });

  it('pieces that only touch along an edge do not overlap', () => {
    expect(overlap(part('sq', 0, 0), part('sq', 1, 0))).toBe(false);
    expect(overlap(part('sq', 0, 0), part('sq', 1, 1))).toBe(false);
    expect(overlap(part('rect2', 0, 0), part('cap', 0, -1))).toBe(false);
    // Rotations pivot on the origin cell, so the complementary 2-cell slope sits at x = 1
    expect(overlap(part('slope2', 0, 0), part('slope2', 1, 0, 2))).toBe(false);
  });
});

describe('connector matching (M1)', () => {
  it('joins neighbouring full edges from opposite sides', () => {
    expect(joined(part('sq', 0, 0), part('sq', 1, 0))).toBe(true);
    expect(joined(part('sq', 0, 0), part('sq', 0, 1))).toBe(true);
    expect(joined(part('rect2', 0, 0), part('cap', 0, -1))).toBe(true);
    expect(joined(part('round', 1, 0, 0), part('sq', 0, 0))).toBe(true);
  });

  it('does not join across gaps, corners, curves or hypotenuses', () => {
    expect(joined(part('sq', 0, 0), part('sq', 2, 0))).toBe(false);
    expect(joined(part('sq', 0, 0), part('sq', 1, 1))).toBe(false);
    // round rot 2 keeps its curve towards the square on its west
    expect(joined(part('sq', 0, 0), part('round', 1, 0, 2))).toBe(false);
    // slope2's hypotenuse is not a connector
    expect(joined(part('slope2', 0, 1), part('rect2', 0, 0))).toBe(false);
  });

  it('cap joins rect2 on both flat edges but counts as one join', () => {
    const joins = computeJoins([geom(part('rect2', 0, 0)), geom(part('cap', 0, -1))]);
    expect(joins).toEqual([[0, 1]]);
  });
});

describe('catalog rules fail loudly (M1)', () => {
  const withPiece = (p: PieceDef) => {
    const files = readCatalogFiles();
    files.pieces = { ...files.pieces, pieces: [...files.pieces.pieces, p] };
    return () => loadCatalog(files);
  };
  const sq = (): PieceDef => JSON.parse(JSON.stringify(catalog.pieces.get('sq')));

  it('names a piece whose arc centre is off the grid', () => {
    const bad: PieceDef = { ...JSON.parse(JSON.stringify(catalog.pieces.get('round'))), id: 'badArc' };
    (bad.outline[1] as any).c = [0.5, 1];
    expect(withPiece(bad)).toThrow(/badArc/);
  });

  it('names a piece with a connector on a curve', () => {
    const bad: PieceDef = { ...JSON.parse(JSON.stringify(catalog.pieces.get('round'))), id: 'curveConn' };
    bad.connectors.push({ cell: [0, 0], side: 'E' });
    expect(withPiece(bad)).toThrow(/curveConn.*not a full straight edge/);
  });

  it('names a piece with an off-grid straight edge', () => {
    const bad = { ...sq(), id: 'offGrid' };
    (bad.outline[0] as any).b = [1, 0.5];
    (bad.outline[1] as any).a = [1, 0.5];
    expect(withPiece(bad)).toThrow(CatalogError);
    expect(withPiece(bad)).toThrow(/offGrid/);
  });

  it('names a piece whose outline leaves its cells', () => {
    const bad = { ...sq(), id: 'leaky', cells: [[0, 0]] as Vec2[] };
    bad.outline = [
      { type: 'line', a: [0, 0], b: [2, 0] }, { type: 'line', a: [2, 0], b: [2, 1] },
      { type: 'line', a: [2, 1], b: [0, 1] }, { type: 'line', a: [0, 1], b: [0, 0] },
    ];
    bad.connectors = [];
    expect(withPiece(bad)).toThrow(/leaky.*outside/);
  });

  it('names a piece with an open outline', () => {
    const bad = { ...sq(), id: 'open' };
    bad.outline = bad.outline.slice(0, 3);
    bad.connectors = [];
    expect(withPiece(bad)).toThrow(/open.*not closed/);
  });
});

describe('variants keep connectors in place', () => {
  it('tri rot 2 has its legs on N and E', () => {
    const v = getVariant(catalog, 'tri', 2, false);
    const sides = v.connectors.filter((c) => 'side' in c).map((c: any) => c.side).sort();
    expect(sides).toEqual(['E', 'N']);
  });
});
