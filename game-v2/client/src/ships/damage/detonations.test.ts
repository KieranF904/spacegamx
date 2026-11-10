/**
 * Detonations (damage/detonations.ts) and the one-off effects (damage/events.ts), through a recording stand-in for the
 * particle field: an unknown kind is a missile's fireball, a hive's blast is a missile's at 0.7 of its radius, and a
 * boss's death is nine blasts across its hull then one huge one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DamageCtx } from './context';
import { detonate } from './detonations';
import { bossDefeated } from './events';

type Call = [string, ...unknown[]];

function rig() {
  const calls: Call[] = [];
  const p = new Proxy({}, { get: (_t, name) => (...args: unknown[]) => { calls.push([String(name), ...args]); } });
  const state = { entities: new Map(), playerId: 1, triggerScreenShake: (...a: unknown[]) => { calls.push(['shake', ...a]); } };
  const sound = (id: string, at?: { x: number; y: number }, v?: number) => { calls.push(['sound', id, at, v]); };
  return { calls, c: new DamageCtx(p as never, {} as never, state as never, sound, 100) };
}

/** Math.random as a fixed sequence, so two runs draw the same dice */
function fixedDice() {
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((i++ * 0.37) % 1));
}
afterEach(() => vi.restoreAllMocks());

describe('a kind with no entry is drawn as a missile\'s fireball', () => {
  it('an unnamed kind makes the very calls a missile does', () => {
    fixedDice();
    const a = rig(); detonate(a.c, 'missile', 10, 20, 100);
    fixedDice();
    const b = rig(); detonate(b.c, 'no_such_warhead', 10, 20, 100);
    expect(a.calls.length).toBeGreaterThan(5);
    expect(b.calls).toEqual(a.calls);
  });
});

describe('a hive\'s blast is a missile\'s at 0.7 of its radius', () => {
  it('a hive at radius R makes the calls of a missile at 0.7 R', () => {
    fixedDice();
    const hive = rig(); detonate(hive.c, 'hive', 10, 20, 200);
    fixedDice();
    const missile = rig(); detonate(missile.c, 'missile', 10, 20, 200 * 0.7);
    expect(hive.calls).toEqual(missile.calls);
  });
});

describe('a boss\'s death is nine blasts across its hull then one huge one', () => {
  it('nine small blasts within the hull, then one large at 1.6 s', () => {
    const { c, calls } = rig();
    bossDefeated(c, 1000, -500);
    const sounds = () => calls.filter((k) => k[0] === 'sound') as unknown as [string, string, { x: number; y: number }][];
    c.time = 1.5; c.runPending();
    expect(sounds().filter((s) => s[1] === 'explosion_small').length).toBe(9);
    expect(sounds().filter((s) => s[1] === 'explosion_large').length).toBe(0);
    for (const s of sounds()) expect(Math.hypot(s[2].x - 1000, s[2].y + 500)).toBeLessThanOrEqual(200 + 1e-6);
    c.time = 1.6; c.runPending();
    const large = sounds().filter((s) => s[1] === 'explosion_large');
    expect(large.length).toBe(1);
    expect(large[0][2]).toEqual({ x: 1000, y: -500 });
    c.time = 10; c.runPending();
    expect(sounds().length).toBe(10);
  });
});
