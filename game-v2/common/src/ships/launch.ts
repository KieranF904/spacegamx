/**
 * Shells leaving a gun, worked out the same way on the server and the client.
 *
 * The server doesn't send a shell from a ship a client is replicating: it sends
 * a fire event (who fired, on which tick, from which weapon part, with what aim
 * and the shells' entity ids) and the client builds the volley itself from the
 * ship's replicated pose and its blueprint (rebuildVolley). Everything random
 * about a shell comes from a generator seeded by its tick, the firing ship, the
 * weapon part and its place in the volley (shellSeed), never by anything only
 * the server knows: so both sides get the same shells, and a pilot's client can
 * fire its own before the server says so (guns.ts, volleyShells). Only straight
 * flyers go this way (homing missiles change course, so they're sent as they
 * fly).
 */

import { mulberry32, hashString } from '../asteroid/polygon.js';
import type { ShipState } from './state.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';
import type { PlacedPart, WeaponMods } from './types.js';
import { buildShot, type ProjectileSpec } from './shot.js';
import type { WeaponInfo } from './rebuild.js';

export interface LaunchShape {
  speedScale: number;
  sizeScale: number;
  turret: boolean;
}

export interface Launched {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  /** Ticks it lives */
  life: number;
}

/** A weapon kind's tuning (unknown kinds fire as cannons) */
export function weaponDef(tuning: ShipTuning, kind: string): WeaponTuning {
  return tuning.weapons?.[kind] ?? tuning.weapons?.cannon ?? { type: 'projectile', speed: 48, damage: 14, life: 150 };
}

const modded = new WeakMap<WeaponTuning, WeakMap<WeaponMods, WeaponTuning>>();

/** A kind's tuning with one gun's mods applied (the same object each time for the same pair) */
export function moddedDef(def: WeaponTuning, mods: WeaponMods | undefined): WeaponTuning {
  if (!mods) return def;
  let byMods = modded.get(def);
  if (!byMods) modded.set(def, (byMods = new WeakMap()));
  let out = byMods.get(mods);
  if (out) return out;
  const d = { ...def, ...(mods.set as Partial<WeaponTuning> | undefined) } as WeaponTuning & Record<string, unknown>;
  for (const [k, v] of Object.entries(mods.mul ?? {})) {
    const m = Math.max(0, 1 + v!);
    if (typeof d[k] === 'number') d[k] = (d[k] as number) * m;
    // (Its burst's numbers live one level down)
    else if (d.splash && (k === 'splashDamage' || k === 'splashRadius')) d.splash = k === 'splashDamage' ? { ...d.splash, damage: d.splash.damage * m } : { ...d.splash, radius: d.splash.radius * m };
  }
  // (Penetration may go below 0: flak's does)
  for (const [k, v] of Object.entries(mods.add ?? {})) d[k] = k === 'pen' ? ((d.pen ?? 0) + v!) : Math.max(0, ((d[k] as number | undefined) ?? (k === 'burst' ? 1 : 0)) + v!);
  if (d.burst !== undefined) d.burst = Math.max(1, Math.round(d.burst));
  if (d.pierce !== undefined) d.pierce = Math.round(d.pierce);
  byMods.set(mods, (out = d));
  return out;
}

// ---------------------------------------------------------------------------
// Ammunition: crates whose rounds change how a gun fires (items.json ammoFor).
// Each has a code (its place in the sorted list, from 1), sent with the gun's
// fire event so every client builds the same shells; both sides register the
// same item data, so the codes agree.
// ---------------------------------------------------------------------------

export interface AmmoCrate { id: string; weapon: string; rounds: number; mods?: WeaponMods }
let crates: AmmoCrate[] = [];
const crateCode = new Map<string, number>();

/** The item catalogue's ammunition (server: GameData; client: at start) */
export function registerAmmo(items: Iterable<{ id: string; ammoFor?: { weapon: string; rounds: number; mods?: WeaponMods } }>): void {
  crates = [...items].filter((d) => d.ammoFor).map((d) => ({ id: d.id, ...d.ammoFor! })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  crateCode.clear();
  crates.forEach((c, i) => crateCode.set(c.id, i + 1));
}

export function ammoCode(item: string | undefined): number {
  return item ? crateCode.get(item) ?? 0 : 0;
}

export function ammoByCode(code: number): AmmoCrate | undefined {
  return code > 0 ? crates[code - 1] : undefined;
}

/** Every crate a weapon kind can fire, its standard one (tuning ammo.item) first */
export function cratesFor(tuning: ShipTuning, kind: string): string[] {
  const std = tuning.weapons?.[kind]?.ammo?.item;
  const rest = crates.filter((c) => c.weapon === kind && c.id !== std).map((c) => c.id);
  return std ? [std, ...rest] : rest;
}

/**
 * Which crate a gun fires from next: an open one (the preferred kind's, if
 * open), else the next one to open from the hold. Server and pilot's client
 * both choose this way. Null: none (a free gun fires plain; one that needs
 * ammunition fires plain rounds).
 */
export function chooseCrate(order: string[], prefer: string | undefined, open: Record<string, number>, inHold: (id: string) => boolean): { item: string; opening: boolean } | null {
  const list = prefer && order.includes(prefer) ? [prefer, ...order.filter((c) => c !== prefer)] : order;
  const item = list.find((c) => (open[c] ?? 0) > 0);
  if (item) return { item, opening: false };
  const next = list.find(inHold);
  return next ? { item: next, opening: true } : null;
}

/** What a grade (Mk I-V) does to a weapon kind (tuning.json weaponGrades): the same object each time */
export function gradeMods(tuning: ShipTuning, kind: string, grade: number | undefined): WeaponMods | undefined {
  const g = tuning.weaponGrades?.[kind];
  return Array.isArray(g) && grade ? g[Math.max(1, Math.min(g.length, Math.round(grade))) - 1] ?? undefined : undefined;
}

const sized = new WeakMap<WeaponTuning, Map<number, WeaponMods | undefined>>();

/** What being `size` times its base size does to a kind (its tuning's bySize), as mods: the same object each time */
export function sizeMods(base: WeaponTuning, size: number | undefined): WeaponMods | undefined {
  if (!base.bySize || !size || Math.abs(size - 1) < 1e-9) return undefined;
  let bySize = sized.get(base);
  if (!bySize) sized.set(base, (bySize = new Map()));
  if (bySize.has(size)) return bySize.get(size);
  const mul: Record<string, number> = {};
  for (const [k, e] of Object.entries(base.bySize)) if (typeof e === 'number' && k !== 'rate') mul[k] = Math.pow(size, e) - 1;
  const out = Object.keys(mul).length ? { mul } : undefined;
  bySize.set(size, out);
  return out;
}

/** A gun's fire rate × this for its grade and size (rebuild.ts works its interval out from it) */
export function gunRate(tuning: ShipTuning, kind: string, grade: number | undefined, size: number | undefined): number {
  const base = weaponDef(tuning, kind);
  const g = gradeMods(tuning, kind, grade)?.mul?.rate ?? 0;
  const e = base.bySize?.rate ?? 0;
  return Math.max(0.2, 1 + g) * (size && e ? Math.pow(size, e) : 1);
}

/**
 * The tuning one gun fires with, the same on the server and every client (the
 * shells' flight comes from it): its kind's, with its part's mods (gems), its
 * ammunition's, then its grade's character and its size's. A model gun
 * (`model`: its function's weaponMods, WeaponInfo.model) is its own instead:
 * its kind's with its model's changes, then its gems and ammunition. Each step
 * is cached, so the same gun gets the same object every time.
 */
export function gunDef(tuning: ShipTuning, kind: string, gun: { grade?: number; size?: number; mods?: WeaponMods; ammo?: WeaponMods; model?: WeaponMods }): WeaponTuning {
  const base = weaponDef(tuning, kind);
  if (gun.model) return moddedDef(moddedDef(moddedDef(base, gun.model), gun.mods), gun.ammo);
  return moddedDef(moddedDef(moddedDef(moddedDef(base, gun.mods), gun.ammo), gradeMods(tuning, kind, gun.grade)), sizeMods(base, gun.size));
}

/** The tuning one gun fires with: its kind's, with the part's mods, and its model's or its grade's and size's (from its WeaponInfo) when given */
export function partWeaponDef(tuning: ShipTuning, kind: string, part: PlacedPart | undefined, gun?: { grade?: number; size?: number; model?: WeaponMods }): WeaponTuning {
  return gunDef(tuning, kind, { mods: part?.mods, grade: gun?.grade, size: gun?.size, model: gun?.model });
}

/** Turret and gimbal aims at the moment of firing go in steps of 1/SHOT_AIM_STEPS rad (both sides fire from the stepped aim) */
export const SHOT_AIM_STEPS = 4096;

export function shotAimQ(aim: number): number {
  return Math.round(aim * SHOT_AIM_STEPS);
}

/** What seeds a shell's randomness: who fired it, from which part (by uid), and its place in the volley */
export function shellSeed(owner: number, partUid: number, index: number): string {
  return `${owner}:${partUid}:${index}`;
}

/** One shell: its spread, speed and size (spawned at `tick`, seeded by `seed`: shellSeed) */
export function launchShot(def: WeaponTuning, kind: string, shape: LaunchShape, angle: number, ownerVx: number, ownerVy: number,
  tick: number, seed: string): Omit<Launched, 'x' | 'y' | 'id'> & { speed: number } {
  const rng = mulberry32(hashString(`shot:${tick}:${seed}`));
  const spread = ((def.burst ?? 1) > 1 ? 4 : def.spread ?? 1.8) * Math.PI / 180;
  const a = angle + (rng() - 0.5) * 2 * spread;
  const cannon = kind === 'cannon';
  const speed = (def.speed ?? 48) * (cannon ? shape.speedScale : 1) * (0.99 + rng() * 0.02);
  // Shells inherit a little of the ship's motion
  return {
    speed,
    vx: Math.cos(a) * speed + ownerVx * 0.3,
    vy: Math.sin(a) * speed + ownerVy * 0.3,
    size: (def.size ?? 1) * (cannon ? shape.sizeScale : 1),
    // Slower shells live longer so the cannon keeps its range
    life: Math.round((def.life ?? 150) / (cannon ? shape.speedScale : 1)),
  };
}

/** A volley's angles in the order its shells are spawned: a burst's fanned extras, then the main shell */
export function volleyAngles(def: WeaponTuning, angle: number): number[] {
  const n = def.burst ?? 1;
  if (n <= 1) return [angle];
  const fan = ((def.spread ?? 10) * Math.PI) / 180;
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push(angle + fan * ((i / (n - 1)) - 0.5) * 2);
  out.push(angle);
  return out;
}

/** Fire events go only for straight flyers */
export function firesStraight(def: WeaponTuning): boolean {
  // Lobbed shells fly as far as the aim (which only the server knows): sent as they fly, like missiles
  return !def.homing && !def.lob;
}

export interface FireRecord {
  owner: number;
  tick: number;
  /** The weapon's part index */
  part: number;
  /** The ammunition it fired (ammoCode: 0 none, or plain rounds) */
  ammo?: number;
  /** Its aim offset, in SHOT_AIM_STEPS */
  aimQ: number;
  /** The shells' entity ids, in spawn order */
  ids: number[];
}

export interface FirePose { x: number; y: number; angle: number; vx: number; vy: number }

/**
 * A fire event's shells, from the firing ship (its structure) and its pose
 * and velocity on that tick. Null if the ship has no such weapon.
 */
export function rebuildVolley(rec: FireRecord, ship: ShipState, pose: FirePose, tuning: ShipTuning): { kind: string; turret: boolean; shells: Launched[] } | null {
  const w = ship.derived.weapons.find((x) => x.part === rec.part);
  if (!w) return null;
  const aim = [...ship.aim];
  aim[rec.part] = rec.aimQ / SHOT_AIM_STEPS;
  const shot = buildShot(w, { ...ship, aim }, pose, rec.tick, tuning);
  const shells = volleyShells(rec.owner, ship, w, shot, pose, rec.tick, tuning, ammoByCode(rec.ammo ?? 0)?.mods);
  if (shells.length !== rec.ids.length) return null;
  return { kind: w.kind, turret: shot.mount === 'turret', shells: shells.map((s, i) => ({ ...s, id: rec.ids[i] })) };
}

/** A volley's shells (without entity ids), in spawn order: a burst's fanned extras, then the main shell */
export function volleyShells(owner: number, ship: ShipState, w: WeaponInfo, shot: ProjectileSpec, pose: FirePose, tick: number, tuning: ShipTuning, ammo?: WeaponMods): Omit<Launched, 'id'>[] {
  const def = gunDef(tuning, w.kind, { mods: ship.blueprint.parts[w.part]?.mods, ammo, grade: w.grade, size: w.size, model: w.model });
  const shape = { speedScale: shot.speedScale, sizeScale: shot.sizeScale, turret: shot.mount === 'turret' };
  const uid = ship.blueprint.parts[w.part]?.uid ?? w.part;
  return volleyAngles(def, shot.angle).map((a, i) => {
    const { speed: _speed, ...l } = launchShot(def, w.kind, shape, a, pose.vx, pose.vy, tick, shellSeed(owner, uid, i));
    return { ...l, x: shot.x, y: shot.y };
  });
}
