/**
 * How big and how long a hit's layered impact is (ImpactLayers), from its data alone: the furthest any part of it
 * reaches (world units), how many frames it lasts (the hull scorch and the light aside), and the fragments it throws.
 * For the impact audit (scripts/balance/impact-audit.ts) and the tests that keep a heavy gun's hit bigger and longer
 * than a light one's. `size`: the shot's shell size x damage scale, as WeaponFx scales it (impactScale).
 */

import type { WeaponStyle } from './weaponStyles';

/** How far something leaving at `v` a frame, keeping `drag` of its speed each frame, goes in `frames` */
function travel(v: number, drag: number, frames: number): number {
  return (v * (1 - Math.pow(drag, frames))) / (1 - drag);
}

export function impactSpan(style: WeaponStyle, size: number): { size: number; frames: number; fragments: number } {
  const k = Math.sqrt(Math.max(0.2, size)), L = style.hit;
  if (!L) {
    const imp = style.impact;
    return { size: Math.max(imp.flash * size, travel(imp.speed, 0.9, imp.life * 1.2)), frames: Math.max(16, imp.life * 1.2), fragments: 0 };
  }
  let reach = 0, frames = 0;
  const at = (r: number, f: number): void => { reach = Math.max(reach, r); frames = Math.max(frames, f); };
  if (L.core) at(L.core.size * k, L.core.life);
  if (L.bloom) at(L.bloom.size * k, L.bloom.life);
  if (L.shock) at(L.shock.size * k, L.shock.life + (L.shock.count ?? 0) * (L.shock.gap ?? 4));
  if (L.spray) at(travel(L.spray.speed * 1.25, 0.88, L.spray.life * 1.2), L.spray.life * 1.2);
  if (L.ricochet) at(travel(L.ricochet.speed * 1.2, 0.93, L.ricochet.life * 1.2), L.ricochet.life * 1.2);
  if (L.flare) at(L.flare.size * k * 1.1, L.flare.life);
  if (L.embers) at(travel(L.embers.speed * 1.2, 0.965, L.embers.life * 1.3), L.embers.life * 1.3);
  if (L.fireball) at(L.fireball.size * k * 1.6, L.fireball.life * 1.2 + (L.fireball.count ?? 3));
  if (L.debris) at(travel(L.debris.speed * 1.3, L.debris.drag ?? 0.95, L.debris.life * 1.25), L.debris.life * 1.25);
  return { size: reach, frames, fragments: L.debris ? Math.round(L.debris.count * Math.min(1.5, k)) : 0 };
}
