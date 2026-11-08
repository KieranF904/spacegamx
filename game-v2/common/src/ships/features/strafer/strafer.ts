/**
 * The Burst Strafer (a part: functions `strafe`; docs/design/build-archetypes.md §5 #1): a thruster that gives nothing
 * for cruising, only a dodge. Each strafer pushes away from its nozzle. The pilot presses dodge and the ship bursts the
 * way the movement keys ask (WASD screen-relative, or forward/back/Q/E at the helm; diagonals too), with whichever
 * strafers can push that way: a way gets the sum of the strafers' pushes along it (strafers on all four sides dodge
 * anywhere; side strafers alone mostly sideways). With no way held, or one no strafer pushes at all, it dodges back the
 * other way from the last dodge (so tapping it weaves), else sideways (the stronger side, right on a tie), else
 * whichever way it pushes hardest. A burst runs a fixed `ticks`; the next can start `cooldown` ticks after this one
 * started (one a press). No charges: energy is the limit.
 *
 * Its whole state is two numbers on the flight body, stepped from the pilot's held dodge control and movement keys, so
 * it rides snapshots and keyframes and prediction replays it exactly (like the jump drive's counter):
 *
 *   dodge       0                       ready
 *               1 .. ticks              a burst under way
 *               ticks+1 .. cooldown     cooling down (at `cooldown` it waits there while the control is still held)
 *   dodgeDir    the way of the current (or last) dodge, ship-local: 1..DODGE_DIRS (0 / absent: never dodged)
 *
 * Energy: while a burst runs, each strafer pushing that way draws its `demand` × how much of its push goes that way,
 * from the Drive Cell bank it touches first, then the ship's Output (energy.ts PowerUse.extra, the flight hook in index.ts). Short of it,
 * the burst pushes that much less; a burst that gets under DODGE_MIN_SHARE on its first tick is refused (the impulse hook, index.ts:
 * the counter goes straight to the end of its cooldown, so it's ready again as soon as the control's let go). Spamming
 * it browns the ship out unless it has the Drive Cells, batteries and generation to back it.
 * Mass matters: the push is a force, so a heavy ship barely moves (index.ts).
 */

import type { ShipDerived } from '../../rebuild.js';
import type { Vec2 } from '../../types.js';
import { FULL_CHARGE, PILOT_ROW, bankHeld, chargeGroupsEnd, poolHeld, type Charge } from '../../energy.js';
import { datan2, dcos, dhypot, dsin } from '../../../math/detTrig.js';

/** One strafer's push (ship-local force vector, x right, y back; as an engine's thrust: world units of acceleration × mass) */
export interface StraferPart {
  part: number;
  push: Vec2;
}

/** What a ship's strafers give (`derived.fx.strafe`: the feature's derive, index.ts) */
export interface StrafeInfo {
  parts: StraferPart[];
  /** A burst's length, and ticks from one burst's start to the next (the best fitted strafer's) */
  ticks: number;
  cooldown: number;
}

/** Dodge ways, ship-local: way i (1..DODGE_DIRS) points (i - 1) × 360°/DODGE_DIRS round from the ship's right (1 right, 9 back, 17 left, 25 forward) */
export const DODGE_DIRS = 32;

// (Declared here, not in index.ts, so everything that imports strafer.ts (the barrel) sees `derived.fx.strafe`)
declare module '../types.js' {
  interface FeatureDerived { strafe?: StrafeInfo }
}
/** A burst that gets less than this share of its energy on its first tick is refused */
export const DODGE_MIN_SHARE = 0.25;
const EPS = 1e-6;

/** The unit vector of each way (index 0 unused), rounded so every side computes the very same numbers */
const DIR_VEC: Vec2[] = Array.from({ length: DODGE_DIRS + 1 }, (_, i) => {
  if (!i) return [0, 0];
  const a = ((i - 1) * 2 * Math.PI) / DODGE_DIRS;
  return [Math.round(dcos(a) * 1e6) / 1e6 || 0, Math.round(dsin(a) * 1e6) / 1e6 || 0];
});

export const DODGE_RIGHT = 1;
export const DODGE_BACK = 1 + DODGE_DIRS / 4;
export const DODGE_LEFT = 1 + DODGE_DIRS / 2;
export const DODGE_FORWARD = 1 + (DODGE_DIRS * 3) / 4;

/** A way's unit vector (ship-local) */
export function dodgeVec(dir: number): Vec2 {
  return DIR_VEC[dir] ?? [0, 0];
}

/** The way nearest a ship-local direction (0 for none) */
export function dodgeDirOf(v: Vec2 | null | undefined): number {
  if (!v || (Math.abs(v[0]) < EPS && Math.abs(v[1]) < EPS)) return 0;
  const step = (2 * Math.PI) / DODGE_DIRS;
  return ((Math.round(datan2(v[1], v[0]) / step) % DODGE_DIRS) + DODGE_DIRS) % DODGE_DIRS + 1;
}

/** The way opposite */
export function oppositeDir(dir: number): number {
  return dir ? ((dir - 1 + DODGE_DIRS / 2) % DODGE_DIRS) + 1 : 0;
}

/** How much of a strafer's push goes along a way (0..1) */
function shareAlong(p: StraferPart, u: Vec2): number {
  const f = dhypot(p.push[0], p.push[1]);
  return f > EPS ? Math.max(0, (p.push[0] * u[0] + p.push[1] * u[1]) / f) : 0;
}

/** The push along a way (1..DODGE_DIRS), all the strafers together */
export function strafeForce(s: StrafeInfo | undefined, dir: number): number {
  if (!s || !dir) return 0;
  const u = dodgeVec(dir);
  let f = 0;
  for (const p of s.parts) f += Math.max(0, p.push[0] * u[0] + p.push[1] * u[1]);
  return f;
}

/** The way the strafers push hardest (the first of equals, from the right round), and that push */
export function bestDodge(s: StrafeInfo | undefined): { dir: number; force: number } {
  let dir = 0, force = 0;
  for (let i = 1; i <= DODGE_DIRS; i++) { const f = strafeForce(s, i); if (f > force + EPS) { dir = i; force = f; } }
  return { dir, force };
}

/**
 * The way a dodge goes: `want` the ship-local way the movement keys ask (null: none held), `last` the last dodge's way.
 * The asked way if any strafer pushes along it; else back from the last dodge; else sideways (stronger side, right on
 * a tie); else the strongest way. 0: the strafers push no way at all.
 */
export function chooseDodgeDir(s: StrafeInfo | undefined, want: Vec2 | null | undefined, last: number | undefined): number {
  if (!s || !s.parts.length) return 0;
  const w = dodgeDirOf(want);
  if (w && strafeForce(s, w) > EPS) return w;
  const back = oppositeDir(last ?? 0);
  if (back && strafeForce(s, back) > EPS) return back;
  const r = strafeForce(s, DODGE_RIGHT), l = strafeForce(s, DODGE_LEFT);
  if (r > EPS || l > EPS) return l > r + EPS ? DODGE_LEFT : DODGE_RIGHT;
  return bestDodge(s).dir;
}

export type DodgePhase = 'ready' | 'burst' | 'cooling' | 'held';

/** The cooldown a ship's strafers keep (never shorter than a burst) */
export function dodgeCooldown(s: StrafeInfo): number {
  return Math.max(s.ticks, s.cooldown);
}

/** Where a dodge counter is: its phase, progress through a burst (0..1), and how much of the cooldown is left (0..1) */
export function dodgePhase(c: number | undefined, s: StrafeInfo | undefined): { phase: DodgePhase; progress: number; cooling: number } {
  const k = c ?? 0;
  if (!s || k <= 0) return { phase: 'ready', progress: 1, cooling: 0 };
  const C = dodgeCooldown(s);
  if (k <= s.ticks) return { phase: 'burst', progress: k / s.ticks, cooling: 1 - k / C };
  if (k < C) return { phase: 'cooling', progress: 1, cooling: 1 - k / C };
  return { phase: 'held', progress: 1, cooling: 0 };
}

/**
 * One tick of the dodge (the flight hook in index.ts runs it): `want` the pilot's dodge control held, `way` the ship-local way the
 * movement keys ask (null: none), `blocked` the drive busy (a jump spooling). Updates the body's counter and way, and
 * returns the way a burst pushes this tick (0: none).
 */
export function stepDodge(body: { dodge?: number; dodgeDir?: number }, want: boolean, way: Vec2 | null, s: StrafeInfo | undefined, blocked: boolean): number {
  let c = body.dodge ?? 0;
  let out = 0;
  if (!s) c = 0;
  else if (c <= 0) {
    const dir = want && !blocked ? chooseDodgeDir(s, way, body.dodgeDir) : 0;
    if (dir) { c = 1; body.dodgeDir = dir; out = dir; }
  } else if (c < s.ticks) { c++; out = body.dodgeDir ?? 0; }
  else {
    // (Cooling down; then held there until the control's let go: one dodge a press)
    const C = dodgeCooldown(s);
    if (c < C) c++;
    if (c >= C) c = want ? C : 0;
  }
  body.dodge = c || undefined;
  return out;
}

/** A refused burst (too little energy on its first tick: index.ts): no push, and it's over (ready once the control's let go) */
export function refuseDodge(body: { dodge?: number }, s: StrafeInfo): void {
  body.dodge = dodgeCooldown(s);
}

// (A ports ship's ask, by part: module scratch, read by powerTick in the same tick)
let portsAsk = new Float64Array(0);

/**
 * What a burst along `dir` asks of each feed group (per second: energy.ts PowerUse.extra), or undefined. A ports ship's
 * is by part (power/ports.ts): each strafer pushing that way burns that share of its burn, from its own buffer (module
 * scratch: good until the next call)
 */
export function dodgeLoad(d: ShipDerived, dir: number): ArrayLike<number> | undefined {
  const s = d.fx?.strafe;
  if (d.ports) {
    if (!s || !dir) return undefined;
    const u = dodgeVec(dir), n = d.ports.n;
    if (portsAsk.length < n) portsAsk = new Float64Array(n);
    portsAsk.fill(0);
    let any = false;
    for (const p of s.parts) { const k = shareAlong(p, u); if (k > 0) { portsAsk[p.part] = k; any = true; } }
    return any ? portsAsk : undefined;
  }
  const L = d.power;
  if (!L || !s || !dir) return undefined;
  const u = dodgeVec(dir);
  const out = new Array<number>(L.feeds.length).fill(0);
  let any = false;
  for (const p of s.parts) {
    const f = L.feedOf[p.part], k = shareAlong(p, u);
    if (f >= 0 && k > 0) { out[f] += L.draw[p.part] * k; any = true; }
  }
  return any ? out : undefined;
}

/** Energy one burst along `dir` costs (every strafer pushing that way, by how much of it goes that way), for readouts */
export function burstEnergy(d: ShipDerived, dir: number): number {
  const L = d.power, s = d.fx?.strafe, P = d.ports;
  if (!s || !dir) return 0;
  const u = dodgeVec(dir);
  let e = 0;
  // (A ports strafer burns its burn (eu a tick) for the burst's ticks)
  if (P) { for (const p of s.parts) e += (P.burn[p.part] * shareAlong(p, u) * s.ticks) / 256; return e; }
  if (!L) return 0;
  for (const p of s.parts) e += (L.draw[p.part] * shareAlong(p, u) * s.ticks) / 60;
  return e;
}

/**
 * Roughly how much of a burst along `dir` the ship could pay for now (0..1, for the HUD): what the Drive Cell banks its
 * strafers touch hold, the ship's pool, and its spare generation over the burst, against the burst's energy. (The burst
 * itself is settled tick by tick in powerTick.)
 */
export function dodgeAffordable(d: ShipDerived, c: Charge | undefined, dir: number): number {
  const L = d.power, s = d.fx?.strafe, P = d.ports;
  const need = burstEnergy(d, dir);
  if (P) {
    // (A ports ship: what the strafers pushing that way hold in their buffers, and what their lines bring over the burst)
    if (!s || need <= EPS) return 1;
    const e = c?.e, u = dodgeVec(dir);
    let have = 0;
    for (const p of s.parts) {
      const k = shareAlong(p, u);
      if (k > 0) have += k * ((e && e.held.length === P.n ? e.held[p.part] : P.cap[p.part]) + P.rate[p.part] * s.ticks) / 256;
    }
    return Math.max(0, Math.min(1, have / need));
  }
  if (!L || !s || !d.energy || need <= EPS) return 1;
  const ch = c ?? FULL_CHARGE;
  const banks = new Set<number>();
  for (const p of s.parts) {
    const f = L.feedOf[p.part];
    if (f >= 0) for (const b of L.feeds[f].banks) banks.add(b);
  }
  let have = poolHeld(d, ch) + (L.spare * s.ticks) / 60;
  for (const b of banks) have += bankHeld(d, ch, b);
  return Math.max(0, Math.min(1, have / need));
}

/**
 * The pilot's own snapshot row carries, after the charge groups (energy.ts chargeGroupsEnd): the dodge
 * counter, the last dodge's way, what the Tow Beam tows (entity id + 1, 0 nothing), and the ticks left marked and slowed
 * (features/weaponry). GameServer writes them in that order (features.wire.json pilotExtra).
 */
export function pilotExtras(data: number[] | undefined): { dodge: number; dodgeDir: number; tow: number; marked: number; slowed: number; shaped: number } {
  if (!data || data.length <= PILOT_ROW.groups) return { dodge: 0, dodgeDir: 0, tow: 0, marked: 0, slowed: 0, shaped: 0 };
  const at = chargeGroupsEnd(data);
  return { dodge: data[at] ?? 0, dodgeDir: data[at + 1] ?? 0, tow: data[at + 2] ?? 0, marked: data[at + 3] ?? 0, slowed: data[at + 4] ?? 0, shaped: data[at + 5] ?? 0 };
}
