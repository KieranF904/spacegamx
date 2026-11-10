/**
 * @contract client.ship.render.muzzle
 * owns:       where a shot left a gun as drawn: which turret or barrel recoils and warms, its spin, and the barrel tip a shot comes out of
 * needs:      the views map (BodyView, Turret, Barrel)
 * invariants: the nearest muzzle to the shot takes the kick — client/src/ships/render/muzzle.test.ts
 *             twin barrels take turns (view.salvo) — client/src/ships/render/muzzle.test.ts
 * extend:     a new muzzle query is one more exported function here
 */

import type { BodyView, Turret, Barrel } from './viewTypes';
import { HEAT_PER_SHOT } from './constants';

/**
 * A shot left a gun at (x, y): the turret it came from (the one whose muzzle
 * is nearest) recoils and warms up.
 */
export function kickGun(views: ReadonlyMap<number, BodyView>, owner: number, x: number, y: number, power = 1): void {
  const view = views.get(owner);
  if (!view || (!view.turrets.length && !view.fixed.length)) return;
  const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  let best: { kick: number; heat: number; len: number; fired?: boolean } | null = null, bestD = Infinity;
  const near = (g: { kick: number; heat: number; len: number; fired?: boolean }, tx: number, ty: number) => {
    const d = Math.hypot(c.x + tx * cos - ty * sin - x, c.y + tx * sin + ty * cos - y);
    if (d < bestD) { bestD = d; best = g; }
  };
  for (const t of view.turrets) near(t, t.x0 + Math.cos(t.barrel.rotation) * t.len, t.y0 + Math.sin(t.barrel.rotation) * t.len);
  for (const b of view.fixed) near(b, b.x0 + b.rx * b.len, b.y0 + b.ry * b.len);
  const hit = best as { kick: number; heat: number; len: number; fired?: boolean } | null;
  if (!hit || bestD > hit.len + 40) return;
  // (a turret's drawn barrel caught up with the angle it fired at: turretEase.ts fireCatch)
  if (view.turrets.includes(hit as Turret)) hit.fired = true;
  hit.kick = Math.min(1.4, power);
  hit.heat = Math.min(1, hit.heat + HEAT_PER_SHOT);
}

/**
 * How far the spin of the gun a shot left (x, y) from has got (0..1): your own gun's spin, another ship's how hard it is
 * being fired (its barrel heat). 0 if no gun fits.
 */
export function spinAtGun(views: ReadonlyMap<number, BodyView>, playerId: number, owner: number, x: number, y: number): number {
  const view = views.get(owner);
  if (!view || (!view.turrets.length && !view.fixed.length)) return 0;
  const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  let best: Turret | Barrel | null = null, bestD = Infinity;
  for (const t of view.turrets) {
    const d = Math.hypot(c.x + t.x0 * cos - t.y0 * sin - x, c.y + t.x0 * sin + t.y0 * cos - y);
    if (d < bestD) { bestD = d; best = t; }
  }
  for (const b of view.fixed) {
    const d = Math.hypot(c.x + b.x0 * cos - b.y0 * sin - x, c.y + b.x0 * sin + b.y0 * cos - y);
    if (d < bestD) { bestD = d; best = b; }
  }
  if (!best) return 0;
  const ship = view.ship;
  if (owner === playerId && ship) return Math.max(0, Math.min(1, ship.spin[best.part] ?? 0));
  return Math.min(1, best.heat * 1.1);
}

/**
 * Where a shot leaving (x, y) along `angle` comes out of its gun as drawn:
 * the tip of the barrel it left by (a fixed gun's barrels poke out past the
 * facing edge where shells spawn; twin barrels take turns; a turret's barrel
 * ends where its shells do). Null if no barrel of the ship's fits.
 */
export function barrelTipOf(views: ReadonlyMap<number, BodyView>, cellSize: number, owner: number, x: number, y: number, angle: number): { x: number; y: number } | null {
  const view = views.get(owner);
  if (!view || (!view.turrets.length && !view.fixed.length)) return null;
  const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
  const ax = Math.cos(angle), ay = Math.sin(angle);
  const world = (tx: number, ty: number) => [c.x + tx * cos - ty * sin, c.y + tx * sin + ty * cos];
  const fits: { d: number; tip: number[] }[] = [];
  for (const b of view.fixed) {
    if (b.debris) continue;
    // Pointing (about) the way the shot went, from the edge it spawned on (turned on its gimbal)
    const nx = b.rx * cos - b.ry * sin, ny = b.rx * sin + b.ry * cos;
    if (nx * ax + ny * ay < 0.94) continue;
    const [bx, by] = world(b.x0, b.y0);
    fits.push({ d: Math.hypot(bx - x, by - y), tip: [bx + nx * b.len, by + ny * b.len] });
  }
  for (const t of view.turrets) {
    const [tx, ty] = world(t.x0 + Math.cos(t.barrel.rotation) * t.len, t.y0 + Math.sin(t.barrel.rotation) * t.len);
    fits.push({ d: Math.hypot(tx - x, ty - y), tip: [tx, ty] });
  }
  if (!fits.length) return null;
  const best = Math.min(...fits.map((f) => f.d));
  if (best > cellSize * 1.6) return null;
  // Twin barrels the same way from the spawn point: each in turn
  const tied = fits.filter((f) => f.d <= best + 2);
  const pick = tied[(view.salvo = (view.salvo ?? 0) + 1) % tied.length];
  return { x: pick.tip[0], y: pick.tip[1] };
}
