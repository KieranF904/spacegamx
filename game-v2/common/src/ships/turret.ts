/**
 * Turret firing windows.
 *
 * A turret's base window is ±halfArcDeg around its facing. Rays are cast from
 * the turret's pivot (its centroid) across that window; any angle whose ray
 * passes through another live part of the same ship is closed, so a turret
 * can never fire through its own hull. rebuild() recomputes the window, so it
 * opens up as neighbouring parts are destroyed or break away.
 *
 * Angles are offsets (radians) from the window centre, in the ship's local
 * grid frame, so a window never wraps.
 */

import type { Side, Vec2 } from './types.js';
import { SIDE_NORMAL } from './catalog.js';
import type { PlacedGeom } from './grid.js';
import { pointInConvex, segmentConvexEntry } from './geometry.js';
import type { ShipTuning } from './tuning.js';
import { datan2, dcos, dhypot, dsin } from '../math/detTrig.js';

const DEG = Math.PI / 180;

export interface TurretWindow {
  /** Local grid-frame angle of the facing direction (atan2, y down) */
  center: number;
  /** Half-width of the base window */
  half: number;
  /** Open intervals [lo, hi] as offsets from `center` */
  open: [number, number][];
  /** Rotation point (part centroid), grid units */
  pivot: Vec2;
  /** Muzzle distance from the pivot, cells (clears the turret's own outline) */
  barrel: number;
}

/** Each part's bounding circle round its shrunk pieces, a hair larger (cr -1: it has none) */
export interface PartCircles { cx: Float64Array; cy: Float64Array; cr: Float64Array }

/** A ray that misses a part's circle can't enter any of its pieces, so most parts are passed over without clipping */
export function partCircles(geoms: readonly PlacedGeom[]): PartCircles {
  const n = geoms.length, cx = new Float64Array(n), cy = new Float64Array(n), cr = new Float64Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of geoms[i].convexShrunk) for (const p of c) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
    if (x0 > x1) continue;
    cx[i] = (x0 + x1) / 2; cy[i] = (y0 + y1) / 2;
    cr[i] = dhypot(x1 - x0, y1 - y0) / 2 + 1e-6;
  }
  return { cx, cy, cr };
}

/** What a turret's window is cast from that its design fixes (design.ts keeps one per turret) */
export interface TurretFrame {
  center: number;
  half: number;
  pivot: Vec2;
  barrel: number;
  /** Rays are cast at steps + 1 angles across the base window: each one's cos and sin */
  steps: number;
  ca: Float64Array;
  sa: Float64Array;
  /** Parts that never block it: itself, and the part it sits on (a turret rides above the hull, as a bespoke one sat on a plate does) */
  skip: Uint8Array;
  /** Per part, how far its outline reaches from the pivot, plus one (a ray must clear the whole ship) */
  reachOf: Float64Array;
  circles: PartCircles;
}

export function turretFrame(
  geoms: readonly PlacedGeom[],
  self: number,
  facing: Side | Vec2,
  tuning: ShipTuning,
  /** Its traverse (degrees, centred on its facing): a model's mounting arc (ships/mounting.ts). Default the tuning's */
  arcDeg: number | undefined,
  circles: PartCircles = partCircles(geoms),
): TurretFrame {
  const t = tuning.turret;
  const halfDeg = arcDeg !== undefined ? Math.max(0.5, Math.min(180, arcDeg / 2)) : t.halfArcDeg;
  // (A grid part's facing side, or a bespoke mount's direction)
  const n = typeof facing === 'string' ? SIDE_NORMAL[facing] : facing;
  const center = datan2(n[1], n[0]);
  const half = halfDeg * DEG;
  const g = geoms[self];
  const pivot = g.centroid;
  let barrel = 0;
  for (const p of g.polygon) barrel = Math.max(barrel, dhypot(p[0] - pivot[0], p[1] - pivot[1]));
  barrel += t.barrelMargin;
  const steps = Math.max(1, Math.round((2 * halfDeg) / t.sampleDeg));
  const ca = new Float64Array(steps + 1), sa = new Float64Array(steps + 1);
  for (let k = 0; k <= steps; k++) {
    const a = center - half + (k / steps) * 2 * half;
    ca[k] = dcos(a); sa[k] = dsin(a);
  }
  const N = geoms.length, skip = new Uint8Array(N), reachOf = new Float64Array(N).fill(-Infinity);
  for (let i = 0; i < N; i++) {
    for (const p of geoms[i].polygon) reachOf[i] = Math.max(reachOf[i], dhypot(p[0] - pivot[0], p[1] - pivot[1]) + 1);
    if (i === self || geoms[i].convexShrunk.some((c) => pointInConvex(c, pivot[0], pivot[1]))) skip[i] = 1;
  }
  return { center, half, pivot, barrel, steps, ca, sa, skip, reachOf, circles };
}

/**
 * A turret's window as cast, and per ray the part that closed it (-1: open). rebuild.ts keeps it from one rebuild to the
 * next: losing parts can only open rays, so after a rebuild where parts only went away (castTurret's `prev`), a window
 * already wide open stays as it is, and only the rays whose blocker went are cast again.
 */
export interface TurretRays {
  win: TurretWindow;
  reach: number;
  blocker: Int32Array;
  /** Rays closed */
  closed: number;
}

/** Ray k cast `reach` long: does part j block it? (Shrunk pieces, so parts that merely touch the turret don't count as cover) */
function rayBlockedBy(f: TurretFrame, geoms: readonly PlacedGeom[], j: number, k: number, reach: number): boolean {
  const { pivot, circles } = f, ca = f.ca[k], sa = f.sa[k];
  const ox = circles.cx[j] - pivot[0], oy = circles.cy[j] - pivot[1], r = circles.cr[j];
  if (r < 0 || Math.abs(ox * sa - oy * ca) > r || ox * ca + oy * sa < -r) return false;
  const x1 = pivot[0] + ca * reach, y1 = pivot[1] + sa * reach;
  for (const c of geoms[j].convexShrunk) if (segmentConvexEntry(c, pivot[0], pivot[1], x1, y1) !== null) return true;
  return false;
}

/** The first live part (in part order) that blocks ray k, -1 none */
function firstBlocker(f: TurretFrame, geoms: readonly PlacedGeom[], alive: readonly boolean[], k: number, reach: number): number {
  for (let j = 0; j < geoms.length; j++) {
    if (f.skip[j] || !alive[j]) continue;
    if (rayBlockedBy(f, geoms, j, k, reach)) return j;
  }
  return -1;
}

function windowOf(f: TurretFrame, blocker: Int32Array): TurretWindow {
  const { steps, half } = f;
  const open: [number, number][] = [];
  let start = -1;
  for (let k = 0; k <= steps + 1; k++) {
    const isFree = k <= steps && blocker[k] < 0;
    if (isFree && start < 0) start = k;
    if (!isFree && start >= 0) {
      open.push([-half + (start / steps) * 2 * half, -half + ((k - 1) / steps) * 2 * half]);
      start = -1;
    }
  }
  return { center: f.center, half, open, pivot: f.pivot, barrel: f.barrel };
}

/**
 * Cast a turret's window among the live parts. `prev`: its rays from the last rebuild, of the same design, when every
 * part alive now was alive then (rebuild.ts checks that); without it, every ray is cast.
 */
export function castTurret(f: TurretFrame, geoms: readonly PlacedGeom[], alive: readonly boolean[], prev?: TurretRays): TurretRays {
  // (A window wide open stays so: parts going can't close a ray)
  if (prev && prev.closed === 0) return prev;
  // Long enough to clear the whole ship
  let reach = 1;
  for (let j = 0; j < geoms.length; j++) if (alive[j] && f.reachOf[j] > reach) reach = f.reachOf[j];
  const blocker = new Int32Array(f.steps + 1);
  let closed = 0, opened = false;
  for (let k = 0; k <= f.steps; k++) {
    let b: number;
    if (!prev) b = firstBlocker(f, geoms, alive, k, reach);
    else {
      const was = prev.blocker[k];
      if (was < 0) b = -1;
      // (Its blocker's still there: still closed. A ray cast shorter is checked against it again)
      else if (alive[was] && (reach === prev.reach || rayBlockedBy(f, geoms, was, k, reach))) b = was;
      else { b = firstBlocker(f, geoms, alive, k, reach); if (b < 0) opened = true; }
    }
    blocker[k] = b;
    if (b >= 0) closed++;
  }
  return { win: prev && !opened ? prev.win : windowOf(f, blocker), reach, blocker, closed };
}

/** A turret's window among the live parts, every ray cast (rebuild.ts keeps its rays from one rebuild to the next: castTurret) */
export function computeTurretWindow(
  geoms: PlacedGeom[],
  alive: boolean[],
  self: number,
  facing: Side | Vec2,
  tuning: ShipTuning,
  /** Its traverse (degrees, centred on its facing): a model's mounting arc (ships/mounting.ts). Default the tuning's */
  arcDeg?: number,
): TurretWindow {
  return castTurret(turretFrame(geoms, self, facing, tuning, arcDeg), geoms, alive).win;
}

export function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function isOpen(w: TurretWindow, offset: number): boolean {
  return w.open.some(([lo, hi]) => offset >= lo - 1e-9 && offset <= hi + 1e-9);
}

/**
 * Slew a turret towards a desired local angle. The turret can rotate across
 * its whole base window (it sits above the hull) but only fires where open.
 * Returns the new offset and whether it may fire this tick.
 */
export function stepTurretAim(
  w: TurretWindow,
  current: number,
  desiredLocalAngle: number,
  tuning: ShipTuning,
): { offset: number; canFire: boolean } {
  const want = wrapPi(desiredLocalAngle - w.center);
  // (A full-circle turret turns the short way round, through its back)
  const full = w.half >= Math.PI - 1e-9;
  const inBase = full || Math.abs(want) <= w.half;
  const target = full ? want : Math.max(-w.half, Math.min(w.half, want));
  const delta = full ? wrapPi(target - current) : target - current;
  const step = Math.max(-tuning.turret.slewRate, Math.min(tuning.turret.slewRate, delta));
  const offset = full ? wrapPi(current + step) : current + step;
  const aligned = Math.abs(full ? wrapPi(want - offset) : want - offset) <= tuning.turret.fireToleranceDeg * DEG;
  return { offset, canFire: inBase && aligned && isOpen(w, offset) };
}

/**
 * Fixed guns: a tiny gimbal. `desired` is the target's angle relative to the
 * gun's facing (radians); the gun points as close to it as its gimbal allows
 * and is clear to fire when the target is within reach of the gimbal.
 * `heading` is the same angle measured from the ship's centre: when the ship
 * itself is pointed at the target (a close target can sit well off a muzzle
 * that's out on a wing), the gun fires anyway at the closest angle it can.
 * `beam`: a beam has no spread and no fat shell to forgive a near miss, so it
 * swings further (beamGimbalDeg). `gimbalDeg`: the gun's own reach, if its
 * kind has one (tuning.json weapons.<kind>.gimbalDeg: the Lance's), over both.
 */
export function stepFixedGunAim(desired: number, tuning: ShipTuning, heading = desired, beam = false, gimbalDeg?: number): { offset: number; canFire: boolean } {
  const g = (gimbalDeg ?? (beam ? tuning.fixedGun?.beamGimbalDeg : undefined) ?? tuning.fixedGun?.gimbalDeg ?? 2) * DEG;
  const tol = (tuning.fixedGun?.fireToleranceDeg ?? 0.5) * DEG;
  const wrap = (a: number) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const d = wrap(desired), h = wrap(heading);
  return { offset: Math.max(-g, Math.min(g, d)), canFire: Math.min(Math.abs(d), Math.abs(h)) <= g + tol };
}
