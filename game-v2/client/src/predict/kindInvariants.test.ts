// Pins the contract invariants of the PT kinds (client/src/predict/shipKinds.ts, kinds/bodiesKind, guidesKind, movesKind) with fake hosts
import { describe, it, expect, vi } from 'vitest';
import { ReplicaMode, ReplicaState, type FlightBody } from '@space-game/common';
import { PT_KINDS, kindOf, registerPtKind, type PtShipKind } from './shipKinds';
import { BodiesKind } from './kinds/bodiesKind';
import { GuidesKind } from './kinds/guidesKind';
import { MovesKind, FORK_BACK } from './kinds/movesKind';
import type { PtHost } from './world';

const body = (x: number): FlightBody => ({ x, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 } as FlightBody);

describe('client.predict.ship-kinds', () => {
  const rep = (id: number, mode: ReplicaMode, x = 0, bits = 5, q = 7) => new ReplicaState(id, mode, body(x), bits, q);
  const host = (over: { ahead?: number[]; players?: number[] } = {}) => {
    const stepAlone = vi.fn((id: number, prev: ReplicaState) => prev);
    const h = {
      bodies: { ahead: (id: number) => (over.ahead ?? []).includes(id) },
      reps: {
        modeOf: (id: number) => ((over.players ?? []).includes(id) ? ReplicaMode.Player : undefined),
        at: (id: number, t: number) => rep(id, ReplicaMode.Pilotless, 100 + t),
        stepAlone,
      },
    };
    return { h: h as unknown as PtHost, stepAlone };
  };

  it('the first claiming kind has the ship (ai, then pilot, then the catch-all rows)', () => {
    const { h } = host({ ahead: [1], players: [1, 2] });
    expect(kindOf(1, h).name).toBe('ai');
    expect(kindOf(2, h).name).toBe('pilot');
    expect(kindOf(3, h).name).toBe('rows');
  });

  it('a registered kind goes ahead of rows and claims before it; registering a name again replaces it', () => {
    const { h } = host();
    const mk = (claim: number): PtShipKind => ({ name: 'test-kind', claims: (id) => id === claim, step: () => null, pushable: false, drawBack: 1 });
    registerPtKind(mk(3));
    try {
      expect(PT_KINDS.map((k) => k.name).slice(-2)).toEqual(['test-kind', 'rows']);
      expect(kindOf(3, h).name).toBe('test-kind');
      expect(kindOf(4, h).name).toBe('rows');
      registerPtKind(mk(4));
      expect(PT_KINDS.filter((k) => k.name === 'test-kind')).toHaveLength(1);
      expect(kindOf(3, h).name).toBe('rows');
      expect(kindOf(4, h).name).toBe('test-kind');
    } finally {
      PT_KINDS.splice(PT_KINDS.findIndex((k) => k.name === 'test-kind'), 1);
    }
  });

  it('is stepped from its kind\'s rule: ai takes a copy of the replica layer\'s state, pilots and rows hold their last input', () => {
    const { h, stepAlone } = host({ ahead: [1] });
    const ai = kindOf(1, h);
    const prev = rep(1, ReplicaMode.Pilotless, 0);
    const out = ai.step(1, prev, 10, h)!;
    expect(out.body.x).toBe(110);
    expect(out.body).not.toBe((h.reps as unknown as { at(id: number, t: number): ReplicaState }).at(1, 10).body);
    expect(ai.pushable).toBe(false);
    expect(stepAlone).not.toHaveBeenCalled();

    for (const [id, name] of [[2, 'pilot'], [3, 'rows']] as const) {
      const k = kindOf(id, host({ players: [2] }).h);
      expect(k.name).toBe(name);
      const { h: hh, stepAlone: s } = host({ players: [2] });
      k.step(id, rep(id, ReplicaMode.Player, 0, 9, 3), 11, hh);
      // (the replica set's own step, on what the ship flew the tick before)
      expect(s).toHaveBeenCalledWith(id, expect.anything(), 11, 9, 3);
      expect(k.pushable).toBe(true);
    }
    // A pilot is drawn one tick nearer your shells than anyone else
    expect(kindOf(2, host({ players: [2] }).h).drawBack).toBe(kindOf(3, host().h).drawBack - 1);
  });
});

describe('client.predict.kind.bodies', () => {
  it('a hash miss against ST re-reads the body to the PT head once (host.at only, no stepping), and a repeat confirm does nothing', () => {
    let shift = 0;
    const calls: [number, number][] = [];
    const host = {
      ids: () => [1],
      at: (id: number, t: number) => { calls.push([id, t]); return new ReplicaState(id, ReplicaMode.Pilotless, body(t * 10 + (t >= 11 ? shift : 0)), 0, 0); },
      now: () => 0,
    };
    const k = new BodiesKind(host);
    k.advance(14);                    // before the first confirm: nothing
    expect(calls).toHaveLength(0);
    k.confirm(10);
    k.advance(14);
    expect(k.has(1)).toBe(true);
    expect(k.stats.steps).toBe(4); // (11..14: the confirmed tick itself is ST's)
    calls.length = 0;
    k.confirm(10);                    // seen already
    expect(calls).toHaveLength(0);
    k.confirm(11);                    // agrees: a check against ST, a match, no re-read
    expect(k.stats).toMatchObject({ checks: 1, matches: 1, misses: 0 });
    expect(calls).toEqual([[1, 11]]);
    // A decision lands: the replica layer now has it elsewhere from tick 11 on
    shift = 500;
    calls.length = 0;
    k.confirm(12);
    expect(k.stats).toMatchObject({ misses: 1, restepThings: 1, resteps: 1 });
    // (the ST read at 12, then 12..14 re-read to the head, then the head again for the ease: each tick once)
    expect(calls.filter(([, t]) => t === 12 || t === 13).map(([, t]) => t)).toEqual([12, 12, 13]);
    expect(k.stats.corrections).toBe(1);
    // Hashes re-recorded to the head: the next confirm matches
    k.confirm(13);
    expect(k.stats.misses).toBe(1);
    expect(k.stats.matches).toBe(2);
  });
});

describe('client.predict.kind.guides', () => {
  it('a hash miss at the confirmed tick re-forks from ST once and eases the drawn place', () => {
    // Truth: moves 1 a tick to tick 101, then 3 a tick (a waypoint the server sent)
    const truth = (t: number) => (t <= 101 ? { x: t, vx: 1 } : { x: 101 + 3 * (t - 101), vx: 3 });
    let stTick = 100;
    let forks = 0, steps = 0;
    const host = {
      ids: () => [7],
      fork: () => { forks++; const { x, vx } = truth(stTick); return { m: { x, y: 0, vx, vy: 0, a: 0 }, g: {} as never, last: stTick, mode: 0 }; },
      step: (_id: number, f: { m: { x: number; vx: number }; last: number }, t: number) => { steps++; f.m.x += f.m.vx; f.last = t; },
      now: () => 0,
    };
    const k = new GuidesKind(host as never);
    k.confirm(100);
    k.advance(105);
    expect(forks).toBe(1);
    expect(steps).toBe(5);
    expect(k.pose(7, 105)!.x).toBe(105);
    stTick = 101;
    k.confirm(101);
    expect(k.stats).toMatchObject({ checks: 1, matches: 1, misses: 0 });
    expect(forks).toBe(2);            // (ST's copy to check against)
    stTick = 102;
    steps = 0;
    const forksBefore = forks;
    k.confirm(102);
    expect(k.stats.misses).toBe(1);
    expect(forks - forksBefore).toBe(1); // (ST's copy: the check's and the one the re-fork is made from)
    expect(steps).toBe(3);            // re-stepped 102 -> 105 once
    expect(k.stats).toMatchObject({ restepThings: 1, resteps: 1, corrections: 1 });
    // The drawn place eases from the old head (105) towards the new (113) rather than jumping
    const drawn = k.pose(7, 105)!.x;
    expect(drawn).toBeGreaterThan(105 - 1e-9);
    expect(drawn).toBeLessThan(113);
    // Further advance steps on from the new run
    k.advance(106);
    expect(steps).toBe(4);
  });
});

describe('client.predict.kind.moves', () => {
  type Look = { tick: number; msg: { type: string } };
  const A: Look = { tick: 103, msg: { type: 'A' } }, B: Look = { tick: 107, msg: { type: 'B' } };
  /** A fake MoveRunner: hands out the looks scheduled up to the tick it is advanced to, once each */
  const runner = (looks: Look[]) => {
    let next = 0, pending: unknown[] = [];
    return {
      advance(to: number) { while (next < looks.length && looks[next].tick <= to) pending.push({ owner: 1, ...looks[next++] }); return { rows: [] }; },
      takeTimed() { const p = pending; pending = []; return p; },
      until: () => undefined,
    };
  };

  it('a miss re-forks from c - FORK_BACK and steps once; a look already shown is not shown twice', () => {
    const forkFroms: number[] = [];
    const shown: [string, number][] = [];
    const host = {
      bodies: () => [1],
      fork: (from: number) => { forkFroms.push(from); return runner(forkFroms.length === 1 ? [A] : [A, B]) as never; },
      self: () => 0,
      drawTick: () => 110,
      show: (m: { type: string }, late: number) => shown.push([m.type, late]),
      shell: () => null, retract: () => {},
      now: () => 0,
    };
    const k = new MovesKind(host as never);
    k.confirm(100);
    k.advance(105);
    expect(forkFroms).toEqual([100 - FORK_BACK]);
    expect(shown).toEqual([['A', 7]]);
    // ST's copy of the look PT drew: not shown again
    expect(k.stMsgs([{ owner: 1, ...A } as never])).toEqual([]);
    expect(shown).toHaveLength(1);
    k.confirm(105);
    expect(k.stats).toMatchObject({ misses: 0 });
    expect(forkFroms).toHaveLength(1);
    // ST has a look PT's fork didn't (a decision it couldn't know): shown late, once
    k.advance(110);
    k.stMsgs([{ owner: 1, ...B } as never]);
    expect(shown).toEqual([['A', 7], ['B', 3]]);
    k.confirm(108);
    expect(k.stats.misses).toBe(1);
    expect(forkFroms).toEqual([100 - FORK_BACK, 108 - FORK_BACK]);
    expect(k.stats).toMatchObject({ restepThings: 1, resteps: 1 });
    // The new fork has the look too: it is not shown a second time, nor is it counted a wrong one
    expect(shown).toEqual([['A', 7], ['B', 3]]);
    expect(k.stMsgs([{ owner: 1, ...B } as never])).toEqual([]);
    expect(shown).toHaveLength(2);
    // And a miss again at the same checked ticks does not re-fork
    k.confirm(108);
    expect(forkFroms).toHaveLength(2);
  });
});
