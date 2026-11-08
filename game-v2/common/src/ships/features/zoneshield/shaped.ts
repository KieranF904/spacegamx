/**
 * Shaped shields (the Shield Lab, prototypes/shield-fx): a shield that covers a line (a wall) or an arc instead of the
 * whole ship. Each is a part with its own HP pool and recharge, projected from the part's open edge in the ship's own
 * frame. A shot is stopped by one only if its path crosses the line or arc before it reaches the hull; everything else
 * goes on to the hull as it did. Pure maths and rules, shared: the server decides every hit, a client works the same
 * out from the state it is told (see `packShaped`), so both agree on which shield a shot meets.
 *
 * Geometry is in the ship's grid space (cells about the grid origin, as part outlines are: collide.ts castParts), so
 * it rides with the hull whatever the pose; a world segment is taken into it by hitRules.ts castShipAt's own maths.
 *
 * (No value import from the registry cycle: only types and grades are used.)
 */

import type { FunctionDef, MaterialDef, Vec2 } from '../../types.js';
import type { PartMount } from '../../grid.js';
import { fnOutput } from '../../grades.js';
import { dcos, datan2, dhypot } from '../../../math/detTrig.js';

/** Ticks a second */
const TPS = 60;
/** Seconds a shield goes unhit before it refills (the Lab's REGEN_IDLE) */
export const SHAPED_IDLE = 1.2;
/** The share of its capacity a broken shield comes back with (the Lab's RETURN_FRAC) */
export const SHAPED_RETURN = 0.25;
/** Most shaped shields a ship uses (the Lab's MAX_SHIELDS); the rest of its shield parts do nothing */
export const MAX_SHAPED = 8;
/** Levels a shield's HP is told in (a nibble on the wire: 0 down, 1..15 live) */
const LEVELS = 14;
/** 16 to the i: a nibble's place in the packed number (no `**`: simMaths) */
const NIBBLE = [1, 16, 256, 4096, 65536, 1048576, 16777216, 268435456];

/** One derived shaped shield: where it stands in the ship's grid (cells) and what it holds */
export interface ShapedShield {
  /** The projector part */
  part: number;
  kind: 'wall' | 'arc';
  /** The projector's emitter point on the hull edge, and the way out of it */
  px: number; py: number; dx: number; dy: number;
  /** A wall's ends */
  ax: number; ay: number; bx: number; by: number;
  /** An arc's centre, radius (cells), middle angle, half span (radians) and cos(half span) */
  cx: number; cy: number; r: number; mid: number; half: number; cosHalf: number;
  /** HP held, HP a second refilled, ticks down after a break */
  cap: number; rate: number; delay: number;
  /** The slow, deep kind (drawn amber, the quick kind cyan) */
  deep: boolean;
  /** The farthest point of it from the grid origin (cells): how far past the hull the shield reaches */
  far: number;
}

/** What a ship's shaped shields are (`derived.fx.shaped`) */
export interface ShapedInfo {
  shields: ShapedShield[];
}

declare module '../types.js' {
  interface FeatureDerived { shaped?: ShapedInfo }
}

/** One shaped shield of a function at a mount, in grid cells; null if the function has none or the mount no edge */
export function shapedAt(fn: FunctionDef, mat: MaterialDef | undefined, part: number, mount: PartMount | null): ShapedShield | null {
  const s = fn.shaped;
  if (!s || !mount) return null;
  const nx = mount.dir[0], ny = mount.dir[1], px = mount.at[0], py = mount.at[1];
  const o = mat ? fnOutput(fn, mat) : 1;
  const out: ShapedShield = {
    part, kind: s.kind, px, py, dx: nx, dy: ny, ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, r: 0, mid: 0, half: 0, cosHalf: 1,
    cap: Math.round(s.cap * o * 100) / 100, rate: Math.round(s.rate * o * 100) / 100, delay: Math.round(s.delay * TPS), deep: !!s.deep, far: 0,
  };
  if (s.kind === 'wall') {
    const cx = px + nx * (s.off ?? 1), cy = py + ny * (s.off ?? 1), tx = -ny, ty = nx, hl = (s.len ?? 2) / 2;
    out.ax = cx - tx * hl; out.ay = cy - ty * hl; out.bx = cx + tx * hl; out.by = cy + ty * hl;
    out.far = Math.max(dhypot(out.ax, out.ay), dhypot(out.bx, out.by));
  } else {
    out.cx = px; out.cy = py; out.r = s.rad ?? 2;
    out.mid = datan2(ny, nx); out.half = ((s.span ?? 90) * Math.PI) / 360; out.cosHalf = dcos(out.half);
    out.far = dhypot(px, py) + out.r;
  }
  return out;
}

/** The result of a crossing test: how far along the segment (0..1) and which shield (index into the ship's list) */
export interface ShapedCross { t: number; i: number }

/**
 * The first live shield the segment (x0, y0) to (x1, y1) crosses, in grid cells (the Lab's crossShields): a wall by
 * the segment meeting its line, an arc by the segment meeting its circle inside the arc's span. A segment that starts
 * inside an arc's circle can still leave through it. `live(i)` says which shields are up. Null: none; `out` is filled
 * and returned when one is (no allocation per call).
 */
export function crossShaped(list: readonly ShapedShield[], live: (i: number) => boolean, x0: number, y0: number, x1: number, y1: number, out: ShapedCross, maxT = 1): ShapedCross | null {
  let hitT = maxT + 1e-12, hit = -1;
  const dx = x1 - x0, dy = y1 - y0;
  for (let i = 0; i < list.length; i++) {
    if (!live(i)) continue;
    const s = list[i];
    if (s.kind === 'wall') {
      const ex = s.bx - s.ax, ey = s.by - s.ay, den = dx * ey - dy * ex;
      if (den > -1e-9 && den < 1e-9) continue;
      const wx = s.ax - x0, wy = s.ay - y0, t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < hitT) { hitT = t; hit = i; }
    } else {
      const fx = x0 - s.cx, fy = y0 - s.cy, A = dx * dx + dy * dy;
      if (A < 1e-12) continue;
      const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - s.r * s.r, disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      for (let k = 0; k < 2; k++) {
        const t = (-B + (k ? sq : -sq)) / (2 * A);
        if (t < 0 || t > 1 || t >= hitT) continue;
        if (s.half < Math.PI - 1e-6) {
          const qx = fx + dx * t, qy = fy + dy * t;
          if ((qx * s.dx + qy * s.dy) / s.r < s.cosHalf) continue;
        }
        hitT = t; hit = i;
      }
    }
  }
  if (hit < 0) return null;
  out.t = hitT; out.i = hit;
  return out;
}

// ---- Per-shield state: kept by part index on the ship (ShipState.shapedHp / shapedDown / shapedIdle), so a field
// refit carries it like any per-part array and a part that is new starts full (hp -1 = not seen yet)

/** The parts of a ship that hold shaped-shield state (read by the server's tick and the client's copy) */
export interface ShapedHolder {
  shapedHp?: number[];
  shapedDown?: number[];
  shapedIdle?: number[];
  blueprint: { parts: readonly unknown[] };
  derived: { fx?: { shaped?: ShapedInfo } };
}

/** A ship's shield list (empty when it has none) */
export function shapedOf(ship: Pick<ShapedHolder, 'derived'>): readonly ShapedShield[] {
  return ship.derived.fx?.shaped?.shields ?? NONE;
}
const NONE: readonly ShapedShield[] = [];

/** Make the state arrays (once; hp -1: a shield not seen yet comes up full) */
export function ensureShaped(ship: ShapedHolder): void {
  if (ship.shapedHp && ship.shapedHp.length === ship.blueprint.parts.length) return;
  const n = ship.blueprint.parts.length;
  ship.shapedHp = new Array<number>(n).fill(-1);
  ship.shapedDown = new Array<number>(n).fill(0);
  ship.shapedIdle = new Array<number>(n).fill(0);
}

/** Is shield `i` of the ship's list up (it holds HP and is not down)? A ship that has not been seen yet is all up */
export function shieldUp(ship: ShapedHolder, i: number): boolean {
  const s = ship.derived.fx?.shaped?.shields[i];
  if (!s) return false;
  const hp = ship.shapedHp?.[s.part];
  if (hp === undefined || hp < 0) return true;
  return hp > 0 && !(ship.shapedDown![s.part] > 0);
}

/** HP the shield holds now (a shield not seen yet: its capacity; down: 0) */
export function shieldHp(ship: ShapedHolder, i: number): number {
  const s = ship.derived.fx?.shaped?.shields[i];
  if (!s) return 0;
  const hp = ship.shapedHp?.[s.part];
  if (hp === undefined || hp < 0) return s.cap;
  return ship.shapedDown![s.part] > 0 ? 0 : hp;
}

/** The share of all its shaped shields' capacity a ship holds (0..1; 0 without any): the HUD bar and the shield percent */
export function shapedFraction(ship: ShapedHolder): number {
  const list = shapedOf(ship);
  let cap = 0, hp = 0;
  for (let i = 0; i < list.length; i++) { cap += list[i].cap; hp += shieldHp(ship, i); }
  return cap > 0 ? hp / cap : 0;
}

/**
 * One tick of every shield's life: a new one comes up full; a broken one counts down and returns at SHAPED_RETURN of its
 * capacity; one unhit for SHAPED_IDLE refills at its rate. `share` is the power it is fed (energy.ts shieldShare) and
 * `scale` a hazard's (a field that wears shields). Allocation-free once the arrays exist.
 */
export function stepShaped(ship: ShapedHolder, share = 1, scale = 1): void {
  const list = ship.derived.fx?.shaped?.shields;
  if (!list || !list.length) return;
  ensureShaped(ship);
  const hp = ship.shapedHp!, down = ship.shapedDown!, idle = ship.shapedIdle!;
  for (let i = 0; i < list.length; i++) {
    const s = list[i], p = s.part;
    if (hp[p] < 0) { hp[p] = s.cap; down[p] = 0; idle[p] = 0; continue; }
    if (down[p] > 0) {
      if (--down[p] <= 0) { down[p] = 0; hp[p] = s.cap * SHAPED_RETURN; idle[p] = Math.round(SHAPED_IDLE * TPS); }
      continue;
    }
    if (hp[p] > s.cap) hp[p] = s.cap;
    idle[p]++;
    if (idle[p] >= SHAPED_IDLE * TPS && hp[p] < s.cap) hp[p] = Math.min(s.cap, hp[p] + (s.rate / TPS) * share * scale);
    else if (idle[p] > 1e6) idle[p] = 1e6;
  }
}

/** What a hit on a shield did */
export interface ShapedSoak {
  /** HP the shield took */
  soak: number;
  /** The shot's amount left over for the hull (a break lets the rest through; 0 if the shield held it all) */
  rest: number;
  /** The shield broke on this hit */
  broke: boolean;
}

/**
 * A hit of `amount` on shield `i`, at `k` times its worth against shields (a weapon's vsShield; 0 never reaches here:
 * such a shot is not stopped). Takes the HP, restarts the wait, and breaks the shield (down `delay` ticks) if it is
 * spent. `rest` is what is left of the shot for the hull, in the shot's own damage.
 */
export function soakShaped(ship: ShapedHolder, i: number, amount: number, k: number, out: ShapedSoak): ShapedSoak {
  const s = ship.derived.fx!.shaped!.shields[i];
  ensureShaped(ship);
  const hpA = ship.shapedHp!, p = s.part;
  if (hpA[p] < 0) hpA[p] = s.cap;
  const have = hpA[p];
  const soak = Math.min(have, amount * k);
  hpA[p] = have - soak;
  ship.shapedIdle![p] = 0;
  out.soak = soak;
  out.rest = k > 0 ? Math.max(0, amount - soak / k) : amount;
  out.broke = hpA[p] <= 1e-9;
  if (out.broke) { hpA[p] = 0; ship.shapedDown![p] = Math.max(1, s.delay); }
  return out;
}

// ---- On the wire: one nibble a shield (0 down, 1..15 live by HP), up to MAX_SHAPED of them, in one number

/** The ship's shields as one number: shield i's level in bits 4i..4i+3 (the status row and a pilot's own row carry it) */
export function packShaped(ship: ShapedHolder): number {
  const list = shapedOf(ship);
  let v = 0;
  for (let i = 0; i < list.length && i < MAX_SHAPED; i++) {
    const up = shieldUp(ship, i);
    const level = up ? 1 + Math.max(0, Math.min(LEVELS, Math.round((shieldHp(ship, i) / list[i].cap) * LEVELS))) : 0;
    v += level * NIBBLE[i];
  }
  return v;
}

/** A shield's level on the wire (0 down, 1..15) */
export function shapedLevel(v: number, i: number): number {
  return Math.floor(v / NIBBLE[i]) % 16;
}

/** Read the packed levels into the ship's state (a client's copy): the HP each shows, down or up */
export function unpackShaped(ship: ShapedHolder, v: number): void {
  const list = shapedOf(ship);
  if (!list.length) return;
  ensureShaped(ship);
  for (let i = 0; i < list.length && i < MAX_SHAPED; i++) {
    const level = shapedLevel(v, i), p = list[i].part;
    if (level === 0) { ship.shapedHp![p] = 0; ship.shapedDown![p] = Math.max(1, ship.shapedDown![p]); }
    else { ship.shapedHp![p] = Math.max(list[i].cap * 0.5 / LEVELS, (list[i].cap * (level - 1)) / LEVELS); ship.shapedDown![p] = 0; }
  }
}

/** How far past the ship's centre (cells from the grid origin, plus the centre's own offset) any shield reaches: for a bounding test */
export function shapedReach(ship: Pick<ShapedHolder, 'derived'> & { derived: { com: Vec2 } }): number {
  const list = shapedOf(ship);
  let far = 0;
  for (let i = 0; i < list.length; i++) far = Math.max(far, list[i].far);
  return far + dhypot(ship.derived.com[0], ship.derived.com[1]);
}
