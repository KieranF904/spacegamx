/**
 * BodyNet on its own (CAPS.BODIES): a boss let go is forgotten at once, even with no capable client to notice its ship
 * is gone, and its id reused by another ship is never synced as it. A move shell fired in the window its ship went in is
 * the client's own (it ran the body through that window), not a row as well; a boss put right by a check that the client
 * can't run at its next snapshot is stopped with an OFF, not left running there while its rows come too.
 */
import { describe, it, expect } from 'vitest';
import { DECISION, syncArgs, wantFly, orderEngage, bodyKindOf, type BodyState, type FlightBody } from '@space-game/common';
import { BodyNet } from './BodyNet.js';

const pose: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 };
const state = (on: boolean): BodyState => ({ kind: 0, homeX: 0, homeY: 0, stage: 1, side: 1, target: 7, want: wantFly(), wantAt: 0, on });

function net() {
  const live = new Set<number>([5, 7]);
  let tick = 100;
  const n = new BodyNet({ tick: () => tick, body: (eid) => (live.has(eid) ? pose : null), has: (eid) => live.has(eid) });
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

  it('an AI pilot whose pack mate leaves the view goes off at once (one keyframe), not keyframed every snapshot it stays out', () => {
    const live = new Set<number>([5, 6, 7]);
    let tick = 100;
    const n = new BodyNet({ tick: () => tick, body: (eid) => (live.has(eid) ? pose : null), has: (eid) => live.has(eid) });
    const s: BodyState = { kind: bodyKindOf('ai'), homeX: 0, homeY: 0, stage: 1, side: 1, target: 7, want: orderEngage(5, 700, 7200, false, 0, 1, 0.5, 3, [6]), wantAt: 0, on: true };
    n.decide(5, DECISION.SYNC, syncArgs(s), s);
    const conn = {}, known = new Map([[5, 1], [6, 1], [7, 1]]);
    const view = new Set([5, 6, 7]);
    const rows = () => n.forClient(conn, 7, () => 1, 1, known, tick, (e) => view.has(e));
    expect(rows().some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
    tick += 3;
    expect(rows()).toEqual([]);
    // (its mate out of view this snapshot: still known, gone from the client from here)
    view.delete(6);
    tick += 3;
    expect(rows()).toEqual([[5, 0, DECISION.OFF]]);
    expect(n.runs(conn, 5)).toBe(false);
    known.delete(6);
    tick += 3;
    expect(rows()).toEqual([]);
    // (back in view: synced again)
    view.add(6);
    tick += 3;
    expect(rows().some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
  });

  it("a boss shot down: the move shells it fired in that last window are the client's own, not rows as well", () => {
    const { n, live, rows, step } = net();
    const s = state(true);
    n.decide(5, DECISION.SYNC, syncArgs(s), s);
    const conn = {};
    expect(rows(conn).some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
    for (let i = 0; i < 3; i++) step();
    rows(conn);
    // (a shot of its move, then its ship gone before the next snapshot: the client works that window out, its removal after)
    step();
    n.moveShell(900, 5, { t: 104, who: -1 });
    step();
    live.delete(5);
    step();
    rows(conn);
    expect(n.shellDerived(conn, 7, 900, false)).toBe(true);
    // (one fired before it began running it is still a row)
    n.moveShell(901, 5, { t: 99, who: -1 });
    expect(n.shellDerived(conn, 7, 901, false)).toBe(false);
  });

  it("a boss put right by a check that it can't run at its next snapshot: an OFF, not left running there", () => {
    const { n, rows, step } = net();
    const s = state(true);
    n.decide(5, DECISION.SYNC, syncArgs(s), s);
    const conn = {};
    rows(conn);
    step();
    expect(n.runs(conn, 5)).toBe(true);
    n.resync(conn);
    step();
    // (out of its view now: it can't run it)
    expect(n.forClient(conn, 7, () => 1, 1, new Map([[5, 1], [7, 1]]), 102, (e) => e !== 5)).toEqual([[5, 0, DECISION.OFF]]);
    expect(n.runs(conn, 5)).toBe(false);
    // (back in its view: synced again; put right while it can run it, synced again at once)
    expect(rows(conn).some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
    step();
    n.resync(conn);
    expect(rows(conn).some((r) => r[0] === 5 && r[2] === DECISION.SYNC)).toBe(true);
    expect(n.runs(conn, 5)).toBe(true);
  });
});
