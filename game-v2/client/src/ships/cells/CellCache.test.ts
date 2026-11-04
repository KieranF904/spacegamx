/**
 * The dropped-cell cache's hash covers only what it keeps: a ship it held but could not keep (detach refused, as for
 * debris) makes the answer miss, so the cell comes back as new instead of as a log naming a ship it no longer has.
 */
import { describe, it, expect } from 'vitest';
import { cellHash, cellMemberHash, type ClientMessage, type ShipReplicaSet } from '@space-game/common';
import { CellCache } from './CellCache';

const body = { x: 100, y: 200, vx: 1, vy: 0, angle: 0, angVel: 0 };

function cache(keeps: (id: number) => boolean) {
  const sent: ClientMessage[] = [];
  const reps = {
    at: (_id: number) => ({ body, bits: 0, q: 0 }),
    detach: (id: number) => (keeps(id) ? ({} as never) : null),
    has: () => false,
    attach: () => {},
  } as unknown as ShipReplicaSet;
  const c = new CellCache({ reps, send: (m) => sent.push(m), forget: () => {} });
  return { c, sent };
}

describe('CellCache', () => {
  it('answers with the hash of the ships it kept', () => {
    const { c, sent } = cache(() => true);
    c.onCells({ type: 'cells', tick: 100, d: [7, 2, 1, 2] } as never);
    c.onCells({ type: 'cells', tick: 160, b: [7, 100] } as never);
    const h = cellHash([[1, cellMemberHash(1, body as never, 0, 0)], [2, cellMemberHash(2, body as never, 0, 0)]]);
    expect((sent[0] as { c: number[] }).c).toEqual([7, 100, h]);
    expect(c.has(1) && c.has(2)).toBe(true);
  });

  it('a ship held but not kept makes its answer miss', () => {
    const { c, sent } = cache((id) => id !== 2);
    c.onCells({ type: 'cells', tick: 100, d: [7, 2, 1, 2] } as never);
    c.onCells({ type: 'cells', tick: 160, b: [7, 100] } as never);
    const both = cellHash([[1, cellMemberHash(1, body as never, 0, 0)], [2, cellMemberHash(2, body as never, 0, 0)]]);
    const got = (sent[0] as { c: number[] }).c[2];
    expect(got).not.toBe(both);
    expect(got).toBe(cellHash([[1, cellMemberHash(1, body as never, 0, 0)], [-1, 0]]));
    expect(c.has(2)).toBe(false);
  });
});
