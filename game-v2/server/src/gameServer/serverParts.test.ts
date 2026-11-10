/**
 * Small gameServer parts, pinned on their own: crash isolation (faults.ts), tick metrics (perf.ts, admin.ts), the removal
 * set (shared.ts), threat ratings (threats.ts), freighter legs (traffic.ts) and a pilot's clock change (travel.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Position, InSystem } from '@space-game/common';
import type { GameServer } from '../GameServer.js';
import { fault, faultCounts } from './faults.js';
import { perfMetrics } from './perf.js';
import { updatePerfMetrics, reportAdminStats } from './admin.js';
import { RemovalSet, TRAFFIC_ARRIVE_RADIUS, TRAFFIC_DWELL_TICKS } from './shared.js';
import { threats, regionThreats } from './threats.js';
import { trafficIntent, getTrafficShips } from './traffic.js';
import { changeClock } from './travel.js';
import { joinPilot, makeEmptyServer, resetGlobals } from '../testkits/world.testkit.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('faults', () => {
  it('counts every error by place, but logs a place at most once per 10 s, with how many it skipped', () => {
    const gs = { faults: new Map(), currentTick: 7 } as unknown as GameServer;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fault(gs, 'tick', new Error('a'));
    fault(gs, 'tick', new Error('b'));
    fault(gs, 'tick', new Error('c'));
    fault(gs, 'save', new Error('d'));
    expect(faultCounts(gs)).toEqual({ tick: 3, save: 1 });
    // (tick: one line, save: one line; the two repeats were held back)
    expect(log).toHaveBeenCalledTimes(2);
    now += 10_000;
    fault(gs, 'tick', new Error('e'));
    expect(log).toHaveBeenCalledTimes(3);
    expect(String(log.mock.calls[2][0])).toContain('and 2 more since the last report');
    expect(faultCounts(gs).tick).toBe(4);
  });
});

describe('tick metrics', () => {
  it('track the last, min and max tick, a smoothed average and the window maximum, and reset the per-tick counters', () => {
    const gs = { currentTick: 1 } as unknown as GameServer;
    Object.assign(perfMetrics, { lastTickMs: 0, avgTickMs: 0, maxTickMs: 0, minTickMs: Infinity, windowMaxMs: 0, ticksProcessed: 0, collisionChecks: 5, spatialQueries: 3 });
    updatePerfMetrics(gs, 4);
    updatePerfMetrics(gs, 2);
    updatePerfMetrics(gs, 8);
    expect(perfMetrics).toMatchObject({ lastTickMs: 8, minTickMs: 2, maxTickMs: 8, windowMaxMs: 8, ticksProcessed: 3, collisionChecks: 0, spatialQueries: 0 });
    // (alpha 0.1: 0 -> 0.4 -> 0.56 -> 1.304)
    expect(perfMetrics.avgTickMs).toBeCloseTo(1.304, 6);
  });

  it('keep the last 120 tick times for the admin stats, and send those only to open admin sockets once a second', () => {
    resetGlobals();
    const server = makeEmptyServer();
    const sent: unknown[] = [];
    const sock = { isOpen: () => true };
    server.clients.set({} as never, { isAdmin: true, ws: sock, playerId: -1 } as never);
    server.clients.set({} as never, { isAdmin: false, ws: sock, playerId: -1 } as never);
    server.send = ((_ws: unknown, m: unknown) => { sent.push(m); }) as never;
    for (let i = 0; i < 130; i++) { server.currentTick = 1; reportAdminStats(server, i); }
    expect(server.tickTimeHistory.length).toBe(120);
    expect(server.tickTimeHistory[0]).toBe(10);
    expect(sent).toEqual([]);
    server.currentTick = 120;
    reportAdminStats(server, 1);
    expect(sent.length).toBe(1);
    expect((sent[0] as { type: string }).type).toBe('adminStats');
  });
});

describe('RemovalSet', () => {
  it('remembers the system an entity was in when it was added, even if it is moved afterwards', () => {
    const e = 4000;
    InSystem.systemId[e] = 3;
    const set = new RemovalSet();
    expect(set.add(e)).toBe(set);
    InSystem.systemId[e] = 9;
    expect(set.get(e)).toBe(3);
  });
});

describe('threat ratings', () => {
  it('are cached until cleared, leave out the training yard and dev-only systems, and a band is at least as bad as the one inside it', () => {
    resetGlobals();
    const server = makeEmptyServer();
    const t = threats(server);
    expect(threats(server)).toBe(t);
    for (const sys of server.gameData.getAllSystems()) if (sys.tutorial) expect(t[sys.id]).toBeUndefined();
    const bands = regionThreats(server);
    expect(regionThreats(server)).toBe(bands);
    let checked = 0;
    for (const sys of server.gameData.getAllSystems()) {
      const b = bands[sys.id];
      if (!b) continue;
      let last = 0;
      for (const g of sys.regions!) {
        if (g.danger !== 'safe') expect(b[g.id]).toBeGreaterThanOrEqual(last);
        last = b[g.id];
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('freighter legs', () => {
  const ST = [4001, 4002];
  function rig(dwell: number, leg = 0) {
    Position.x[ST[0]] = 0; Position.y[ST[0]] = 0;
    Position.x[ST[1]] = 10_000; Position.y[ST[1]] = 0;
    const slot = { eid: 5000, systemNum: 1, leg, dwell, respawnTick: 0, data: { id: 'f', route: ['a', 'b'], blueprint: 'x' } };
    const gs = { traffic: [slot], stationEntity: (id: string) => ST[id === 'a' ? 0 : 1] } as unknown as GameServer;
    return { gs, slot };
  }

  it('lists only the freighters flying', () => {
    const { gs, slot } = rig(0);
    expect(getTrafficShips(gs)).toEqual([{ eid: 5000, route: ['a', 'b'], leg: 0 }]);
    slot.eid = -1;
    expect(getTrafficShips(gs)).toEqual([]);
  });

  it('a distant one flies to its station, holds there for the rest of its dwell, then heads for the next; a stranger gets nothing', () => {
    const { gs, slot } = rig(0, 0);
    // (Far from its station: on to it)
    const far = trafficIntent(gs, 5000, { x: 5000, y: 0, tick: 100 } as never);
    expect(far).toMatchObject({ kind: 'goto', x: 0, y: 0, arrive: TRAFFIC_ARRIVE_RADIUS });
    // (At it: holds out the dwell)
    const hold = trafficIntent(gs, 5000, { x: 100, y: 0, tick: 100 } as never);
    expect(hold).toEqual({ kind: 'hold', until: 100 + TRAFFIC_DWELL_TICKS });
    expect(slot.dwell).toBe(TRAFFIC_DWELL_TICKS);
    // (Dwell done: its next station)
    const next = trafficIntent(gs, 5000, { x: 100, y: 0, tick: 100 + TRAFFIC_DWELL_TICKS } as never);
    expect(slot.leg).toBe(1);
    expect(slot.dwell).toBe(0);
    expect(next).toMatchObject({ kind: 'goto', x: 10_000 });
    expect(trafficIntent(gs, 1, { x: 0, y: 0, tick: 0 } as never)).toBeUndefined();
  });
});

describe('a clock change (travel.ts)', () => {
  it('moves the notes of the pilot\'s client by the delta and drops inputs said in the old ticks; a zero delta changes nothing', () => {
    resetGlobals();
    const server = makeEmptyServer();
    const p = joinPilot(server, 'Clock');
    const conn = [...server.clients.values()].find((c) => c.playerId === p.pid)!;
    conn.scheduledInputs = [{ tick: 3 } as never];
    conn.aheadHashes.set(1, 2 as never);
    conn.selfHashes.set(1, 2 as never);
    conn.liveTick = 100; conn.lastSnapshotSentTick = 90;
    changeClock(server, conn, 0);
    expect([conn.liveTick, conn.lastSnapshotSentTick, conn.scheduledInputs.length]).toEqual([100, 90, 1]);
    server.riftCooldown.set(p.pid, 500);
    changeClock(server, conn, 40);
    expect([conn.liveTick, conn.lastSnapshotSentTick]).toEqual([140, 130]);
    expect(conn.scheduledInputs).toEqual([]);
    expect(conn.aheadHashes.size + conn.selfHashes.size).toBe(0);
    expect(server.riftCooldown.get(p.pid)).toBe(540);
  });
});

describe('GameServer options (options.ts)', () => {
  it('the dev-only ones (guestAdmin, freeBuild, devStart) are dropped under NODE_ENV=production, and take effect otherwise', () => {
    const was = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      resetGlobals();
      const prod = makeEmptyServer({ guestAdmin: true, freeBuild: true, devStart: 'dev_rockery' });
      expect([prod.guestAdmin, prod.freeBuildAllowed, prod.devStartNum]).toEqual([false, false, -1]);
      process.env.NODE_ENV = 'development';
      resetGlobals();
      const dev = makeEmptyServer({ guestAdmin: true, freeBuild: true, devStart: 'dev_rockery' });
      expect([dev.guestAdmin, dev.freeBuildAllowed]).toEqual([true, true]);
      expect(dev.devStartNum).toBeDefined();
    } finally { process.env.NODE_ENV = was; }
  });
});
