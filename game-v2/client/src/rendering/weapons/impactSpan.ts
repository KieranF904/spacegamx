/**
 * How big and how long a hit's layered impact is (ImpactLayers), from its data alone: how far its typical parts reach
 * (world units) and how many frames they last, the same for its tail (the outlier fragments and embers: faster and
 * longer-lived, impactAim burstSpeed / burstLife), and the fragments it throws. The hull scorch and the light aside.
 * For the impact audit (scripts/balance/impact-audit.ts) and the tests that keep a heavy gun's hit bigger and longer
 * than a light one's. `size`: the shot's shell size x damage scale, as WeaponFx scales it (impactScale).
 */

import type { BurstSpread, WeaponStyle } from './weaponStyles';
import { BURST } from './impactAim';

/** How far something leaving at `v` a frame, keeping `drag` of its speed each frame, goes in `frames` */
function travel(v: number, drag: number, frames: number): number {
  return (v * (1 - Math.pow(drag, frames))) / (1 - drag);
}

export interface ImpactSpan {
  /** How far the typical parts reach, and how many frames they last */
  size: number; frames: number;
  /** The same for the tail: the outliers' furthest reach and longest life (at least the typical) */
  tailSize: number; tailFrames: number;
  fragments: number;
}

export function impactSpan(style: WeaponStyle, size: number): ImpactSpan {
  const k = Math.sqrt(Math.max(0.2, size)), L = style.hit;
  if (!L) {
    const imp = style.impact, r = Math.max(imp.flash * size, travel(imp.speed, 0.9, imp.life * 1.2)), f = Math.max(16, imp.life * 1.2);
    return { size: r, frames: f, tailSize: r, tailFrames: f, fragments: 0 };
  }
  let reach = 0, frames = 0, tReach = 0, tFrames = 0;
  const at = (r: number, f: number, tr = r, tf = f): void => {
    reach = Math.max(reach, r); frames = Math.max(frames, f); tReach = Math.max(tReach, tr, r); tFrames = Math.max(tFrames, tf, f);
  };
  /** A burst (debris, embers): its typical part at its typical speed and life; its tail at the outliers' (burstSpeed, burstLife tops) */
  const burst = (b: { speed: number; life: number } & BurstSpread, drag: number): void => {
    const tl = b.life * (b.outLife ?? BURST.outLife) * 1.15, ts = b.speed * (b.outSpeed ?? BURST.outSpeed) * 1.3;
    at(travel(b.speed, drag, b.life), b.life, travel(ts, drag, tl), tl);
  };
  if (L.core) at(L.core.size * k, L.core.life);
  if (L.bloom) at(L.bloom.size * k, L.bloom.life);
  if (L.shock) at(L.shock.size * k, L.shock.life + (L.shock.count ?? 0) * (L.shock.gap ?? 4));
  if (L.spray) at(travel(L.spray.speed * 1.25, 0.88, L.spray.life * 1.2), L.spray.life * 1.2);
  if (L.ricochet) at(travel(L.ricochet.speed * 1.2, 0.93, L.ricochet.life * 1.2), L.ricochet.life * 1.2);
  if (L.flare) at(L.flare.size * k * 1.1, L.flare.life);
  if (L.fireball) at(L.fireball.size * k * 1.6, L.fireball.life * 1.2 + (L.fireball.count ?? 3));
  if (L.embers) burst(L.embers, 0.94);
  if (L.debris) burst(L.debris, L.debris.drag ?? 0.95);
  const lq = L.liquid;
  if (lq) {
    // (a liquid splash: its blobs' highest arc or the film's creep, whichever reaches further; the film, or a late blob's smear, lasting longest)
    const v = lq.blobs.speed * Math.sqrt(k) * 1.1, F = lq.film;
    at(Math.max((v * v) / (2 * Math.max(0.01, lq.blobs.pull)), F.length * k * 1.4 + F.creep * F.life * 0.6), Math.max(F.life, lq.blobs.life * 1.2 + F.life * 0.6));
  }
  return { size: reach, frames, tailSize: tReach, tailFrames: tFrames, fragments: L.debris ? Math.round(L.debris.count * Math.min(1.5, k)) : 0 };
}
