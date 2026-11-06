/**
 * ShipBridge: glue between the engine (bitecs world, GameServer systems) and the
 * shared, engine-agnostic ship logic in common/src/ships.
 *
 * GameServer calls into it at a handful of hook points (player created,
 * movement, weapons, spatial grid, projectile collision, end of tick). All ship
 * state lives in plain ShipState objects keyed by entity id; position,
 * velocity and angle stay in the engine's ECS components (Position = the
 * ship's centre of mass).
 */

import {
  Velocity, Blueprint, Catalog,
  ShipState, ShipTuning, PlacedGeom, Vec2, InventoryStub, ValidationResult,
  GravityWell, FlightConstants, type HitInfo, type WarmthStage, type JumpField, standing,
  WeaponInfo, WeaponTuning, ReplicaMode, FireRecord, type FlightBody, type Charge, type OwnExtras, dhypot, newAimHoldStats,
} from '@space-game/common';
import {
  STAGE_COVER, type ShipHost, type PartDestroyedEvent, type PilotOrders, type PendingBlast, type PendingSalvoShell,
  type ShipBridgeConfig, type ShipBridgeStats, type ContactPiece, type BridgeCtx,
} from './bridge/core.js';
import * as sync from './bridge/sync.js';
import * as rbd from './bridge/rebuild.js';
import * as wpn from './bridge/weapons.js';
import * as dmg from './bridge/damage.js';
import * as flt from './bridge/flight.js';
import * as plt from './bridge/pilotless.js';
import { DebrisNet } from './bridge/debrisNet.js';
import { StructLog } from './bridge/structLog.js';
import { OwnCauses } from './bridge/ownCauses.js';
import { ContactLog } from '../net/causes/contactLog.js';
import { ServerPulls } from './bridge/pullFields.js';

// (The engine interface, events and constants now live in bridge/core.ts; re-exported for everything that imports them from here)
export { STAGE_COVER };
export type { ShipHost, PartDestroyedEvent, PilotOrders, ShipBridgeConfig, ShipBridgeStats };

export class ShipBridge {
  readonly catalog: Catalog;
  readonly tuning: ShipTuning;
  readonly inventory: InventoryStub;
  /** Ships and debris, by entity id */
  readonly bodies = new Map<number, ShipState>();
  playerBlueprint: Blueprint;
  readonly library: Map<string, Blueprint>;
  readonly enemyDesigns: Record<string, Blueprint>;
  readonly devDesigns: Record<string, Blueprint>;
  readonly stats: ShipBridgeStats = { lastRebuildMs: 0, rebuildCount: 0, debrisCount: 0, aimHold: newAimHoldStats() };
  /**
   * What each body flew with this tick (replication: the server's shadow of each
   * ship replays exactly this, with the structure the step used)
   */
  readonly replicaCtl = new Map<number, { mode: ReplicaMode; bits: number; q: number; derived: ShipState['derived']; body?: PilotOrders['body']; rawQ?: number; heldQ?: number }>();
  /** What moved each pilot's ship this tick besides its controls (CAPS.OWN_SIM: Replication hands them to its client as causes) */
  readonly ownCauses = new OwnCauses();
  /** Each tick's contact pass as a client finding its own pairs needs it (CAPS.CONTACTS: net/causes/contactLog.ts) */
  readonly contactLog = new ContactLog();
  /**
   * Pull fields the moves declare (a magnet, a reel, a collapsing star: bridge/pullFields.ts): its pilots' steps take
   * their pulls from them (stepMovement), as every client's steps do from the records it is sent
   */
  readonly pulls = new ServerPulls((e) => this.bodies.has(e), (e) => this.host?.terrainAt?.(e));
  /** Repair kits only work on a ship holding still (world units per tick) */
  static readonly KIT_STILL_SPEED = 0.8;
  /** Shots fired since the last snapshot (sent as fire events: see launch.ts); the server clears it */
  readonly fired: FireRecord[] = [];

  /** This bridge as its modules (bridge/*.ts) see it, private state included (bridge/core.ts BridgeCtx) */
  private readonly ctx: BridgeCtx = this as unknown as BridgeCtx;
  private host!: ShipHost;
  private now: () => number;
  private geomCache = new WeakMap<Blueprint, PlacedGeom[]>();
  /** Who last landed a shot on each body */
  private lastHitBy = new Map<number, number>();
  /** The tick of each body's last hit with a source (lastHitBy's tick: a sourceless hurt, a hazard's, leaves it) */
  private lastHitAt = new Map<number, number>();
  /** Wrecks: they drift (no gravity, no helm) instead of holding station like dummies */
  private anchored = new Set<number>();
  /** Structures fixed to the ground (a siege's bastion and turrets): nothing shoves them; they only turn */
  private pinned = new Map<number, { x: number; y: number }>();
  /** Every ship's battery charge (energy.ts; absent: full). Players' total is mirrored to Boost.fuel for the HUD */
  private charge = new Map<number, Charge>();
  /** Pilotless ships flying somewhere: the point each is heading for */
  private autopilot = new Map<number, { x: number; y: number; arriveRadius: number }>();
  /** Destroyed parts that blow up a few ticks later (chain reactions) */
  private blasts: PendingBlast[] = [];
  /** Debris: the tick each part crumbles away, by part index */
  private decayAt = new Map<number, number[]>();
  /** Parts that just crumbled (decay, not damage): they don't blow up */
  private crumbled = new Set<string>();
  /** Last tick each body took damage (station repair waits a while after) */
  private lastDamaged = new Map<number, number>();
  /** Ticks of progress towards regrowing the next missing part */
  private restoreProgress = new Map<number, number>();
  /** Last contact effect per pair of bodies */
  private contactFx = new Map<string, number>();
  /** Debris clients work out themselves: splits to tell, spawn checks, what moved otherwise (bridge/debrisNet.ts) */
  readonly debrisNet = new DebrisNet();
  /** Debris that's only to be seen (a boss blowing apart): nothing hits it, it hits nothing, shots and blasts pass through (the debris bookkeeping's set: a piece's sync says so) */
  private intangible = this.debrisNet.intangible;
  /** Each ship's structures after its last few rebuild ticks, for clients keeping each (CAPS.STRUCTS, bridge/structLog.ts) */
  readonly structLog = new StructLog();
  private joinCache = new WeakMap<Blueprint, [number, number][]>();
  /** EMP'd ships: engines and guns dead until this tick */
  private empUntil = new Map<number, number>();
  /**
   * Warmth, 0 (frozen through) to 1 (warm; not kept): the cold builds it down (server/src/game/Warmth.ts steps it),
   * frost hits take it off, and frozen through a ship seizes up (common/src/ships/warmth.ts)
   */
  private warmth = new Map<number, number>();
  /** Marked ships (a Searchlight's beam, features/weaponry): they take MARK_TAKEN × every hit until this tick */
  private markedUntil = new Map<number, number>();
  /** Slowed ships (a Frostbite's beam, features/weaponry): thrust and turning × SLOW_CONTROL until this tick */
  private slowedUntil = new Map<number, number>();
  /** Walking salvos under way, per ship: the shells still to fire (bridge/weapons.ts stepSalvos) */
  private salvos = new Map<number, PendingSalvoShell[]>();
  /** Where each ship's guns aimed on the last tick they stepped, and whether the trigger was held (guided shells steer to it) */
  private guides = new Map<number, { tick: number; held: boolean; x: number; y: number }>();
  /** A ramping beam's run on one part, per ship and gun (key = ship * 1024 + part): the part it is on, the ticks it has burned there, its last tick (fireBeam) */
  private ramps = new Map<number, { target: number; ticks: number; last: number }>();
  /** The ship the last damaging beam tick burned (fireBeam; -1 none): a marking or slowing beam's role reads it */
  private beamStruck = -1;
  /** Burning parts (incendiary hits): damage over time, spreading to neighbours as parts go */
  private burns: { eid: number; part: number; until: number; dps: number; radius: number; source: number; hit?: HitInfo }[] = [];
  /** Weapon beams on this tick, per ship: how far along the nearest one hit (0..1) */
  private weaponBeams = new Map<number, number>();
  /** Pulse lasers mid-pulse, per ship: which part, and the tick its pulse started (common/src/ships/pulse.ts) */
  private pulsing = new Map<number, { part: number; start: number; hit?: { eid: number; dealt: number } }[]>();
  /** What the last pulse tick burned (fireBeam), so a pulse's damage is told as one number */
  private pulseHit: { eid: number; dealt: number } | null = null;
  /** Autopilot headings, held steady until they drift a little (fewer control changes to send) */
  private apHeading = new Map<number, number>();
  /** AI pilots: pilotless ships flown by a controller */
  private controllers = new Map<number, (eid: number, ship: ShipState) => PilotOrders | null>();
  /**
   * Distant ships (SimLod.ts): far from every pilot, they're out of the whole
   * pipeline (no controller, flight, guns, shields, contacts, hits); SimLod
   * moves them along what they're doing, cheaply. The tick each went to sleep.
   */
  private dormant = new Map<number, number>();
  /** Last tick each ship fired anything (a ship still shooting isn't put to sleep) */
  private lastFired = new Map<number, number>();
  /** Damage multipliers: boss rage, factions' weak guns (pilots' skills no longer add damage) */
  private damageMuls = new Map<number, number>();
  /** Flying in a wing (party members close by): a damage multiplier on top */
  private wing = new Map<number, number>();
  /** The target each player has selected (missiles lock on to it) */
  private targets = new Map<number, number>();
  /** Repair kits: a budget of credits spent slowly on the ship, damaged parts first, then missing ones */
  private kits = new Map<number, { left: number; total: number; hpPerSec: number; restoreTicks: number; progress: number; since: number }>();
  /** Parts designed but not built yet, by ship (part indices): absent, and never regrown by station repair */
  private ghosts = new Map<number, Set<number>>();
  /** Ships marked for a rebuild whose pieces breaking off aren't for clients to work out (shed whole): bridge/rebuild.ts markRebuild */
  private underivable = new Set<number>();
  /**
   * Pushes on pilots made while the pilotless ships step (a boss's or a custom enemy's pull), applied once they all have:
   * a body reads its target before that tick's pulls (bodies/, ShipReplicaSet.preAt), so a ship stepping after the one
   * that pulled reads it as unpulled, as its clients do (bridge/flight.ts push)
   */
  private pushQueue: [number, number, number][] | null = null;
  /** How much of the last hit got through the armour it struck (hitMultiplier): under GLANCING it shows as glancing */
  private lastThrough = 1;
  /** While a splash hurts one body's parts (all from the point `at`): the part cover last sent a hit to, and in what stage */
  private coverMemo: { ship: ShipState; at: Vec2; first: number; best: number } | null = null;
  /** Mining beam state per ship, for the snapshot: on, and how far along the beam it hit */
  private beams = new Map<number, number>();
  /** Point defence's shots in reach this tick (reused), and what each turret is on (ship -> part -> shot) */
  private pdList: { id: number; x: number; y: number; d: number }[] = [];
  private pdOn = new Map<number, Map<number, number>>();
  /** Bodies spawned or moved instantly since the broadphase was last filed (addToSpatialGrid) */
  private ungridded = new Set<number>();
  /** The ship being cast against (castShip's standing test, without a closure per call) */
  private castOn: ShipState | null = null;
  private readonly castOk = (i: number): boolean => standing(this.catalog, this.castOn!, i);
  /** Flight constants with a system's gravity, built once per gravity (it's data: it never changes) */
  private gravityK = new WeakMap<GravityWell, FlightConstants>();

  constructor(cfg: ShipBridgeConfig) {
    this.catalog = cfg.catalog;
    this.tuning = cfg.tuning;
    this.playerBlueprint = cfg.starterBlueprint;
    this.inventory = cfg.inventory;
    this.library = new Map(Object.entries(cfg.library ?? {}));
    this.enemyDesigns = cfg.enemies ?? {};
    this.devDesigns = cfg.dev ?? {};
    this.now = cfg.now ?? (() => 0);
  }

  attach(host: ShipHost): void {
    this.host = host;
  }

  has(eid: number): boolean {
    return this.bodies.has(eid);
  }

  get(eid: number): ShipState | undefined {
    return this.bodies.get(eid);
  }

  /** Is this ship holding still enough to use a repair kit? */
  isStill(eid: number): boolean {
    return dhypot(Velocity.x[eid], Velocity.y[eid]) <= ShipBridge.KIT_STILL_SPEED;
  }

  // -------------------------------------------------------------------------
  // Flight (bridge/flight.ts): movement, the end-of-tick step, contacts, the broadphase, sleep and wake
  // -------------------------------------------------------------------------

  isDormant(eid: number): boolean { return flt.isDormant(this.ctx, eid); }

  /** Distant ships, and when each went to sleep */
  dormantShips(): ReadonlyMap<number, number> { return flt.dormantShips(this.ctx); }

  isPinned(eid: number): boolean { return flt.isPinned(this.ctx, eid); }

  isAnchored(eid: number): boolean { return flt.isAnchored(this.ctx, eid); }

  /**
   * Why this ship can't go distant now (null: it can): a pilot's, debris, in
   * the middle of something (hurt or shooting lately, EMP'd, burning, under
   * repair, a blast of its own pending, mid-jump, docked)
   */
  sleepBlocker(eid: number, recentTicks: { damaged: number; fired: number }): string | null { return flt.sleepBlocker(this.ctx, eid, recentTicks); }

  /** Take a pilotless ship out of the pipeline (SimLod moves it from now on). False if it can't go now. */
  sleep(eid: number, recentTicks = { damaged: 600, fired: 300 }): boolean { return flt.sleep(this.ctx, eid, recentTicks); }

  /**
   * Back into the pipeline: what went on while it slept is caught up (guns'
   * cooldowns and heat, its shield, its battery), and it carries on from where
   * SimLod left it (position, velocity, heading), with every part as it was.
   */
  wake(eid: number): void { return flt.wake(this.ctx, eid); }

  /** Where SimLod has a distant ship now (rounded as every body is: what clients would be sent) */
  moveDistant(eid: number, b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number }): void { return flt.moveDistant(this.ctx, eid, b); }

  /** Move a ship instantly (boss blinks) */
  teleport(eid: number, x: number, y: number): void { return flt.teleport(this.ctx, eid, x, y); }

  /**
   * A pull on a body's velocity that no pull field says (a pull on an AI ship; a Grapple gem's shell on anything). A
   * pilot's is put on the PULL grid and told to its clients as a cause: they can't work it out (network/ownTick.ts
   * PULL). A pull on a pilot from a body or a parked star is a field instead (`pulls`, bridge/pullFields.ts)
   */
  push(eid: number, ax: number, ay: number): void { return flt.push(this.ctx, eid, ax, ay); }

  /** Is this a pilot's ship (a pull field reaches it: `pulls`) */
  isPilot(eid: number): boolean { return flt.isPilot(this.ctx, eid); }

  /** Fix a pilotless ship where it stands (or free it): rams and blasts no longer move it */
  pin(eid: number, on = true): void { return flt.pin(this.ctx, eid, on); }

  /** Player movement. Returns false for non-ship entities so the legacy path runs. */
  stepMovement(eid: number): boolean { return flt.stepMovement(this.ctx, eid); }

  /** A pilot's stores, guns, hazards and priming as tick `tick` ended, as its own client steps them (a copy; null: no ship) */
  ownExtras(eid: number, tick: number): OwnExtras | null { return flt.ownExtras(this.ctx, eid, tick); }

  addToSpatialGrid(add: (eid: number, x: number, y: number, r: number) => void): void { return flt.addToSpatialGrid(this.ctx, add); }

  /**
   * The bodies as they are now, for a loop that may add or remove some: their ids and states as two lists (and 0, to
   * count from), rather than a pair for each (that was most of what such a loop cost)
   */
  private bodiesNow(): [number[], ShipState[], number] { return flt.bodiesNow(this.ctx); }

  /** End of tick: pilotless motion, contacts, rebuilds, detachment, debris lifetime, health sync. */
  tick(): void { return flt.tick(this.ctx); }

  private withGravity(gravity: GravityWell): FlightConstants { return flt.withGravity(this.ctx, gravity); }

  /**
   * World-space convex pieces of every alive part (shrunk, so parts that merely
   * touch don't collide), each with its bounding box
   */
  private worldPieces(eid: number, ship: ShipState, near?: { x: number; y: number; r: number }): ContactPiece[] { return flt.worldPieces(this.ctx, eid, ship, near); }

  /**
   * Push overlapping bodies apart, exchange an impulse along the contact
   * normal, and damage the touching parts on both sides when the closing speed
   * is high enough (scaled by the other body's share of the mass).
   *
   * Pairs are found by system, swept along x (bounding circles, padded by
   * CONTACT_MARGIN for the pushes earlier pairs make this pass), then taken in
   * the same order as testing every pair would. Pieces are only tested against
   * pieces whose bounding boxes they meet: the rest can't overlap.
   */
  private resolveContacts(): void { return flt.resolveContacts(this.ctx); }

  /** Every live piece of debris, one tick: drift, then push-only knocks among debris, in id order (common ships/debris.ts) */
  stepDebrisWorld(ids: readonly number[]): void { this.debrisNet.step(this.ctx, ids); }

  private damageContact(eid: number, ship: ShipState, parts: Set<number>, amount: number, source: number): void { return flt.damageContact(this.ctx, eid, ship, parts, amount, source); }

  /** How hard a collision lands on a part: its piece's `contact` share, doubled for brittle material */
  private contactScale(ship: ShipState, part: number): number { return flt.contactScale(this.ctx, ship, part); }

  // -------------------------------------------------------------------------
  // Pilotless (bridge/pilotless.ts): AI pilots, the autopilot, the pilotless step
  // -------------------------------------------------------------------------

  hasController(eid: number): boolean { return plt.hasController(this.ctx, eid); }

  /** Where its autopilot is taking it (null: none) */
  autopilotOf(eid: number): { x: number; y: number; arriveRadius: number } | null { return plt.autopilotOf(this.ctx, eid); }

  /** The heading its autopilot last steered by (undefined: none yet): what it flew with, as its replicas have it, is that on the aim grid */
  autopilotHeading(eid: number): number | undefined { return this.apHeading.get(eid); }

  /** Give a pilotless ship an AI pilot (null: none) */
  setController(eid: number, fn: ((eid: number, ship: ShipState) => PilotOrders | null) | null): void { return plt.setController(this.ctx, eid, fn); }

  /** Fly a pilotless ship towards a point (null: stop and hold). */
  setAutopilot(eid: number, target: { x: number; y: number; arriveRadius?: number } | null): void { return plt.setAutopilot(this.ctx, eid, target); }

  /**
   * Autopilot controls: turn to face the target, thrust when roughly facing it,
   * and cut the engines in time to coast to a stop at the arrival radius.
   */
  private autopilotControls(eid: number, target: { x: number; y: number; arriveRadius: number }) { return plt.autopilotControls(this.ctx, eid, target); }

  /** One end-of-tick step of a pilotless ship (tick) */
  private stepPilotless(eid: number, ship: ShipState, k: FlightConstants, tick: number): void { return plt.stepPilotless(this.ctx, eid, ship, k, tick); }

  // -------------------------------------------------------------------------
  // Weapons (bridge/weapons.ts): firing, beams, point defence, casts, projectile hits, targets, damage scaling
  // -------------------------------------------------------------------------

  lastFiredTick(eid: number): number { return wpn.lastFiredTick(this.ctx, eid); }

  setDamageScale(eid: number, k: number): void { return wpn.setDamageScale(this.ctx, eid, k); }

  setWingBonus(eid: number, k: number): void { return wpn.setWingBonus(this.ctx, eid, k); }

  wingBonus(eid: number): number { return wpn.wingBonus(this.ctx, eid); }

  private damageMul(eid: number): number { return wpn.damageMul(this.ctx, eid); }
  /** Its shells' damage multiplier (a boss's damage and rage: setDamageScale), as its syncs tell clients (`dmg`) */
  damageMulOf(eid: number): number { return wpn.damageMul(this.ctx, eid); }

  setTarget(eid: number, target: number): void { return wpn.setTarget(this.ctx, eid, target); }

  /** A player's selected target, if it's still there and in the same system */
  targetOf(eid: number): number { return wpn.targetOf(this.ctx, eid); }

  nearestTarget(eid: number, x: number, y: number, range: number, filter?: (other: number) => boolean, hull = false): number { return wpn.nearestTarget(this.ctx, eid, x, y, range, filter, hull); }

  stepWeapons(eid: number): boolean { return wpn.stepWeapons(this.ctx, eid); }

  /** Where a ship's guns aimed and whether its trigger was held, if they stepped this tick or the last (a guided shell steers to it) */
  guideOf(eid: number, tick: number): { held: boolean; x: number; y: number } | undefined { return wpn.guideOf(this.ctx, eid, tick); }

  private stepMiners(eid: number, ship: ShipState, on: boolean, aimWorld: number, aimDist: number): void { return wpn.stepMiners(this.ctx, eid, ship, on, aimWorld, aimDist); }

  private fireWeapons(eid: number, ship: ShipState, firing: boolean, aimWorld?: number, aimDist = 0, target = -1, energy?: { charge: Charge }, hold = false): void { return wpn.fireWeapons(this.ctx, eid, ship, firing, aimWorld, aimDist, target, energy, hold); }

  /** Each pulse under way burns its tick's share along its gun's aim, as wide as its curve says; done, it's dropped */
  private stepPulses(eid: number, ship: ShipState, tick: number): void { return wpn.stepPulses(this.ctx, eid, ship, tick); }

  private fireBeam(eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, pulse?: { damage: number; width: number }): number { return wpn.fireBeam(this.ctx, eid, ship, w, def, pulse); }

  /** A beam's muzzle (world) and angle, along its gun's aim */
  private beamFrom(eid: number, ship: ShipState, w: WeaponInfo): { x: number; y: number; angle: number } { return wpn.beamFrom(this.ctx, eid, ship, w); }



  private alongBeam(systemNum: number, x0: number, y0: number, x1: number, y1: number, half: number): Iterable<number> { return wpn.alongBeam(this.ctx, systemNum, x0, y0, x1, y1, half); }

  /**
   * Projectile vs ship parts. The engine's broadphase gives `nearby`; each
   * candidate ship is tested part by part in its local grid space, and the
   * first part the segment touches takes the damage.
   */
  hitProjectile(
    proj: number, ownerId: number, x0: number, y0: number, x1: number, y1: number,
    nearby: { id: number }[], exclude?: Set<number>, radius = 0,
  ): { eid: number; x: number; y: number; part: number } | null {
    return wpn.hitProjectile(this.ctx, proj, ownerId, x0, y0, x1, y1, nearby, exclude, radius);
  }

  /** Does a world-space segment come within a ship's bounding circle (segmentHit's first test) */
  private nearSegment(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): boolean { return wpn.nearSegment(this.ctx, eid, ship, x0, y0, x1, y1, margin); }

  segmentHit(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null { return wpn.segmentHit(this.ctx, eid, ship, x0, y0, x1, y1, margin); }

  /** segmentHit without its bounding-circle test (for callers that have just made it) */
  private castShip(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null { return wpn.castShip(this.ctx, eid, ship, x0, y0, x1, y1, margin); }

  private cover(ship: ShipState, part: number, at?: Vec2): number { return wpn.cover(this.ctx, ship, part, at); }

  /** The ship part under a world point (debug key K). */
  partAt(x: number, y: number): { eid: number; part: number } | null { return wpn.partAt(this.ctx, x, y); }

  damagePartFraction(eid: number, part: number, fraction: number): void { return wpn.damagePartFraction(this.ctx, eid, part, fraction); }

  // -------------------------------------------------------------------------
  // Damage (bridge/damage.ts): hits, EMP and cold, fire, nearest-part queries, hp edits, ghosts, part deaths, blasts
  // -------------------------------------------------------------------------

  /** Seize a ship up (as an EMP) for `ticks`: hazards' storms */
  emp(eid: number, ticks: number): void { return dmg.emp(this.ctx, eid, ticks); }

  /** A frost hit landed (a gemmed gun, the Brood Mother's cold): it takes `amount` of warmth, less what the hull keeps out; frozen through, the ship seizes up for `ticks` */
  frostHit(eid: number, amount: number, ticks: number): void { return dmg.frostHit(this.ctx, eid, amount, ticks); }

  /** A ship's warmth (0 frozen through .. 1 warm) */
  warmthOf(eid: number): number { return dmg.warmthOf(this.ctx, eid); }

  /** Ships that aren't fully warm */
  chilled(): IterableIterator<number> { return dmg.chilled(this.ctx); }

  warm(eid: number, delta: number, seizeTicks: number): void { return dmg.warm(this.ctx, eid, delta, seizeTicks); }

  /** What the cold costs a pilot's ship now (others aren't slowed: the meter only seizes them up) */
  private coldStage(eid: number): WarmthStage { return dmg.coldStage(this.ctx, eid); }

  /** Hull left, as a fraction of the ship's full HP (every part counted) */
  integrity(eid: number): number { return dmg.integrity(this.ctx, eid); }

  /** Mark these parts (uids) as not built yet */
  setGhosts(eid: number, uids: number[]): void { return dmg.setGhosts(this.ctx, eid, uids); }

  isGhost(eid: number, part: number): boolean { return dmg.isGhost(this.ctx, eid, part); }

  /** A ghost part arrived: build it in at full HP */
  installGhost(eid: number, uid: number): boolean { return dmg.installGhost(this.ctx, eid, uid); }

  /** Make a ship tougher (elite enemies): every part's max HP × k, at full HP */
  scaleHp(eid: number, k: number): void { return dmg.scaleHp(this.ctx, eid, k); }
  /** Every part's most HP set outright (a custom enemy's pieces), at full HP */
  setMaxHp(eid: number, hp: readonly number[]): void { return dmg.setMaxHp(this.ctx, eid, hp); }

  /** Toughen one function's parts (a boss's core) by `k` */
  hardenParts(eid: number, fn: string, k: number): void { return dmg.hardenParts(this.ctx, eid, fn, k); }

  /** Core HP as a fraction of its max (0 when lost) */
  coreFraction(eid: number): number { return dmg.coreFraction(this.ctx, eid); }

  setPartHp(eid: number, fraction: (uid: number) => number): void { return dmg.setPartHp(this.ctx, eid, fraction); }

  /** Heal every intact part by a fraction of its max HP (repair kits) */
  healAll(eid: number, fraction: number): void { return dmg.healAll(this.ctx, eid, fraction); }

  lastHitter(eid: number): number { return dmg.lastHitter(this.ctx, eid); }

  lastDamagedTick(eid: number): number { return dmg.lastDamagedTick(this.ctx, eid); }

  lastHitTick(eid: number): number { return dmg.lastHitTick(this.ctx, eid); }

  hurt(eid: number, ship: ShipState, part: number, amount: number, source = -1, vs?: { splash?: boolean; shield?: number; hull?: number; hit?: HitInfo; at?: Vec2; bane?: { faction: string; damage: number } }): number { return dmg.hurt(this.ctx, eid, ship, part, amount, source, vs); }

  /** Damage one part from outside the usual weapons (a boss's beam): hurt, and reported as any hit is */
  damagePartBy(eid: number, part: number, amount: number, source: number, hit?: HitInfo): number { return dmg.damagePartBy(this.ctx, eid, part, amount, source, hit); }

  /** Mark a ship for `ticks` (a Searchlight's beam): it takes MARK_TAKEN × every hit, from everyone */
  mark(eid: number, ticks: number): void { return dmg.mark(this.ctx, eid, ticks); }

  /** Slow a ship for `ticks` (a Frostbite's beam): thrust and turning × SLOW_CONTROL, as its replicas fly it (CTL.slowed) */
  slow(eid: number, ticks: number): void { return dmg.slow(this.ctx, eid, ticks); }

  /** Ticks it stays marked (0: it isn't) */
  markedTicksLeft(eid: number): number { return dmg.markedTicksLeft(this.ctx, eid); }

  /** Ticks it stays slowed (0: it isn't), so the pilot's prediction flies it slowed exactly as long */
  slowedTicksLeft(eid: number): number { return dmg.slowedTicksLeft(this.ctx, eid); }

  /** Is this ship's electronics knocked out by an EMP? */
  isEmped(eid: number): boolean { return dmg.isEmped(this.ctx, eid); }

  /** How many more ticks it stays knocked out (0: it isn't), so the pilot's prediction drifts exactly as long as the server does */
  empTicksLeft(eid: number): number { return dmg.empTicksLeft(this.ctx, eid); }

  splashAt(systemNum: number, x: number, y: number, radius: number, damage: number, source: number, hit?: HitInfo, overhead?: Vec2): void { return dmg.splashAt(this.ctx, systemNum, x, y, radius, damage, source, hit, overhead); }

  /** An EMP burst: ships in range lose engines and guns for `ticks` (shields halve it) */
  empAt(systemNum: number, x: number, y: number, radius: number, ticks: number, source: number): number[] { return dmg.empAt(this.ctx, systemNum, x, y, radius, ticks, source); }

  ignite(eid: number, x: number, y: number, dps: number, ticks: number, radius: number, source: number, hit?: HitInfo, struck = -1): number { return dmg.ignite(this.ctx, eid, x, y, dps, ticks, radius, source, hit, struck); }

  /** Parts on fire now (for the snapshot effects): [body, part] pairs */
  burning(): { eid: number; part: number }[] { return dmg.burning(this.ctx); }

  /** The intact part whose real outline is nearest a world point (-1: none) */
  private closestPart(eid: number, ship: ShipState, x: number, y: number): number { return dmg.closestPart(this.ctx, eid, ship, x, y); }

  hullDistance(eid: number, x: number, y: number, within = Infinity): number { return dmg.hullDistance(this.ctx, eid, x, y, within); }

  /** The middle of the standing part nearest a world point by its outline (where an arc strikes), or null */
  nearestPartPoint(eid: number, x: number, y: number): Vec2 | null { return dmg.nearestPartPoint(this.ctx, eid, x, y); }

  /** The part a straight shot from (x0, y0) at a ship's centre strikes first (a station's turret), else the one nearest (x0, y0); -1 if none */
  partFacing(eid: number, x0: number, y0: number): number { return dmg.partFacing(this.ctx, eid, x0, y0); }

  private nearestPart(eid: number, ship: ShipState, x: number, y: number, exclude = -1): number { return dmg.nearestPart(this.ctx, eid, ship, x, y, exclude); }

  private stepBurns(tick: number): void { return dmg.stepBurns(this.ctx, tick); }

  private partDeaths(eid: number, ship: ShipState, tick: number): boolean { return dmg.partDeaths(this.ctx, eid, ship, tick); }

  /** Damage every intact part within the blast radius (any body), falling off with distance. */
  private applyBlast(b: PendingBlast): void { return dmg.applyBlast(this.ctx, b); }

  // -------------------------------------------------------------------------
  // Rebuild (bridge/rebuild.ts): geometry, spawning, removal, rebuilds, debris, repair kits and station repair
  // -------------------------------------------------------------------------

  geometry(ship: ShipState): PlacedGeom[] { return rbd.geometry(this.ctx, ship); }

  private spawnOn(eid: number, bp: Blueprint, kind: 'ship' | 'debris', hp?: number[], angVel = 0): ShipState { return rbd.spawnOn(this.ctx, eid, bp, kind, hp, angVel); }

  onPlayerCreated(eid: number): void { return rbd.onPlayerCreated(this.ctx, eid); }

  /** A pilotless ship (debug key B). Returns its entity id. */
  spawnDummy(bp: Blueprint, x: number, y: number, angle: number, systemId = 0): number { return rbd.spawnDummy(this.ctx, bp, x, y, angle, systemId); }

  spawnWreck(bp: Blueprint, x: number, y: number, angle: number, systemId: number, seed: number): number { return rbd.spawnWreck(this.ctx, bp, x, y, angle, systemId, seed); }

  setSkills(eid: number, _skills: Record<string, number>): void { return rbd.setSkills(this.ctx, eid, _skills); }

  removeShip(eid: number): void { return rbd.removeShip(this.ctx, eid); }

  private forget(eid: number): void { return rbd.forget(this.ctx, eid); }

  /** Is there anything a repair kit could do for this ship? */
  needsRepair(eid: number): boolean { return rbd.needsRepair(this.ctx, eid); }

  /** Start a kit (another one adds to the budget and keeps the faster rate) */
  startRepairKit(eid: number, kit: { budget: number; hpPerSec: number; restoreSec: number }): void { return rbd.startRepairKit(this.ctx, eid, kit); }

  repairKitLeft(eid: number): number { return rbd.repairKitLeft(this.ctx, eid); }

  private stepRepairKits(tick: number): void { return rbd.stepRepairKits(this.ctx, tick); }

  /** The missing part (not a ghost) that joins the structure, nearest the core */
  private nextMissing(eid: number, ship: ShipState): number { return rbd.nextMissing(this.ctx, eid, ship); }

  validate(bp: Blueprint, opts: { mounting?: boolean } = {}): ValidationResult { return rbd.validate(this.ctx, bp, opts); }

  /** Hangar save: swap the ship's blueprint and respawn in place at full HP. */
  respawnInPlace(eid: number, bp: Blueprint): void { return rbd.respawnInPlace(this.ctx, eid, bp); }

  /** Proto debug key U. */
  repair(eid: number): void { return rbd.repair(this.ctx, eid); }

  /** Joins between every part of a blueprint, intact or not (where missing parts would reattach) */
  private joinsOf(ship: ShipState): [number, number][] { return rbd.joinsOf(this.ctx, ship); }

  private partWorld(eid: number, ship: ShipState, part: number): Vec2 { return rbd.partWorld(this.ctx, eid, ship, part); }

  private decay(eid: number, ship: ShipState, tick: number): void { return rbd.decay(this.ctx, eid, ship, tick); }

  private repairStep(eid: number, ship: ShipState, tick: number): void { return rbd.repairStep(this.ctx, eid, ship, tick); }

  private noteRebuild(t0: number): void { return rbd.noteRebuild(this.ctx, t0); }

  private rebuildNow(eid: number, ship: ShipState, derivable = true): void { return rbd.rebuildNow(this.ctx, eid, ship, derivable); }

  /** Rebuild at the tick's one rebuild point (tick step 3), however many things asked for it: bridge/rebuild.ts */
  private markRebuild(eid: number, ship: ShipState, derivable = true): void { return rbd.markRebuild(this.ctx, eid, ship, derivable); }

  /** (Dev tools moving a fight on outside the tick) rebuild now what's marked, as a tick would: bridge/rebuild.ts */
  settle(eid: number): void { return rbd.settle(this.ctx, eid); }

  /** The tick's rebuild point: every ship marked since the last, rebuilt once (bridge/rebuild.ts) */
  private rebuildMarked(eid: number, ship: ShipState): void { return rbd.rebuildMarked(this.ctx, eid, ship); }

  shed(eid: number, groups: number[][], fling = 0, crumble = 0, intangible = false): void { return rbd.shed(this.ctx, eid, groups, fling, crumble, intangible); }

  /** A connected group of parts leaves `ship` as a new debris body built from the same parts and HP. */
  private spawnDebris(parentEid: number, ship: ShipState, group: number[], parentCom: Vec2, pose: { x: number; y: number; angle: number }, k: number, fling = 0, crumble = 0): number { return rbd.spawnDebris(this.ctx, parentEid, ship, group, parentCom, pose, k, fling, crumble); }

  private removeBody(eid: number): void { return rbd.removeBody(this.ctx, eid); }

  // -------------------------------------------------------------------------
  // Sync (bridge/sync.ts): body and health sync, jump fields, Tow Beam glue, snapshot readers
  // -------------------------------------------------------------------------

  /** A ship's battery charge (energy.ts) */
  chargeOf(eid: number): Charge { return sync.chargeOf(this.ctx, eid); }

  /** Set it (a player's total is mirrored to Boost.fuel, which the HUD's gauge reads) */
  setCharge(eid: number, c: Charge): void { return sync.setCharge(this.ctx, eid, c); }

  /** Weapon beam state for the snapshot */
  weaponBeamState(eid: number): { on: boolean; hit: number } { return sync.weaponBeamState(this.ctx, eid); }

  /** Shield charge 0..1 for the snapshot (0 also without a shield) */
  shieldFraction(eid: number): number { return sync.shieldFraction(this.ctx, eid); }

  beamState(eid: number): { on: boolean; hit: number } { return sync.beamState(this.ctx, eid); }

  private syncHealth(eid: number, ship: ShipState): void { return sync.syncHealth(eid, ship); }

  private pose(eid: number) { return sync.pose(eid); }

  private readBody(eid: number, ship: ShipState): FlightBody { return sync.readBody(eid, ship); }

  /** Jump range multiplier where this ship is (a star's ring, or a lodestone's priming) */
  jumpBoost(eid: number): number { return sync.jumpBoost(this.ctx, eid); }

  /** The charging fields where this ship is now */
  private fieldAt(eid: number): JumpField { return sync.fieldAt(this.ctx, eid); }

  /** For the pilot's snapshot: 1 = in a star's charging ring, 2 = in a lodestone's field (bits), and the priming left */
  jumpFieldState(eid: number): { flags: number; prime: number } { return sync.jumpFieldState(this.ctx, eid); }

  // ---- Tow Beam (ships/features/tow/Towing.ts; common/src/ships/features/tow/tow.ts)
  /** What a Tow Beam can take hold of: debris you can touch, or a derelict wreck (never a working ship); null otherwise */
  towable(eid: number): { kind: 'wreck' | 'debris'; mass: number; radius: number } | null { return sync.towable(this.ctx, eid); }
  /** Towable bodies in a system within `r` of (x, y) */
  towablesNear(systemNum: number, x: number, y: number, r: number): number[] { return sync.towablesNear(this.ctx, systemNum, x, y, r); }
  /** Being towed: debris neither crumbles nor goes while a beam holds it */
  holdTowed(eid: number): void { return sync.holdTowed(this.ctx, eid); }
  // ---- (end Tow Beam)

  /** Mid-jump (the burn itself): no guns, and the ship passes through other hulls */
  isJumping(ship: ShipState): boolean { return sync.isJumping(this.ctx, ship); }

  private writeBody(eid: number, ship: ShipState, b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number; jump?: number; jumpScale?: number; jumpAim?: number; jumpTo?: number; cargo?: number; dodge?: number; dodgeDir?: number }): void { return sync.writeBody(eid, ship, b); }

  worldToGrid(eid: number, ship: ShipState, x: number, y: number): Vec2 { return sync.worldToGrid(this.ctx, eid, ship, x, y); }
}
