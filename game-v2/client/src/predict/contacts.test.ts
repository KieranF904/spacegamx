/** The PT layer's contact pass leaves a Docking Clamps pair out of contact with itself, as the server's pass does */
import { describe, expect, it } from 'vitest';
import type { ReplicaState, ShipTuning } from '@space-game/common';
import { RealContacts, type PtShape } from './contacts';
import type { PtBody } from './ptst';

const SHAPE: PtShape = { mass: 10, radius: 20, geom: [], alive: [], com: [0, 0], big: false };
const TUNING = { cellSize: 10, collision: { restitution: 0.3 } } as unknown as ShipTuning;
const body = (id: number, x: number): PtBody => ({ s: { id, body: { x, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 } } as unknown as ReplicaState, moves: true });

describe('RealContacts', () => {
  it('finds two overlapping ships a pair, unless they are clamped to each other', () => {
    const loose = new RealContacts(() => SHAPE, TUNING);
    loose.pass(5, [body(1, 0), body(2, 10)], []);
    expect(loose.stats.pairs).toBe(1);
    const clamped = new RealContacts(() => SHAPE, TUNING, (id, t) => (t === 5 ? (id === 1 ? 2 : id === 2 ? 1 : undefined) : undefined));
    clamped.pass(5, [body(1, 0), body(2, 10)], []);
    expect(clamped.stats.pairs).toBe(0);
    // (Not linked on another tick: a pair again)
    clamped.pass(6, [body(1, 0), body(2, 10)], []);
    expect(clamped.stats.pairs).toBe(1);
  });
});
