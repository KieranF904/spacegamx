/**
 * rebuild(): the pure function that turns a blueprint plus per-part HP into
 * everything the simulation needs. Runs on spawn and when a ship is dirty,
 * never every tick. Effects like a starved weapon, a lopsided turn or a
 * severed wire all fall out of this; there is no special-case code.
 */

import type { Blueprint, FireSpec, FunctionDef, MaterialDef, Vec2, WeaponMods, WireSeg } from './types.js';
import type { Catalog } from './catalog.js';
import { designOf, newDesign, wholeBuilt, turretFrameOf, wholeExhaust, wholeTurret, type DesignInfo } from './design.js';
import { floodFill, partMount } from './blueprint.js';
import { ShipTuning, partHealth } from './tuning.js';
import { type TurretRays, type TurretWindow, castTurret } from './turret.js';
import { DEFAULT_JUMP, coilCapacity, jumpDriveStats } from './flight.js';
import { fnOutput, isEngine, partDemand, partGrade, partSupply, partThrust, weaponBaseArea, weaponStrength } from './grades.js';
import { netJoins, wireNetworks } from './wires.js';
import { groupsGone } from './groups.js';
import { gunRate } from './launch.js';
import { type CellMap, cellMap, engineExhaust } from './mounting.js';
import { type EnergyInfo, gunDrawFlatOut } from './energy.js';
import { type PowerLayout, bankKind, powerLayout } from './circuits.js';
import { type PortsLayout, buildPortsLayout, portsFed } from './power/ports.js';
import type { FeatureDerived } from './features/types.js';
import { getPlan, featureBits, featureList } from './features/plan.js';
import { dhypot, dpow } from '../math/detTrig.js';

const legacyFire = new WeakMap<FunctionDef, FireSpec>();
/**
 * A gun's firing model (guns.ts): a weapon model's own `fire` block (scripts/econ/models.mjs); a legacy gun's
 * (enemies', bosses') from its kind as it always fired: a held beam burns, point defence fires on its own, the rest cycle
 */
export function fireOf(tuning: ShipTuning, fn: FunctionDef): FireSpec {
  if (fn.fire) return fn.fire;
  let f = legacyFire.get(fn);
  if (!f) {
    const def = tuning.weapons?.[fn.weapon ?? ''];
    const model = def?.type === 'beam' && !def.pulse ? 'beam' : def?.pointDefence ? 'auto' : 'cycle';
    legacyFire.set(fn, (f = Object.freeze({ model, interval: model === 'beam' ? 1 : fn.fireInterval ?? 10 })));
  }
  return f;
}

/** The most engine output a blueprint can ask for (a boss's; players' designs stop at 1) */
export const MAX_DRIVE = 2.5;
/** The most a boss's turning (Blueprint `turn`) may be multiplied */
export const MAX_TURN = 20;

export interface ThrusterInfo {
  part: number;
  /** Ship-local force (grid frame, forward = -y), already scaled by satisfaction */
  force: Vec2;
  /** Centroid, grid units */
  pos: Vec2;
  /** Torque about the centre of mass, world units; positive turns clockwise on screen (angle increases) */
  torque: number;
  /** A model engine's rated speed (world units a tick): its thrust fades out towards it (flight.ts); absent, it never fades */
  rated?: number;
  /** The share of its exhaust lanes the ship leaves clear, when some are blocked (mounting.ts engineExhaust; `force` is already scaled by it) */
  exhaust?: number;
}

export interface WeaponInfo {
  part: number;
  uid: number;
  /** Which weapon (tuning.weapons.<kind>): cannon, railgun, laser, flak, missile, lance, emp */
  kind: string;
  satisfaction: number;
  /** Damage multiplier from its grade and size (ships/grades.ts): 1 for a base-size Mk I */
  strength: number;
  /** Size against the weapon's base size (1: base; 2: twice the cells) */
  size: number;
  /** Its grade (Mk I-V: its material's, or a model's tier): how hard it punches through, and (legacy guns) its character (tuning.json weaponGrades) */
  grade: number;
  /** A model gun: its own changes to its kind's tuning (launch.ts gunDef: in place of its grade's character and size's) */
  model?: WeaponMods;
  /** Ticks between shots */
  interval: number;
  /** Its firing model and numbers (guns.ts stepGuns): a model's own, a legacy gun's from its kind (fireOf) */
  fire: FireSpec;
  /** Energy per shot (beams: per tick they're on): see energy.ts */
  energy: number;
  /** Muzzle point on the facing edge, grid units */
  muzzle: Vec2;
  /** Unit direction out of the facing edge, grid frame */
  dir: Vec2;
  mount: 'fixed' | 'turret';
  /** Turrets only: where it can fire, recomputed whenever the ship's structure changes */
  window?: TurretWindow;
}

/** A mining laser: a beam out of its facing edge while the pilot mines */
export interface MinerInfo {
  part: number;
  /** A gas siphon: it draws from gas pockets, and passes through rock */
  gas?: boolean;
  material: string;
  satisfaction: number;
  /** Beam origin on the facing edge, grid units */
  muzzle: Vec2;
  /** Unit direction out of the facing edge, grid frame */
  dir: Vec2;
}

/** A launch bay (an enemy-only part): what it sends out, from where */
export interface LauncherInfo {
  part: number;
  mob: string;
  count: number;
  every: number;
  satisfaction: number;
  /** Its mouth, and the way out, grid units / grid frame */
  muzzle: Vec2;
  dir: Vec2;
}

export interface FlowNetwork {
  parts: number[];
  supply: number;
  demand: number;
  delivered: number;
  /** A generator is on it (its batteries count) */
  powered: boolean;
}

export interface ShipDerived {
  /** Core index, or the root used for debris; -1 when nothing is left */
  root: number;
  /** hp > 0, not detached and connected to the root */
  alive: boolean[];
  /** Intact parts not connected to the root, grouped by connectivity */
  orphanGroups: number[][];
  /** Joins between intact parts */
  joins: [number, number][];
  /** Joins between parts on the same power network */
  flowJoins: [number, number][];
  /** Power network per part (wires.ts), -1 for parts on none */
  network: number[];
  networks: FlowNetwork[];
  /** The wires it runs on (its design's, or auto-wired: wires.ts), and per segment whether it's live and its network (-1 cut) */
  wires: WireSeg[];
  wireLive: boolean[];
  wireNet: number[];
  /**
   * Per part: steady consumers get delivered / demand in [0, 1]; engines, guns
   * and mining lasers draw on the battery instead (1 if their network has a
   * generator or a battery, 0 if not: energy.ts); everything else 1
   */
  satisfaction: number[];
  /** Battery, spare generator power, and what draws on it (energy.ts) */
  energy: EnergyInfo;
  /** The power layout: the ship's pool (the core's store and the batteries), the Capacitor and Drive Cell banks and the feed groups (circuits.ts; energy.ts runs them) */
  power?: PowerLayout;
  /** The ports layout (power/ports.ts), for a design that says `power: 'ports'`: then `power` is absent and the ports core runs it */
  ports?: PortsLayout;
  mass: number;
  /** Centre of mass, grid units */
  com: Vec2;
  /** Moment of inertia about the centre of mass, mass × world units² */
  inertia: number;
  /**
   * The ship as built (every part but unbuilt ghosts): flight divides by these,
   * so losing parts never makes a ship quicker or nimbler than it was whole.
   */
  fullMass: number;
  fullInertia: number;
  /**
   * Engines and steering as a share of whole (1 intact): a wrecked frame can't
   * use its drives, so a core and a few parts limp (see flight.ts).
   */
  drive: number;
  /** A boss's turning (Blueprint `turn`): its turning acceleration × this, braking in time (flight.ts); absent, a ship's own */
  turn?: number;
  /** While boosting: the engines' thrust multiplier, and how fast it drains the boost battery (× the usual), weighted by each engine's thrust */
  boostFactor: number;
  boostDrain: number;
  thrusters: ThrusterInfo[];
  /** Force available along each ship-local axis (thrusters only) */
  maxThrust: { forward: number; back: number; left: number; right: number };
  /** Omnidirectional force from the core (0 without a core) */
  maneuverForce: number;
  /** Turning torque available in each direction (world units) */
  maxTorque: { cw: number; ccw: number };
  weapons: WeaponInfo[];
  /** Cargo space: the core's own allowance plus every intact cargo hold */
  cargoCapacity: number;
  miners: MinerInfo[];
  /** Launch bays (enemy-only) */
  launchers: LauncherInfo[];
  /** Dash coils (enemy-only): the burst of speed a dash gives (0: none), the best coil's recharge, and how many are left */
  dash: { speed: number; cooldown: number; coils: number };
  /** Best scanner range (world units), 0 without a powered scanner */
  scanRange: number;
  /** Shield capacity from powered shield generators (0 = no shield) */
  shieldMax: number;
  /** What the shield puts back a second (points, all generators together) and the ticks a hit holds that back (weighted by capacity); a Flash Screen adds none of either */
  shieldRegen: number;
  shieldDelay: number;
  /**
   * Part features (features/): the ones this ship has (bit = feature number in the plan: a live part they apply to, or
   * global), the same as a list in plan order, and what each one derived. All three absent when it has none.
   */
  fxMask?: number;
  fxList?: Int8Array;
  fx?: FeatureDerived;
  /** Jump drive reach (world units) and cooldown (ticks): the core's own coil and powered jump coils against the hull (flight.ts jumpDriveStats) */
  jumpRange: number;
  jumpCooldown: number;
  /** The coils' capacity over what the hull needs (1: just right) */
  jumpRatio: number;
  /** Bounding radius about the centre of mass, world units */
  radius: number;
  /**
   * What the ship is made of, by share of its intact cells: each material
   * trait's share (0..1), and the hazard tolerance its materials add up to
   * (an all-iridium hull: radiation 5; half of one: 2.5); conduits, how many
   * of them are of a conductive material, and the mass in mass-anchor material;
   * the share of cold its materials keep out (insulation, warmth.ts)
   */
  makeup: { traits: Record<string, number>; tolerance: Record<string, number>; conduits: number; conductiveConduits: number; anchorMass: number; insulation: number };
}

export interface RebuildInput {
  catalog: Catalog;
  tuning: ShipTuning;
  blueprint: Blueprint;
  hp: number[];
  maxHp: number[];
  detached: boolean[];
  /** Parts not built yet (hangar ghosts): not missing, just not part of the ship yet */
  ghost?: boolean[];
  /** 'core' for ships, 'largest' for debris (the biggest connected group stays) */
  rootMode: 'core' | 'largest';
  /** The ship's own memo of its last rebuild (ShipState.memo): read, and replaced by this one. Absent, nothing is kept */
  memo?: RebuildMemo;
  /** (Tests: the design worked out afresh, and every turret ray and exhaust lane cast afresh, as the memo's parity check) */
  fresh?: boolean;
}

/**
 * What a rebuild keeps for the ship's next one: its turrets' rays and its engines' exhaust, and which parts were alive.
 * Losing parts can only open a turret's ray or an engine's lane, never close one, so a rebuild where every part alive
 * was alive last time (and the design and tuning are the same) casts only the rays whose blocker went, and checks only
 * the engines that were blocked. After anything that adds a part (a repair, a ghost built, a new ship) it carries on
 * the same way from the design's rays and exhaust with every part standing (design.ts), which every ship of it is a
 * subset of. The result is the same either way: the memo only saves work, so ships with different histories (the
 * server's, a client's) still rebuild alike (rebuildMemo.test.ts checks that against every ray cast afresh).
 */
export interface RebuildMemo {
  last?: {
    design: DesignInfo;
    tuning: ShipTuning;
    alive: Uint8Array;
    turrets: Map<number, TurretRays>;
    /** Each live engine's exhaust share */
    exhaust: Map<number, number>;
  };
}

/**
 * Engines and steering left as a ship comes apart: whole, all of it; half its
 * mass gone, about two thirds; down to a core and a few parts, about a third.
 */
export function driveFactor(mass: number, fullMass: number): number {
  if (fullMass <= 0 || mass >= fullMass) return 1;
  return 0.2 + 0.8 * dpow(Math.max(0, mass / fullMass), 0.75);
}

/** Guns made of a conductive material recharge this much faster */
export const CONDUCTIVE_RATE = 1.15;

/** Cargo space every core carries, before any cargo holds */
export const CORE_CARGO = 30;

const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/**
 * Share supply between consumers: priority 1 first, then 2, then 3; within a
 * tier, in proportion to each consumer's draw. Returns what each one receives.
 */
export function allocateFlow(supply: number, consumers: { draw: number; priority: number }[]): number[] {
  const out = consumers.map(() => 0);
  let remaining = supply;
  for (const tier of [1, 2, 3]) {
    const idx = consumers.map((c, i) => (c.priority === tier ? i : -1)).filter((i) => i >= 0);
    const total = idx.reduce((s, i) => s + consumers[i].draw, 0);
    if (total <= 0) continue;
    if (remaining >= total) {
      for (const i of idx) out[i] = consumers[i].draw;
      remaining -= total;
    } else {
      for (const i of idx) out[i] = remaining * consumers[i].draw / total;
      remaining = 0;
    }
  }
  return out;
}

function components(count: number, joins: [number, number][], include: (i: number) => boolean): number[][] {
  const seen = new Array<boolean>(count).fill(false);
  const groups: number[][] = [];
  for (let i = 0; i < count; i++) {
    if (seen[i] || !include(i)) continue;
    const reached = floodFill(count, joins, i, include);
    const group: number[] = [];
    reached.forEach((r, j) => { if (r) { group.push(j); seen[j] = true; } });
    groups.push(group);
  }
  return groups;
}

/** A mining laser (or a gas siphon): a beam while the pilot mines */
export function isMinerFn(fn: FunctionDef | undefined): boolean {
  return !!fn && (fn.id === 'miner' || !!fn.mining || !!fn.siphon);
}

/** (A model gun with no changes of its own) */
const NO_MODS: WeaponMods = {};

/** A rigid design's flight as built (Blueprint `rigid`), worked out once */
const AS_BUILT = new WeakMap<object, Pick<ShipDerived, typeof RIGID[number]>>();
const RIGID = ['mass', 'com', 'inertia', 'fullMass', 'fullInertia', 'drive', 'boostFactor', 'boostDrain', 'thrusters', 'maxThrust', 'maneuverForce', 'maxTorque', 'radius'] as const;

export function rebuild(input: RebuildInput): ShipDerived {
  const d = rebuildAsIs(input), bp = input.blueprint;
  if (!bp.rigid || input.rootMode !== 'core') return d;
  let whole = AS_BUILT.get(bp);
  if (!whole) {
    const n = bp.parts.length, full = rebuildAsIs({ ...input, hp: [...input.maxHp], detached: new Array(n).fill(false), ghost: undefined, memo: undefined });
    whole = Object.fromEntries(RIGID.map((k) => [k, full[k]])) as Pick<ShipDerived, typeof RIGID[number]>;
    AS_BUILT.set(bp, whole);
  }
  return { ...d, ...whole };
}

/** What holds together: the joins between intact parts, the root, what's still joined to it, and the groups that aren't */
export interface Structure {
  intact: (i: number) => boolean;
  joins: [number, number][];
  root: number;
  alive: boolean[];
  orphanGroups: number[][];
}

/** A rebuild's first steps alone (state.ts splitRebuild looks ahead with it): `allJoins`, the design's (design.ts) */
export function structureOf(blueprint: Blueprint, hp: readonly number[], detached: readonly boolean[], rootMode: 'core' | 'largest', allJoins: [number, number][], reach?: readonly boolean[]): Structure {
  const parts = blueprint.parts;
  const n = parts.length;
  // (A ship's part the core holds on to through no part of the design is planned only: never intact, whatever its HP says)
  const planned = rootMode === 'core' && reach ? (i: number) => !reach[i] : null;
  // (A custom enemy's piece breaks as one: a part of a group that's gone isn't intact either, groups.ts)
  const gone = groupsGone(blueprint, hp, detached);
  const base = gone ? (i: number) => hp[i] > 0 && !detached[i] && !(parts[i].group !== undefined && gone & (1 << parts[i].group!)) : (i: number) => hp[i] > 0 && !detached[i];
  const intact = planned ? (i: number) => base(i) && !planned(i) : base;

  // 1. Joins (between intact parts only: dead parts don't hold anything together)
  const joins = allJoins.filter(([a, b]) => intact(a) && intact(b));

  // 2. Structure
  let root = -1;
  if (rootMode === 'core') {
    root = parts.findIndex((p, i) => p.fn === 'core' && intact(i));
  } else {
    const groups = components(n, joins, intact);
    let best: number[] | null = null;
    for (const g of groups) if (!best || g.length > best.length) best = g;
    root = best ? best[0] : -1;
  }
  const alive = floodFill(n, joins, root, intact);
  const orphanGroups = components(n, joins, (i) => intact(i) && !alive[i]);
  return { intact, joins, root, alive, orphanGroups };
}

function rebuildAsIs(input: RebuildInput): ShipDerived {
  const { catalog, tuning, blueprint, hp, maxHp } = input;
  const parts = blueprint.parts;
  const n = parts.length;
  // What the design fixes, worked out once per blueprint (design.ts)
  const D = input.fresh ? newDesign(catalog, blueprint) : designOf(catalog, blueprint);
  const { geoms, mounts, fns, mats } = D;
  const allJoins = D.joins;
  const { joins, root, alive, orphanGroups } = structureOf(blueprint, hp, input.detached, input.rootMode, allJoins, D.core >= 0 ? wholeBuilt(D) : undefined);
  // (Parts only went since the last rebuild: its turrets' rays and engines' exhaust carry on from it, RebuildMemo)
  const last = input.fresh ? undefined : input.memo?.last;
  let shrunk = !!last && last.design === D && last.tuning === tuning;
  if (shrunk) for (let i = 0; i < n; i++) if (alive[i] && !last!.alive[i]) { shrunk = false; break; }
  const was = shrunk ? last : undefined;
  const turretRays = new Map<number, TurretRays>(), exhaustOf = new Map<number, number>();
  // A turret's window (turret.ts): its rays carried on from the last rebuild when they can be
  const turretWindow = (i: number): TurretWindow => {
    const rays = castTurret(turretFrameOf(D, i, tuning), geoms, alive, input.fresh ? undefined : was?.turrets.get(i) ?? wholeTurret(D, i, tuning));
    turretRays.set(i, rays);
    return rays.win;
  };

  // 3. Power networks: what the live wires join, and what's plugged into a generator (wires.ts)
  const wn = wireNetworks(catalog, blueprint, geoms, alive, joins);
  const network = wn.network;
  const flowJoins = netJoins(joins, network);

  // 4. Power, per network
  const area = D.area;
  const satisfaction = new Array<number>(n).fill(1);
  // (Part features: which ones each part's function gives (features/plan.ts); a `burst` feature's parts draw by the tick too, as a
  // Tow Beam's and a Burst Strafer's)
  const P = getPlan();
  const fxOf = P.features.length ? fns.map((fn) => featureBits(P, fn)) : undefined;
  const burst = (i: number) => isEngine(fns[i]) || !!fns[i].weapon || isMinerFn(fns[i])
    || (fxOf !== undefined && (fxOf[i] & P.burstMask) !== 0);
  // (Of those, the ones Drive Cell banks feed: engines, and burst 'engine' features (a Burst Strafer's); and the ones Capacitor
  // banks feed: guns, beams and mining lasers. circuits.ts)
  const engineLike = (i: number) => isEngine(fns[i]) || (fxOf !== undefined && (fxOf[i] & P.engineMask) !== 0);
  const gunLike = (i: number) => !!fns[i].weapon || isMinerFn(fns[i]);
  const coreAlive = input.rootMode === 'core' && root >= 0 && parts[root].fn === 'core';
  // (A burst consumer a bank of its kind touches runs on that bank whatever its network: circuits.ts)
  const nearBank = new Array<boolean>(n).fill(false);
  for (const [a, b] of joins) {
    if (!alive[a] || !alive[b]) continue;
    for (const [s, t] of [[a, b], [b, a]] as const) {
      const k = bankKind(fns[s]);
      if (k && (k === 'drive' ? engineLike(t) : gunLike(t))) nearBank[t] = true;
    }
  }
  let spare = 0, totalSupply = 0;
  const networks: FlowNetwork[] = wn.nets.map((g) => {
    let supply = 0, powered = false, stored = false;
    for (const i of g) {
      if ((fns[i].produce ?? 0) > 0) { powered = true; supply += partSupply(fns[i], area[i], mats[i]) * partHealth(hp[i], maxHp[i], tuning); }
      // (Energy routing's relays, the Conduit and Diode, store nothing for the old flow: circuits.ts leaves them out of the pool)
      if ((fns[i].store ?? 0) > 0 && !fns[i].relayOnly && !fns[i].oneWay) stored = true;
    }
    // Engines, guns and mining lasers draw on the battery (energy.ts): only steady loads share out the supply here
    const consumers = g.filter((i) => (fns[i].demand ?? 0) > 0 && !burst(i));
    const demands = consumers.map((i) => partDemand(fns[i], area[i], mats[i]));
    const alloc = allocateFlow(supply, consumers.map((i, k) => ({ draw: demands[k], priority: fns[i].priority ?? 3 })));
    let delivered = 0;
    consumers.forEach((i, k) => {
      satisfaction[i] = demands[k] > 0 ? Math.min(1, alloc[k] / demands[k]) : 0;
      delivered += satisfaction[i] * demands[k];
    });
    // (They run while their network has a generator or a battery on it (the ship's pool pays), or a bank of their kind touches them)
    for (const i of g) if (burst(i) && (fns[i].demand ?? 0) > 0) satisfaction[i] = powered || stored || nearBank[i] ? 1 : 0;
    spare += Math.max(0, supply - delivered);
    totalSupply += supply;
    return { parts: g, supply, demand: demands.reduce((s, d) => s + d, 0), delivered, powered };
  });
  // Consumers on no network get nothing (but engines, guns and mining lasers a bank of their kind touches)
  parts.forEach((_, i) => {
    if (alive[i] && (fns[i].demand ?? 0) > 0 && network[i] < 0) satisfaction[i] = burst(i) && nearBank[i] ? 1 : 0;
  });
  // (A ports design has no networks: its ports core decides what each part gets, every tick; nothing is starved here)
  if (blueprint.power === 'ports') parts.forEach((_, i) => { if (alive[i]) satisfaction[i] = 1; });

  // 5. Derived physics
  const cs = tuning.cellSize;
  let mass = 0, mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const m = area[i] * mats[i].density * (fns[i].massScale ?? 1);
    mass += m;
    mx += m * geoms[i].centroid[0];
    my += m * geoms[i].centroid[1];
  }
  const com: Vec2 = mass > 0 ? [mx / mass, my / mass] : [0, 0];
  // The same for the ship as built: every part but ghosts, held on through built parts
  const core = D.core;
  const asBuilt = core >= 0 && input.rootMode === 'core'
    ? !input.ghost?.some(Boolean) ? wholeBuilt(D) : floodFill(n, allJoins.filter(([a, b]) => !input.ghost?.[a] && !input.ghost?.[b]), core, (i) => !input.ghost?.[i])
    : parts.map((_, i) => !input.ghost?.[i]);
  const built = (i: number) => asBuilt[i];
  let fullMass = 0, fx = 0, fy = 0;
  for (let i = 0; i < n; i++) {
    if (!built(i)) continue;
    const m = area[i] * mats[i].density * (fns[i].massScale ?? 1);
    fullMass += m;
    fx += m * geoms[i].centroid[0];
    fy += m * geoms[i].centroid[1];
  }
  const fcom: Vec2 = fullMass > 0 ? [fx / fullMass, fy / fullMass] : [0, 0];
  let fullInertiaGrid = 0;
  for (let i = 0; i < n; i++) {
    if (!built(i)) continue;
    const dx = geoms[i].centroid[0] - fcom[0], dy = geoms[i].centroid[1] - fcom[1];
    fullInertiaGrid += mats[i].density * (fns[i].massScale ?? 1) * (geoms[i].variant.polarMoment + area[i] * (dx * dx + dy * dy));
  }
  let inertiaGrid = 0;
  let radius = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const d = mats[i].density * (fns[i].massScale ?? 1);
    const dx = geoms[i].centroid[0] - com[0], dy = geoms[i].centroid[1] - com[1];
    inertiaGrid += d * (geoms[i].variant.polarMoment + area[i] * (dx * dx + dy * dy));
    for (const p of geoms[i].polygon) radius = Math.max(radius, dhypot(p[0] - com[0], p[1] - com[1]));
  }

  const thrusters: ThrusterInfo[] = [];
  const maxThrust = { forward: 0, back: 0, left: 0, right: 0 };
  let torqueCw = 0, torqueCcw = 0;
  let thrustSum = 0, boostSum = 0, drainSum = 0, demandSum = 0;
  // (An engine keeps the share of its exhaust lanes the ship as it stands leaves clear: mounting.ts engineExhaust)
  let standing: CellMap | null = null;
  for (let i = 0; i < n; i++) {
    if (!alive[i] || !isEngine(fns[i]) || !mounts[i]) continue;
    const nrm = mounts[i]!.dir, side = parts[i].facing;
    // (A lane only opens as parts go: an engine that was clear still is, RebuildMemo)
    const exhaust = !side || geoms[i].bespoke ? 1 : !input.fresh && (was ? was.exhaust.get(i) : wholeExhaust(D, i, side)) === 1 ? 1 : engineExhaust(geoms, i, side, standing ??= cellMap(geoms, (j) => alive[j])).share;
    exhaustOf.set(i, exhaust);
    const mag = partThrust(catalog, fns[i], area[i], mats[i]) * satisfaction[i] * exhaust;
    thrustSum += mag;
    boostSum += mag * (fns[i].boost ?? 2.2);
    // (The drain is weighted by what each engine draws, as the power tick adds it up engine by engine)
    const dem = partDemand(fns[i], area[i], mats[i]);
    demandSum += dem;
    drainSum += dem * (fns[i].boostDrain ?? 1);
    const force: Vec2 = [-nrm[0] * mag || 0, -nrm[1] * mag || 0];
    const pos = geoms[i].centroid;
    const torque = cross2([pos[0] - com[0], pos[1] - com[1]], force) * cs;
    thrusters.push({ part: i, force, pos, torque, ...(fns[i].rated ? { rated: fns[i].rated } : {}), ...(exhaust < 1 ? { exhaust } : {}) });
    maxThrust.forward += Math.max(0, -force[1]);
    maxThrust.back += Math.max(0, force[1]);
    maxThrust.left += Math.max(0, -force[0]);
    maxThrust.right += Math.max(0, force[0]);
    if (torque > 0) torqueCw += torque; else torqueCcw -= torque;
  }
  const hasCore = root >= 0 && parts[root].fn === 'core';
  const gyro = hasCore ? tuning.flight.gyroTorque : 0;
  const gain = tuning.flight.thrusterTorqueGain;

  // 6. Weapons
  const weapons: WeaponInfo[] = [];
  let weaponDraw = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i] || !fns[i].weapon || !mounts[i]) continue;
    const { at: muzzle, dir } = mounts[i]!;
    const sat = satisfaction[i];
    // (A model's mount is its own; a legacy gun's its part's)
    const mount = partMount(catalog, parts[i]);
    // (A model is its own size, and its tier its grade)
    const model = fns[i].model;
    const size = model ? 1 : area[i] / weaponBaseArea(catalog, fns[i]);
    const grade = partGrade(catalog, parts[i]);
    // Its grade and size have their own rhythm too (a heavy shell loads slower: launch.ts gunRate). A legacy fixed
    // cannon loads slower (tuning.fixedGun); a model's interval is its own, mount and all (scripts/econ/models.mjs)
    const interval = (fns[i].fireInterval ?? 10) * (mount === 'fixed' && !model && fns[i].weapon === 'cannon' ? tuning.fixedGun?.intervalScale ?? 1 : 1) / Math.max(sat, tuning.flow.minWeaponSatisfaction)
      / (mats[i].traits?.includes('conductive') ? CONDUCTIVE_RATE : 1) / Math.max(0.2, 1 + (parts[i].mods?.mul?.rate ?? 0)) / (model ? 1 : gunRate(tuning, fns[i].weapon!, grade, size));
    // Firing flat out it draws its demand: a shot is that much power for one interval (beams: per tick)
    const draw = partDemand(fns[i], area[i], mats[i]);
    // (A pulse laser pays for a pulse at a time, as a gun does a shot)
    const fire = fireOf(tuning, fns[i]);
    const beam = fire.model === 'beam';
    weapons.push({
      part: i,
      uid: parts[i].uid,
      kind: fns[i].weapon!,
      satisfaction: sat,
      strength: weaponStrength(catalog, fns[i], area[i], mats[i]),
      size,
      grade,
      ...(model ? { model: fns[i].weaponMods ?? NO_MODS } : {}),
      interval,
      fire,
      energy: beam ? draw / 60 : (draw * interval) / 60,
      muzzle,
      dir,
      mount,
      window: mount === 'turret' ? turretWindow(i) : undefined,
    });
    // (What it draws firing flat out, by its firing model: an ammunition gun nothing, a clip gun its reloads, a spinning one spun up: energy.ts)
    weaponDraw += gunDrawFlatOut(weapons[weapons.length - 1], draw);
  }

  // 7. Cargo, mining lasers, scanners
  let cargoCapacity = hasCore ? CORE_CARGO : 0;
  let scanRange = 0;
  let shieldMax = 0, shieldRegen = 0, shieldDelayW = 0, coilCool = 1;
  const jt = { ...DEFAULT_JUMP, ...(tuning.jump ?? {}) };
  // The jump drive: coil capacity (the core's own, and powered coils', a little more for better grades) against the hull's cells
  // (A ports design's coils count once the layout says power reaches them: portsCoils, below)
  let jumpCap = 0, jumpGradeSum = 0, hullCells = 0;
  const portsCoils: number[] = [], portsShields: number[] = [];
  const onPorts = blueprint.power === 'ports';
  const miners: MinerInfo[] = [];
  const launchers: LauncherInfo[] = [];
  const dash = { speed: 0, cooldown: 0, coils: 0 };
  let engineDraw = 0, minerDraw = 0;
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    hullCells += area[i];
    const coil = parts[i].fn === 'core' ? jt.coreCapacity : (fns[i].jumpCapacity ?? 0) * area[i] * satisfaction[i];
    if (coil > 0 && onPorts && parts[i].fn !== 'core') portsCoils.push(i);
    else if (coil > 0) {
      const grade = partGrade(catalog, parts[i]);
      jumpCap += coilCapacity(coil, grade, jt);
      jumpGradeSum += coil * grade;
    }
    if ((fns[i].capacity ?? 0) > 0) cargoCapacity += fns[i].capacity! * area[i];
    if ((fns[i].range ?? 0) > 0) scanRange = Math.max(scanRange, fns[i].range! * satisfaction[i]);
    if ((fns[i].shield ?? 0) > 0 && onPorts && !fns[i].flash) portsShields.push(i);
    else if ((fns[i].shield ?? 0) > 0) {
      const cap = fns[i].shield! * area[i] * fnOutput(fns[i], mats[i]) * satisfaction[i];
      shieldMax += cap;
      // (its own refill, per cell; else the ship-wide tuning's share of what it holds)
      const sr = fns[i].shieldRegen, sd = fns[i].shieldDelay ?? tuning.shield?.regenDelayTicks ?? 0;
      const rate = sr !== undefined ? sr * area[i] * fnOutput(fns[i], mats[i]) * satisfaction[i] : cap * (tuning.shield?.regenPerSecond ?? 0);
      shieldRegen += rate;
      shieldDelayW += rate * sd;
    }
    if ((fns[i].jumpCooldown ?? 1) < coilCool && satisfaction[i] > 0 && !onPorts) coilCool = fns[i].jumpCooldown!;
    if (satisfaction[i] > 0 && (fns[i].demand ?? 0) > 0) {
      const draw = partDemand(fns[i], area[i], mats[i]);
      if (isEngine(fns[i])) engineDraw += draw;
      else if (isMinerFn(fns[i])) minerDraw += draw;
    }
    if (isMinerFn(fns[i]) && mounts[i]) {
      miners.push({
        part: i, material: mats[i].id, satisfaction: satisfaction[i], ...(fns[i].siphon ? { gas: true } : {}),
        muzzle: mounts[i]!.at, dir: mounts[i]!.dir,
      });
    }
    const ln = fns[i].launches;
    if (ln) {
      const m = mounts[i];
      launchers.push({ part: i, mob: ln.mob, count: ln.count, every: ln.every, satisfaction: satisfaction[i], muzzle: m?.at ?? geoms[i].centroid, dir: m?.dir ?? [0, -1] });
    }
    const ds = fns[i].dash;
    if (ds && satisfaction[i] > 0) {
      dash.coils++;
      dash.speed = Math.max(dash.speed, ds.speed);
      dash.cooldown = dash.cooldown ? Math.min(dash.cooldown, ds.cooldown) : ds.cooldown;
    }
  }

  // ---- Part features (features/): each one this ship has derives its own `fx.<key>`, in plan order
  let fxMask = 0, fxList: Int8Array | undefined, fxOut: FeatureDerived | undefined;
  // (Turning torque features add, both ways and wherever their parts sit: a Gyro's. DeriveCtx.turn)
  const fxTurn = { torque: 0 };
  if (fxOf) {
    fxMask = P.globalMask;
    for (let i = 0; i < n; i++) if (alive[i]) fxMask |= fxOf[i];
    if (fxMask) {
      fxList = featureList(fxMask);
      fxOut = {};
      for (const f of fxList) {
        const derive = P.derive[f];
        if (!derive) continue;
        const bit = 1 << f, mine: number[] = [];
        for (let i = 0; i < n; i++) if (alive[i] && (fxOf[i] & bit)) mine.push(i);
        derive({ catalog, tuning, blueprint, fns, mats, area, geoms, mounts, alive, satisfaction, parts: mine, out: fxOut, turn: fxTurn });
      }
    }
  }

  // ---- The power layout (circuits.ts): the ship's pool and the banks, worked out here once, run by energy.ts every tick
  const health = hp.map((h, i) => partHealth(h, maxHp[i], tuning));
  // (A ports design runs on the ports core instead, power/ports.ts: power crosses only through the parts' ports, and the old
  // layout is left out, so everything that reads `power` must do without it)
  const ports = blueprint.power === 'ports'
    ? buildPortsLayout({ parts, fns, area, mats, alive, cells: geoms.map((g) => g.cells), core: coreAlive ? root : -1, tuning, health, weapons: weapons.map((w) => ({ part: w.part, fire: w.fire, interval: w.interval })) })
    : undefined;
  const power = ports ? undefined : powerLayout({ fns, area, mats, alive, joins, network, networks, burst, engine: engineLike, gun: gunLike, core: coreAlive, tuning, health });
  const batteryMax = power ? power.pool.cap : ports!.gaugeMax / 256;
  let driveMax = 0, weaponMax = 0;
  if (power) for (const B of power.banks) if (B.kind === 'drive') driveMax += B.cap; else weaponMax += B.cap;
  // ---- (end power layout)

  // (A ports design's coils: those power reaches, through their in ports, count; one cut off is dead weight)
  if (ports && portsCoils.length) {
    const fed = portsFed(ports);
    for (const i of portsCoils) {
      if (!fed[i]) continue;
      const coil = (fns[i].jumpCapacity ?? 0) * area[i], grade = partGrade(catalog, parts[i]);
      jumpCap += coilCapacity(coil, grade, jt);
      jumpGradeSum += coil * grade;
      if ((fns[i].jumpCooldown ?? 1) < coilCool) coilCool = fns[i].jumpCooldown!;
    }
  }
  // (And its shields, by the same rule: one power can't reach adds nothing; one reached refills as it is fed, energy.ts shieldShare)
  if (ports && portsShields.length) {
    const fed = portsFed(ports);
    for (const i of portsShields) {
      if (!fed[i]) continue;
      const cap = fns[i].shield! * area[i] * fnOutput(fns[i], mats[i]);
      shieldMax += cap;
      const sr = fns[i].shieldRegen, sd = fns[i].shieldDelay ?? tuning.shield?.regenDelayTicks ?? 0;
      const rate = sr !== undefined ? sr * area[i] * fnOutput(fns[i], mats[i]) : cap * (tuning.shield?.regenPerSecond ?? 0);
      shieldRegen += rate;
      shieldDelayW += rate * sd;
    }
  }
  // (Shaped shields by the same rule: one power cannot reach is not up; features/zoneshield)
  if (ports && fxOut?.shaped) {
    const fed = portsFed(ports), up = fxOut.shaped.shields.filter((s) => fed[s.part]);
    if (up.length) fxOut.shaped.shields = up; else delete fxOut.shaped;
  }
  const jump = jumpDriveStats(jumpCap, hullCells, jumpCap > 0 ? jumpGradeSum / jumpCap : 1, jt);
  if (input.memo) input.memo.last = { design: D, tuning, alive: Uint8Array.from(alive, Number), turrets: turretRays, exhaust: exhaustOf };

  return {
    root,
    alive,
    orphanGroups,
    joins,
    flowJoins,
    network,
    networks,
    wires: wn.wires,
    wireLive: wn.live,
    wireNet: wn.segNet,
    satisfaction,
    energy: { max: Math.round(batteryMax), driveMax: Math.round(driveMax), weaponMax: Math.round(weaponMax), spare, supply: totalSupply, engineDraw, minerDraw, weaponDraw },
    power,
    ...(ports ? { ports } : {}),
    mass,
    com,
    inertia: inertiaGrid * cs * cs,
    fullMass: Math.max(mass, fullMass),
    fullInertia: Math.max(inertiaGrid, fullInertiaGrid) * cs * cs,
    drive: driveFactor(mass, fullMass) * Math.max(0.1, Math.min(MAX_DRIVE, blueprint.drive ?? 1)),
    ...(blueprint.turn ? { turn: Math.max(0.1, Math.min(MAX_TURN, blueprint.turn)) } : {}),
    boostFactor: ports ? 1 : thrustSum > 0 ? boostSum / thrustSum : 2.2,
    boostDrain: demandSum > 0 ? drainSum / demandSum : 1,
    thrusters,
    maxThrust,
    maneuverForce: hasCore ? tuning.flight.coreManeuverForce : 0,
    maxTorque: { cw: gyro + fxTurn.torque + gain * torqueCw, ccw: gyro + fxTurn.torque + gain * torqueCcw },
    weapons,
    cargoCapacity: Math.round(cargoCapacity),
    miners,
    launchers,
    dash,
    scanRange: Math.round(scanRange),
    shieldMax: Math.round(shieldMax),
    shieldRegen: Math.round(shieldRegen * 100) / 100,
    shieldDelay: shieldRegen > 0 ? Math.round(shieldDelayW / shieldRegen) : 0,
    ...(fxMask ? { fxMask, fxList, fx: fxOut } : {}),
    jumpRange: jump.range,
    jumpCooldown: coilCool < 1 ? Math.round(jump.cooldown * coilCool) : jump.cooldown,
    jumpRatio: jump.ratio,
    radius: radius * cs,
    makeup: makeupOf(alive, area, mats, fns),
  };
}

function makeupOf(alive: boolean[], area: number[], mats: MaterialDef[], fns: FunctionDef[]): ShipDerived['makeup'] {
  const traits: Record<string, number> = {}, tolerance: Record<string, number> = {};
  let cells = 0, conduits = 0, conductiveConduits = 0, anchorMass = 0, insulation = 0;
  for (let i = 0; i < alive.length; i++) {
    if (!alive[i]) continue;
    cells += area[i];
    for (const t of mats[i].traits ?? []) traits[t] = (traits[t] ?? 0) + area[i];
    for (const [h, r] of Object.entries(mats[i].hazards ?? {})) tolerance[h] = (tolerance[h] ?? 0) + area[i] * r;
    insulation += area[i] * (mats[i].insulation ?? 0);
    if (fns[i].id === 'conduit') {
      conduits++;
      if (mats[i].traits?.includes('conductive')) conductiveConduits++;
    }
    if (mats[i].traits?.includes('mass_anchor')) anchorMass += area[i] * mats[i].density;
  }
  if (cells > 0) {
    for (const k in traits) traits[k] /= cells;
    for (const k in tolerance) tolerance[k] /= cells;
    insulation /= cells;
  }
  return { traits, tolerance, conduits, conductiveConduits, anchorMass, insulation };
}
