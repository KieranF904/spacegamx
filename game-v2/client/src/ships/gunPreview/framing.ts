/**
 * @contract client.ships.gun-preview.framing
 * owns:       where the hangar gun preview's block wall stands and how the view is scaled to fit gun, flight and wall (no Pixi, no DOM)
 * needs:      GunPlan (gunPlan.ts)
 * invariants: the wall stands at 70-85% of the gun's reach, held between a near and a far limit — client/src/ships/gunPreview/framing.test.ts
 *             gun, flight and wall always fit the canvas, at no less than the minimum zoom — client/src/ships/gunPreview/framing.test.ts
 * extend:     a new kind of weapon reach is one case in reachOf
 */

import type { GunPlan } from './gunPlan';

export const PREVIEW_W = 300;
export const PREVIEW_H = 150;
/** The wall: blocks deep (along the line of fire) and tall */
export const WALL_COLS = 3;
export const WALL_ROWS = 5;
/** The wall stands this share of the gun's reach away, within the limits (world units): a long gun's is held by the minimum zoom */
export const REACH_SHARE = 0.78;
export const DIST_MIN = 110;
export const DIST_MAX = 1000;
/** The least the view is zoomed out (screen px a world unit): the gun's cells and the wall's blocks stay readable */
export const MIN_ZOOM = 0.2;
/** The most the view is zoomed in (a short gun, a small wall) */
export const MAX_ZOOM = 1.1;
/** Blocks grow with the distance (a share of cell size a 320-unit gap is 1:1) so a far wall still reads */
const BLOCK_PER_DIST = 320;
const BLOCK_MAX_SCALE = 2.4;

export interface Framing {
  /** The gun's reach (world units from the muzzle) */
  reach: number;
  /** Muzzle to the wall's front face */
  dist: number;
  /** A block's side, and the wall's depth and half height */
  block: number;
  depth: number;
  halfH: number;
  /** The x at the wall's back, and the x a lobbed round is aimed at (inside the front column) */
  farX: number;
  aimX: number;
  /** Screen px a world unit, and where the muzzle (world origin) sits on the canvas */
  zoom: number;
  originX: number;
  originY: number;
  /** The reach tick's x if it is in view, else null (it is off the right edge) */
  tickX: number | null;
}

/**
 * How far a gun really carries (world units). A beam its range; a round the ground it covers in its life (a seeker
 * speeds up along the way, so its sum, not top speed over life); a lobbed round its flight.
 */
export function reachOf(p: GunPlan): number {
  if (p.beam || p.support) return Math.max(0, p.range);
  if (p.tracked && p.accel > 0) {
    let d = 0, v = Math.max(0.1, p.speed);
    for (let t = 0; t < p.life; t++) {
      d += v;
      v = Math.min(p.maxSpeed > 0 ? p.maxSpeed : v + p.accel, v + p.accel);
    }
    return d;
  }
  return Math.max(0, (p.maxSpeed || p.speed) * p.life);
}

/** The framing for a gun whose art reaches `leftMargin` behind the muzzle and `gunHalfH` either side of its line */
export function frame(plan: GunPlan, leftMargin: number, gunHalfH: number): Framing {
  const reach = reachOf(plan);
  // (the share of its reach, kept short of the reach itself for a gun that carries only a little)
  let dist = Math.max(DIST_MIN, Math.min(DIST_MAX, reach * REACH_SHARE));
  if (reach > 0) dist = Math.min(dist, reach * 0.85);
  dist = Math.max(40, dist);
  const block = plan.cell * Math.max(1, Math.min(BLOCK_MAX_SCALE, dist / BLOCK_PER_DIST));
  const depth = WALL_COLS * block, halfH = (WALL_ROWS * block) / 2;
  // (the reach tick is kept in view when the wall stands at its share of it; a far reach held by the minimum zoom is off the right edge)
  const tickIn = reach > 0 && reach <= dist / 0.7;
  const span = leftMargin + Math.max(dist + depth + 24, tickIn ? reach + 12 : 0);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, PREVIEW_W / span, PREVIEW_H / 2 / (Math.max(gunHalfH, halfH) * 1.12)));
  // (centred, unless the minimum zoom leaves it no room: then the muzzle sits at the left with its art)
  const originX = leftMargin * zoom + Math.max(0, (PREVIEW_W - span * zoom) / 2);
  const right = (PREVIEW_W - originX) / zoom - 6;
  return {
    reach, dist, block, depth, halfH, farX: dist + depth, aimX: dist + block * 0.5,
    zoom, originX, originY: PREVIEW_H / 2, tickX: tickIn && reach <= right ? reach : null,
  };
}
