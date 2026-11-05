import { describe, it, expect } from 'vitest';
import { MineAndDeposit, mineOpts } from './mineAndDeposit.js';
import { BotStats } from '../stats/BotStats.js';
import { idle, type Bag, type Controls, type DepositMode, type PilotDriver, type Pose } from '../core/types.js';
import type { BotWorld, RockView } from '../core/world.js';
import type { TaskCtx } from './types.js';

/** A driver the test flies by hand: the pose is set by the test, the calls are recorded */
class FakeDriver implements PilotDriver {
  readonly kind = 'client' as const;
  readonly name = 'fake';
  readonly eid = 1;
  p: Pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };
  c: Controls = idle();
  berthed = false;
  freeVolume = 80;
  items: Bag = {};
  calls: string[] = [];
  reach = true;
  observe(): void { /* nothing */ }
  pose(): Pose { return this.p; }
  radius(): number { return 40; }
  docked(): boolean { return this.berthed; }
  hold() { return { items: { ...this.items }, capacity: 80, free: this.freeVolume }; }
  brownout(): boolean { return false; }
  set(c: Controls): void { this.c = c; }
  dock(): boolean { if (!this.reach) return false; this.berthed = true; this.calls.push('dock'); return true; }
  undock(): void { this.berthed = false; this.calls.push('undock'); }
  deposit(mode: DepositMode) { this.calls.push(`deposit:${mode}`); const items = this.items; this.items = {}; this.freeVolume = 80; return { items, credits: 0, valueIfSold: 5 }; }
  flush(): void { /* nothing */ }
  close(): void { /* nothing */ }
}

const STATION = { eid: 9, id: 'st', name: 'St', x: 1000, y: 0, radius: 100, interact: 300, system: 0 };
const rock = (eid: number, x: number, y: number, left = 20, hardness = 1): RockView => ({ eid, x, y, size: 100, type: 'asteroid_metal', hardness, left, ores: { iron_ore: 1 } });

function fakeWorld(rocks: RockView[], pods: () => number[] = () => []): BotWorld {
  return {
    station: () => STATION,
    laser: () => ({ range: 700 }),
    rock: (eid: number) => rocks.find((r) => r.eid === eid) ?? null,
    rocksNear: (_s: number, x: number, y: number, keep: (r: RockView) => boolean) => rocks.filter(keep).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)),
    podsNear: () => pods(),
    server: { mining: { table: { types: { asteroid_metal: {}, gas: { gas: true } } } } },
  } as unknown as BotWorld;
}

function rig(rocks: RockView[], pods?: () => number[]) {
  const d = new FakeDriver(), stats = new BotStats(60, () => 0), world = fakeWorld(rocks, pods);
  const task = new MineAndDeposit(mineOpts({}));
  let tick = 0;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { tick++; task.step({ driver: d, world, stats, tick, tickRate: 60, system: 0 } as TaskCtx); stats.tick(tick, task.phase, false, d.p); } };
  return { d, stats, task, step, tick: () => tick };
}

describe('mine-and-deposit', () => {
  it('docks first (setup, not a trip), waits 10 s docked, then undocks for the nearest suitable rock', () => {
    const r = rig([rock(1, 5000, 0), rock(2, 3000, 100), rock(3, 2000, 0, 20, 2), rock(4, 2500, 0, 3)]);
    r.d.p = { ...r.d.p, x: 900 };
    r.step();
    expect(r.d.calls).toEqual(['dock']);
    expect(r.task.state).toBe('docked');
    expect(r.stats.tripOpen).toBe(true);
    r.step(598);
    expect(r.d.calls).toEqual(['dock']);
    r.step(2);
    expect(r.d.calls).toEqual(['dock', 'undock']);
    expect(r.task.state).toBe('out');
    // (Not the harder rock (2000), nor the spent one (2500): the nearest it can mine at full yield)
    expect((r.task as unknown as { rock: RockView }).rock.eid).toBe(2);
    expect(r.stats.current!.ticks.docked).toBeGreaterThanOrEqual(599);
  });

  it('flies out toward the rock, begins mining when in range and fires the laser with the nose on it', () => {
    const r = rig([rock(2, 5000, 0)]);
    r.d.p = { ...r.d.p, x: 900 };
    r.step(602);
    expect(r.task.state).toBe('out');
    expect(r.d.c.right).toBe(true);
    expect(r.d.c.mine).toBe(false);
    // (Arrives: 400 off the rock's surface, nearly still)
    r.d.p = { x: 4500, y: 0, vx: 0.5, vy: 0, angle: 0 };
    r.step();
    expect(r.task.state).toBe('mining');
    r.step();
    expect(r.d.c.mine).toBe(true);
    expect(r.d.c.aim).toBeCloseTo(0, 1);
    expect(r.task.phase).toBe('mining');
  });

  it('returns when the hold is full, waits for stray chunks, docks, deposits and starts the next trip', () => {
    let pods = [7];
    const r = rig([rock(2, 5000, 0, 40)], () => pods);
    r.d.p = { ...r.d.p, x: 900 };
    r.step(602);
    r.d.p = { x: 4500, y: 0, vx: 0, vy: 0, angle: 0 };
    r.step(5);
    expect(r.task.state).toBe('mining');
    r.d.freeVolume = 4;
    r.d.items = { iron_ore: 76 };
    r.step();
    expect(r.task.state).toBe('collecting');
    expect(r.d.c.mine).toBe(false);
    // (A chunk is still flying in: it waits, up to collectWait seconds)
    r.step(60);
    expect(r.task.state).toBe('collecting');
    pods = [];
    r.step();
    expect(r.task.state).toBe('back');
    r.d.reach = false;
    r.d.p = { x: 2000, y: 0, vx: 0, vy: 0, angle: 0 };
    r.step(3);
    expect(r.d.calls.filter((c) => c === 'dock')).toHaveLength(1);
    r.d.reach = true;
    r.d.p = { x: 1100, y: 0, vx: 0, vy: 0, angle: 0 };
    r.step();
    expect(r.d.calls).toContain('deposit:store');
    expect(r.stats.trips).toHaveLength(1);
    expect(r.stats.trips[0].deposited).toEqual({ iron_ore: 76 });
    expect(r.stats.trips[0].valueIfSold).toBe(5);
    expect(r.task.state).toBe('docked');
    expect(r.stats.tripOpen).toBe(true);
  });

  it('goes on to the next nearest rock when this one is spent and there is room in the hold', () => {
    const rocks = [rock(2, 5000, 0, 20), rock(3, 5600, 900, 20)];
    const r = rig(rocks);
    r.d.p = { ...r.d.p, x: 900 };
    r.step(602);
    r.d.p = { x: 4500, y: 0, vx: 0, vy: 0, angle: 0 };
    r.step(3);
    expect(r.task.state).toBe('mining');
    rocks[0].left = 0;
    r.step();
    expect(r.task.state).toBe('collecting');
    r.step(2);
    expect(r.task.state).toBe('out');
    expect((r.task as unknown as { rock: RockView }).rock.eid).toBe(3);
    expect(r.stats.current!.rocks).toBe(2);
  });

  it('sells when told to', () => {
    const rocks = [rock(2, 5000, 0, 40)];
    const d = new FakeDriver(), stats = new BotStats(60, () => 0), world = fakeWorld(rocks);
    const task = new MineAndDeposit(mineOpts({ mode: 'sell', dockWait: 1 }));
    let tick = 0;
    const step = (n = 1) => { for (let i = 0; i < n; i++) { tick++; task.step({ driver: d, world, stats, tick, tickRate: 60, system: 0 } as TaskCtx); } };
    d.p = { ...d.p, x: 900 };
    step(70);
    d.p = { x: 4500, y: 0, vx: 0, vy: 0, angle: 0 };
    step(2);
    d.freeVolume = 0;
    step(400);
    d.p = { x: 1100, y: 0, vx: 0, vy: 0, angle: 0 };
    step();
    expect(d.calls).toContain('deposit:sell');
  });
});
