import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { gunPlan, type GunPlan } from './gunPlan';
import { DIST_MAX, DIST_MIN, MIN_ZOOM, PREVIEW_H, PREVIEW_W, WALL_COLS, frame, reachOf } from './framing';

const { catalog, tuning } = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const plans: GunPlan[] = [];
for (const fn of catalog.functions.values()) { const p = gunPlan(catalog, tuning, fn); if (p) plans.push(p); }
const byKind = (kind: string) => plans.filter((p) => p.kind === kind && !p.support);

/** Everything the view shows sits on the canvas: the gun's art behind the muzzle, the wall's far side, the wall's height */
function fits(p: GunPlan, back = 80, half = 30): void {
  const f = frame(p, back, half);
  expect(f.zoom).toBeGreaterThanOrEqual(MIN_ZOOM - 1e-9);
  expect(f.originX - back * f.zoom).toBeGreaterThanOrEqual(-0.5);
  expect(f.originX + (f.farX + 6) * f.zoom).toBeLessThanOrEqual(PREVIEW_W + 0.5);
  expect(f.halfH * f.zoom).toBeLessThanOrEqual(PREVIEW_H / 2);
  expect(half * f.zoom).toBeLessThanOrEqual(PREVIEW_H / 2);
}

describe('gun preview framing', () => {
  it('has real guns to test', () => {
    expect(plans.length).toBeGreaterThan(20);
  });
  it('every gun and its wall fit the canvas at no less than the minimum zoom', () => {
    for (const p of plans) fits(p);
    for (const p of plans) fits(p, 190, 60);
  });
  it('a short gun stands the wall at 70-85% of its reach', () => {
    const short = plans.filter((p) => !p.support && reachOf(p) > 0 && reachOf(p) < 1000 && reachOf(p) * 0.78 >= DIST_MIN);
    expect(short.length).toBeGreaterThan(0);
    for (const p of short) {
      const f = frame(p, 80, 30), r = reachOf(p);
      expect(f.dist).toBeGreaterThanOrEqual(r * 0.7);
      expect(f.dist).toBeLessThanOrEqual(r * 0.85);
      // (the reach tick is in view past the wall)
      expect(f.tickX).toBe(r);
    }
  });
  it('a long rail gun stands the wall far out (held by the minimum zoom) and marks that its reach is off the view', () => {
    const rails = byKind('railgun');
    expect(rails.length).toBeGreaterThan(0);
    for (const p of rails) {
      const f = frame(p, 80, 30);
      expect(reachOf(p)).toBeGreaterThan(2000);
      expect(f.dist).toBe(DIST_MAX);
      expect(f.dist).toBeLessThanOrEqual(reachOf(p) * 0.85);
      expect(f.tickX).toBeNull();
    }
  });
  it('a lobbed gun is aimed inside the wall, short of its reach', () => {
    const lobs = plans.filter((p) => p.lob);
    expect(lobs.length).toBeGreaterThan(0);
    for (const p of lobs) {
      const f = frame(p, 80, 30);
      expect(f.aimX).toBeGreaterThan(f.dist);
      expect(f.aimX).toBeLessThan(f.dist + f.depth);
      expect(f.dist).toBeLessThanOrEqual(reachOf(p) * 0.85);
    }
  });
  it('a beam stands the wall at its range share', () => {
    const beams = plans.filter((p) => p.beam && !p.support && p.range > 0);
    expect(beams.length).toBeGreaterThan(0);
    for (const p of beams) {
      const f = frame(p, 80, 30);
      expect(f.dist).toBeLessThanOrEqual(p.range * 0.85);
      expect(f.dist).toBeGreaterThanOrEqual(Math.min(p.range * 0.7, DIST_MAX));
    }
  });
  it('a seeker\'s reach counts its speeding up, not its top speed over its whole life', () => {
    for (const p of plans.filter((q) => q.tracked && q.accel > 0 && !q.beam)) {
      expect(reachOf(p)).toBeLessThanOrEqual(p.maxSpeed * p.life + 1e-6);
      expect(reachOf(p)).toBeGreaterThan(p.speed * p.life - 1e-6);
    }
  });
  it('a gun with a tiny reach still stands the wall short of it', () => {
    const p = { ...plans[0], beam: false, support: undefined, speed: 10, maxSpeed: 0, life: 12, accel: 0, tracked: false, lob: false } as GunPlan;
    const f = frame(p, 80, 30);
    expect(f.dist).toBeLessThanOrEqual(120 * 0.85);
    expect(f.farX).toBeCloseTo(f.dist + WALL_COLS * f.block, 6);
  });
});
