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

import { collideTerrain, terrainRadius } from '@space-game/common';
import { hasComponent, entityExists } from 'bitecs';
import {
  Position, Velocity, Rotation, Input, Boost, Player, Dead, Projectile, InSystem, FRICTION, Blueprint, Catalog,
  ShipState, ShipTuning, PlacedGeom, Vec2, InventoryStub, stepShipPhysics, quantizeShipBody, ValidationResult,
  GravityWell, FlightConstants, damagePart, hitMultiplier, type HitInfo, stepFlight, stepDrift, withEmp, withNumb,
  type WarmthStage, jumpTuning, pilotJumpStep, NO_FIELDS, type JumpField, blueprintGeometry, standing,
  convexPenetration, WeaponInfo, WeaponTuning, ReplicaMode, CTL, controlBits, replicaAngle, quantizeReplicaAngle,
  partWeaponDef, FireRecord, partMaterial, powerTick, gunLoad, quantizeCargo, type FlightBody, buildFlightInputs,
  newFlightControls, type FlightInputSource, chargeTotal, FULL_CHARGE, type Charge,
} from '@space-game/common';
import {
  GLANCING, STAGE_COVER, K, centroidOf, CONTACT_MARGIN, BIG_BODY, type ShipHost, type PartDestroyedEvent,
  type PilotOrders, type PendingBlast, type ShipBridgeConfig, type ShipBridgeStats, type ContactPiece,
  type BridgeCtx,
} from './bridge/core.js';
import * as sync from './bridge/sync.js';
import * as rbd from './bridge/rebuild.js';
import * as wpn from './bridge/weapons.js';
import * as dmg from './bridge/damage.js';

// (The engine interface, events and constants now live in bridge/core.ts; re-exported for everything that imports them from here)
export { STAGE_COVER };
export type { ShipHost, PartDestroyedEvent, PilotOrders, ShipBridgeConfig, ShipBridgeStats };

/** stepMovement's scratch: the held keys read from Input, and the controls built from them (reused every call; the step never keeps them) */
const MOVE_SRC: FlightInputSource = {
  forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0,
  helm: false, strafeLeft: false, strafeRight: false, jump: false, cursorDist: 0, dodge: false,
};
const MOVE_CTL = newFlightControls();

/** Read a player's held keys from the Input component into `src` */
function readInputsInto(eid: number, src: FlightInputSource): FlightInputSource {
  src.forward = Input.forward[eid] === 1;
  src.backward = Input.backward[eid] === 1;
  src.left = Input.left[eid] === 1;
  src.right = Input.right[eid] === 1;
  src.boost = Input.boost[eid] === 1;
  src.targetAngle = Input.targetAngle[eid];
  src.helm = Input.helm[eid] === 1;
  src.strafeLeft = Input.strafeLeft[eid] === 1;
  src.strafeRight = Input.strafeRight[eid] === 1;
  src.jump = Input.jump[eid] === 1;
  src.cursorDist = Input.cursorDist[eid];
  src.dodge = Input.dodge[eid] === 1;
  return src;
}

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
  readonly stats: ShipBridgeStats = { lastRebuildMs: 0, rebuildCount: 0, debrisCount: 0 };

  /** This bridge as its modules (bridge/*.ts) see it, private state included (bridge/core.ts BridgeCtx) */
  private readonly ctx: BridgeCtx = this as unknown as BridgeCtx;
  private host!: ShipHost;
  private now: () => number;
  private geomCache = new WeakMap<Blueprint, PlacedGeom[]>();
  /** Who last landed a shot on each body */
  private lastHitBy = new Map<number, number>();
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
  /** Debris that's only to be seen (a boss blowing apart): nothing hits it, it hits nothing, shots and blasts pass through */
  private intangible = new Set<number>();
  /** Parts that just crumbled (decay, not damage): they don't blow up */
  private crumbled = new Set<string>();
  /** Last tick each body took damage (station repair waits a while after) */
  private lastDamaged = new Map<number, number>();
  /** Ticks of progress towards regrowing the next missing part */
  private restoreProgress = new Map<number, number>();
  /** Last contact effect per pair of bodies */
  private contactFx = new Map<string, number>();
  private joinCache = new WeakMap<Blueprint, [number, number][]>();
  /** EMP'd ships: engines and guns dead until this tick */
  private empUntil = new Map<number, number>();
  /**
   * Warmth, 0 (frozen through) to 1 (warm; not kept): the cold builds it down (server/src/game/Warmth.ts steps it),
   * frost hits take it off, and frozen through a ship seizes up (common/src/ships/warmth.ts)
   */
  private warmth = new Map<number, number>();

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
  /** Burning parts (incendiary hits): damage over time, spreading to neighbours as parts go */
  private burns: { eid: number; part: number; until: number; dps: number; radius: number; source: number; hit?: HitInfo }[] = [];
  /** Weapon beams on this tick, per ship: how far along the nearest one hit (0..1) */
  private weaponBeams = new Map<number, number>();
  /** Pulse lasers mid-pulse, per ship: which part, and the tick its pulse started (common/src/ships/pulse.ts) */
  private pulsing = new Map<number, { part: number; start: number; hit?: { eid: number; dealt: number } }[]>();
  /** What the last pulse tick burned (fireBeam), so a pulse's damage is told as one number */
  private pulseHit: { eid: number; dealt: number } | null = null;
  /**
   * What each body flew with this tick (replication: the server's shadow of each
   * ship replays exactly this, with the structure the step used)
   */
  readonly replicaCtl = new Map<number, { mode: ReplicaMode; bits: number; q: number; derived: ShipState['derived'] }>();
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

  isDormant(eid: number): boolean {
    return this.dormant.has(eid);
  }

  /** Distant ships, and when each went to sleep */
  dormantShips(): ReadonlyMap<number, number> {
    return this.dormant;
  }

  isPinned(eid: number): boolean {
    return this.pinned.has(eid);
  }

  isAnchored(eid: number): boolean {
    return this.anchored.has(eid);
  }

  hasController(eid: number): boolean {
    return this.controllers.has(eid);
  }

  /** Where its autopilot is taking it (null: none) */
  autopilotOf(eid: number): { x: number; y: number; arriveRadius: number } | null {
    return this.autopilot.get(eid) ?? null;
  }

  lastFiredTick(eid: number): number { return wpn.lastFiredTick(this.ctx, eid); }

  /**
   * Why this ship can't go distant now (null: it can): a pilot's, debris, in
   * the middle of something (hurt or shooting lately, EMP'd, burning, under
   * repair, a blast of its own pending, mid-jump, docked)
   */
  sleepBlocker(eid: number, recentTicks: { damaged: number; fired: number }): string | null {
    const ship = this.bodies.get(eid);
    if (!ship) return 'gone';
    if (ship.kind !== 'ship') return 'debris';
    if (hasComponent(this.host.world, Player, eid)) return 'pilot';
    if (this.intangible.has(eid)) return 'intangible';
    const now = this.host.getTick();
    if (now - (this.lastDamaged.get(eid) ?? -Infinity) < recentTicks.damaged) return 'damaged';
    if (now - (this.lastFired.get(eid) ?? -Infinity) < recentTicks.fired) return 'firing';
    if (this.pulsing.has(eid) || this.weaponBeams.has(eid) || this.beams.has(eid)) return 'firing';
    if (this.isEmped(eid) || this.warmth.has(eid)) return 'emp';
    if (this.isJumping(ship)) return 'jumping';
    if (this.kits.has(eid)) return 'repairing';
    if (this.host.sheltered?.(eid)) return 'docked';
    for (const b of this.burns) if (b.eid === eid) return 'burning';
    for (const b of this.blasts) if (b.source === eid) return 'blast';
    return null;
  }

  /** Take a pilotless ship out of the pipeline (SimLod moves it from now on). False if it can't go now. */
  sleep(eid: number, recentTicks = { damaged: 600, fired: 300 }): boolean {
    if (this.dormant.has(eid) || this.sleepBlocker(eid, recentTicks)) return false;
    this.dormant.set(eid, this.host.getTick());
    const ship = this.bodies.get(eid)!;
    // (It flies on smoothly: no spin carried into a kinematic heading, wrecks excepted)
    if (!this.anchored.has(eid)) ship.angVel = 0;
    this.replicaCtl.delete(eid);
    this.apHeading.delete(eid);
    return true;
  }

  /**
   * Back into the pipeline: what went on while it slept is caught up (guns'
   * cooldowns and heat, its shield, its battery), and it carries on from where
   * SimLod left it (position, velocity, heading), with every part as it was.
   */
  wake(eid: number): void {
    const since = this.dormant.get(eid);
    if (since === undefined) return;
    this.dormant.delete(eid);
    // (Not in this tick's broadphase: beams look for it anyway)
    this.ungridded.add(eid);
    const ship = this.bodies.get(eid);
    if (!ship) return;
    const now = this.host.getTick(), dt = Math.max(0, now - since);
    for (let i = 0; i < ship.cooldown.length; i++) if (ship.cooldown[i] > 0) ship.cooldown[i] = Math.max(0, ship.cooldown[i] - dt);
    for (let i = 0; i < ship.heat.length; i++) {
      if (ship.heat[i] <= 0) continue;
      const w = ship.derived.weapons.find((x) => x.part === i);
      const cool = w ? partWeaponDef(this.tuning, w.kind, ship.blueprint.parts[w.part], w).coolPerSec ?? 30 : 30;
      ship.heat[i] = Math.max(0, ship.heat[i] - (cool / 60) * dt);
      if (ship.overheated[i] && ship.heat[i] < 30) ship.overheated[i] = false;
    }
    const sh = this.tuning.shield, max = ship.derived.shieldMax;
    if (sh && max > 0 && ship.shield < max) {
      const regen = Math.max(0, now - Math.max(since, ship.shieldHitTick + sh.regenDelayTicks));
      ship.shield = Math.min(max, ship.shield + ((max * sh.regenPerSecond) / 60) * regen);
    }
    // Its battery: spare power tops it up as it would have, a tick at a time (it's never long)
    let c = this.charge.get(eid);
    if (c) {
      for (let i = 0; i < Math.min(dt, 3600) && chargeTotal(ship.derived, c) < 100; i++) {
        c = powerTick(ship.derived, c, { thrusting: false, boosting: false }, this.tuning).charge;
      }
      this.charge.set(eid, c);
    }
    const body = this.readBody(eid, ship);
    quantizeShipBody(body);
    this.writeBody(eid, ship, body);
  }

  /** Where SimLod has a distant ship now (rounded as every body is: what clients would be sent) */
  moveDistant(eid: number, b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number }): void {
    const ship = this.bodies.get(eid);
    if (!ship || !this.dormant.has(eid)) return;
    const body = { ...b, jump: ship.jump, jumpScale: ship.jumpScale };
    quantizeShipBody(body);
    this.writeBody(eid, ship, body);
  }

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

  geometry(ship: ShipState): PlacedGeom[] {
    let g = this.geomCache.get(ship.blueprint);
    if (!g) {
      g = blueprintGeometry(this.catalog, ship.blueprint);
      this.geomCache.set(ship.blueprint, g);
    }
    return g;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private spawnOn(eid: number, bp: Blueprint, kind: 'ship' | 'debris', hp?: number[], angVel = 0): ShipState { return rbd.spawnOn(this.ctx, eid, bp, kind, hp, angVel); }

  onPlayerCreated(eid: number): void { return rbd.onPlayerCreated(this.ctx, eid); }

  /** A pilotless ship (debug key B). Returns its entity id. */
  spawnDummy(bp: Blueprint, x: number, y: number, angle: number, systemId = 0): number { return rbd.spawnDummy(this.ctx, bp, x, y, angle, systemId); }

  spawnWreck(bp: Blueprint, x: number, y: number, angle: number, systemId: number, seed: number): number { return rbd.spawnWreck(this.ctx, bp, x, y, angle, systemId, seed); }

  /** Damage multipliers: boss rage, factions' weak guns (pilots' skills no longer add damage) */
  private damageMuls = new Map<number, number>();
  setSkills(eid: number, _skills: Record<string, number>): void { return rbd.setSkills(this.ctx, eid, _skills); }

  setDamageScale(eid: number, k: number): void { return wpn.setDamageScale(this.ctx, eid, k); }

  /** Flying in a wing (party members close by): a damage multiplier on top */
  private wing = new Map<number, number>();
  setWingBonus(eid: number, k: number): void { return wpn.setWingBonus(this.ctx, eid, k); }

  wingBonus(eid: number): number { return wpn.wingBonus(this.ctx, eid); }

  private damageMul(eid: number): number { return wpn.damageMul(this.ctx, eid); }

  /** The target each player has selected (missiles lock on to it) */
  private targets = new Map<number, number>();
  setTarget(eid: number, target: number): void { return wpn.setTarget(this.ctx, eid, target); }

  /** A player's selected target, if it's still there and in the same system */
  targetOf(eid: number): number { return wpn.targetOf(this.ctx, eid); }

  /** Hull left, as a fraction of the ship's full HP (every part counted) */
  integrity(eid: number): number { return dmg.integrity(this.ctx, eid); }

  /** Move a ship instantly (boss blinks) */
  teleport(eid: number, x: number, y: number): void {
    if (!this.bodies.has(eid)) return;
    Position.x[eid] = x;
    Position.y[eid] = y;
    this.ungridded.add(eid);
  }

  /** A ship's battery charge (energy.ts) */
  chargeOf(eid: number): Charge { return sync.chargeOf(this.ctx, eid); }

  /** Set it (a player's total is mirrored to Boost.fuel, which the HUD's gauge reads) */
  setCharge(eid: number, c: Charge): void { return sync.setCharge(this.ctx, eid, c); }

  removeShip(eid: number): void { return rbd.removeShip(this.ctx, eid); }

  private forget(eid: number): void { return rbd.forget(this.ctx, eid); }

  // -------------------------------------------------------------------------
  // Repair kits: a budget of credits spent slowly on the ship, damaged parts first, then missing ones
  // -------------------------------------------------------------------------

  private kits = new Map<number, { left: number; total: number; hpPerSec: number; restoreTicks: number; progress: number; since: number }>();

  /** Repair kits only work on a ship holding still (world units per tick) */
  static readonly KIT_STILL_SPEED = 0.8;

  /** Is this ship holding still enough to use a repair kit? */
  isStill(eid: number): boolean {
    return Math.hypot(Velocity.x[eid], Velocity.y[eid]) <= ShipBridge.KIT_STILL_SPEED;
  }

  /** Is there anything a repair kit could do for this ship? */
  needsRepair(eid: number): boolean { return rbd.needsRepair(this.ctx, eid); }

  /** Start a kit (another one adds to the budget and keeps the faster rate) */
  startRepairKit(eid: number, kit: { budget: number; hpPerSec: number; restoreSec: number }): void { return rbd.startRepairKit(this.ctx, eid, kit); }

  repairKitLeft(eid: number): number { return rbd.repairKitLeft(this.ctx, eid); }

  private stepRepairKits(tick: number): void { return rbd.stepRepairKits(this.ctx, tick); }

  /** The missing part (not a ghost) that joins the structure, nearest the core */
  private nextMissing(eid: number, ship: ShipState): number { return rbd.nextMissing(this.ctx, eid, ship); }

  /** Parts designed but not built yet, by ship (part indices): absent, and never regrown by station repair */
  private ghosts = new Map<number, Set<number>>();

  /** Mark these parts (uids) as not built yet */
  setGhosts(eid: number, uids: number[]): void { return dmg.setGhosts(this.ctx, eid, uids); }

  isGhost(eid: number, part: number): boolean { return dmg.isGhost(this.ctx, eid, part); }

  /** A ghost part arrived: build it in at full HP */
  installGhost(eid: number, uid: number): boolean { return dmg.installGhost(this.ctx, eid, uid); }

  /** Fix a pilotless ship where it stands (or free it): rams and blasts no longer move it */
  pin(eid: number, on = true): void {
    if (on && this.bodies.has(eid)) this.pinned.set(eid, { x: Position.x[eid], y: Position.y[eid] });
    else this.pinned.delete(eid);
  }

  /** Give a pilotless ship an AI pilot (null: none) */
  setController(eid: number, fn: ((eid: number, ship: ShipState) => PilotOrders | null) | null): void {
    if (fn) this.controllers.set(eid, fn);
    else this.controllers.delete(eid);
  }

  /** Make a ship tougher (elite enemies): every part's max HP × k, at full HP */
  scaleHp(eid: number, k: number): void { return dmg.scaleHp(this.ctx, eid, k); }

  /** Toughen one function's parts (a boss's core) by `k` */
  hardenParts(eid: number, fn: string, k: number): void { return dmg.hardenParts(this.ctx, eid, fn, k); }

  /** Core HP as a fraction of its max (0 when lost) */
  coreFraction(eid: number): number { return dmg.coreFraction(this.ctx, eid); }

  /** Fly a pilotless ship towards a point (null: stop and hold). */
  setAutopilot(eid: number, target: { x: number; y: number; arriveRadius?: number } | null): void {
    if (target) this.autopilot.set(eid, { x: target.x, y: target.y, arriveRadius: target.arriveRadius ?? 500 });
    else this.autopilot.delete(eid);
  }

  /**
   * Autopilot controls: turn to face the target, thrust when roughly facing it,
   * and cut the engines in time to coast to a stop at the arrival radius.
   */
  private autopilotControls(eid: number, target: { x: number; y: number; arriveRadius: number }) {
    const dx = target.x - Position.x[eid], dy = target.y - Position.y[eid];
    const dist = Math.hypot(dx, dy);
    // Hold the heading until the course drifts a degree or so: fewer control changes to replicate
    let want = Math.atan2(dy, dx);
    const held = this.apHeading.get(eid);
    if (held !== undefined && Math.abs(Math.atan2(Math.sin(want - held), Math.cos(want - held))) < 0.02 && dist > target.arriveRadius) want = held;
    this.apHeading.set(eid, want);
    let err = want - Rotation.angle[eid];
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    // Friction alone stops a ship moving at v within about v / (1 - FRICTION)
    const speed = Math.hypot(Velocity.x[eid], Velocity.y[eid]);
    const stopping = speed / (1 - FRICTION);
    const go = Math.abs(err) < 0.5 && dist - target.arriveRadius > stopping;
    // Mouse-steer controls are screen-relative (forward = up the screen): press the
    // screen directions nearest the nose, and the PD turn keeps the nose on target
    const a = Rotation.angle[eid], cx = Math.cos(a), cy = Math.sin(a);
    return { forward: go && cy < -0.38, backward: go && cy > 0.38, left: go && cx < -0.38, right: go && cx > 0.38, boost: false, targetAngle: want };
  }

  validate(bp: Blueprint, opts: { mounting?: boolean } = {}): ValidationResult { return rbd.validate(this.ctx, bp, opts); }

  /** Hangar save: swap the ship's blueprint and respawn in place at full HP. */
  respawnInPlace(eid: number, bp: Blueprint): void { return rbd.respawnInPlace(this.ctx, eid, bp); }

  setPartHp(eid: number, fraction: (uid: number) => number): void { return dmg.setPartHp(this.ctx, eid, fraction); }

  /** Heal every intact part by a fraction of its max HP (repair kits) */
  healAll(eid: number, fraction: number): void { return dmg.healAll(this.ctx, eid, fraction); }

  lastHitter(eid: number): number { return dmg.lastHitter(this.ctx, eid); }

  lastDamagedTick(eid: number): number { return dmg.lastDamagedTick(this.ctx, eid); }

  hurt(eid: number, ship: ShipState, part: number, amount: number, source = -1, vs?: { shield?: number; hull?: number; hit?: HitInfo; at?: Vec2; bane?: { faction: string; damage: number } }): number { return dmg.hurt(this.ctx, eid, ship, part, amount, source, vs); }

  /** Damage one part from outside the usual weapons (a boss's beam): hurt, and reported as any hit is */
  damagePartBy(eid: number, part: number, amount: number, source: number, hit?: HitInfo): number { return dmg.damagePartBy(this.ctx, eid, part, amount, source, hit); }

  /** How much of the last hit got through the armour it struck (hitMultiplier): under GLANCING it shows as glancing */
  private lastThrough = 1;

  /** While a splash hurts one body's parts (all from the point `at`): the part cover last sent a hit to, and in what stage */
  private coverMemo: { ship: ShipState; at: Vec2; first: number; best: number } | null = null;

  /** Is this ship's electronics knocked out by an EMP? */
  isEmped(eid: number): boolean { return dmg.isEmped(this.ctx, eid); }

  /** How many more ticks it stays knocked out (0: it isn't), so the pilot's prediction drifts exactly as long as the server does */
  empTicksLeft(eid: number): number { return dmg.empTicksLeft(this.ctx, eid); }

  splashAt(systemNum: number, x: number, y: number, radius: number, damage: number, source: number, hit?: HitInfo): void { return dmg.splashAt(this.ctx, systemNum, x, y, radius, damage, source, hit); }

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

  nearestTarget(eid: number, x: number, y: number, range: number, filter?: (other: number) => boolean, hull = false): number { return wpn.nearestTarget(this.ctx, eid, x, y, range, filter, hull); }

  /** Weapon beam state for the snapshot */
  weaponBeamState(eid: number): { on: boolean; hit: number } { return sync.weaponBeamState(this.ctx, eid); }

  /** Hottest beam weapon (0..1) and whether any has overheated, for the HUD */
  heatState(eid: number): { heat: number; over: boolean } { return sync.heatState(this.ctx, eid); }

  /** Shield charge 0..1 for the snapshot (0 also without a shield) */
  shieldFraction(eid: number): number { return sync.shieldFraction(this.ctx, eid); }

  /** Proto debug key U. */
  repair(eid: number): void { return rbd.repair(this.ctx, eid); }

  // -------------------------------------------------------------------------
  // Per-tick hooks from GameServer
  // -------------------------------------------------------------------------

  /** Player movement. Returns false for non-ship entities so the legacy path runs. */
  stepMovement(eid: number): boolean {
    const ship = this.bodies.get(eid);
    if (!ship || ship.kind !== 'ship') return false;
    const body = this.readBody(eid, ship);
    // The hold's cargo flies with it (ships/load.ts), as the pilot's prediction and every replica have it
    // (and what its Tow Beam tows, as load: ships/tow.ts)
    body.cargo = quantizeCargo((this.host.cargoMass?.(eid) ?? 0) + (this.host.towLoad?.(eid) ?? 0));
    // (Burst Strafer: the dodge held; its way comes from the movement keys: ships/strafer.ts)
    const q = quantizeReplicaAngle(Input.targetAngle[eid]);
    // An EMP cripples the drive (thrust and steering × EMP_CONTROL) and stops a jump starting; the pilot's prediction flies it the same
    const emp = this.isEmped(eid);
    // The controls the step reads (flightInputs.ts: jump && !emp, jumpDist = cursorDist); the replica's bits read the same
    const controls = buildFlightInputs(readInputsInto(eid, MOVE_SRC), emp, MOVE_CTL);
    // Numb with cold, the drive is sluggish (warmth.ts): its pilot's prediction works it out from the warmth it's told, replicas from CTL.numb
    const cold = this.coldStage(eid);
    const hazard = withNumb(this.host.hazardFlight?.(eid, ship.derived, body.x, body.y), cold);
    this.replicaCtl.set(eid, {
      mode: ReplicaMode.Player, q, derived: ship.derived,
      bits: controlBits(controls) | (emp ? CTL.emp : 0) | (cold.control < 1 ? CTL.numb : 0),
    });
    // Charging fields round the step (a star's ring, a lodestone's): the range boost from where it starts, then a faster
    // cooldown and a lodestone's priming from where it ends (the pilot's prediction runs the same: ShipClient.predict)
    const jt = jumpTuning(this.tuning);
    let res!: ReturnType<typeof stepShipPhysics>;
    ship.jumpPrime = pilotJumpStep(body, ship.jumpPrime ?? 0, this.host.jumpFields?.(eid) ?? NO_FIELDS, this.host.getTick(), ship.derived.jumpCooldown || jt.cooldownTicks, jt, (rangeBoost) => {
      res = stepShipPhysics(body, controls, ship.derived, this.tuning, { charge: this.chargeOf(eid), drainRate: 1, load: gunLoad(ship, this.host.getTick()), tick: this.host.getTick() }, this.host.gravityAt(eid), rangeBoost, emp ? withEmp(hazard) : hazard, this.host.terrainAt?.(eid));
    });
    this.setCharge(eid, res.charge);
    this.writeBody(eid, ship, body);
    if (res.isBoosting) Boost.lastUseTick[eid] = this.host.getTick();
    return true;
  }

  stepWeapons(eid: number): boolean { return wpn.stepWeapons(this.ctx, eid); }

  /** Shots fired since the last snapshot (sent as fire events: see launch.ts); the server clears it */
  readonly fired: FireRecord[] = [];

  /** Mining beam state per ship, for the snapshot: on, and how far along the beam it hit */
  private beams = new Map<number, number>();

  beamState(eid: number): { on: boolean; hit: number } { return sync.beamState(this.ctx, eid); }

  private stepMiners(eid: number, ship: ShipState, on: boolean, aimWorld: number, aimDist: number): void { return wpn.stepMiners(this.ctx, eid, ship, on, aimWorld, aimDist); }

  private fireWeapons(eid: number, ship: ShipState, firing: boolean, aimWorld?: number, aimDist = 0, target = -1, energy?: { charge: Charge }): void { return wpn.fireWeapons(this.ctx, eid, ship, firing, aimWorld, aimDist, target, energy); }

  /** Each pulse under way burns its tick's share along its gun's aim, as wide as its curve says; done, it's dropped */
  private stepPulses(eid: number, ship: ShipState, tick: number): void { return wpn.stepPulses(this.ctx, eid, ship, tick); }

  private fireBeam(eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, pulse?: { damage: number; width: number }): number { return wpn.fireBeam(this.ctx, eid, ship, w, def, pulse); }

  // -------------------------------------------------------------------------
  // Support weapons: the Repair Beam and point defence (common/src/ships/support.ts)
  // -------------------------------------------------------------------------

  /** A beam's muzzle (world) and angle, along its gun's aim */
  private beamFrom(eid: number, ship: ShipState, w: WeaponInfo): { x: number; y: number; angle: number } { return wpn.beamFrom(this.ctx, eid, ship, w); }

  private repairBeam(eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning): number { return wpn.repairBeam(this.ctx, eid, ship, w, def); }

  /** Point defence's shots in reach this tick (reused), and what each turret is on (ship -> part -> shot) */
  private pdList: { id: number; x: number; y: number; d: number }[] = [];
  private pdOn = new Map<number, Map<number, number>>();

  private pointDefence(eid: number, ship: ShipState, pose: { x: number; y: number; angle: number }, def: (w: WeaponInfo) => WeaponTuning): void { return wpn.pointDefence(this.ctx, eid, ship, pose, def); }

  private alongBeam(systemNum: number, x0: number, y0: number, x1: number, y1: number, half: number): Iterable<number> { return wpn.alongBeam(this.ctx, systemNum, x0, y0, x1, y1, half); }

  /** Bodies spawned or moved instantly since the broadphase was last filed (addToSpatialGrid) */
  private ungridded = new Set<number>();

  addToSpatialGrid(add: (eid: number, x: number, y: number, r: number) => void): void {
    this.ungridded.clear();
    for (const [eid, ship] of this.bodies) {
      // (already in the grid as a player; only to be seen; or distant, out of every fight)
      if (hasComponent(this.host.world, Player, eid) || this.intangible.has(eid) || this.dormant.has(eid)) continue;
      add(eid, Position.x[eid], Position.y[eid], Math.max(1, ship.derived.radius));
    }
  }

  /**
   * Projectile vs ship parts. The engine's broadphase gives `nearby`; each
   * candidate ship is tested part by part in its local grid space, and the
   * first part the segment touches takes the damage.
   */
  hitProjectile(
    proj: number, ownerId: number, x0: number, y0: number, x1: number, y1: number,
    nearby: { id: number }[], exclude?: Set<number>, radius = 0,
  ): { eid: number; x: number; y: number; part: number } | null {
    let best: { eid: number; ship: ShipState; part: number; t: number } | null = null;
    const systemNum = InSystem.systemId[proj];
    for (const { id: eid } of nearby) {
      // (Instanced copies share coordinates: only ships in the shot's own copy)
      if (eid === ownerId || exclude?.has(eid) || InSystem.systemId[eid] !== systemNum || this.intangible.has(eid)) continue;
      const ship = this.bodies.get(eid);
      if (!ship) continue;
      // Shots pass straight through ships they may not hurt
      if (this.host.canDamage && !this.host.canDamage(ownerId, eid)) continue;
      const hit = this.segmentHit(eid, ship, x0, y0, x1, y1, radius);
      if (hit && (!best || hit.t < best.t)) best = { eid, ship, ...hit };
    }
    if (!best) return null;
    const hx = x0 + (x1 - x0) * best.t, hy = y0 + (y1 - y0) * best.t;
    const dealt = this.hurt(best.eid, best.ship, best.part, Projectile.damage[proj], ownerId, { ...this.host.shotVs?.(proj), at: this.worldToGrid(best.eid, best.ship, hx, hy) });
    this.host.notifyDamage(best.eid, dealt, ownerId, this.lastThrough < GLANCING);
    this.host.notifyProjectileHit(proj, hx, hy);
    return { eid: best.eid, x: hx, y: hy, part: best.part };
  }

  /** Does a world-space segment come within a ship's bounding circle (segmentHit's first test) */
  private nearSegment(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): boolean { return wpn.nearSegment(this.ctx, eid, ship, x0, y0, x1, y1, margin); }

  segmentHit(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null { return wpn.segmentHit(this.ctx, eid, ship, x0, y0, x1, y1, margin); }

  /** The ship being cast against (castShip's standing test, without a closure per call) */
  private castOn: ShipState | null = null;
  private readonly castOk = (i: number): boolean => standing(this.catalog, this.castOn!, i);

  /** segmentHit without its bounding-circle test (for callers that have just made it) */
  private castShip(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null { return wpn.castShip(this.ctx, eid, ship, x0, y0, x1, y1, margin); }

  private cover(ship: ShipState, part: number, at?: Vec2): number { return wpn.cover(this.ctx, ship, part, at); }

  /** The ship part under a world point (debug key K). */
  partAt(x: number, y: number): { eid: number; part: number } | null { return wpn.partAt(this.ctx, x, y); }

  damagePartFraction(eid: number, part: number, fraction: number): void { return wpn.damagePartFraction(this.ctx, eid, part, fraction); }

  /**
   * The bodies as they are now, for a loop that may add or remove some: their ids and states as two lists (and 0, to
   * count from), rather than a pair for each (that was most of what such a loop cost)
   */
  private bodiesNow(): [number[], ShipState[], number] {
    return [[...this.bodies.keys()], [...this.bodies.values()], 0];
  }

  /** End of tick: pilotless motion, contacts, rebuilds, detachment, debris lifetime, health sync. */
  tick(): void {
    const world = this.host.world;
    const tick = this.host.getTick();
    if (tick % 10 === 0 && this.burns.length) this.stepBurns(tick);
    if (tick % 15 === 0 && this.kits.size) this.stepRepairKits(tick);

    // 1. Prune and move everything nobody pilots
    for (let [ids, ships, bi] = this.bodiesNow(); bi < ids.length; bi++) {
      const eid = ids[bi], ship = ships[bi];
      if (!entityExists(world, eid) || hasComponent(world, Dead, eid)) {
        this.bodies.delete(eid);
        this.forget(eid);
        continue;
      }
      // Distant (SimLod moves it): nothing else happens to it
      if (this.dormant.has(eid)) continue;
      const gravity = this.host.gravityAt(eid);
      const k = gravity ? this.withGravity(gravity) : K;
      if (ship.kind === 'debris') {
        if (tick >= ship.despawnTick) { this.removeBody(eid); continue; }
        this.decay(eid, ship, tick);
        this.replicaCtl.set(eid, { mode: ReplicaMode.Drift, bits: 0, q: 0, derived: ship.derived });
        const body = this.readBody(eid, ship);
        stepDrift(body, k);
        this.writeBody(eid, ship, body);
      } else if (this.anchored.has(eid)) {
        // Wrecks turn slowly and coast when shoved, but no well pulls them in
        this.replicaCtl.set(eid, { mode: ReplicaMode.Anchored, bits: 0, q: 0, derived: ship.derived });
        const body = this.readBody(eid, ship);
        const spin = body.angVel;
        stepDrift(body, K);
        body.angVel = spin;
        this.writeBody(eid, ship, body);
      } else if (!hasComponent(world, Player, eid)) {
        // Dummy: holds its heading, coasts, and keeps its weapons cooling (or flies its autopilot course)
        const body = this.readBody(eid, ship);
        const ai = this.controllers.get(eid);
        const orders = ai ? ai(eid, ship) : null;
        const target = this.autopilot.get(eid);
        const emp = this.isEmped(eid);
        const hold = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: body.angle };
        let controls = orders ? orders.controls : target ? this.autopilotControls(eid, target) : hold;
        // Aim in the replicated quantization, so every client steps it exactly the same
        let q = 0;
        if (controls !== hold) {
          q = quantizeReplicaAngle(controls.targetAngle);
          controls = { ...controls, targetAngle: replicaAngle(ReplicaMode.Pilotless, q) };
        }
        // EMP'd: it keeps flying, crippled (as a pilot does)
        this.replicaCtl.set(eid, { mode: ReplicaMode.Pilotless, bits: (controls === hold ? CTL.hold : controlBits(controls)) | (emp ? CTL.emp : 0), q, derived: ship.derived });
        if (orders?.impulse && !emp) { body.vx += orders.impulse[0]; body.vy += orders.impulse[1]; }
        stepFlight(body, controls, ship.derived, this.tuning, { charge: FULL_CHARGE, drainRate: 0 }, emp ? { ...k, hazard: withEmp(undefined) } : k);
        // A surface's rock (as the replicas have it: replicaStep)
        collideTerrain(body, terrainRadius(ship.derived.radius), this.host.terrainAt?.(eid));
        this.writeBody(eid, ship, body);
        const pin = this.pinned.get(eid);
        if (pin) { Position.x[eid] = pin.x; Position.y[eid] = pin.y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; }
        // Pilotless ships have a battery too: spare power charges it, shots spend it
        // (Its guns draw on their own circuits as they reload: energy.ts)
        const energy = { charge: powerTick(ship.derived, this.chargeOf(eid), { thrusting: false, boosting: false, load: gunLoad(ship, tick) }, this.tuning).charge };
        this.fireWeapons(eid, ship, !!orders?.firing && !emp && !this.isJumping(ship), orders?.aim, orders?.aimDist ?? 0, orders?.target ?? -1, energy);
        this.charge.set(eid, energy.charge);
      }
    }

    // Shields recharge once they've gone a while without a hit
    const sh = this.tuning.shield;
    if (sh) {
      for (const ship of this.bodies.values()) {
        if (this.dormant.has(ship.id)) continue; // (caught up when it wakes)
        const max = ship.derived.shieldMax;
        if (max <= 0) { ship.shield = 0; continue; }
        if (ship.shield > max) ship.shield = max;
        if (ship.shield < max && tick - ship.shieldHitTick > sh.regenDelayTicks) ship.shield = Math.min(max, ship.shield + ((max * sh.regenPerSecond) / 60) * (this.host.hazardScale?.(ship.id, 'shield') ?? 1));
      }
    }

    // 2. Ship-to-ship and ship-to-debris contacts
    this.resolveContacts();

    // Past an event horizon nothing survives: every part is crushed (ships then
    // go through the normal core-loss path; debris simply vanishes)
    for (let [ids, ships, bi] = this.bodiesNow(); bi < ids.length; bi++) {
      const eid = ids[bi], ship = ships[bi];
      const horizon = this.host.gravityAt(eid)?.horizon;
      if (!horizon || Math.hypot(Position.x[eid], Position.y[eid]) > horizon || this.host.invulnerable?.(eid)) continue;
      if (ship.kind === 'debris') { this.removeBody(eid); continue; }
      // (A distant ship drifted in: it dies as a live one does)
      this.wake(eid);
      ship.hp.forEach((_, i) => { if (damagePart(ship, i, Infinity, this.tuning) > 0) this.crumbled.add(`${eid}:${i}`); });
    }

    // Destroyed parts: effects, and the ones that blow up (cores at once, so the
    // parts they leave behind carry the damage; the rest a few ticks later)
    // A blast can kill more parts, so repeat until nothing new dies this tick
    for (let pass = 0; pass < 8; pass++) {
      let more = false;
      for (let [ids, ships, bi] = this.bodiesNow(); bi < ids.length; bi++) if (!this.dormant.has(ids[bi])) more = this.partDeaths(ids[bi], ships[bi], tick) || more;
      for (let i = this.blasts.length - 1; i >= 0; i--) {
        if (this.blasts[i].due > tick) continue;
        const b = this.blasts[i];
        this.blasts.splice(i, 1);
        this.applyBlast(b);
        more = true;
      }
      if (!more) break;
    }
    this.crumbled.clear();

    // Station repair
    const rp = this.tuning.repair;
    if (rp && tick % rp.intervalTicks === 0) {
      for (const [eid, ship] of this.bodies) if (!this.dormant.has(eid)) this.repairStep(eid, ship, tick);
    }

    // 3. Rebuild what changed, then mirror core HP into the engine's health
    for (let [ids, ships, bi] = this.bodiesNow(); bi < ids.length; bi++) {
      const eid = ids[bi], ship = ships[bi];
      if (ship.dirty) this.rebuildNow(eid, ship);
      if (this.bodies.has(eid) && hasComponent(world, Player, eid)) this.syncHealth(eid, ship);
    }

    // 4. Round every body to snapshot precision, so what the server holds is
    //    exactly what clients receive (client prediction replays from it)
    for (const [eid, ship] of this.bodies) {
      if (this.dormant.has(eid)) continue; // (SimLod rounds what it writes)
      const body = this.readBody(eid, ship);
      quantizeShipBody(body);
      this.writeBody(eid, ship, body);
    }
    let debris = 0;
    for (const s of this.bodies.values()) if (s.kind === 'debris') debris++;
    this.stats.debrisCount = debris;
  }

  /** Flight constants with a system's gravity, built once per gravity (it's data: it never changes) */
  private gravityK = new WeakMap<GravityWell, FlightConstants>();
  private withGravity(gravity: GravityWell): FlightConstants {
    let k = this.gravityK.get(gravity);
    if (!k) this.gravityK.set(gravity, (k = { ...K, gravity }));
    return k;
  }

  /**
   * World-space convex pieces of every alive part (shrunk, so parts that merely
   * touch don't collide), each with its bounding box
   */
  private worldPieces(eid: number, ship: ShipState, near?: { x: number; y: number; r: number }): ContactPiece[] {
    const cs = this.tuning.cellSize;
    const [cx, cy] = ship.derived.com;
    const px = Position.x[eid], py = Position.y[eid];
    const phi = Rotation.angle[eid] + Math.PI / 2;
    const c = Math.cos(phi), s = Math.sin(phi);
    const out: ContactPiece[] = [];
    // Only the parts that could reach a circle (the other body's bounds): a boss's far side isn't transformed for a ship grinding its flank
    let nx = 0, ny = 0, nr = Infinity;
    if (near) { [nx, ny] = this.worldToGrid(eid, ship, near.x, near.y); nr = near.r / cs + 1; }
    this.geometry(ship).forEach((g, i) => {
      if (!ship.derived.alive[i]) return;
      if (near && (g.bbox.maxX < nx - nr || g.bbox.minX > nx + nr || g.bbox.maxY < ny - nr || g.bbox.minY > ny + nr)) return;
      for (const piece of g.convexShrunk) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        const poly = piece.map(([x, y]) => {
          const lx = (x - cx) * cs, ly = (y - cy) * cs;
          const wx = px + lx * c - ly * s, wy = py + lx * s + ly * c;
          if (wx < x0) x0 = wx;
          if (wx > x1) x1 = wx;
          if (wy < y0) y0 = wy;
          if (wy > y1) y1 = wy;
          return [wx, wy] as Vec2;
        });
        out.push({ part: i, poly, x0, x1, y0, y1 });
      }
    });
    return out;
  }

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
  private resolveContacts(): void {
    const ct = this.tuning.collision;
    // Who can touch anything at all (none of it changes while this runs)
    const list: [number, ShipState][] = [];
    for (const e of this.bodies) {
      if (e[1].derived.mass > 0 && !this.dormant.has(e[0]) && !this.isJumping(e[1]) && !this.host.sheltered?.(e[0]) && !this.intangible.has(e[0])) list.push(e);
    }
    const n = list.length;
    const pairs: number[] = [];
    const bySys = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const sys = InSystem.systemId[list[i][0]];
      let ids = bySys.get(sys);
      if (!ids) bySys.set(sys, (ids = []));
      ids.push(i);
    }
    // (Each one's left edge worked out once, not on every comparison of the sort)
    const lefts = list.map(([eid, ship]) => Position.x[eid] - ship.derived.radius);
    const left = (i: number) => lefts[i];
    for (const ids of bySys.values()) {
      if (ids.length < 2) continue;
      ids.sort((p, q) => left(p) - left(q));
      for (let a = 0; a < ids.length; a++) {
        const i = ids[a], ei = list[i][0];
        const ri = list[i][1].derived.radius + CONTACT_MARGIN;
        const right = Position.x[ei] + ri, yi = Position.y[ei];
        for (let b = a + 1; b < ids.length; b++) {
          const j = ids[b];
          // Sorted by left edge: everything after this starts further right still
          if (left(j) > right) break;
          if (Math.abs(Position.y[list[j][0]] - yi) > ri + list[j][1].derived.radius) continue;
          pairs.push(i < j ? i * n + j : j * n + i);
        }
      }
    }
    pairs.sort((p, q) => p - q);

    const pieces = new Map<number, ContactPiece[]>();
    // A small body's pieces are kept for the pass (until it's pushed); a big one's (a boss's) are only those near the other body
    const piecesOf = (eid: number, ship: ShipState, other: number, os: ShipState) => {
      if (ship.blueprint.parts.length > BIG_BODY) return this.worldPieces(eid, ship, { x: Position.x[other], y: Position.y[other], r: os.derived.radius });
      let p = pieces.get(eid);
      if (!p) { p = this.worldPieces(eid, ship); pieces.set(eid, p); }
      return p;
    };
    for (const key of pairs) {
      const i = Math.floor(key / n), j = key - i * n;
      const [ea, A] = list[i];
      const [eb, B] = list[j];
      const dx = Position.x[eb] - Position.x[ea], dy = Position.y[eb] - Position.y[ea];
      if (Math.hypot(dx, dy) > A.derived.radius + B.derived.radius) continue;

      let deepest: { depth: number; nx: number; ny: number } | null = null;
      let at: Vec2 = [0, 0];
      const partsA = new Set<number>(), partsB = new Set<number>();
      const pa = piecesOf(ea, A, eb, B), pb = piecesOf(eb, B, ea, A);
      // All of B's pieces lie in this box: A's pieces outside it touch nothing
      let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
      for (const q of pb) {
        if (q.x0 < bx0) bx0 = q.x0;
        if (q.x1 > bx1) bx1 = q.x1;
        if (q.y0 < by0) by0 = q.y0;
        if (q.y1 > by1) by1 = q.y1;
      }
      for (const p of pa) {
        if (p.x1 < bx0 || p.x0 > bx1 || p.y1 < by0 || p.y0 > by1) continue;
        for (const q of pb) {
          if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
          const pen = convexPenetration(p.poly, q.poly);
          if (!pen) continue;
          partsA.add(p.part);
          partsB.add(q.part);
          if (!deepest || pen.depth > deepest.depth) {
            deepest = pen;
            // Contact point: between the two overlapping pieces
            const ca = centroidOf(p.poly), cb = centroidOf(q.poly);
            at = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2];
          }
        }
      }
      if (!deepest) continue;

      // Pinned structures don't give: whatever hits them takes all the push
      const invA = this.pinned.has(ea) ? 0 : 1 / A.derived.mass, invB = this.pinned.has(eb) ? 0 : 1 / B.derived.mass;
      if (invA + invB === 0) continue;
      const { nx, ny, depth } = deepest;
      const corr = depth / (invA + invB);
      Position.x[ea] -= nx * corr * invA; Position.y[ea] -= ny * corr * invA;
      Position.x[eb] += nx * corr * invB; Position.y[eb] += ny * corr * invB;
      pieces.delete(ea);
      pieces.delete(eb);

      const vrel = (Velocity.x[eb] - Velocity.x[ea]) * nx + (Velocity.y[eb] - Velocity.y[ea]) * ny;
      if (vrel >= 0) continue; // already separating
      const jImp = -(1 + ct.restitution) * vrel / (invA + invB);
      Velocity.x[ea] -= jImp * invA * nx; Velocity.y[ea] -= jImp * invA * ny;
      Velocity.x[eb] += jImp * invB * nx; Velocity.y[eb] += jImp * invB * ny;

      const closing = -vrel;
      // Sparks and a thud, at most once per pair per cooldown
      if (closing > (ct.fxMinSpeed ?? 0.6)) {
        const fk = ea < eb ? `${ea}:${eb}` : `${eb}:${ea}`;
        const tick = this.host.getTick();
        if (tick - (this.contactFx.get(fk) ?? -1e9) >= (ct.fxCooldownTicks ?? 8)) {
          this.contactFx.set(fk, tick);
          this.host.notifyContact?.({ systemId: InSystem.systemId[ea], x: at[0], y: at[1], nx, ny, speed: closing });
        }
      }
      if (closing <= ct.minDamageSpeed) continue;
      if (this.host.canDamage && !(this.host.canDamage(ea, eb) && this.host.canDamage(eb, ea))) continue;
      const base = (closing - ct.minDamageSpeed) * ct.damagePerSpeed;
      const total = A.derived.mass + B.derived.mass;
      this.damageContact(ea, A, partsA, base * (2 * B.derived.mass / total), eb);
      this.damageContact(eb, B, partsB, base * (2 * A.derived.mass / total), ea);
    }
  }

  private damageContact(eid: number, ship: ShipState, parts: Set<number>, amount: number, source: number): void {
    let dealt = 0;
    // A wedge nose turns a blow aside; brittle material shatters
    for (const p of parts) dealt += this.hurt(eid, ship, p, (amount / parts.size) * this.contactScale(ship, p), source);
    if (dealt > 0) {
      this.lastDamaged.set(eid, this.host.getTick());
      this.host.notifyDamage(eid, dealt, source);
    }
  }

  /** How hard a collision lands on a part: its piece's `contact` share, doubled for brittle material */
  private contactScale(ship: ShipState, part: number): number {
    const q = ship.blueprint.parts[part];
    const piece = this.catalog.pieces.get(q.piece);
    return (piece?.contact ?? 1) * (partMaterial(this.catalog, q)?.traits?.includes('brittle') ? 2 : 1);
  }

  // -------------------------------------------------------------------------
  // Destroyed parts, blasts, decay and station repair
  // -------------------------------------------------------------------------

  /** Joins between every part of a blueprint, intact or not (where missing parts would reattach) */
  private joinsOf(ship: ShipState): [number, number][] { return rbd.joinsOf(this.ctx, ship); }

  private partWorld(eid: number, ship: ShipState, part: number): Vec2 { return rbd.partWorld(this.ctx, eid, ship, part); }

  private partDeaths(eid: number, ship: ShipState, tick: number): boolean { return dmg.partDeaths(this.ctx, eid, ship, tick); }

  /** Damage every intact part within the blast radius (any body), falling off with distance. */
  private applyBlast(b: PendingBlast): void { return dmg.applyBlast(this.ctx, b); }

  private decay(eid: number, ship: ShipState, tick: number): void { return rbd.decay(this.ctx, eid, ship, tick); }

  private repairStep(eid: number, ship: ShipState, tick: number): void { return rbd.repairStep(this.ctx, eid, ship, tick); }

  // -------------------------------------------------------------------------
  // Rebuild, detachment and debris
  // -------------------------------------------------------------------------

  private noteRebuild(t0: number): void { return rbd.noteRebuild(this.ctx, t0); }

  private rebuildNow(eid: number, ship: ShipState): void { return rbd.rebuildNow(this.ctx, eid, ship); }

  shed(eid: number, groups: number[][], fling = 0, crumble = 0, intangible = false): void { return rbd.shed(this.ctx, eid, groups, fling, crumble, intangible); }

  /** A connected group of parts leaves `ship` as a new debris body built from the same parts and HP. */
  private spawnDebris(parentEid: number, ship: ShipState, group: number[], parentCom: Vec2, pose: { x: number; y: number; angle: number }, k: number, fling = 0, crumble = 0): number { return rbd.spawnDebris(this.ctx, parentEid, ship, group, parentCom, pose, k, fling, crumble); }

  private removeBody(eid: number): void { return rbd.removeBody(this.ctx, eid); }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private syncHealth(eid: number, ship: ShipState): void { return sync.syncHealth(eid, ship); }

  private pose(eid: number) { return sync.pose(eid); }

  private readBody(eid: number, ship: ShipState): FlightBody { return sync.readBody(eid, ship); }

  /** Jump range multiplier where this ship is (a star's ring, or a lodestone's priming) */
  jumpBoost(eid: number): number { return sync.jumpBoost(this.ctx, eid); }

  /** The charging fields where this ship is now */
  private fieldAt(eid: number): JumpField { return sync.fieldAt(this.ctx, eid); }

  /** For the pilot's snapshot: 1 = in a star's charging ring, 2 = in a lodestone's field (bits), and the priming left */
  jumpFieldState(eid: number): { flags: number; prime: number } { return sync.jumpFieldState(this.ctx, eid); }

  // ---- Tow Beam (Towing.ts; common/src/ships/tow.ts)
  /** What a Tow Beam can take hold of: debris you can touch, or a derelict wreck (never a working ship); null otherwise */
  towable(eid: number): { kind: 'wreck' | 'debris'; mass: number; radius: number } | null { return sync.towable(this.ctx, eid); }
  /** Towable bodies in a system within `r` of (x, y) */
  towablesNear(systemNum: number, x: number, y: number, r: number): number[] { return sync.towablesNear(this.ctx, systemNum, x, y, r); }
  /** Being towed: debris neither crumbles nor goes while a beam holds it */
  holdTowed(eid: number): void { return sync.holdTowed(this.ctx, eid); }
  // ---- (end Tow Beam)

  /** Mid-jump (the burn itself): no guns, and the ship passes through other hulls */
  isJumping(ship: ShipState): boolean { return sync.isJumping(this.ctx, ship); }

  private writeBody(eid: number, ship: ShipState, b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number; jump?: number; jumpScale?: number; cargo?: number; dodge?: number; dodgeDir?: number }): void { return sync.writeBody(eid, ship, b); }

  worldToGrid(eid: number, ship: ShipState, x: number, y: number): Vec2 { return sync.worldToGrid(this.ctx, eid, ship, x, y); }
}
