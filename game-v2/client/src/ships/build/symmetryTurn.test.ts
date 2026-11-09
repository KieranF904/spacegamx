import { describe, it, expect } from 'vitest';
import type { PlacedPart } from '@space-game/common';
import { testCatalog } from '../../../../common/src/ships/testData';
import { mirrorFollow } from './symmetryTurn';
import { mirrorPart } from './symmetry';

const catalog = testCatalog();
const part = (over: Partial<PlacedPart> & { uid: number }): PlacedPart => ({ piece: 'rect2', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false, ...over });
// Axis x = 5 (twice: 10). Left rect2 at x 2..3, its mirror at 6..7.
const AXIS = 10;

describe('mirrorFollow', () => {
  it('turns the part across the axis to the exact mirror of the turned one, keeping its uid', () => {
    const left = part({ uid: 1, x: 3, y: 0, rot: 1 });
    const right = part({ uid: 2, x: 6, y: 0 });
    const f = mirrorFollow(catalog, [left, right], 0, [3.5, 0.5], AXIS);
    if (!f || 'skip' in f) throw new Error(JSON.stringify(f));
    expect(f.j).toBe(1);
    expect(f.part.uid).toBe(2);
    expect(f.part).toEqual({ ...mirrorPart(catalog, left, AXIS)!, uid: 2 });
  });

  it('nothing follows from a part on the axis or one already matched', () => {
    const mid = part({ uid: 1, x: 4 });
    expect(mirrorFollow(catalog, [mid], 0, [4.5, 0.5], AXIS)).toBeNull();
    const left = part({ uid: 1, x: 3 });
    const right = { ...mirrorPart(catalog, left, AXIS)!, uid: 2 };
    expect(mirrorFollow(catalog, [left, right], 0, [3.5, 0.5], AXIS)).toBeNull();
  });

  it('says why when the other side is empty, a different part, or the turn is refused', () => {
    const left = part({ uid: 1, x: 3, rot: 1 });
    expect(mirrorFollow(catalog, [left], 0, [3.5, 0.5], AXIS)).toEqual({ skip: 'nothing on the mirror side' });
    const other = part({ uid: 2, x: 6, piece: 'sq' });
    expect(mirrorFollow(catalog, [left, other], 0, [3.5, 0.5], AXIS)).toEqual({ skip: 'the mirror side is a different part' });
    // A part in the way of the turned copy
    const right = part({ uid: 2, x: 6, y: 0 });
    const block = part({ uid: 3, piece: 'sq', x: 6, y: 1 });
    const f = mirrorFollow(catalog, [left, right, block], 0, [3.5, 0.5], AXIS);
    expect(f && 'skip' in f && f.skip.startsWith('mirror side blocked')).toBe(true);
  });
});
