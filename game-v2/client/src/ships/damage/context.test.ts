/** The damage effects' shared context (damage/context.ts): a delayed action runs once, on the first update at or after its time. */
import { describe, expect, it } from 'vitest';
import { DamageCtx } from './context';

const ctx = (entities = new Map<number, unknown>(), playerId = 1) =>
  new DamageCtx({} as never, {} as never, { entities, playerId } as never, () => {}, 100);

describe('DamageCtx delayed actions', () => {
  it('runs an action only once the clock reaches its time, and only once', () => {
    const c = ctx();
    const ran: string[] = [];
    c.later(0.5, () => ran.push('a'));
    c.runPending();
    expect(ran).toEqual([]);
    c.time = 0.49; c.runPending();
    expect(ran).toEqual([]);
    c.time = 0.5; c.runPending();
    expect(ran).toEqual(['a']);
    c.time = 5; c.runPending();
    expect(ran).toEqual(['a']);
  });

  it('is relative to the clock when it was queued; a late first update still runs everything due', () => {
    const c = ctx();
    c.time = 10;
    const ran: number[] = [];
    c.later(1, () => ran.push(1));
    c.later(2, () => ran.push(2));
    c.later(3, () => ran.push(3));
    c.time = 12.5; c.runPending();
    expect(ran.sort()).toEqual([1, 2]);
    c.time = 13; c.runPending();
    expect(ran.sort()).toEqual([1, 2, 3]);
  });

  it('an action queued from a running action waits for the next update', () => {
    const c = ctx();
    const ran: string[] = [];
    c.later(0, () => { ran.push('first'); c.later(0, () => ran.push('second')); });
    c.runPending();
    expect(ran).toEqual(['first']);
    c.runPending();
    expect(ran).toEqual(['first', 'second']);
  });

  it('near() is false without a local ship and measures from where it is drawn', () => {
    const none = ctx();
    expect(none.near(0, 0, 1e9)).toBe(false);
    const c = ctx(new Map([[1, { renderX: 100, renderY: 0 }]]));
    expect(c.near(130, 40, 51)).toBe(true);
    expect(c.near(130, 40, 49)).toBe(false);
  });
});
