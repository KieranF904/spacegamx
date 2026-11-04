/**
 * ShipBridge core: the types, constants and engine interface (ShipHost) the bridge and its modules (bridge/*.ts)
 * share, and BridgeCtx, the bridge's internal state as those modules see it.
 *
 * Import rule: bridge modules import ShipBridge as a type only (erased), never its value; runtime imports run one
 * way, ShipBridge.ts -> bridge/*.ts -> core.ts / common.
 */

import type { IWorld } from 'bitecs';
import {
  FRICTION, BOOST_FACTOR, WORLD_SIZE, CONTACT_BIG_BODY,
  type Blueprint, type Catalog, type ShipState, type ShipTuning, type PlacedPart, type Vec2, type InventoryStub,
  type GravityWell, type FlightConstants, type HitInfo, type FieldEnv, type WeaponMods, type ShipDerived, type Terrain,
} from '@space-game/common';
import type { ShipBridge } from '../ShipBridge.js';

/** What the bridge needs from the engine. GameServer provides it. */
export interface ShipHost {
  readonly world: IWorld;
  getTick(): number;
  /** The tick of the system a body is in (its own clock, crowd dilation: sim/SystemClocks.ts); unset: getTick */
  systemTick?(eid: number): number;
  /** New entity with Position, Velocity, Rotation, Radius */
  createBody(): number;
  removeBody(eid: number): void;
  /** A projectile weapon's shot (kind = tuning.weapons key), spawned exactly at (x, y). `target` is a homing target (or -1). */
  /** Returns the shells' entity ids, in spawn order */
  fireBaseShot(ownerEid: number, x: number, y: number, angle: number, damageScale: number, shape?: { speedScale: number; sizeScale: number; turret: boolean; kind?: string; target?: number; seed?: string; mods?: WeaponMods; dry?: boolean; ammoMods?: WeaponMods; reach?: number; grade?: number; size?: number; model?: WeaponMods; gun?: number }): number[] | void;
  /** A shot's damage against shields and hull (pulse lasers), if it has its own */
  shotVs?(proj: number): { shield?: number; hull?: number; hit?: HitInfo; bane?: { faction: string; damage: number } } | undefined;
  /** Where a hazard bites: beam heat or shield regeneration × this (1 where nothing does) */
  hazardScale?(eid: number, what: 'shield'): number;
  /** A part with gems in it was destroyed (the gems go with it) */
  partLost?(eid: number, uid: number): void;
  /** A pilot's gun fires a volley: spend its ammunition (if it takes any). Its damage share, and whether it's a plain round */
  /** `free`: this gun needs none (a model that makes its own: it still fires a special crate if there's one aboard) */
  spendAmmo?(eid: number, kind: string, free?: boolean): { scale: number; dry: boolean; mods?: WeaponMods; item?: string };
  /** A weapon beam meets asteroids: damage the first one along it (and mine it a little). Returns how far along (0..1) it hit, 1 = nothing. */
  /** A surface's rock where this body is (terrain.ts): ships are pushed out of it, beams stop at it */
  terrainAt?(eid: number): Terrain | undefined;
  /** Splash reaching mobs (Mobs.ts): only pilots' hurts them */
  splashMobs?(systemNum: number, x: number, y: number, radius: number, damage: number, source: number): void;
  /** A beam passing through mobs this tick */
  beamMobs?(systemNum: number, x0: number, y0: number, x1: number, y1: number, width: number, damage: number, source: number): void;
  /** A zap leapt to (x, y) from (fromX, fromY) (a Tesla's chain): everyone in the system sees the arc */
  arcHop?(systemNum: number, x: number, y: number, fromX: number, fromY: number): void;
  beamAsteroid?(eid: number, x: number, y: number, angle: number, range: number, damage: number, kind: string): number;
  /** `glancing`: the hit barely got through the armour it struck (a gun too weak for it) */
  notifyDamage(targetEid: number, amount: number, sourceEid: number, glancing?: boolean): void;
  /**
   * A projectile hit something at (x, y). A shell's hit on a ship says what it did (`hit`: the part it struck, the
   * damage, glancing, what a shield took, the ship's rebuild count): confirmed hits (net/hits/HitLedger.ts)
   */
  notifyProjectileHit(proj: number, x: number, y: number, hit?: { target: number; part: number; dealt: number; glancing: boolean; soak: number; rebuilds: number }): void;
  /**
   * Ship bodies whose bounding circles may come within `pad` of a segment (the
   * tick's broadphase; beams cast through it). Absent: every body is tried.
   */
  shipsAlong?(systemNum: number, x0: number, y0: number, x1: number, y1: number, pad: number): Iterable<number>;
  /** The gravity well in this entity's system (black holes), or null */
  gravityAt(eid: number): GravityWell | null;
  /** What hazards do to a pilot's ship here (ships/hazards.ts hazardFlight) */
  hazardFlight?(eid: number, derived: ShipDerived, x: number, y: number): FlightConstants['hazard'];
  /** Mass of what's in a pilot's hold (ships/load.ts; station storage weighs nothing) */
  cargoMass?(eid: number): number;
  /** Mass its part features add to a pilot's hold (ships/features/host.ts: a Tow Beam's load), carried as cargo */
  featureCargo?(eid: number): number;
  /** A ship was rebuilt (ships/features: features re-check what depends on its parts) */
  shipRebuilt?(eid: number): void;
  /** A ship's shield broke (ships/features: a Flash Screen starts its return) */
  shieldBroken?(eid: number): void;
  /** Everything kept about an entity id was dropped (ships/features: features forget it) */
  shipForgotten?(eid: number): void;
  /** The jump drive's charging fields in this ship's system (a star's ring, lodestones: common/src/ships/jumpFields.ts) */
  jumpFields?(eid: number): FieldEnv;
  /** What a part is worth in credits (repair kits charge their budget by it) */
  partValue?(part: PlacedPart): number;
  /** A repair kit's progress changed (budget left, or 0 when it's done; `broken` says why it stopped early) */
  onRepairKit?(eid: number, left: number, total: number, broken?: 'hit' | 'moved'): void;
  /** A pilotless ship lost its core (it is removed right after). `lastHitBy` is the last entity whose shot hit it. */
  onShipDestroyed?(eid: number, lastHitBy: number | undefined, ship?: ShipState): void;
  /** A part was destroyed (shot, rammed, blown up or crumbled away), for effects */
  notifyPartDestroyed?(e: PartDestroyedEvent): void;
  /** Two bodies hit each other hard enough to see and hear */
  notifyContact?(e: { systemId: number; x: number; y: number; nx: number; ny: number; speed: number }): void;
  /** Whether a ship is close enough to a station to be repaired */
  nearRepairSite?(eid: number): boolean;
  /** Station repair is about to regrow a lost part: charge for it. False = can't pay (try again later). */
  payRebuild?(eid: number, part: number): boolean;
  /** Pay for `hp` of station repair: the share (0..1) of it that goes ahead (absent: free) */
  payRepair?(eid: number, hp: number): number;
  /** May `attacker` hurt `target`? (Players can't hurt each other outside PvP zones.) Default: yes. */
  canDamage?(attacker: number, target: number): boolean;
  // --- Support weapons (common/src/ships/features/support/support.ts) ---
  /** May `healer`'s Repair Beam mend `target`? (A friendly ship: absent, nobody) */
  canHeal?(healer: number, target: number): boolean;
  /** A Repair Beam mended `hp` of `target` this tick (support credit: GameServer's Support ledger) */
  onHeal?(healer: number, target: number, hp: number): void;
  /** Shots point defence on `eid` could fire on within `range` of (x, y), nearest first, into `out` */
  pdThreats?(eid: number, x: number, y: number, range: number, out: { id: number; x: number; y: number; d: number }[]): void;
  /** A point-defence shot from part `part` of `eid` (its muzzle at x, y) hits shot `proj`: true when that brings it down */
  intercept?(eid: number, part: number, proj: number, x: number, y: number): boolean;
  // --- end support weapons ---
  /** Takes no damage at all (admin god mode, docked) */
  invulnerable?(eid: number): boolean;
  /** What share of a hit it takes (a boss braced, or laid open): absent, all of it */
  takenScale?(eid: number): number;
  /** A staged boss: what share of a hit on a later stage's part passes to the current stage's plate (absent: STAGE_COVER) */
  stageCover?(eid: number): number | undefined;
  /** The faction a hostile ship flies for, when ammunition made for it counts (not a boss): Quench Slugs' bane */
  baneFaction?(eid: number): string | undefined;
  /** Inside a station (docked): nothing touches it, and it fires nothing */
  sheltered?(eid: number): boolean;
  /**
   * A mining beam this tick from (x, y) along `angle`, up to `range`: hit the
   * first asteroid and mine it with `dps` (per tick) using the laser's
   * material. Returns how far along the beam (0..1) it hit, or 1 for nothing.
   */
  mineBeam?(eid: number, x: number, y: number, angle: number, range: number, damage: number, material: string, gas?: boolean, full?: number): number;
}

/** A destroyed part, for effects: what it was, where, and how it went */
export interface PartDestroyedEvent {
  systemId: number;
  bodyId: number;
  part: number;
  fn: string;
  /** 'blast' = it blew up (cores, generators, thrusters, weapons), 'break' = shot or crushed apart, 'crumble' = a loose part decaying */
  how: 'blast' | 'break' | 'crumble';
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Blast radius in world units (0 when it didn't blow up), or the part's size otherwise */
  size: number;
}

/** What an AI pilot wants this tick */
export interface PilotOrders {
  controls: { forward: boolean; backward: boolean; left: boolean; right: boolean; boost: boolean; targetAngle: number };
  firing: boolean;
  /** World angle and distance to aim the guns at */
  aim?: number;
  aimDist?: number;
  /** Missile lock */
  target?: number;
  /** A sudden burst of speed this tick (a boss's dash or charge: world units a tick, added to its velocity) */
  impulse?: [number, number];
  /** Flown by its body (common bodies/, CAPS.BODIES): the controls and push it made, as a client's body makes them */
  body?: { bits: number; q: number; ix: number; iy: number };
}

// (the glancing line and the stage cover share: common/src/ships/hitRules.ts, the rules a client works hits out by too)
export { GLANCING, STAGE_COVER } from '@space-game/common';

export interface PendingBlast { due: number; systemId: number; x: number; y: number; radius: number; damage: number; source: number }

/**
 * A walking salvo's shell still to fire (features/weaponry walk): from its gun (by part uid), on tick `due`, landing at
 * `reach` (its fraction of the aim distance when the salvo was fired), with the salvo's damage and ammunition
 */
export interface PendingSalvoShell {
  uid: number;
  due: number;
  index: number;
  reach: number;
  /** A rippling salvo's missiles: the lock they steer to */
  target?: number;
  damageScale: number;
  dry?: boolean;
  ammoMods?: WeaponMods;
}

export interface ShipBridgeConfig {
  catalog: Catalog;
  tuning: ShipTuning;
  /** What newly created players fly */
  starterBlueprint: Blueprint;
  /** What every player owns (stub until crafting exists) */
  inventory: InventoryStub;
  /** Pre-made ships by file name (derelicts are built from these) */
  library?: Record<string, Blueprint>;
  /** Enemy designs by file name */
  enemies?: Record<string, Blueprint>;
  /** Dev test ships by file name (the F9 ship swap only) */
  dev?: Record<string, Blueprint>;
  /** Wall-clock source for the admin panel's rebuild timer only (never used by ship logic) */
  now?: () => number;
}

export interface ShipBridgeStats {
  lastRebuildMs: number;
  rebuildCount: number;
  debrisCount: number;
}

export const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };

// (Contacts are worked out in common ships/contact.ts, alike on the server and on a pilot's own tick-aligned ship)
export { centroidOf, type ContactPiece } from '@space-game/common';

/** After an EMP wears off, the ship can't be knocked out again for this long */
export const EMP_IMMUNE_TICKS = 240;

/**
 * Contact pairs are looked for this much beyond touching bounding circles:
 * more than all the pushes earlier pairs can give a body in one pass (each is
 * at most a piece's overlap, a few cells), so nothing that comes into contact
 * mid-pass is missed
 */
export const CONTACT_MARGIN = 256;

/** How far past a beam's width its broadphase looks: more than any ship moves in a tick (it's filed where it began the tick) */
export const BEAM_PAD = 120;

/** Bodies with more parts than this only have the pieces near what they touch put in world space (contacts) */
export const BIG_BODY = CONTACT_BIG_BODY;

/**
 * The bridge's private state (and, as later cuts need them, the private methods its modules call back through).
 * TypeScript keeps `private` members out of reach of functions outside the class, so modules see the bridge as a
 * BridgeCtx: the facade's public API plus these, each typed straight from the class (ShipBridge['host'] etc.) so
 * they can't drift. It is the same object as the ShipBridge (ShipBridge.ctx). Only ShipBridge.ts and bridge/*.ts use it.
 */
export interface BridgeInternals {
  host: ShipBridge['host']; now: ShipBridge['now']; geomCache: ShipBridge['geomCache'];
  lastHitBy: ShipBridge['lastHitBy']; anchored: ShipBridge['anchored']; pinned: ShipBridge['pinned'];
  charge: ShipBridge['charge']; autopilot: ShipBridge['autopilot']; blasts: ShipBridge['blasts'];
  decayAt: ShipBridge['decayAt']; intangible: ShipBridge['intangible']; crumbled: ShipBridge['crumbled'];
  lastDamaged: ShipBridge['lastDamaged']; restoreProgress: ShipBridge['restoreProgress']; contactFx: ShipBridge['contactFx'];
  joinCache: ShipBridge['joinCache']; empUntil: ShipBridge['empUntil']; warmth: ShipBridge['warmth'];
  burns: ShipBridge['burns']; weaponBeams: ShipBridge['weaponBeams']; pulsing: ShipBridge['pulsing'];
  pulseHit: ShipBridge['pulseHit']; apHeading: ShipBridge['apHeading']; controllers: ShipBridge['controllers'];
  dormant: ShipBridge['dormant']; lastFired: ShipBridge['lastFired']; damageMuls: ShipBridge['damageMuls'];
  wing: ShipBridge['wing']; targets: ShipBridge['targets']; kits: ShipBridge['kits'];
  ghosts: ShipBridge['ghosts']; underivable: ShipBridge['underivable']; lastThrough: ShipBridge['lastThrough']; coverMemo: ShipBridge['coverMemo'];
  beams: ShipBridge['beams']; pdList: ShipBridge['pdList']; pdOn: ShipBridge['pdOn'];
  ungridded: ShipBridge['ungridded']; castOn: ShipBridge['castOn']; castOk: ShipBridge['castOk'];
  gravityK: ShipBridge['gravityK'];
  markedUntil: ShipBridge['markedUntil']; slowedUntil: ShipBridge['slowedUntil']; salvos: ShipBridge['salvos'];
  guides: ShipBridge['guides']; ramps: ShipBridge['ramps']; beamStruck: ShipBridge['beamStruck'];
  // Private methods modules call back through
  fieldAt: ShipBridge['fieldAt'];
  rebuildNow: ShipBridge['rebuildNow']; markRebuild: ShipBridge['markRebuild']; rebuildMarked: ShipBridge['rebuildMarked']; syncHealth: ShipBridge['syncHealth']; cover: ShipBridge['cover'];
  fireWeapons: ShipBridge['fireWeapons']; stepMiners: ShipBridge['stepMiners']; pose: ShipBridge['pose'];
  alongBeam: ShipBridge['alongBeam']; nearSegment: ShipBridge['nearSegment']; castShip: ShipBridge['castShip'];
  coldStage: ShipBridge['coldStage']; fireBeam: ShipBridge['fireBeam'];
  stepPulses: ShipBridge['stepPulses']; damageMul: ShipBridge['damageMul'];
  beamFrom: ShipBridge['beamFrom'];
  noteRebuild: ShipBridge['noteRebuild']; spawnOn: ShipBridge['spawnOn']; removeBody: ShipBridge['removeBody'];
  forget: ShipBridge['forget']; nextMissing: ShipBridge['nextMissing']; joinsOf: ShipBridge['joinsOf'];
  spawnDebris: ShipBridge['spawnDebris'];
  closestPart: ShipBridge['closestPart']; partWorld: ShipBridge['partWorld']; nearestPart: ShipBridge['nearestPart'];
  readBody: ShipBridge['readBody']; writeBody: ShipBridge['writeBody']; bodiesNow: ShipBridge['bodiesNow'];
  withGravity: ShipBridge['withGravity']; worldPieces: ShipBridge['worldPieces']; resolveContacts: ShipBridge['resolveContacts'];
  damageContact: ShipBridge['damageContact']; contactScale: ShipBridge['contactScale']; stepBurns: ShipBridge['stepBurns'];
  stepRepairKits: ShipBridge['stepRepairKits']; decay: ShipBridge['decay']; repairStep: ShipBridge['repairStep'];
  partDeaths: ShipBridge['partDeaths']; applyBlast: ShipBridge['applyBlast']; autopilotControls: ShipBridge['autopilotControls'];
  stepPilotless: ShipBridge['stepPilotless']; aloof: ShipBridge['aloof'];
}

/** The bridge as its modules see it */
export type BridgeCtx = Pick<ShipBridge, keyof ShipBridge> & BridgeInternals;

/**
 * What a part feature's weapon hooks (features/types.ts ServerWeaponHooks) are given: the bridge itself, the same
 * object the bridge modules call back through. Named apart so the rule "only ShipBridge.ts and bridge/*.ts use the
 * bridge internals" (imports.test.ts) stays about the bridge's own files; a feature's hooks are run by the bridge's gun step.
 */
export type WeaponBridge = BridgeCtx;
