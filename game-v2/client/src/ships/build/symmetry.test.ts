import { describe, it, expect } from 'vitest';
import { placeGeometry, gunFacing } from '@space-game/common';
import type { PlacedPart, Rot } from '@space-game/common';
import { testCatalog } from '../../../../common/src/ships/testData';
import { axisOf, mirrorPart, mirrorPoint, mirrorSide, onAxis } from './symmetry';

const catalog = testCatalog();
const part = (over: Partial<PlacedPart> = {}): PlacedPart => ({ uid: 1, piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false, ...over });
const verts = (p: PlacedPart, reflect?: number) =>
  placeGeometry(catalog, p).polygon
    .map((v) => `${Math.round((reflect === undefined ? v[0] : reflect - v[0]) * 1e4)},${Math.round(v[1] * 1e4)}`).sort();

describe('axisOf', () => {
  it("is the core's middle, twice over", () => {
    const parts = [part({ uid: 0, fn: 'core', x: 3, y: 2 }), part({ uid: 1, x: 5 })];
    expect(axisOf(catalog, parts)).toBe(7);
    expect(axisOf(catalog, [part()])).toBeNull();
  });
  it('mirrors a point and a side', () => {
    expect(mirrorPoint([1.25, 4], 7)).toEqual([5.75, 4]);
    expect([mirrorSide('N'), mirrorSide('E'), mirrorSide('S'), mirrorSide('W')]).toEqual(['N', 'W', 'S', 'E']);
  });
});

describe('mirrorPart: the footprint is the reflection of the original', () => {
  for (const piece of catalog.pieceIds) {
    it(`${piece}: all eight orientations, two axes, a few places`, () => {
      for (const flip of [false, true]) for (const rot of [0, 1, 2, 3] as const) for (const axis2 of [1, 6]) for (const [x, y] of [[-3, -2], [0, 0], [4, 5]]) {
        const p = part({ piece, rot, flip, x, y });
        const m = mirrorPart(catalog, p, axis2);
        expect(m).not.toBeNull();
        expect(verts(m!)).toEqual(verts(p, axis2).sort());
        expect(m!.flip).toBe(!flip);
        // (and back again)
        const back = mirrorPart(catalog, m!, axis2)!;
        expect([back.x, back.y, back.rot, back.flip]).toEqual([x, y, rot, flip]);
      }
    });
  }

  it('a part astride the axis is its own mirror, one off it is not', () => {
    // axis 2 = 2 is the line x = 1: a 2-wide piece at x 0 straddles it
    expect(onAxis(catalog, part({ piece: 'rect2', x: 0 }), 2)).toBe(true);
    expect(onAxis(catalog, part({ piece: 'sq', x: 0 }), 1)).toBe(true);
    expect(onAxis(catalog, part({ piece: 'sq', x: 1 }), 1)).toBe(false);
    expect(onAxis(catalog, part({ piece: 'rect2', x: 1 }), 2)).toBe(false);
  });
});

describe('mirrorPart: facing', () => {
  it("a fixed-barrel gun's mirror fires out of the mirrored side", () => {
    for (const flip of [false, true]) for (const rot of [0, 1, 2, 3] as Rot[]) {
      const base = { fn: 'cannon_twinlink', piece: 'rect2', rot, flip };
      const p = part({ ...base, facing: gunFacing(catalog, base)! });
      const m = mirrorPart(catalog, p, 1)!;
      expect(m.facing).toBe(mirrorSide(p.facing!));
      expect(m.facing).toBe(gunFacing(catalog, m));
    }
  });

  it('a free facing swaps east and west', () => {
    const p = part({ fn: 'thruster', facing: 'S' });
    expect(mirrorPart(catalog, p, 1)!.facing).toBe('S');
    expect(mirrorPart(catalog, { ...p, facing: 'E' }, 1)!.facing).toBe('W');
  });
});
