/**
 * Homing shells on a client's tick layer (CAPS.WAYPOINTS; common guidance/, net/guides/GuideNet.ts, client
 * ships/guides/GuideRunner.ts). Missiles fired at ships near the client (derived: it plans their waypoints itself) and
 * at a pilot who jumps out of its focus and back (sent while it lacks the target, derived again after, the switch
 * mid-flight). Every shell it runs is compared with the server's on every tick it steps; a legacy observer still gets
 * rows. The scene: bench/guides/guideScene.testkit.ts.
 */
import { describe, it, expect } from 'vitest';
import { Position, Velocity, InSystem, CAPS, launchPattern, quantizeCursorAngle } from '@space-game/common';
import type { Weapons } from '../../game/Weapons.js';
import { run, BASE, ALL } from '../../bench/guides/guideScene.testkit.js';

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

  it('mobs: launched at it and at a pilot beside it who jumps away (their brain picks again), exact; rows only for HP', () => {
    const r = run({
      every: 20, from: [2500, -800], at: (w) => w.A.pid, pAt: [1800, 600], ticks: 600, mob: 'scrap_mite',
      // (the pilot they may pick jumps out of the focus and back)
      each: (t, w) => {
        const to = t === 200 ? [26000, 4000] : t === 380 ? [1500, 900] : null;
        if (!to) return;
        const p = w.P.pid, a = w.A.pid;
        Position.x[p] = Position.x[a] + to[0]; Position.y[p] = Position.y[a] + to[1]; Velocity.x[p] = 0; Velocity.y[p] = 0;
      },
    });
    if (process.env.GUIDE_DEBUG) console.log('GUIDE', JSON.stringify({ got: r.got, rows: r.rows, checks: r.checks, net: r.net, runner: r.runner }));
    expect(r.rows.syncs).toBeGreaterThan(15);
    expect(r.got.checked).toBeGreaterThan(2000);
    expect(r.got.off, r.got.firstOff).toBe(0);
    expect(r.runner!.plans).toBeGreaterThan(50);
    expect(r.runner!.blind).toBe(0);
    expect(r.rows.Aafter).toBeLessThan(r.rows.syncs);
    expect(r.checks.bodyOff).toBe(0);
  }, 120_000);

  it('a volley of mines laid at once (a Rivet Sower\'s): one LAUNCH row each, no SYNCs, every mine exact; without LAUNCHES, SYNCs', () => {
    const lay = (caps: number) => run({
      every: 1e9, from: [2500, -800], at: (w) => w.A.pid, ticks: 400, caps,
      each: (t, w) => {
        // (a line across, then a ring, then a line the other way: every 80 ticks)
        if (t % 80 !== 5) return;
        const a = w.A.pid, k = (t - 5) / 80;
        w.server.mobs.launch('rivet_mine', InSystem.systemId[a], launchPattern(Position.x[a] + 900 + k * 40.37, Position.y[a] - 300 + k * 17.11, quantizeCursorAngle(0.4 + k), 6, k % 2 === 1, k % 2 ? 260 : 170), w.D);
      },
    });
    const r = lay(ALL | CAPS.LAUNCHES), legacy = lay(ALL);
    if (process.env.GUIDE_DEBUG) console.log('LAUNCH', JSON.stringify({ got: r.got, rows: r.rows, net: r.net, runner: r.runner, legacy: legacy.rows }));
    expect(r.net.launches).toBe(5);
    expect(r.net.launched).toBe(30);
    expect(r.runner!.launches).toBe(5);
    expect(r.rows.syncs).toBe(legacy.rows.syncs - 30);
    expect(r.got.checked).toBeGreaterThan(5000);
    expect(r.got.off, r.got.firstOff).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
    // (the same mines as SYNCs to a client without the bit; both exact, fewer bytes with it)
    expect(legacy.rows.syncs).toBeGreaterThanOrEqual(30);
    expect(legacy.net.launches).toBe(0);
    expect(legacy.got.off, legacy.got.firstOff).toBe(0);
    expect(r.bytes.A).toBeLessThan(legacy.bytes.A);
  }, 120_000);

  it('legacy clients (no WAYPOINTS) get rows as before', () => {
    const r = run({ every: 12, from: [3500, 1200], at: (w) => w.A.pid, caps: BASE, ticks: 200 });
    expect(r.rows.syncs).toBe(0);
    expect(r.rows.Aafter).toBeGreaterThan(50);
    expect(r.got.checked).toBe(0);
  }, 120_000);
});
