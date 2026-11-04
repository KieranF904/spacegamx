/**
 * Homing shells on a client's tick layer (CAPS.WAYPOINTS; common guidance/, net/guides/GuideNet.ts, client
 * ships/guides/GuideRunner.ts). Missiles fired at ships near the client (derived: it plans their waypoints itself) and
 * at a pilot who jumps out of its focus and back (sent while it lacks the target, derived again after, the switch
 * mid-flight). Every shell it runs is compared with the server's on every tick it steps; a legacy observer still gets
 * rows. The scene: guidesScene.testkit.ts.
 */
import { describe, it, expect } from 'vitest';
import { Position, Velocity } from '@space-game/common';
import type { Weapons } from '../../game/Weapons.js';
import { run, BASE } from './guidesScene.testkit.js';

describe('homing shells on the tick layer (CAPS.WAYPOINTS)', () => {
  it('both ends held: it plans their waypoints itself, nothing sent; every shell exact, no rows after the first', () => {
    const r = run({ every: 12, from: [3500, 1200], at: (w) => (Math.floor(w.server.getTick() / 12) % 2 ? w.A.pid : w.H) });
    if (process.env.GUIDE_DEBUG) console.log('GUIDE', JSON.stringify({ got: r.got, rows: r.rows, checks: r.checks, net: r.net, runner: r.runner }));
    expect(r.got.checked).toBeGreaterThan(3000);
    expect(r.got.off, r.got.firstOff).toBe(0);
    expect(r.rows.syncs).toBeGreaterThan(20);
    expect(r.rows.sent).toBe(0);
    expect(r.runner!.plans).toBeGreaterThan(100);
    expect(r.runner!.blind).toBe(0);
    expect(r.rows.Aafter).toBe(0);
    expect(r.rows.B).toBeGreaterThan(r.rows.syncs * 5);
    expect(r.checks.bodyOff).toBe(0);
    expect(r.checks.agreed).toBeGreaterThan(20);
  }, 120_000);

  it('the target out of its focus and back: sent while it lacks it, derived again after, exact through the switches', () => {
    const r = run({
      every: 15, from: [2000, 0], at: (w) => w.P.pid, pAt: [24000, 0], ticks: 700,
      // (it jumps into the focus, and out past its 19 km again)
      each: (t, w) => {
        const to = t === 250 ? [6000, 2500] : t === 480 ? [25000, -3000] : null;
        if (!to) return;
        const p = w.P.pid, a = w.A.pid;
        Position.x[p] = Position.x[a] + to[0]; Position.y[p] = Position.y[a] + to[1]; Velocity.x[p] = 0; Velocity.y[p] = 0;
      },
    });
    if (process.env.GUIDE_DEBUG) console.log('GUIDE', JSON.stringify({ got: r.got, rows: r.rows, checks: r.checks, net: r.net, runner: r.runner }));
    expect(r.got.checked).toBeGreaterThan(3000);
    expect(r.got.off, r.got.firstOff).toBe(0);
    expect(r.rows.sent).toBeGreaterThan(10);
    expect(r.rows.modes).toBeGreaterThanOrEqual(2);
    expect(r.runner!.plans).toBeGreaterThan(50);
    expect(r.runner!.blind).toBe(0);
    expect(r.rows.Aafter).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
  }, 120_000);

  it('a drift injected into a shell it runs: its check catches it and a SYNC puts it right', () => {
    let hit = -1;
    const r = run({
      every: 20, from: [3000, 0], at: (w) => w.A.pid, ticks: 300,
      each: (t, w) => {
        // (a shell moved a unit on the server alone: as a bug would)
        if (t !== 150) return;
        const weapons = (w.server as unknown as { weapons: Weapons }).weapons;
        for (const [eid] of weapons.guided()) { if (w.A.guides!.state(eid)) { Position.x[eid] += 1; hit = eid; break; } }
      },
    });
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(r.got.off).toBeGreaterThan(0);
    expect(r.checks.bodyOff).toBeGreaterThan(0);
    expect(r.net.resyncs).toBeGreaterThan(0);
  }, 120_000);

  it('legacy clients (no WAYPOINTS) get rows as before', () => {
    const r = run({ every: 12, from: [3500, 1200], at: (w) => w.A.pid, caps: BASE, ticks: 200 });
    expect(r.rows.syncs).toBe(0);
    expect(r.rows.Aafter).toBeGreaterThan(50);
    expect(r.got.checked).toBe(0);
  }, 120_000);
});
