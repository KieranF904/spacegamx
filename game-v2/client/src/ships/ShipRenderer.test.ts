/**
 * Taking a hit (ShipRenderer.hit): damage and the hit flash are data the hull shader reads, so a hit only sets the
 * view's flash level: it builds no hull and drops no cache. A big hull flashes far less than a small one.
 */
import { describe, expect, it } from 'vitest';
import { ShipRenderer } from './ShipRenderer';
import { HULLS, ASKED } from './render/hullCaches';
import type { BodyView } from './render/viewTypes';

function renderer(radius: number) {
  const view = { flashLevel: 0, hullKey: 'k', ship: { derived: { radius } }, turretShip: null } as unknown as BodyView;
  const r = Object.create(ShipRenderer.prototype) as { views: Map<number, BodyView>; hit(id: number, amount: number): void };
  r.views = new Map([[1, view]]);
  return { r, view };
}

describe('damage and the hit flash are data the hull shader reads: taking hits builds nothing', () => {
  it('a hit raises only the flash level; the view\'s hull and the hull caches are untouched', () => {
    const { r, view } = renderer(60);
    const bp = view.ship!.blueprint;
    const before = [HULLS.get(bp), ASKED.get(bp), view.hullKey, view.ship, view.turretShip];
    r.hit(1, 20);
    expect(view.flashLevel).toBeGreaterThan(0);
    expect([HULLS.get(bp), ASKED.get(bp), view.hullKey, view.ship, view.turretShip]).toEqual(before);
    // a harder hit flashes harder (to a cap); a hit on a ship that is not drawn is nothing
    const soft = view.flashLevel;
    r.hit(1, 80);
    expect(view.flashLevel).toBeGreaterThan(soft);
    expect(view.flashLevel).toBeLessThanOrEqual(0.75);
    r.hit(99, 80);
  });
  it('a boss-sized hull flashes far less than a small ship for the same hit', () => {
    const small = renderer(60), boss = renderer(1600);
    small.r.hit(1, 40);
    boss.r.hit(1, 40);
    expect(boss.view.flashLevel).toBeLessThan(small.view.flashLevel / 3);
  });
});
