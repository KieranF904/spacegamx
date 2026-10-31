/**
 * ShipState: the plain, serialisable data for one ship or debris body.
 * The engine owns position/velocity/angle (ECS components); this owns the rest.
 */

import type { Blueprint } from './types.js';
import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import { partMaxHp } from './blueprint.js';
import { ShipDerived, rebuild } from './rebuild.js';

export interface ShipState {
  /** Engine entity id */
  id: number;
  kind: 'ship' | 'debris';
  blueprint: Blueprint;
  hp: number[];
  maxHp: number[];
  /** Its parts' HP is scaled from the blueprint's (a boss's hp, a hardened core): clients are sent the true maximums */
  scaledHp?: boolean;
  /** HP as it was at the last rebuild (what `derived` was computed from; clients rebuild from this) */
  rebuildHp: number[];
  /** Part left this body as debris (its blueprint entry stays for repair) */
  detached: boolean[];
  /** Not built yet (hangar ghosts): flight doesn't count these as lost */
  ghost: boolean[];
  /** Set when a part dies or its HP crosses a band; cleared by rebuild */
  dirty: boolean;
  angVel: number;
  /** Jump drive counter (flight.ts stepJump), 0 = ready */
  jump: number;
  /** This jump's speed scale (set when its burn starts) */
  jumpScale?: number;
  /** Mass of the cargo in its hold (load.ts), absent = 0 */
  cargo?: number;
  /** Burst Strafer (features/strafer/strafer.ts): the dodge counter and the way of the last dodge (1..DODGE_DIRS, ship-local), absent = 0 */
  dodge?: number;
  dodgeDir?: number;
  /** Tow Beam (tow.ts): what it's towing (an entity id), absent = nothing; the server sets it, gunLoad draws for it */
  tow?: number;
  /** Ticks left of a stillstone's priming (jumpFields.ts stepPrime; negative: a scarred one's): the next jump reaches further */
  jumpPrime?: number;
  /** Ticks until each part (weapons) can fire again, by part index */
  cooldown: number[];
  /** The mining-laser segment last paid for (energy.ts payMining) */
  minePaid?: number;
  /** The tick the mining laser's pulse under way ends (energy.ts MINE_CYCLE) */
  mineUntil?: number;
  /** Turret aim, by part index: radians from the centre of its window */
  aim: number[];
  derived: ShipDerived;
  rebuilds: number;
  spawnTick: number;
  /** Debris despawn tick, -1 for ships */
  despawnTick: number;
  /** Shield charge (0..derived.shieldMax) and when it was last hit */
  shield: number;
  shieldHitTick: number;
  /**
   * Gun state by part index (guns.ts stepGuns, the firing models): rounds in a clip gun's clip; a clip gun's reload
   * ticks left (a regrowing clip's: progress towards its next round); a charge gun's charge in ticks (below 0: draining
   * away after an early release), a beam's ticks lit (its windup); a spinning gun's spin (0..1)
   */
  rounds: number[];
  reload: number[];
  charge: number[];
  spin: number[];
}

export function rebuildShip(state: ShipState, catalog: Catalog, tuning: ShipTuning): void {
  state.derived = rebuild({
    catalog,
    tuning,
    blueprint: state.blueprint,
    hp: state.hp,
    maxHp: state.maxHp,
    detached: state.detached,
    ghost: state.ghost,
    rootMode: state.kind === 'ship' ? 'core' : 'largest',
  });
  state.rebuildHp = [...state.hp];
  state.dirty = false;
  state.rebuilds++;
}

export function createShipState(
  catalog: Catalog,
  tuning: ShipTuning,
  id: number,
  blueprint: Blueprint,
  tick: number,
  opts: { kind?: 'ship' | 'debris'; hp?: number[]; angVel?: number } = {},
): ShipState {
  const maxHp = blueprint.parts.map((p) => partMaxHp(catalog, p));
  const state: ShipState = {
    id,
    kind: opts.kind ?? 'ship',
    blueprint,
    hp: opts.hp ? [...opts.hp] : [...maxHp],
    maxHp,
    rebuildHp: [],
    detached: blueprint.parts.map(() => false),
    ghost: blueprint.parts.map(() => false),
    dirty: true,
    angVel: opts.angVel ?? 0,
    jump: 0,
    cooldown: blueprint.parts.map(() => 0),
    aim: blueprint.parts.map(() => 0),
    derived: null as unknown as ShipDerived,
    rebuilds: 0,
    spawnTick: tick,
    despawnTick: opts.kind === 'debris' ? tick + tuning.debris.lifetimeTicks : -1,
    shield: 0,
    shieldHitTick: -1e9,
    rounds: blueprint.parts.map(() => 0),
    reload: blueprint.parts.map(() => 0),
    charge: blueprint.parts.map(() => 0),
    spin: blueprint.parts.map(() => 0),
  };
  rebuildShip(state, catalog, tuning);
  // (Every clip starts full)
  fillClips(state);
  state.shield = state.derived.shieldMax;
  return state;
}

/** Fill every clip gun's clip (a new ship, a respawn), and clear reloads, charges and spin */
export function fillClips(state: ShipState): void {
  for (const w of state.derived.weapons) {
    state.rounds[w.part] = w.fire.model === 'clip' ? w.fire.clip ?? 0 : 0;
    state.reload[w.part] = 0;
    state.charge[w.part] = 0;
    state.spin[w.part] = 0;
  }
}

/** Full HP is band 4 (with 25% bands) until it drops below 75%; 0 HP is band 0. */
function band(hp: number, max: number, size: number): number {
  return Math.ceil((hp / max) / size - 1e-9);
}

/**
 * Damage one part. Marks the ship dirty when the part dies or crosses an HP
 * band. Returns the damage actually applied.
 */
export function damagePart(state: ShipState, part: number, amount: number, tuning: ShipTuning): number {
  const before = state.hp[part];
  if (before <= 0 || state.detached[part]) return 0;
  const after = Math.max(0, before - amount);
  state.hp[part] = after;
  if (after <= 0 || band(before, state.maxHp[part], tuning.hpBandSize) !== band(after, state.maxHp[part], tuning.hpBandSize)) {
    state.dirty = true;
  }
  return before - after;
}

/**
 * Heal one intact part (station repair). Marks the ship dirty when the part
 * crosses an HP band. Returns the HP actually restored.
 */
export function healPart(state: ShipState, part: number, amount: number, tuning: ShipTuning): number {
  const before = state.hp[part];
  if (before <= 0 || state.detached[part]) return 0;
  const after = Math.min(state.maxHp[part], before + amount);
  state.hp[part] = after;
  if (band(before, state.maxHp[part], tuning.hpBandSize) !== band(after, state.maxHp[part], tuning.hpBandSize)) state.dirty = true;
  return after - before;
}

/** Bring a destroyed or lost part back, re-attached at `fraction` of its max HP. */
export function restorePart(state: ShipState, part: number, fraction: number): void {
  state.detached[part] = false;
  state.hp[part] = Math.max(1, state.maxHp[part] * fraction);
  state.dirty = true;
}

/** Full repair: every part back to max HP and re-attached. */
export function repairShip(state: ShipState): void {
  state.hp = [...state.maxHp];
  state.detached = state.detached.map(() => false);
  state.dirty = true;
}

/** Core HP (0 when the core is gone). */
export function coreHp(state: ShipState): { hp: number; max: number } {
  const i = state.blueprint.parts.findIndex((p) => p.fn === 'core');
  if (i < 0) return { hp: 0, max: 1 };
  return { hp: state.detached[i] ? 0 : state.hp[i], max: state.maxHp[i] };
}
