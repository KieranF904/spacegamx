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

import { collideTerrain, rayTerrain, terrainRadius } from '@space-game/common';
import { repairAt, pointDefenceOf, stepPointDefenceAim, wrapPi, isOpen } from '@space-game/common';
import { hasComponent, entityExists } from 'bitecs';
import {
  Position, Velocity, Rotation, Radius, Health, Input, Boost, Player, Dead, Projectile, InSystem, FRICTION,
  Blueprint, Catalog, ShipState, ShipTuning, PlacedGeom, Vec2, InventoryStub, stepShipPhysics, quantizeShipBody,
  validateBlueprint, ValidationResult, GravityWell, FlightConstants, createShipState, rebuildShip, damagePart,
  repairShip, healPart, restorePart, computeJoins, hitMultiplier, weaponHit, shooterGrade, type HitInfo, stepFlight,
  stepDrift, localToWorldDir, withEmp, withNumb, type WarmthStage, jumpTuning, pilotJumpStep, NO_FIELDS,
  type JumpField, blueprintGeometry, castParts, partDistance, pointInConvex, standing, deciding, stageOf,
  currentStage, stageParts, convexPenetration, seededRng, hashInts, shipPointToWorld, WeaponInfo, WeaponTuning,
  ReplicaMode, CTL, controlBits, replicaAngle, quantizeReplicaAngle, firesStraight, partWeaponDef, FireRecord,
  stepGuns, ammoCode, partMaterial, outputOf, powerTick, gunLoad, remapCharge, quantizeCargo, type FlightBody,
  buildFlightInputs, newFlightControls, type FlightInputSource, payMining, MINE_CYCLE, MINING_PULSE, MINE_TAIL,
  mineFalloff, chargeTotal, FULL_CHARGE, type Charge, pulseProfile, beamFalloff,
} from '@space-game/common';
import {
  GLANCING, STAGE_COVER, K, centroidOf, CONTACT_MARGIN, BEAM_PAD, BIG_BODY, type ShipHost, type PartDestroyedEvent,
  type PilotOrders, type PendingBlast, type ShipBridgeConfig, type ShipBridgeStats, type ContactPiece,
  type BridgeCtx,
} from './bridge/core.js';
import * as sync from './bridge/sync.js';
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

  lastFiredTick(eid: number): number {
    return this.lastFired.get(eid) ?? -Infinity;
  }

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

  private spawnOn(eid: number, bp: Blueprint, kind: 'ship' | 'debris', hp?: number[], angVel = 0): ShipState {
    const t0 = this.now();
    const ship = createShipState(this.catalog, this.tuning, eid, bp, this.host.getTick(), { kind, hp, angVel });
    this.noteRebuild(t0);
    // A new ship on a body that had one (a refit, a swap): its stores start as full, all told, as the old one's were
    const was = this.bodies.get(eid), had = this.charge.get(eid);
    if (was && had && ship.derived.power) {
      const p = chargeTotal(was.derived, had);
      this.charge.set(eid, { core: p, s: ship.derived.power.stores.map(() => p) });
    }
    this.bodies.set(eid, ship);
    this.ungridded.add(eid);
    Radius.value[eid] = Math.max(1, ship.derived.radius);
    return ship;
  }

  onPlayerCreated(eid: number): void {
    const ship = this.spawnOn(eid, this.playerBlueprint, 'ship');
    this.syncHealth(eid, ship);
  }

  /** A pilotless ship (debug key B). Returns its entity id. */
  spawnDummy(bp: Blueprint, x: number, y: number, angle: number, systemId = 0): number {
    const eid = this.host.createBody();
    InSystem.systemId[eid] = systemId;
    Position.x[eid] = x;
    Position.y[eid] = y;
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    Rotation.angle[eid] = angle;
    this.spawnOn(eid, bp, 'ship');
    return eid;
  }

  /**
   * A derelict hulk: a pilotless ship with seeded battle damage (a few parts
   * shot away, many scorched) that drifts in place. Returns its entity id.
   */
  spawnWreck(bp: Blueprint, x: number, y: number, angle: number, systemId: number, seed: number): number {
    const eid = this.spawnDummy(bp, x, y, angle, systemId);
    const ship = this.bodies.get(eid)!;
    const rng = seededRng(seed);
    ship.blueprint.parts.forEach((p, i) => {
      if (p.fn === 'core') return;
      const r = rng();
      if (r < 0.07) ship.hp[i] = 0; // holes in the hull (orphaned bits drift off as debris)
      else if (r < 0.55) ship.hp[i] = ship.maxHp[i] * (0.2 + 0.55 * rng());
    });
    ship.dirty = true;
    this.rebuildNow(eid, ship);
    ship.angVel = (rng() - 0.5) * 0.0006;
    this.anchored.add(eid);
    return eid;
  }

  /** Damage multipliers: boss rage, factions' weak guns (pilots' skills no longer add damage) */
  private damageMuls = new Map<number, number>();
  setSkills(eid: number, _skills: Record<string, number>): void {
    this.setDamageScale(eid, 1);
  }

  setDamageScale(eid: number, k: number): void {
    if (k !== 1) this.damageMuls.set(eid, k);
    else this.damageMuls.delete(eid);
  }

  /** Flying in a wing (party members close by): a damage multiplier on top */
  private wing = new Map<number, number>();
  setWingBonus(eid: number, k: number): void {
    if (k !== 1) this.wing.set(eid, k);
    else this.wing.delete(eid);
  }

  wingBonus(eid: number): number {
    return this.wing.get(eid) ?? 1;
  }

  private damageMul(eid: number): number {
    return (this.damageMuls.get(eid) ?? 1) * (this.wing.get(eid) ?? 1);
  }

  /** The target each player has selected (missiles lock on to it) */
  private targets = new Map<number, number>();
  setTarget(eid: number, target: number): void {
    if (target > 0 && target !== eid) this.targets.set(eid, target);
    else this.targets.delete(eid);
  }

  /** A player's selected target, if it's still there and in the same system */
  targetOf(eid: number): number {
    const t = this.targets.get(eid);
    if (t === undefined) return -1;
    if (!this.bodies.has(t) || InSystem.systemId[t] !== InSystem.systemId[eid]) { this.targets.delete(eid); return -1; }
    return t;
  }

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

  removeShip(eid: number): void {
    if (this.bodies.has(eid)) this.removeBody(eid);
    else this.forget(eid);
  }

  /**
   * Drop everything kept about an entity id. Ids are reused once enough are
   * freed, so a new ship must never inherit a dead one's battery, heading,
   * a boss's damage scale.
   */
  private forget(eid: number): void {
    this.lastHitBy.delete(eid);
    this.intangible.delete(eid);
    this.anchored.delete(eid);
    this.pinned.delete(eid);
    this.charge.delete(eid);
    this.autopilot.delete(eid);
    this.decayAt.delete(eid);
    this.lastDamaged.delete(eid);
    this.restoreProgress.delete(eid);
    this.empUntil.delete(eid);
    this.warmth.delete(eid);
    this.weaponBeams.delete(eid);
    this.pulsing.delete(eid);
    this.pdOn.delete(eid);
    this.replicaCtl.delete(eid);
    this.apHeading.delete(eid);
    this.controllers.delete(eid);
    this.damageMuls.delete(eid);
    this.wing.delete(eid);
    this.targets.delete(eid);
    this.kits.delete(eid);
    this.ghosts.delete(eid);
    this.beams.delete(eid);
    this.dormant.delete(eid);
    this.lastFired.delete(eid);
    this.ungridded.delete(eid);
    for (const [k, v] of this.targets) if (v === eid) this.targets.delete(k);
  }

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
  needsRepair(eid: number): boolean {
    const ship = this.bodies.get(eid);
    if (!ship || ship.kind !== 'ship') return false;
    return ship.hp.some((h, i) => (ship.derived.alive[i] && h < ship.maxHp[i] - 1e-6) || (!ship.derived.alive[i] && !this.isGhost(eid, i)));
  }

  /** Start a kit (another one adds to the budget and keeps the faster rate) */
  startRepairKit(eid: number, kit: { budget: number; hpPerSec: number; restoreSec: number }): void {
    const cur = this.kits.get(eid);
    const restoreTicks = Math.max(30, Math.round(kit.restoreSec * 60));
    if (cur) {
      cur.left += kit.budget;
      cur.total += kit.budget;
      cur.hpPerSec = Math.max(cur.hpPerSec, kit.hpPerSec);
      cur.restoreTicks = Math.min(cur.restoreTicks, restoreTicks);
    } else {
      this.kits.set(eid, { left: kit.budget, total: kit.budget, hpPerSec: kit.hpPerSec, restoreTicks, progress: 0, since: this.host.getTick() });
    }
    const k = this.kits.get(eid)!;
    this.host.onRepairKit?.(eid, k.left, k.total);
  }

  repairKitLeft(eid: number): number {
    return this.kits.get(eid)?.left ?? 0;
  }

  private stepRepairKits(tick: number): void {
    const step = 15;
    for (const [eid, kit] of this.kits) {
      const ship = this.bodies.get(eid);
      if (!ship || ship.kind !== 'ship' || ship.derived.root < 0) { this.kits.delete(eid); continue; }
      // A hit or moving off breaks the repair: whatever was left of the kit is wasted
      const broken = (this.lastDamaged.get(eid) ?? -1e9) > kit.since ? 'hit' : !this.isStill(eid) ? 'moved' : null;
      if (broken) {
        this.kits.delete(eid);
        this.host.onRepairKit?.(eid, 0, kit.total, broken);
        continue;
      }
      const value = (i: number) => Math.max(1, this.host.partValue?.(ship.blueprint.parts[i]) ?? 20);
      const alive = ship.derived.alive;
      let healed = false;
      // 1. Damaged parts: heal each a little, paying for the HP restored
      for (let i = 0; i < ship.hp.length && kit.left > 0; i++) {
        if (!alive[i] || ship.hp[i] >= ship.maxHp[i] - 1e-6) continue;
        const want = Math.min(ship.maxHp[i] - ship.hp[i], ship.maxHp[i] * kit.hpPerSec * step / 60);
        const cost = (value(i) * want) / ship.maxHp[i];
        const frac = Math.min(1, kit.left / Math.max(1e-6, cost));
        const got = healPart(ship, i, want * frac, this.tuning);
        kit.left -= (value(i) * got) / ship.maxHp[i];
        healed = true;
      }
      // 2. All sound: rebuild missing parts (not ghosts) one at a time, nearest the core first
      if (!healed && kit.left > 0) {
        const pick = this.nextMissing(eid, ship);
        if (pick < 0) { kit.left = 0; }
        else if (value(pick) > kit.left) { kit.left = 0; }
        else {
          kit.progress += step;
          if (kit.progress >= kit.restoreTicks) {
            kit.progress = 0;
            kit.left -= value(pick);
            restorePart(ship, pick, 1);
            ship.rebuildHp[pick] = 0;
          }
        }
      }
      if (kit.left <= 0.5) {
        this.kits.delete(eid);
        this.host.onRepairKit?.(eid, 0, kit.total);
      } else if (tick % 60 === 0) {
        this.host.onRepairKit?.(eid, kit.left, kit.total);
      }
    }
  }

  /** The missing part (not a ghost) that joins the structure, nearest the core */
  private nextMissing(eid: number, ship: ShipState): number {
    const n = ship.hp.length;
    const alive = ship.derived.alive;
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const [a, c] of this.joinsOf(ship)) { adj[a].push(c); adj[c].push(a); }
    const depth = new Array<number>(n).fill(Infinity);
    depth[ship.derived.root] = 0;
    const queue = [ship.derived.root];
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of adj[u]) if (depth[v] === Infinity) { depth[v] = depth[u] + 1; queue.push(v); }
    }
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (alive[i] || this.isGhost(eid, i) || !adj[i].some((j) => alive[j])) continue;
      if (pick < 0 || depth[i] < depth[pick]) pick = i;
    }
    return pick;
  }

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

  /**
   * Validate a blueprint against the catalog, the rules and the inventory stub. `mounting: false` for a saved ship
   * being loaded: one fitted before a weapon's mounting rules changed still flies (a refit must keep them).
   */
  validate(bp: Blueprint, opts: { mounting?: boolean } = {}): ValidationResult {
    return validateBlueprint(this.catalog, bp, this.tuning, this.inventory, opts);
  }

  /** Hangar save: swap the ship's blueprint and respawn in place at full HP. */
  respawnInPlace(eid: number, bp: Blueprint): void {
    this.ghosts.delete(eid);
    const ship = this.spawnOn(eid, bp, 'ship');
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
    this.syncHealth(eid, ship);
  }

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

  /** Nearest ship `eid` may attack within `range` of (x, y) (missile targets) */
  /** `hull`: by the distance to its hull (hullDistance), not to its centre (a boss's centre is far inside it) */
  nearestTarget(eid: number, x: number, y: number, range: number, filter?: (other: number) => boolean, hull = false): number {
    let best = -1, bd = range;
    for (const [other, ship] of this.bodies) {
      if (other === eid || ship.kind !== 'ship' || InSystem.systemId[other] !== InSystem.systemId[eid] || this.dormant.has(other)) continue;
      // Distance first: it rules out nearly everything, and the checks after it are lookups
      let d = Math.hypot(Position.x[other] - x, Position.y[other] - y);
      if (hull) {
        if (d - ship.derived.radius - this.tuning.cellSize >= bd) continue;
        d = this.hullDistance(other, x, y, bd);
      }
      if (d >= bd || this.isJumping(ship)) continue;
      if (this.host.canDamage && !this.host.canDamage(eid, other)) continue;
      if (filter && !filter(other)) continue;
      bd = d; best = other;
    }
    return best;
  }

  /** Weapon beam state for the snapshot */
  weaponBeamState(eid: number): { on: boolean; hit: number } { return sync.weaponBeamState(this.ctx, eid); }

  /** Hottest beam weapon (0..1) and whether any has overheated, for the HUD */
  heatState(eid: number): { heat: number; over: boolean } { return sync.heatState(this.ctx, eid); }

  /** Shield charge 0..1 for the snapshot (0 also without a shield) */
  shieldFraction(eid: number): number { return sync.shieldFraction(this.ctx, eid); }

  /** Proto debug key U. */
  repair(eid: number): void {
    const ship = this.bodies.get(eid);
    if (!ship || ship.kind !== 'ship') return;
    repairShip(ship);
    this.rebuildNow(eid, ship);
    this.syncHealth(eid, ship);
  }

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

  /**
   * Player weapons. Left mouse fires the guns; right mouse runs the mining
   * lasers (or fires the guns too, on a ship without any).
   */
  stepWeapons(eid: number): boolean {
    const ship = this.bodies.get(eid);
    if (!ship || ship.kind !== 'ship') return false;
    // No firing mid-jump (the guns would be left behind by their own shots), nor from inside a station
    const jumping = this.isJumping(ship) || this.isEmped(eid) || !!this.host.sheltered?.(eid);
    const hasMiners = ship.derived.miners.length > 0;
    const firing = (Input.fireLeft[eid] === 1 || (Input.fireRight[eid] === 1 && !hasMiners)) && !jumping;
    // Shots spend stored energy (energy.ts); then the mining lasers pay for their segment from what's left
    const energy = { charge: this.chargeOf(eid) };
    this.fireWeapons(eid, ship, firing, Input.targetAngle[eid], Input.cursorDist[eid], this.targetOf(eid), energy);
    if (jumping) ship.mineUntil = 0;
    const mining = payMining(ship, Input.fireRight[eid] === 1 && hasMiners && !jumping, this.host.getTick(), energy);
    this.setCharge(eid, energy.charge);
    this.stepMiners(eid, ship, mining, Input.targetAngle[eid], Input.cursorDist[eid]);
    return true;
  }

  /** Shots fired since the last snapshot (sent as fire events: see launch.ts); the server clears it */
  readonly fired: FireRecord[] = [];

  /** Mining beam state per ship, for the snapshot: on, and how far along the beam it hit */
  private beams = new Map<number, number>();

  beamState(eid: number): { on: boolean; hit: number } { return sync.beamState(this.ctx, eid); }

  /**
   * Mining lasers: each one projects a beam out of its facing edge, swivelled a
   * little towards the cursor point. The beam stops at the first asteroid or
   * hull; asteroids are mined, ship parts take a little damage.
   */
  private stepMiners(eid: number, ship: ShipState, on: boolean, aimWorld: number, aimDist: number): void {
    const mt = this.tuning.miner;
    if (!on || !mt) { this.beams.delete(eid); return; }
    const pose = this.pose(eid);
    const cs = this.tuning.cellSize;
    const gimbal = mt.gimbalDeg * Math.PI / 180;
    const aimX = pose.x + Math.cos(aimWorld) * Math.max(aimDist, mt.range);
    const aimY = pose.y + Math.sin(aimWorld) * Math.max(aimDist, mt.range);
    let nearest = 1;
    // The cutting is focused at the pulse's flare (the same curve as its look; a whole pulse still cuts what it did)
    const prof = pulseProfile(MINING_PULSE);
    const age = Math.max(0, Math.min(prof.ticks - 1, this.host.getTick() - ((ship.mineUntil ?? 0) - MINE_CYCLE)));
    const focus = prof.share[age] * prof.ticks;
    for (const m of ship.derived.miners) {
      if (m.satisfaction <= 0.01) continue;
      const [x, y] = shipPointToWorld(ship, pose, m.muzzle, cs);
      const facing = pose.angle + Math.PI / 2 + Math.atan2(m.dir[1], m.dir[0]);
      let off = Math.atan2(aimY - y, aimX - x) - facing;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      const angle = facing + Math.max(-gimbal, Math.min(gimbal, off));
      // (It reaches past its range, fading: mineFalloff)
      const range = mt.range * (1 + MINE_TAIL);
      const x1 = x + Math.cos(angle) * range, y1 = y + Math.sin(angle) * range;
      // Nearest hull along the beam (not our own)
      let shipHit: { eid: number; ship: ShipState; part: number; t: number } | null = null;
      for (const other of this.alongBeam(InSystem.systemId[eid], x, y, x1, y1, 0)) {
        const os = this.bodies.get(other);
        if (!os || other === eid || InSystem.systemId[other] !== InSystem.systemId[eid] || this.dormant.has(other) || this.intangible.has(other) || !this.nearSegment(other, os, x, y, x1, y1) || this.isJumping(os)) continue;
        if (this.host.canDamage && !this.host.canDamage(eid, other)) continue;
        const h = this.castShip(other, os, x, y, x1, y1);
        if (h && (!shipHit || h.t < shipHit.t)) shipHit = { eid: other, ship: os, ...h };
      }
      const sat = m.satisfaction;
      const rockT = this.host.mineBeam?.(eid, x, y, angle, shipHit ? shipHit.t * range : range, (mt.dps / 60) * sat * focus, m.material, m.gas, mt.range) ?? 1;
      const rockFrac = rockT * (shipHit ? shipHit.t : 1);
      if (shipHit && rockT >= 0.999) {
        // A mining laser is a poor weapon: a tenth or so of a same-grade laser
        this.hurt(shipHit.eid, shipHit.ship, shipHit.part, (mt.shipDps / 60) * outputOf(this.catalog.materials.get(m.material)) * sat * mineFalloff(shipHit.t * range, mt.range), eid,
          { hit: { type: 'thermal', pen: shooterGrade(this.catalog, { material: m.material } as never) }, at: this.worldToGrid(shipHit.eid, shipHit.ship, x + (x1 - x) * shipHit.t, y + (y1 - y) * shipHit.t) });
        nearest = Math.min(nearest, shipHit.t);
      } else {
        nearest = Math.min(nearest, rockFrac);
      }
    }
    this.beams.set(eid, nearest);
  }

  /**
   * Cool down every weapon, slew turrets towards the cursor, and fire what's
   * ready. The cursor is `aimWorld` (angle from the ship) at `aimDist`; each
   * turret aims at that point from its own pivot so the battery converges
   * (parallel fire when the distance is unknown). Fixed weapons fire straight
   * out; turrets only fire when on target and pointing through an open part
   * of their window.
   */
  private fireWeapons(eid: number, ship: ShipState, firing: boolean, aimWorld?: number, aimDist = 0, target = -1, energy?: { charge: Charge }): void {
    const tick = this.host.getTick();
    const pose = this.pose(eid);
    const def = (w: WeaponInfo) => partWeaponDef(this.tuning, w.kind, ship.blueprint.parts[w.part], w);
    let beamHit = -1;
    const beamed = new Set<number>();
    // The guns' tick (shared with the pilot's client, which fires its own shells on the same tick: guns.ts)
    const { shots, beams, pulses } = stepGuns(ship, pose, { firing, aimWorld, aimDist, energy, slow: this.coldStage(eid).guns }, tick, this.tuning);
    for (const w of beams) {
      beamed.add(w.part);
      // (A Repair Beam mends a friendly hull instead: support.ts)
      const t = def(w).heal ? this.repairBeam(eid, ship, w, def(w)) : this.fireBeam(eid, ship, w, def(w));
      beamHit = beamHit < 0 ? t : Math.min(beamHit, t);
    }
    // A pulse laser starts a pulse: it runs its course along its aim from now (a fire event with no shells tells clients when)
    for (const { w, aimQ } of pulses) {
      let list = this.pulsing.get(eid);
      if (!list) this.pulsing.set(eid, (list = []));
      list.push({ part: w.part, start: tick });
      this.fired.push({ owner: eid, tick, part: w.part, aimQ, ids: [] });
    }
    this.stepPulses(eid, ship, tick);
    // Point defence fires on its own, whatever the trigger (support.ts)
    this.pointDefence(eid, ship, pose, def);
    for (const { w, aimQ, shot, pierce } of shots) {
      const d = def(w);
      // (Surge: a full bank's Rail Driver slug goes through one more ship: surge.ts)
      const mods0 = ship.blueprint.parts[w.part].mods;
      const gunMods = pierce ? { ...mods0, add: { ...mods0?.add, pierce: (mods0?.add?.pierce ?? 0) + pierce } } : mods0;
      // Missiles lock on to the target given, or the one nearest the aim point
      let lock = -1;
      if (d.homing) {
        lock = target;
        if (lock < 0 && aimWorld !== undefined) {
          const ax = pose.x + Math.cos(aimWorld) * Math.max(aimDist, 400), ay = pose.y + Math.sin(aimWorld) * Math.max(aimDist, 400);
          lock = this.nearestTarget(eid, ax, ay, 1400, undefined, true);
        }
      }
      const round = this.host.spendAmmo?.(eid, w.kind, !d.ammo);
      const ids = this.host.fireBaseShot(eid, shot.x, shot.y, shot.angle, shot.damageScale * this.damageMul(eid) * (round?.scale ?? 1),
        { speedScale: shot.speedScale, sizeScale: shot.sizeScale, turret: shot.mount === 'turret', kind: w.kind, target: lock, seed: `${eid}:${ship.blueprint.parts[w.part].uid}`, mods: gunMods, dry: round?.dry, ammoMods: round?.mods,
          reach: d.lob ? Math.max(200, aimDist) : undefined, grade: w.grade, size: w.size, model: w.model });
      if (ids?.length && firesStraight(d)) this.fired.push({ owner: eid, tick, part: w.part, aimQ, ids, ...(round?.item ? { ammo: ammoCode(round.item) } : {}) });
    }
    if (beamHit >= 0) this.weaponBeams.set(eid, beamHit);
    else this.weaponBeams.delete(eid);
    if (shots.length || beams.length || pulses.length) this.lastFired.set(eid, tick);
    // Beam weapons cool while they aren't firing
    for (let i = 0; i < ship.heat.length; i++) {
      if (ship.heat[i] <= 0 || beamed.has(i)) continue;
      const w = ship.derived.weapons.find((x) => x.part === i);
      ship.heat[i] = Math.max(0, ship.heat[i] - (w ? def(w).coolPerSec ?? 30 : 30) / 60);
      if (ship.overheated[i] && ship.heat[i] < 30) ship.overheated[i] = false;
    }
  }

  /** Each pulse under way burns its tick's share along its gun's aim, as wide as its curve says; done, it's dropped */
  private stepPulses(eid: number, ship: ShipState, tick: number): void {
    const list = this.pulsing.get(eid);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const w = ship.derived.weapons.find((x) => x.part === p.part);
      const def = w && partWeaponDef(this.tuning, w.kind, ship.blueprint.parts[w.part], w);
      const prof = def?.pulse && pulseProfile(def.pulse);
      const age = tick - p.start;
      const tell = () => { if (p.hit && p.hit.dealt > 0) this.host.notifyDamage(p.hit.eid, p.hit.dealt, eid); p.hit = undefined; };
      // (Its gun shot away, or its pulse over)
      if (!w || !def || !prof || age >= prof.ticks) { tell(); list.splice(i, 1); continue; }
      this.pulseHit = null;
      this.fireBeam(eid, ship, w, def, { damage: (def.damage ?? 0) * prof.share[age], width: (def.width ?? 0) * prof.width[age] });
      // The damage it does is told once a pulse (or when it swings on to another ship)
      const h = this.pulseHit as { eid: number; dealt: number } | null;
      if (h) {
        if (p.hit && p.hit.eid !== h.eid) tell();
        p.hit = { eid: h.eid, dealt: (p.hit?.dealt ?? 0) + h.dealt };
      }
      if (age === prof.ticks - 1) tell();
    }
    if (!list.length) this.pulsing.delete(eid);
  }

  /**
   * One tick of a beam weapon: out of its muzzle along its aim, it burns the
   * first hull (more against armour for the lance) or asteroid it meets, and
   * heats up; at 100 it overheats and must cool. Returns how far along it hit.
   * A pulse laser's tick (`pulse`) burns its share of the pulse, that wide, and doesn't heat.
   */
  private fireBeam(eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, pulse?: { damage: number; width: number }): number {
    const pose = this.pose(eid);
    const cs = this.tuning.cellSize;
    let muzzle = w.muzzle, dir = w.dir;
    if (w.mount === 'turret' && w.window) {
      const a = w.window.center + ship.aim[w.part];
      dir = [Math.cos(a), Math.sin(a)];
      muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
    } else if (ship.aim[w.part]) {
      const a = Math.atan2(dir[1], dir[0]) + ship.aim[w.part];
      dir = [Math.cos(a), Math.sin(a)];
    }
    const [x, y] = shipPointToWorld(ship, pose, muzzle, cs);
    const [dx, dy] = localToWorldDir(dir, pose.angle);
    const angle = Math.atan2(dy, dx);
    const range = def.range ?? 800;
    const x1 = x + Math.cos(angle) * range, y1 = y + Math.sin(angle) * range;
    // (A hostile's beam burns at its kind's npcScale: the laser was made better for pilots, not for the scrap that fires it)
    const npc = hasComponent(this.host.world, Player, eid) ? 1 : def.npcScale ?? 1;
    const dmg = (pulse ? pulse.damage : (def.dps ?? 50) / 60) * Math.max(w.satisfaction, this.tuning.flow.minWeaponSatisfaction) * w.strength * this.damageMul(eid) * npc;
    let shipHit: { eid: number; ship: ShipState; part: number; t: number } | null = null;
    // It burns `width` wide: a hull that close to its line is hit (its edges are tried when the line itself misses)
    const half = (pulse ? pulse.width : def.width ?? 0) / 2;
    for (const other of this.alongBeam(InSystem.systemId[eid], x, y, x1, y1, half)) {
      const os = this.bodies.get(other);
      if (!os || other === eid || InSystem.systemId[other] !== InSystem.systemId[eid] || this.isJumping(os) || this.intangible.has(other) || this.dormant.has(other)) continue;
      if (!this.nearSegment(other, os, x, y, x1, y1, half)) continue;
      if (this.host.canDamage && !this.host.canDamage(eid, other)) continue;
      // (Its whole width against the parts' real shapes: a capsule, collide.ts)
      const h = this.castShip(other, os, x, y, x1, y1, half);
      if (h && (!shipHit || h.t < shipHit.t)) shipHit = { eid: other, ship: os, ...h };
    }
    // A surface's rock stops it before anything behind
    const wall = rayTerrain(this.host.terrainAt?.(eid), x, y, x1, y1);
    if (shipHit && shipHit.t > wall) shipHit = null;
    const rockT = Math.min(wall, this.host.beamAsteroid?.(eid, x, y, angle, shipHit ? shipHit.t * range : range * wall, dmg, w.kind) ?? 1);
    // (Mobs along its line burn too, up to whatever stops it: they don't stop it themselves)
    if (this.host.beamMobs) {
      const stop = rockT * (shipHit ? shipHit.t : 1);
      this.host.beamMobs(InSystem.systemId[eid], x, y, x + (x1 - x) * stop, y + (y1 - y) * stop, half * 2, dmg * beamFalloff(def, stop * range * 0.5), eid);
    }
    if (!pulse) {
      ship.heat[w.part] = Math.min(100, ship.heat[w.part] + ((def.heatPerSec ?? 20) / 60) * (this.host.hazardScale?.(eid, 'heat') ?? 1));
      if (ship.heat[w.part] >= 100) ship.overheated[w.part] = true;
    }
    if (shipHit && rockT >= 0.999) {
      if (def.chill) {
        // Each tick on a ship takes its warmth (frozen through from warm in holdTicks), and frozen through it seizes up
        this.frostHit(shipHit.eid, 1 / def.chill.holdTicks, def.chill.ticks);
      }
      const armor = shipHit.ship.blueprint.parts[shipHit.part].fn === 'armor' ? def.armorBonus ?? 1 : 1;
      // Past its effective range a fading beam (the laser's) burns ever weaker, out to where it gives out (pulse.ts beamFalloff)
      const fade = beamFalloff(def, shipHit.t * range);
      const at = this.worldToGrid(shipHit.eid, shipHit.ship, x + (x1 - x) * shipHit.t, y + (y1 - y) * shipHit.t);
      const dealt = this.hurt(shipHit.eid, shipHit.ship, shipHit.part, dmg * armor * fade, eid, { hit: weaponHit(w.kind, def, shooterGrade(this.catalog, ship.blueprint.parts[w.part])), at });
      if (pulse) this.pulseHit = { eid: shipHit.eid, dealt };
      else if (dealt > 0 && this.host.getTick() % 10 === 0) this.host.notifyDamage(shipHit.eid, dealt * 10, eid);
      return shipHit.t;
    }
    return rockT * (shipHit ? shipHit.t : 1);
  }

  // -------------------------------------------------------------------------
  // Support weapons: the Repair Beam and point defence (common/src/ships/support.ts)
  // -------------------------------------------------------------------------

  /** A beam's muzzle (world) and angle, along its gun's aim */
  private beamFrom(eid: number, ship: ShipState, w: WeaponInfo): { x: number; y: number; angle: number } {
    const pose = this.pose(eid);
    let muzzle = w.muzzle, dir = w.dir;
    if (w.mount === 'turret' && w.window) {
      const a = w.window.center + ship.aim[w.part];
      dir = [Math.cos(a), Math.sin(a)];
      muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
    } else if (ship.aim[w.part]) {
      const a = Math.atan2(dir[1], dir[0]) + ship.aim[w.part];
      dir = [Math.cos(a), Math.sin(a)];
    }
    const [x, y] = shipPointToWorld(ship, pose, muzzle, this.tuning.cellSize);
    const [dx, dy] = localToWorldDir(dir, pose.angle);
    return { x, y, angle: Math.atan2(dy, dx) };
  }

  /**
   * One tick of a Repair Beam: along its aim it passes through every ship it may not mend and stops on the first
   * friendly hull (or rock), mending `heal` a second into the damaged parts nearest where it lands. Never its own ship,
   * never a destroyed part. Returns how far along it stopped (0..1).
   */
  private repairBeam(eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning): number {
    const { x, y, angle } = this.beamFrom(eid, ship, w);
    const range = def.range ?? 500;
    const x1 = x + Math.cos(angle) * range, y1 = y + Math.sin(angle) * range;
    const half = (def.width ?? 0) / 2, sys = InSystem.systemId[eid];
    let hit: { eid: number; ship: ShipState; part: number; t: number } | null = null;
    for (const other of this.alongBeam(sys, x, y, x1, y1, half)) {
      const os = this.bodies.get(other);
      if (!os || other === eid || os.kind !== 'ship' || InSystem.systemId[other] !== sys || this.isJumping(os) || this.intangible.has(other) || this.dormant.has(other)) continue;
      if (!this.host.canHeal?.(eid, other) || !this.nearSegment(other, os, x, y, x1, y1, half)) continue;
      const h = this.castShip(other, os, x, y, x1, y1, half);
      if (h && (!hit || h.t < hit.t)) hit = { eid: other, ship: os, ...h };
    }
    const wall = rayTerrain(this.host.terrainAt?.(eid), x, y, x1, y1);
    if (!hit || hit.t > wall) return wall;
    const amount = ((def.heal ?? 0) / 60) * Math.max(w.satisfaction, this.tuning.flow.minWeaponSatisfaction) * w.strength;
    const at = this.worldToGrid(hit.eid, hit.ship, x + (x1 - x) * hit.t, y + (y1 - y) * hit.t);
    const healed = repairAt(hit.ship, this.geometry(hit.ship), at[0], at[1], amount, this.tuning);
    if (healed > 0) this.host.onHeal?.(eid, hit.eid, healed);
    return hit.t;
  }

  /** Point defence's shots in reach this tick (reused), and what each turret is on (ship -> part -> shot) */
  private pdList: { id: number; x: number; y: number; d: number }[] = [];
  private pdOn = new Map<number, Map<number, number>>();

  /**
   * Point-defence turrets: each turns to the nearest shot in reach it can bring to bear on (staying on the one it's on
   * while it can), and fires when it's on it and loaded, each hit instant. Quiet mid-jump, EMP'd or inside a station,
   * when they turn back to rest.
   */
  private pointDefence(eid: number, ship: ShipState, pose: { x: number; y: number; angle: number }, def: (w: WeaponInfo) => WeaponTuning): void {
    let listed = false, on = this.pdOn.get(eid);
    const quiet = this.isJumping(ship) || this.isEmped(eid) || !!this.host.sheltered?.(eid) || !this.host.pdThreats || !this.host.intercept;
    for (const w of ship.derived.weapons) {
      const d = def(w);
      if (!d.pointDefence || !w.window) continue;
      const pd = pointDefenceOf(d);
      if (!listed && !quiet) {
        this.host.pdThreats!(eid, pose.x, pose.y, pd.range + ship.derived.radius, this.pdList);
        listed = true;
      }
      const win = w.window;
      const [px, py] = shipPointToWorld(ship, pose, win.pivot, this.tuning.cellSize);
      const reach = pd.range;
      // (Local angle to a point, and whether it can fire that way: in its arc, and not through its own hull)
      const local = (tx: number, ty: number) => Math.atan2(ty - py, tx - px) - (pose.angle + Math.PI / 2);
      const bears = (a: number) => { const off = wrapPi(a - win.center); return (win.half >= Math.PI - 1e-9 || Math.abs(off) <= win.half) && isOpen(win, off); };
      let pick: { id: number; x: number; y: number } | null = null;
      if (!quiet && this.pdList.length) {
        const was = on?.get(w.part);
        for (const t of this.pdList) {
          if (Math.hypot(t.x - px, t.y - py) > reach || !bears(local(t.x, t.y))) continue;
          if (t.id === was) { pick = t; break; }
          if (!pick) pick = t;
        }
      }
      if (pick) { if (!on) this.pdOn.set(eid, (on = new Map())); on.set(w.part, pick.id); } else on?.delete(w.part);
      const res = stepPointDefenceAim(win, ship.aim[w.part], pick ? local(pick.x, pick.y) : undefined, this.tuning, pd.slew);
      ship.aim[w.part] = res.offset;
      if (!pick || !res.canFire || ship.cooldown[w.part] > 0) continue;
      // From its barrel's tip, instantly: one of the shot's hits
      const a = win.center + res.offset;
      const [mx, my] = shipPointToWorld(ship, pose, [win.pivot[0] + Math.cos(a) * win.barrel, win.pivot[1] + Math.sin(a) * win.barrel], this.tuning.cellSize);
      const cd = ship.cooldown[w.part];
      ship.cooldown[w.part] = (cd > -1 ? cd : 0) + w.interval * (this.coldStage(eid).guns ?? 1);
      const target = pick.id;
      if (this.host.intercept!(eid, w.part, target, mx, my)) {
        const i = this.pdList.findIndex((t) => t.id === target);
        if (i >= 0) this.pdList.splice(i, 1);
        on?.delete(w.part);
      }
      this.lastFired.set(eid, this.host.getTick());
    }
    if (on && !on.size) this.pdOn.delete(eid);
  }

  /**
   * The bodies a beam might meet: the host's broadphase (ships filed by their
   * bounding circles when the tick began, so padded by how far one can have
   * moved since), or every body
   */
  private alongBeam(systemNum: number, x0: number, y0: number, x1: number, y1: number, half: number): Iterable<number> {
    const near = this.host.shipsAlong?.(systemNum, x0, y0, x1, y1, half + BEAM_PAD);
    if (!near) return this.bodies.keys();
    // (and what's come or been moved since it was filed: spawned this tick, a boss's blink)
    if (!this.ungridded.size) return near;
    const out = [...near];
    for (const e of this.ungridded) out.push(e);
    return out;
  }

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
  private nearSegment(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): boolean {
    const px = Position.x[eid], py = Position.y[eid];
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
    return Math.hypot(x0 + dx * u - px, y0 + dy * u - py) <= ship.derived.radius + 1 + margin;
  }

  /**
   * First part touched by a world-space segment, `margin` thick either side
   * (a beam's half-width, a great orb's radius: 0 for a line), against the
   * parts' real shapes in the ship's local grid space (collide.ts castParts).
   */
  segmentHit(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null {
    if (!this.nearSegment(eid, ship, x0, y0, x1, y1, margin)) return null;
    return this.castShip(eid, ship, x0, y0, x1, y1, margin);
  }

  /** The ship being cast against (castShip's standing test, without a closure per call) */
  private castOn: ShipState | null = null;
  private readonly castOk = (i: number): boolean => standing(this.catalog, this.castOn!, i);

  /** segmentHit without its bounding-circle test (for callers that have just made it) */
  private castShip(eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null {
    const a = this.worldToGrid(eid, ship, x0, y0);
    const b = this.worldToGrid(eid, ship, x1, y1);
    this.castOn = ship;
    // (shots pass through bones and wrecks: stages.ts standing)
    const h = castParts(this.geometry(ship), this.castOk, a[0], a[1], b[0], b[1], margin / this.tuning.cellSize);
    this.castOn = null;
    return h;
  }

  /**
   * What takes a hit meant for `part` (a boss's stages: stages.ts): itself if it's standing in the stage being fought;
   * otherwise (a later stage's, or a wreck) the nearest part standing in that stage, one that decides it if any does;
   * -1 if nothing stands (between stages). Nearest to where it struck (`at`, grid space) by each part's own outline,
   * when that's known: so a shot at a boss's back goes to the plate nearest that spot (not one by its middle, the
   * first of two equally near: the left one, always); else to the struck part's middle.
   */
  private cover(ship: ShipState, part: number, at?: Vec2): number {
    if (!stageOf(this.catalog, ship, part)) return part;
    const first = currentStage(this.catalog, ship);
    if (!first) return -1;
    if (stageOf(this.catalog, ship, part) === first && standing(this.catalog, ship, part)) return part;
    // One blast's parts, all from the same point (coverMemo): while the part the last went to still stands, it's the
    // nearest still (in the blast nothing heals or moves, so the parts standing only ever get fewer)
    const memo = this.coverMemo?.ship === ship && this.coverMemo.at === at ? this.coverMemo : null;
    if (memo && memo.first === first && memo.best >= 0 && standing(this.catalog, ship, memo.best)) return memo.best;
    const geoms = this.geometry(ship), [cx, cy] = at ?? geoms[part].centroid;
    let best = -1, bd = Infinity;
    // (That stage's parts, in part order: the first of two equally near wins)
    for (const i of stageParts(this.catalog, ship, first)) {
      const g = geoms[i];
      if (!g || !standing(this.catalog, ship, i)) continue;
      const d = (at ? partDistance(g, cx, cy) : Math.hypot(g.centroid[0] - cx, g.centroid[1] - cy)) + (deciding(this.catalog, ship, i) ? 0 : 1e6);
      if (d < bd) { bd = d; best = i; }
    }
    if (memo) { memo.first = first; memo.best = best; }
    return best;
  }

  /** The ship part under a world point (debug key K). */
  partAt(x: number, y: number): { eid: number; part: number } | null {
    for (const [eid, ship] of this.bodies) {
      const g = this.worldToGrid(eid, ship, x, y);
      const geoms = this.geometry(ship);
      for (let i = 0; i < geoms.length; i++) {
        if (ship.derived.alive[i] && geoms[i].convex.some((c) => pointInConvex(c, g[0], g[1]))) return { eid, part: i };
      }
    }
    return null;
  }

  damagePartFraction(eid: number, part: number, fraction: number): void {
    const ship = this.bodies.get(eid);
    if (!ship) return;
    damagePart(ship, part, ship.maxHp[part] * fraction, this.tuning);
  }

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
  private joinsOf(ship: ShipState): [number, number][] {
    let j = this.joinCache.get(ship.blueprint);
    if (!j) { j = computeJoins(this.geometry(ship)); this.joinCache.set(ship.blueprint, j); }
    return j;
  }

  private partWorld(eid: number, ship: ShipState, part: number): Vec2 {
    return shipPointToWorld(ship, this.pose(eid), this.geometry(ship)[part].centroid, this.tuning.cellSize);
  }

  private partDeaths(eid: number, ship: ShipState, tick: number): boolean { return dmg.partDeaths(this.ctx, eid, ship, tick); }

  /** Damage every intact part within the blast radius (any body), falling off with distance. */
  private applyBlast(b: PendingBlast): void { return dmg.applyBlast(this.ctx, b); }

  /**
   * Debris has no core holding it together: each part crumbles away at its own
   * time (spread around decayTicks), and what is left splits as it goes.
   */
  private decay(eid: number, ship: ShipState, tick: number): void {
    let at = this.decayAt.get(eid);
    if (!at) {
      const life = this.tuning.debris.decayTicks ?? 1200;
      const rng = seededRng(hashInts(eid, ship.spawnTick, 77));
      at = ship.hp.map(() => tick + Math.round(life * (0.25 + rng())));
      this.decayAt.set(eid, at);
    }
    at.forEach((t, i) => {
      if (tick < t || ship.hp[i] <= 0 || ship.detached[i]) return;
      damagePart(ship, i, Infinity, this.tuning);
      this.crumbled.add(`${eid}:${i}`);
    });
  }

  /**
   * Near a station (and not hit recently): heal every damaged part a little, and
   * regrow missing parts one at a time, nearest the core first. A part can only
   * come back where it joins something still attached, so ships rebuild from
   * the core outwards.
   */
  private repairStep(eid: number, ship: ShipState, tick: number): void {
    const rp = this.tuning.repair!;
    if (ship.kind !== 'ship' || ship.derived.root < 0) return;
    if (tick - (this.lastDamaged.get(eid) ?? -1e9) < rp.combatPauseTicks) return;
    if (!this.host.nearRepairSite?.(eid)) { this.restoreProgress.delete(eid); return; }
    const alive = ship.derived.alive;
    let heal = rp.healPerSecond * rp.intervalTicks / 60;
    // The owner pays for what the crews mend
    if (this.host.payRepair) {
      let want = 0;
      ship.hp.forEach((hp, i) => { if (alive[i] && hp > 0 && !ship.detached[i]) want += Math.min(ship.maxHp[i] * heal, ship.maxHp[i] - hp); });
      if (want > 0) heal *= this.host.payRepair(eid, want);
    }
    if (heal > 0) ship.hp.forEach((_, i) => { if (alive[i]) healPart(ship, i, ship.maxHp[i] * heal, this.tuning); });

    // Missing parts that join the attached structure, by distance (in joins) from the core
    const n = ship.hp.length;
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const [a, c] of this.joinsOf(ship)) { adj[a].push(c); adj[c].push(a); }
    const depth = new Array<number>(n).fill(Infinity);
    depth[ship.derived.root] = 0;
    const queue = [ship.derived.root];
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of adj[u]) if (depth[v] === Infinity) { depth[v] = depth[u] + 1; queue.push(v); }
    }
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (alive[i] || !adj[i].some((j) => alive[j]) || this.isGhost(eid, i)) continue;
      if (pick < 0 || depth[i] < depth[pick]) pick = i;
    }
    if (pick < 0) { this.restoreProgress.delete(eid); return; }
    const progress = (this.restoreProgress.get(eid) ?? 0) + rp.intervalTicks;
    if (progress < rp.restoreTicks) { this.restoreProgress.set(eid, progress); return; }
    // Ready: the owner pays the rebuild bill (or it waits, ready, until they can)
    if (this.host.payRebuild && !this.host.payRebuild(eid, pick)) { this.restoreProgress.set(eid, progress); return; }
    this.restoreProgress.set(eid, 0);
    restorePart(ship, pick, rp.restoreHp);
    // Not "freshly destroyed" if it is lost again before the rebuild
    ship.rebuildHp[pick] = 0;
  }

  // -------------------------------------------------------------------------
  // Rebuild, detachment and debris
  // -------------------------------------------------------------------------

  private noteRebuild(t0: number): void {
    this.stats.lastRebuildMs = this.now() - t0;
    this.stats.rebuildCount++;
  }

  private rebuildNow(eid: number, ship: ShipState): void {
    const oldCom: Vec2 = ship.derived.com;
    // (Its circuits may split or join: each store keeps what it held, energy.ts remapCharge)
    const before = ship.derived;
    const pose = this.pose(eid);
    const t0 = this.now();
    rebuildShip(ship, this.catalog, this.tuning);
    this.noteRebuild(t0);

    // Orphaned groups leave as debris (for a ship with no core, that's everything)
    const groups = ship.derived.orphanGroups;
    if (groups.length) {
      // (what breaks off debris only to be seen is only to be seen too)
      groups.forEach((g, k) => { const d = this.spawnDebris(eid, ship, g, oldCom, pose, k); if (this.intangible.has(eid)) this.intangible.add(d); });
      for (const g of groups) for (const i of g) ship.detached[i] = true;
      rebuildShip(ship, this.catalog, this.tuning);
    }
    const held = this.charge.get(eid);
    if (held) this.setCharge(eid, remapCharge(before, ship.derived, held));

    // Core loss (or debris shot to nothing): every part has already left as debris
    if (ship.derived.root < 0) {
      if (hasComponent(this.host.world, Player, eid)) {
        // The existing death/respawn flow takes over: health 0 → Dead → respawn.
        // The empty body stays until then so nothing else draws in its place.
        Health.current[eid] = 0;
      } else {
        this.host.onShipDestroyed?.(eid, this.lastHitBy.get(eid), ship);
        this.removeBody(eid);
      }
      return;
    }

    // Keep the remaining parts where they were: the centre of mass moved in grid space
    const newCom = ship.derived.com;
    if (newCom[0] !== oldCom[0] || newCom[1] !== oldCom[1]) {
      const cs = this.tuning.cellSize;
      const [wx, wy] = localToWorldDir([(newCom[0] - oldCom[0]) * cs, (newCom[1] - oldCom[1]) * cs], pose.angle);
      Position.x[eid] += wx;
      Position.y[eid] += wy;
    }
    Radius.value[eid] = Math.max(1, ship.derived.radius);
  }

  /**
   * Groups of parts leave a ship whole, each group a debris body of its own (a boss shedding its carapace, a wing
   * breaking away); whatever then hangs off nothing goes too. `fling`: each thrown out from its middle this fast (a
   * boss blowing apart); `crumble`: each crumbles away within this many ticks (not left lying about); `intangible`:
   * only to be seen (nothing hits it, it hits nothing)
   */
  shed(eid: number, groups: number[][], fling = 0, crumble = 0, intangible = false): void {
    const ship = this.bodies.get(eid);
    if (!ship) return;
    const live = groups.map((g) => g.filter((i) => ship.derived.alive[i])).filter((g) => g.length);
    if (!live.length) return;
    const pose = this.pose(eid), com = ship.derived.com;
    live.forEach((g, k) => { const d = this.spawnDebris(eid, ship, g, com, pose, k, fling, crumble); if (intangible) this.intangible.add(d); });
    for (const g of live) for (const i of g) ship.detached[i] = true;
    this.rebuildNow(eid, ship);
  }

  /** A connected group of parts leaves `ship` as a new debris body built from the same parts and HP. */
  private spawnDebris(parentEid: number, ship: ShipState, group: number[], parentCom: Vec2, pose: { x: number; y: number; angle: number }, k: number, fling = 0, crumble = 0): number {
    const parts = group.map((i) => ship.blueprint.parts[i]);
    const hp = group.map((i) => ship.hp[i]);
    const bp: Blueprint = { name: `${ship.blueprint.name} debris`, catalogVersion: ship.blueprint.catalogVersion, parts };
    const eid = this.host.createBody();
    InSystem.systemId[eid] = InSystem.systemId[parentEid]; // debris stays in its ship's system
    const rng = seededRng(hashInts(parentEid, this.host.getTick(), k));
    const debris = this.spawnOn(eid, bp, 'debris', hp, ship.angVel + (rng() - 0.5) * 2 * this.tuning.debris.pushSpin);
    // Debris breaking up further keeps its parts' crumble times
    const parentDecay = this.decayAt.get(parentEid);
    if (parentDecay) this.decayAt.set(eid, group.map((i) => parentDecay[i]));
    if (crumble > 0) { const now = this.host.getTick(); this.decayAt.set(eid, group.map(() => now + Math.round(crumble * (0.5 + 0.5 * rng())))); }

    const cs = this.tuning.cellSize;
    const [rx, ry] = localToWorldDir([(debris.derived.com[0] - parentCom[0]) * cs, (debris.derived.com[1] - parentCom[1]) * cs], pose.angle);
    Position.x[eid] = pose.x + rx;
    Position.y[eid] = pose.y + ry;
    Rotation.angle[eid] = pose.angle;
    // Parent's velocity at the group's centre of mass, plus a small seeded push
    const push = this.tuning.debris.pushSpeed * (0.5 + rng());
    const dir = rng() * Math.PI * 2;
    Velocity.x[eid] = Velocity.x[parentEid] - ship.angVel * ry + Math.cos(dir) * push;
    Velocity.y[eid] = Velocity.y[parentEid] + ship.angVel * rx + Math.sin(dir) * push;
    if (fling > 0) {
      const l = Math.hypot(rx, ry) || 1, f = fling * (0.6 + 0.8 * rng());
      Velocity.x[eid] += (rx / l) * f;
      Velocity.y[eid] += (ry / l) * f;
    }
    return eid;
  }

  private removeBody(eid: number): void {
    this.bodies.delete(eid);
    this.forget(eid);
    for (const k of this.contactFx.keys()) if (k.startsWith(`${eid}:`) || k.endsWith(`:${eid}`)) this.contactFx.delete(k);
    this.host.removeBody(eid);
  }

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
