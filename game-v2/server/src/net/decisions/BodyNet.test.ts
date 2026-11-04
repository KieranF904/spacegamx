/**
 * BodyNet on its own (CAPS.BODIES): a boss let go is forgotten at once, even with no capable client to notice its ship
 * is gone, and its id reused by another ship is never synced as it; a client whose caps dropped the cap runs nothing.
 */
import { describe, it, expect } from 'vitest';
import { DECISION, syncArgs, wantFly, type BodyState, type FlightBody } from '@space-game/common';
import { BodyNet } from './BodyNet.js';

const pose: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };
const state = (on: boolean): BodyState => ({ kind: 0, homeX: 0, homeY: 0, stage: 1, side: 1, target: 7, want: wantFly(), wantAt: 0, on });

function net() {
  const live = new Set<number>([5, 7]);
  let tick = 100;
  const n = new BodyNet({ tick: () => tick, body: (eid) => (live.has(eid) ? pose : null) });
  const rows = (conn: object) => n.forClient(conn, 7, () => 1, 1, new Map([[5, 1], [7, 1]]), tick, () => true);
  return { n, live, rows, step: () => tick++ };
}

describe('BodyNet', () => {
  it('a boss let go with its ship gone is forgotten at once; its id on another ship is never synced as the boss', () => {
    const { n, live, rows, step } = net();
    const s = state(true);
    n.decide(5, DECISION.SYNC, syncArgs(s), s);
    const conn = {};
    expect(rows(conn).some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
    step();
    // (despawned: the ship goes, then its brain lets go, an OFF)
    live.delete(5);
    s.on = false;
    n.decide(5, DECISION.OFF, [], s);
    expect((n as unknown as { bosses: Map<number, unknown> }).bosses.has(5)).toBe(false);
    // (the id taken by some other ship: nothing of the old boss goes to anyone)
    live.add(5);
    step();
    expect(rows(conn)).toEqual([]);
    expect(rows({})).toEqual([]);
    expect(n.runs(conn, 5)).toBe(false);
  });

  it('dropped (its caps went off): it runs nothing, and a SYNC starts it again', () => {
    const { n, rows, step } = net();
    const s = state(true);
    n.decide(5, DECISION.SYNC, syncArgs(s), s);
    const conn = {};
    rows(conn);
    n.note(conn, 100);
    expect(n.runs(conn, 5)).toBe(true);
    n.drop(conn);
    expect(n.runs(conn, 5)).toBe(false);
    step();
    expect(rows(conn).some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
  });
});
