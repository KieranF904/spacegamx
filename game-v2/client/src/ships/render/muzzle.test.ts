/**
 * Where a shot left a gun as drawn: the nearest muzzle takes the kick, and twin barrels take turns (muzzle.ts).
 */
import { describe, expect, it } from 'vitest';
import { kickGun, barrelTipOf } from './muzzle';
import { HEAT_PER_SHOT } from './constants';
import type { BodyView } from './viewTypes';

const turret = (x0: number, y0: number) => ({ part: 0, x0, y0, len: 10, kick: 0, heat: 0, barrel: { rotation: 0 } });
// A fixed gun's barrel pokes along +x from (x0, y0)
const fixed = (x0: number, y0: number) => ({ part: 1, x0, y0, rx: 1, ry: 0, len: 10, kick: 0, heat: 0 });
const view = (turrets: object[], fixedGuns: object[]) =>
  ({ container: { x: 0, y: 0, rotation: 0 }, turrets, fixed: fixedGuns }) as unknown as BodyView;

describe('the nearest muzzle to the shot takes the kick', () => {
  it('only the closest of two turrets recoils and warms', () => {
    const a = turret(0, 0), b = turret(100, 0);
    kickGun(new Map([[1, view([a, b], [])]]), 1, 108, 0);
    expect(b.kick).toBe(1);
    expect(b.heat).toBeCloseTo(HEAT_PER_SHOT);
    expect(a.kick).toBe(0);
    expect(a.heat).toBe(0);
  });
  it('a fixed gun nearer than a turret takes it, and a shot far from every muzzle kicks nothing', () => {
    const t = turret(0, 0), f = fixed(100, 0);
    const views = new Map([[1, view([t], [f])]]);
    kickGun(views, 1, 110, 0);
    expect(f.kick).toBe(1);
    expect(t.kick).toBe(0);
    kickGun(views, 1, 5000, 5000);
    expect(t.kick).toBe(0);
  });
});

describe('twin barrels take turns (view.salvo)', () => {
  it('two barrels equally near the shot are picked alternately', () => {
    const v = view([], [fixed(0, -3), fixed(0, 3)]);
    const views = new Map([[1, v]]);
    const ys = [0, 1, 2, 3].map(() => barrelTipOf(views, 20, 1, 0, 0, 0)!.y);
    expect(new Set(ys)).toEqual(new Set([-3, 3]));
    expect(ys[0]).not.toBe(ys[1]);
    expect(ys[0]).toBe(ys[2]);
  });
});
