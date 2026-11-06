/**
 * The PT timeline's registry (ptKinds.ts): every kind's confirm before any kind's advance, in order; the first kind
 * that steps a thing places it; the ease fades a re-step's jump. The kinds themselves are held to the server in
 * server/src/net/decisions/ptWorld.test.ts (a real fight, the pilot's frames late).
 */
import { describe, it, expect } from 'vitest';
import { PtEase, PtKinds, noPtStats, type PtKind } from './ptKinds';

function fake(name: string, order: number, log: string[], owns: number[] = []): PtKind {
  return {
    name, order, stats: noPtStats(),
    confirm: (c) => log.push(`${name}.confirm(${c})`),
    advance: (to) => log.push(`${name}.advance(${to})`),
    reset: () => log.push(`${name}.reset`),
    has: (id) => owns.includes(id),
    pose: (id, t) => (owns.includes(id) ? { x: order, y: t, angle: 0 } : null),
  };
}

describe('PtKinds', () => {
  it('confirms every kind, lowest order first, then advances them all', () => {
    const log: string[] = [];
    const k = new PtKinds().add(fake('moves', 30, log)).add(fake('ships', 0, log)).add(fake('bodies', 10, log));
    k.frame(100, 108);
    expect(log).toEqual(['ships.confirm(100)', 'bodies.confirm(100)', 'moves.confirm(100)', 'ships.advance(108)', 'bodies.advance(108)', 'moves.advance(108)']);
  });

  it('a kind added again by name replaces the old; the first that steps a thing places it', () => {
    const log: string[] = [];
    const k = new PtKinds().add(fake('ships', 0, log, [1])).add(fake('bodies', 10, log, [1, 2])).add(fake('bodies', 10, log, [2]));
    expect(k.all().map((x) => x.name)).toEqual(['ships', 'bodies']);
    expect(k.pose(1, 5)).toEqual({ x: 0, y: 5, angle: 0 });
    expect(k.pose(2, 5)).toEqual({ x: 10, y: 5, angle: 0 });
    expect(k.has(3)).toBe(false);
    expect(k.pose(3, 5)).toBeNull();
  });
});

describe('PtEase', () => {
  it('draws the old place at first, the new one after lerpMs, and carries what is left into the next', () => {
    let now = 0;
    const e = new PtEase(100, () => now);
    expect(e.moved(7, { x: 10, y: 0, angle: 0 }, { x: 0, y: 0, angle: 0 })).toBe(10);
    expect(e.apply(7, { x: 0, y: 0, angle: 0 }).x).toBeCloseTo(10);
    now = 50;
    expect(e.apply(7, { x: 0, y: 0, angle: 0 }).x).toBeCloseTo(5);
    // (a second re-step half way: the half left of the first carries on)
    e.moved(7, { x: 4, y: 0, angle: 0 }, { x: 0, y: 0, angle: 0 });
    expect(e.apply(7, { x: 0, y: 0, angle: 0 }).x).toBeCloseTo(9);
    now = 200;
    expect(e.apply(7, { x: 0, y: 0, angle: 0 }).x).toBe(0);
    expect(e.moved(7, { x: 1, y: 2, angle: 0 }, { x: 1, y: 2, angle: 0 })).toBe(0);
  });
});
