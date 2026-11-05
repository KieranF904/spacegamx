import { describe, it, expect } from 'vitest';
import { RandomFlight, flightOpts, changeSeconds, rng } from './randomFlight.js';
import { idle, type Bag, type Controls, type DepositMode, type PilotDriver, type Pose } from '../core/types.js';
import type { BotStats } from '../stats/BotStats.js';
import type { BotWorld } from '../core/world.js';
import type { TaskCtx } from './types.js';

class FakeDriver implements PilotDriver {
  readonly kind = 'client' as const;
  readonly name = 'fake';
  readonly eid = 1;
  p: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };
  c: Controls = idle();
  sets: Controls[] = [];
  observe(): void { /* nothing */ }
  pose(): Pose { return this.p; }
  radius(): number { return 40; }
  docked(): boolean { return false; }
  hold() { return { items: {} as Bag, capacity: 0, free: 0 }; }
  brownout(): boolean { return false; }
  set(c: Controls): void { this.c = c; this.sets.push({ ...c }); }
  dock(): boolean { return false; }
  undock(): void { /* nothing */ }
  deposit(_m: DepositMode) { return { items: {}, credits: 0, valueIfSold: 0 }; }
  flush(): void { /* nothing */ }
  close(): void { /* nothing */ }
}

function rig(opts: Record<string, string | number | boolean>) {
  const d = new FakeDriver(), task = new RandomFlight(flightOpts(opts));
  let tick = 0;
  const step = (n = 1, move = false) => {
    for (let i = 0; i < n; i++) {
      tick++;
      task.step({ driver: d, world: {} as BotWorld, stats: {} as BotStats, tick, tickRate: 60, system: 0 } as TaskCtx);
      // (a crude ship: each tick moves by the keys held, so the leash can be tested)
      if (move) { d.p = { ...d.p, x: d.p.x + (d.c.right ? 10 : 0) - (d.c.left ? 10 : 0), y: d.p.y + (d.c.backward ? 10 : 0) - (d.c.forward ? 10 : 0) }; }
    }
  };
  return { d, task, step };
}

describe('random-flight', () => {
  it('twitchy changes inputs far more often than calm', () => {
    const calm = rig({ twitch: 'calm' }), twitchy = rig({ twitch: 'twitchy' });
    calm.step(60 * 60); twitchy.step(60 * 60);
    expect(twitchy.task.changes).toBeGreaterThan(calm.task.changes * 5);
    expect(changeSeconds(0)).toBeCloseTo(4); expect(changeSeconds(1)).toBeCloseTo(0.2);
  });

  it('repeats under the same seed and differs under another', () => {
    const run = (seed: number) => { const r = rig({ seed, twitch: 0.8 }); r.step(1200); return JSON.stringify(r.d.sets); };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });

  it('makes sharp turns, boost bursts and stops over a long run', () => {
    const r = rig({ twitch: 0.9, boost: 0.5, stop: 0.3 });
    r.step(60 * 120);
    expect(r.d.sets.some((c) => c.boost)).toBe(true);
    expect(r.task.changes).toBeGreaterThan(50);
    const aims = r.d.sets.map((c) => c.aim);
    let sharp = 0;
    for (let i = 1; i < aims.length; i++) { let da = Math.abs(aims[i] - aims[i - 1]) % (Math.PI * 2); if (da > Math.PI) da = Math.PI * 2 - da; if (da > Math.PI / 3) sharp++; }
    expect(sharp).toBeGreaterThan(5);
  });

  it('a hard stop brakes against the velocity', () => {
    const r = rig({ twitch: 'calm', stop: 1 });
    r.d.p = { x: 0, y: 0, vx: 20, vy: 0, angle: 0 };
    r.step(2);
    expect(r.task.stopped).toBe(true);
    expect(r.d.c.left).toBe(true);
    expect(r.d.c.boost).toBe(false);
  });

  it('turns for home past the leash', () => {
    const r = rig({ twitch: 'twitchy', leash: 400, stop: 0 });
    r.step(1);
    let far = 0;
    for (let i = 0; i < 20; i++) { r.step(60 * 10, true); far = Math.max(far, Math.hypot(r.d.p.x, r.d.p.y)); }
    expect(far).toBeLessThan(400 + 2000);
  });

  it('fires at its target only when shoot is on and the target is in range', () => {
    const on = rig({ shoot: 1, range: 1000 }), off = rig({ shoot: 0, range: 1000 });
    for (const r of [on, off]) r.task.target = () => ({ x: 500, y: 0 });
    on.step(3); off.step(3);
    expect(on.d.c.mine).toBe(true);
    expect(on.d.c.aim).toBeCloseTo(0);
    expect(off.d.c.mine).toBe(false);
    on.task.target = () => ({ x: 5000, y: 0 });
    on.step(1);
    expect(on.d.c.mine).toBe(false);
  });

  it('seeded generator is in [0,1)', () => {
    const r = rng(3);
    for (let i = 0; i < 1000; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});
