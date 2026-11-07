/**
 * ShipBridge flight: how bodies move. A pilot's movement step (stepMovement), the end-of-tick step (tick: pilotless
 * motion, shields, contacts, event horizons, part deaths and blasts, station repair, rebuilds, rounding), contacts
 * between bodies (resolveContacts, worldPieces, damageContact), the broadphase (addToSpatialGrid), and distant ships
 * going to sleep and waking (SimLod.ts), teleports and pins. ShipBridge keeps one-line delegators with the same names.
 *
 * tick, stepMovement, resolveContacts and worldPieces run every tick: plain functions, scratch kept at module level.
 * Sibling behaviour is reached through the bridge (b.hurt, b.fireWeapons, b.markRebuild), never by import.
 */

import { hasComponent, entityExists } from 'bitecs';
import {
  Position, Velocity, Rotation, Boost, Player, Dead, InSystem, quantizeShipBody, damagePart,
  stepDrift, NO_FIELDS, ReplicaMode, CTL, stepShip, SimShipView,
  controlBits, quantizeReplicaAngle, partWeaponDef, partMaterial, powerTick, gunLoadTick, quantizeCargo,
  chargeTotal, shieldShare, contactPieces, contactPair, quantizePull, addPull, CONTACT_FLAG, contactFxDue,
  ContactPairCache, contactPairs, cloneCharge, gunStateOf, type ContactPair, type HazardState, type OwnExtras,
  type ShipState, type GravityWell, type FlightConstants, type SimEnv, type SimEvent, type SimInput, type FieldEnv, type ShipDerived,
} from '@space-game/common';
import { K, BIG_BODY, type ContactPiece, type BridgeCtx } from './core.js';
import { ownShape } from './ownCauses.js';
import { readPilotInput } from './inputs.js';
import { dhypot } from '@space-game/common';
import { SimPass } from '../../sim/SystemClocks.js';
import { clampMove, foldClampContacts } from './clamp.js';

export function isDormant(b: BridgeCtx, eid: number): boolean {
  return b.dormant.has(eid);
}

/** Distant ships, and when each went to sleep */
export function dormantShips(b: BridgeCtx): ReadonlyMap<number, number> {
  return b.dormant;
}

export function isPinned(b: BridgeCtx, eid: number): boolean {
  return b.pinned.has(eid);
}

export function isAnchored(b: BridgeCtx, eid: number): boolean {
  return b.anchored.has(eid);
}

/**
 * Why this ship can't go distant now (null: it can): a pilot's, debris, in
 * the middle of something (hurt or shooting lately, EMP'd, burning, under
 * repair, a blast of its own pending, mid-jump, docked)
 */
export function sleepBlocker(ctx: BridgeCtx, eid: number, recentTicks: { damaged: number; fired: number }): string | null {
  const ship = ctx.bodies.get(eid);
  if (!ship) return 'gone';
  if (ship.kind !== 'ship') return 'debris';
  if (hasComponent(ctx.host.world, Player, eid)) return 'pilot';
  if (ctx.intangible.has(eid)) return 'intangible';
  const now = ctx.host.getTick();
  if (now - (ctx.lastDamaged.get(eid) ?? -Infinity) < recentTicks.damaged) return 'damaged';
  if (now - (ctx.lastFired.get(eid) ?? -Infinity) < recentTicks.fired) return 'firing';
  if (ctx.pulsing.has(eid) || ctx.weaponBeams.has(eid) || ctx.beams.has(eid)) return 'firing';
  if (ctx.isEmped(eid) || ctx.warmth.has(eid)) return 'emp';
  if (ctx.isJumping(ship)) return 'jumping';
  if (ctx.host.sheltered?.(eid)) return 'docked';
  for (const b of ctx.burns) if (b.eid === eid) return 'burning';
  for (const b of ctx.blasts) if (b.source === eid) return 'blast';
  return null;
}

/** Take a pilotless ship out of the pipeline (SimLod moves it from now on). False if it can't go now. */
export function sleep(b: BridgeCtx, eid: number, recentTicks = { damaged: 600, fired: 300 }): boolean {
  if (b.dormant.has(eid) || b.sleepBlocker(eid, recentTicks)) return false;
  b.dormant.set(eid, b.host.getTick());
  const ship = b.bodies.get(eid)!;
  // (It flies on smoothly: no spin carried into a kinematic heading, wrecks excepted)
  if (!b.anchored.has(eid)) ship.angVel = 0;
  b.replicaCtl.delete(eid);
  b.apHeading.delete(eid);
  return true;
}

/**
 * Back into the pipeline: what went on while it slept is caught up (guns'
 * cooldowns and clips, its shield, its battery), and it carries on from where
 * SimLod left it (position, velocity, heading), with every part as it was.
 */
export function wake(b: BridgeCtx, eid: number): void {
  const since = b.dormant.get(eid);
  if (since === undefined) return;
  b.dormant.delete(eid);
  // (Not in this tick's broadphase: beams look for it anyway)
  b.ungridded.add(eid);
  const ship = b.bodies.get(eid);
  if (!ship) return;
  const now = b.host.getTick(), dt = Math.max(0, now - since);
  for (let i = 0; i < ship.cooldown.length; i++) if (ship.cooldown[i] > 0) ship.cooldown[i] = Math.max(0, ship.cooldown[i] - dt);
  // (Clips reload and charges drain while it sleeps: it wakes with full clips and no charge)
  for (const w of ship.derived.weapons) {
    if (w.fire.model === 'clip' && dt > 0) { ship.rounds[w.part] = w.fire.clip ?? 0; ship.reload[w.part] = 0; }
    if (dt > 0) { ship.charge[w.part] = 0; ship.spin[w.part] = 0; }
  }
  // (At the fulfilment its shields had when it fell asleep: energy.ts shieldShare)
  const max = ship.derived.shieldMax, rate = ship.derived.shieldRegen * shieldShare(ship.derived, b.charge.get(eid));
  if (rate > 0 && max > 0 && ship.shield < max) {
    const regen = Math.max(0, now - Math.max(since, ship.shieldHitTick + ship.derived.shieldDelay));
    ship.shield = Math.min(max, ship.shield + (rate / 60) * regen);
  }
  // Its battery: spare power tops it up as it would have, a tick at a time (it's never long)
  let c = b.charge.get(eid);
  if (c) {
    for (let i = 0; i < Math.min(dt, 3600) && chargeTotal(ship.derived, c) < 100; i++) {
      c = powerTick(ship.derived, c, { thrusting: false, boosting: false }, b.tuning).charge;
    }
    b.charge.set(eid, c);
  }
  const body = b.readBody(eid, ship);
  quantizeShipBody(body);
  b.writeBody(eid, ship, body);
}

/** Where SimLod has a distant ship now (rounded as every body is: what clients would be sent) */
export function moveDistant(ctx: BridgeCtx, eid: number, b: { x: number; y: number; vx: number; vy: number; angle: number; angVel: number }): void {
  const ship = ctx.bodies.get(eid);
  if (!ship || !ctx.dormant.has(eid)) return;
  const body = { ...b, jump: ship.jump, jumpScale: ship.jumpScale };
  quantizeShipBody(body);
  ctx.writeBody(eid, ship, body);
}

/** Move a ship instantly (boss blinks) */
export function teleport(b: BridgeCtx, eid: number, x: number, y: number): void {
  if (!b.bodies.has(eid)) return;
  Position.x[eid] = x;
  Position.y[eid] = y;
  b.ungridded.add(eid);
}

/** Fix a pilotless ship where it stands (or free it): rams and blasts no longer move it */
export function pin(b: BridgeCtx, eid: number, on = true): void {
  if (on && b.bodies.has(eid)) b.pinned.set(eid, { x: Position.x[eid], y: Position.y[eid] });
  else b.pinned.delete(eid);
}

/**
 * A pull on a body's velocity that no pull field says (bridge/pullFields.ts: a Grapple gem's shell, a pull on an AI
 * ship). A pilot's is put on the PULL grid, its velocity back on its own (addPull, as every pull on a pilot is) and
 * noted as its clients' cause: they can't work it out (network/ownTick.ts PULL). Debris isn't pulled.
 */
export function push(b: BridgeCtx, eid: number, ax: number, ay: number): void {
  const ship = b.bodies.get(eid);
  if (ship?.kind === 'debris' || hasComponent(b.host.world, Dead, eid)) return;
  if (ship && hasComponent(b.host.world, Player, eid)) {
    // (While the pilotless ships step: once they all have, so none reads this tick's pull: tick)
    if (b.pushQueue) { b.pushQueue.push([eid, ax, ay]); return; }
    const dvx = quantizePull(ax), dvy = quantizePull(ay);
    PUSHED.vx = Velocity.x[eid]; PUSHED.vy = Velocity.y[eid];
    addPull(PUSHED, dvx, dvy);
    Velocity.x[eid] = PUSHED.vx; Velocity.y[eid] = PUSHED.vy;
    b.ownCauses.add(eid, { kind: 0, dvx, dvy });
    return;
  }
  Velocity.x[eid] += ax;
  Velocity.y[eid] += ay;
}

/** Is this a pilot's ship (ShipBridge.isPilot) */
export function isPilot(b: BridgeCtx, eid: number): boolean {
  return b.bodies.has(eid) && hasComponent(b.host.world, Player, eid);
}

/** Player movement. Returns false for non-ship entities so the legacy path runs. */
export function stepMovement(b: BridgeCtx, eid: number): boolean {
  // (Docking Clamps: a follower steps after its leader, bridge/clamp.ts)
  if (clampMove(b, eid)) return true;
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return false;
  const body = b.readBody(eid, ship);
  // The hold's cargo flies with it (ships/load.ts), as the pilot's prediction and every replica have it
  // (and what its part features add as load: a Tow Beam's tow, ships/features/tow)
  const had = body.cargo ?? 0;
  body.cargo = quantizeCargo((b.host.cargoMass?.(eid) ?? 0) + (b.host.featureCargo?.(eid) ?? 0));
  // (Changed since its last step, a pickup, a sale, a tow: its clients fly the new mass from this step on, CAPS.CARGO)
  if (body.cargo !== had) b.ownCauses.add(eid, { kind: 3, cargo: body.cargo });
  // One tick of the one stepper (common sim/step.ts stepShip), in place on a view of the ship: the hazard chain (the env
  // hazard, numb with cold, slowed by a Frostbite's beam, an EMP's crippled drive and no jump starting), the charging
  // fields round the flight (range boost from where it starts, a faster cooldown and a stillstone's priming from where it
  // ends), the aim on the replicated grid. The pilot's prediction (ShipClient.predict) and every replica step the same
  const tick = b.host.getTick();
  const s = MOVE_VIEW.load(eid, ReplicaMode.Player, body, ship.derived, ship, b.chargeOf(eid), true, ship.jumpPrime ?? 0);
  pilotHazards(b, eid, tick, s.hazard);
  // (Its inputs from its source: bridge/inputs.ts, the pilot's held keys off the Input component; with the aim it was
  // applied at last tick, so the step says whether that would have flown it the same: common sim/aimHold.ts)
  readPilotInput(eid, MOVE_IN);
  MOVE_IN.heldQ = ship.aimQ;
  const { isBoosting } = stepShip(s, MOVE_IN, moveEnv(b, eid, tick), s, MOVE_EVENTS);
  // (Its pulls this tick, the pull fields' (bridge/pullFields.ts), in its step after the motion: noted as its causes,
  // derived, so its shadows have them and a client that can't work one out is told it, net/Replication.ts)
  for (const e of MOVE_EVENTS) if (e.k === 'pull') { b.ownCauses.add(eid, { kind: 0, dvx: e.dvx, dvy: e.dvy, from: e.from, derived: true }); b.pulls.stats.pulls++; }
  ship.jumpPrime = s.jumpPrime;
  b.setCharge(eid, s.charge);
  // (What it flew: its keys, its hazards' bits, the engines' power and a boost the stores refused: replicas have no charge.
  // Its aim as applied (the held one where its flight would have gone the same on it; its guns weigh it next, stepWeapons)
  // and the raw one its client's inputs say)
  b.replicaCtl.set(eid, { mode: ReplicaMode.Player, q: s.ctl.q, derived: ship.derived, bits: s.ctl.bits, rawQ: MOVE_IN.q, heldQ: MOVE_IN.heldQ });
  ship.aimQ = s.ctl.q;
  b.writeBody(eid, ship, body);
  MOVE_EVENTS.length = 0;
  if (isBoosting) Boost.lastUseTick[eid] = tick;
  return true;
}

/**
 * A pilot's hazards as its step at `tick` reads them (stepMovement; ownExtras, its client's view of them): EMP'd and
 * slowed until, numb with cold (its own client steps it with the same, told by ownSync; replicas read CTL.numb)
 */
export function pilotHazards(b: BridgeCtx, eid: number, tick: number, out: HazardState): HazardState {
  out.empUntil = b.empUntil.get(eid) ?? 0;
  out.slowUntil = b.slowedUntil.size > 0 ? tick + b.slowedTicksLeft(eid) : 0;
  out.numb = b.coldStage(eid).control;
  return out;
}

/**
 * A pilot's stores, guns, hazards and priming as tick `tick` ended (now, in the snapshot after it): what its own client
 * steps the next tick from (common sim/ownStep.ts), for its head hash and an ownSync. A copy. Null: not a ship
 */
export function ownExtras(b: BridgeCtx, eid: number, tick: number): OwnExtras | null {
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return null;
  return {
    charge: cloneCharge(b.chargeOf(eid)), guns: gunStateOf(ship), jumpPrime: ship.jumpPrime ?? 0,
    hazard: pilotHazards(b, eid, tick + 1, { empUntil: 0, slowUntil: 0, numb: 1 }),
  };
}

/** stepMovement's scratch: the view, its input and env (reused every call; the step keeps none of them) */
const MOVE_VIEW = new SimShipView();
const MOVE_IN: SimInput = { bits: 0, q: 0, jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 };
/** (Its pulls' events: its guns are fireWeapons', env.gunsByHost) */
const MOVE_EVENTS: SimEvent[] = [];
/** (push's scratch) */
const PUSHED = { vx: 0, vy: 0 };
const MOVE_FIELDS: FieldEnv = { central: null };
const MOVE_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: MOVE_FIELDS, terrain: null, gunsByHost: true };
let moveEid = 0, moveB: BridgeCtx | undefined;
const moveHazard = (d: ShipDerived, x: number, y: number) => moveB!.host.hazardFlight?.(moveEid, d, x, y);
function moveEnv(b: BridgeCtx, eid: number, tick: number): SimEnv {
  const f = b.host.jumpFields?.(eid) ?? NO_FIELDS;
  MOVE_FIELDS.central = f.central; MOVE_FIELDS.lodestones = f.lodestones;
  moveB = b; moveEid = eid;
  MOVE_ENV.tick = tick; MOVE_ENV.tuning = b.tuning; MOVE_ENV.gravity = b.host.gravityAt(eid); MOVE_ENV.terrain = b.host.terrainAt?.(eid) ?? null;
  MOVE_ENV.hazard = b.host.hazardFlight ? moveHazard : undefined;
  MOVE_ENV.pulls = b.pulls?.any ? b.pulls.source : undefined;
  MOVE_ENV.clamp = b.clamps.any ? b.clamps.source : undefined;
  return MOVE_ENV;
}

export function addToSpatialGrid(b: BridgeCtx, add: (eid: number, x: number, y: number, r: number) => void): void {
  b.ungridded.clear();
  for (const [eid, ship] of b.bodies) {
    // (already in the grid as a player; only to be seen; or distant, out of every fight)
    if (hasComponent(b.host.world, Player, eid) || b.intangible.has(eid) || b.dormant.has(eid)) continue;
    add(eid, Position.x[eid], Position.y[eid], Math.max(1, ship.derived.radius));
  }
}

/**
 * The bodies as they are now, for a loop that may add or remove some: their ids and states as two lists (and 0, to
 * count from), rather than a pair for each (that was most of what such a loop cost)
 */
export function bodiesNow(b: BridgeCtx): [number[], ShipState[], number] {
  if (SimPass.all) return [[...b.bodies.keys()], [...b.bodies.values()], 0];
  // (The pass's systems only: crowd dilation, sim/SystemClocks.ts; the tick's walks are the only callers)
  const ids: number[] = [], ships: ShipState[] = [];
  for (const [eid, s] of b.bodies) if (SimPass.on(InSystem.systemId[eid])) { ids.push(eid); ships.push(s); }
  return [ids, ships, 0];
}

/** End of tick: pilotless motion, contacts, rebuilds, detachment, debris lifetime, health sync. */
export function tick(ctx: BridgeCtx): void {
  const world = ctx.host.world;
  const tick = ctx.host.getTick();
  if (tick % 10 === 0 && ctx.burns.length) ctx.stepBurns(tick);

  // 1. Prune and move everything nobody pilots (debris after, all together: ships/debris.ts)
  const debrisNow: number[] = [];
  ctx.pushQueue = [];
  for (let [ids, ships, bi] = ctx.bodiesNow(); bi < ids.length; bi++) {
    const eid = ids[bi], ship = ships[bi];
    if (!entityExists(world, eid) || hasComponent(world, Dead, eid)) {
      ctx.bodies.delete(eid);
      ctx.forget(eid);
      continue;
    }
    // Distant (SimLod moves it): nothing else happens to it
    if (ctx.dormant.has(eid)) continue;
    const gravity = ctx.host.gravityAt(eid);
    const k = gravity ? ctx.withGravity(gravity) : K;
    if (ship.kind === 'debris') {
      if (tick >= ship.despawnTick) { ctx.removeBody(eid); continue; }
      ctx.decay(eid, ship, tick);
      ctx.replicaCtl.set(eid, { mode: ReplicaMode.Drift, bits: 0, q: 0, derived: ship.derived });
      debrisNow.push(eid);
    } else if (ctx.anchored.has(eid)) {
      // Wrecks turn slowly and coast when shoved, but no well pulls them in
      ctx.replicaCtl.set(eid, { mode: ReplicaMode.Anchored, bits: 0, q: 0, derived: ship.derived });
      const body = ctx.readBody(eid, ship);
      const spin = body.angVel;
      stepDrift(body, K);
      body.angVel = spin;
      ctx.writeBody(eid, ship, body);
    } else if (!hasComponent(world, Player, eid)) {
      ctx.stepPilotless(eid, ship, k, tick);
    }
  }

  // (This tick's pulls on pilots, as they were made: none read by a ship stepping after the one that pulled)
  const pushes = ctx.pushQueue;
  ctx.pushQueue = null;
  for (const [eid, ax, ay] of pushes) ctx.push(eid, ax, ay);

  // Debris drifts and knocks into other debris (only), by the step every client runs too
  ctx.stepDebrisWorld(debrisNow);

  // Shields recharge once they've gone a while without a hit
  {
    for (const ship of ctx.bodies.values()) {
      if (ctx.dormant.has(ship.id) || !SimPass.on(InSystem.systemId[ship.id])) continue; // (caught up when it wakes; another pass's)
      const max = ship.derived.shieldMax;
      if (max <= 0) { ship.shield = 0; continue; }
      if (ship.shield > max) ship.shield = max;
      // (A ports ship's shields refill only as fast as they are fed: energy.ts shieldShare, this tick's fulfilment)
      const rate = ship.derived.shieldRegen * shieldShare(ship.derived, ctx.charge.get(ship.id));
      if (rate > 0 && ship.shield < max && tick - ship.shieldHitTick > ship.derived.shieldDelay) ship.shield = Math.min(max, ship.shield + (rate / 60) * (ctx.host.hazardScale?.(ship.id, 'shield') ?? 1));
    }
  }

  // 2. Ship-to-ship contacts (debris knocks only into debris, above)
  ctx.resolveContacts();
  foldClampContacts(ctx);

  // Past an event horizon nothing survives: every part is crushed (ships then
  // go through the normal core-loss path; debris simply vanishes)
  for (let [ids, ships, bi] = ctx.bodiesNow(); bi < ids.length; bi++) {
    const eid = ids[bi], ship = ships[bi];
    const horizon = ctx.host.gravityAt(eid)?.horizon;
    if (!horizon || dhypot(Position.x[eid], Position.y[eid]) > horizon || ctx.host.invulnerable?.(eid)) continue;
    if (ship.kind === 'debris') { ctx.removeBody(eid); continue; }
    // (A distant ship drifted in: it dies as a live one does)
    ctx.wake(eid);
    ship.hp.forEach((_, i) => { if (damagePart(ship, i, Infinity, ctx.tuning) > 0) ctx.crumbled.add(`${eid}:${i}`); });
  }

  // Destroyed parts: effects, and the ones that blow up (cores at once, so the
  // parts they leave behind carry the damage; the rest a few ticks later)
  // A blast can kill more parts, so repeat until nothing new dies this tick
  for (let pass = 0; pass < 8; pass++) {
    let more = false;
    for (let [ids, ships, bi] = ctx.bodiesNow(); bi < ids.length; bi++) if (!ctx.dormant.has(ids[bi])) more = ctx.partDeaths(ids[bi], ships[bi], tick) || more;
    for (let i = ctx.blasts.length - 1; i >= 0; i--) {
      if (ctx.blasts[i].due > tick || !SimPass.on(ctx.blasts[i].systemId)) continue;
      const b = ctx.blasts[i];
      ctx.blasts.splice(i, 1);
      ctx.applyBlast(b);
      more = true;
    }
    if (!more) break;
  }
  ctx.crumbled.clear();

  // Station repair
  const rp = ctx.tuning.repair;
  if (rp && tick % rp.intervalTicks === 0) {
    for (const [eid, ship] of ctx.bodies) if (!ctx.dormant.has(eid) && SimPass.on(InSystem.systemId[eid])) ctx.repairStep(eid, ship, tick);
  }

  // 3. The tick's one rebuild point: whatever changed a ship this tick (hits, heals, sheds, repairs, ghosts, saved
  //    HP: bridge/rebuild.ts markRebuild) rebuilds it once, here; then mirror core HP into the engine's health
  for (let [ids, ships, bi] = ctx.bodiesNow(); bi < ids.length; bi++) {
    const eid = ids[bi], ship = ships[bi];
    if (ship.dirty) ctx.rebuildMarked(eid, ship);
    if (ctx.bodies.has(eid) && hasComponent(world, Player, eid)) ctx.syncHealth(eid, ship);
  }

  // 4. Round every body to snapshot precision, so what the server holds is
  //    exactly what clients receive (client prediction replays from it)
  for (const [eid, ship] of ctx.bodies) {
    if (ctx.dormant.has(eid) || !SimPass.on(InSystem.systemId[eid])) continue; // (SimLod rounds what it writes; another pass's)
    const body = ctx.readBody(eid, ship);
    quantizeShipBody(body);
    ctx.writeBody(eid, ship, body);
  }
  // (Debris that something besides its step moved this tick: keyframes, Replication)
  ctx.debrisNet.endTick(ctx);
  let debris = 0;
  for (const s of ctx.bodies.values()) if (s.kind === 'debris') debris++;
  ctx.stats.debrisCount = debris;
}

export function withGravity(b: BridgeCtx, gravity: GravityWell): FlightConstants {
  let k = b.gravityK.get(gravity);
  if (!k) b.gravityK.set(gravity, (k = { ...K, gravity }));
  return k;
}

/**
 * World-space convex pieces of every alive part (shrunk, so parts that merely
 * touch don't collide), each with its bounding box
 */
export function worldPieces(b: BridgeCtx, eid: number, ship: ShipState, near?: { x: number; y: number; r: number }): ContactPiece[] {
  return contactPieces(b.geometry(ship), ship.derived.alive, ship.derived.com, b.tuning.cellSize, { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid] }, near);
}

/**
 * Each bridge's contact pairs by tick, a cache per pass (sim/c-contactCache.ts: found once, then read; a system with
 * a clock of its own has its own pass and ticks: SimPass)
 */
const PAIRS = new WeakMap<BridgeCtx, Map<number, ContactPairCache>>();

/**
 * Tick t's candidate pairs, every system's one after another: who can touch anything at all (none of it changes
 * while the pass runs), by id: a pair's first body is its lower id, and pairs go in that order, as a client finding
 * them itself takes them (CAPS.CONTACTS, common ships/contactPass.ts). Notes each system's pass for those clients
 */
function findPairs(ctx: BridgeCtx, tick: number): ContactPair[] {
  const list: [number, ShipState][] = [];
  for (const e of ctx.bodies) {
    if (e[1].kind !== 'debris' && e[1].derived.mass > 0 && !ctx.dormant.has(e[0]) && SimPass.on(InSystem.systemId[e[0]]) && !ctx.isJumping(e[1]) && !ctx.host.sheltered?.(e[0]) && !ctx.intangible.has(e[0])) list.push(e);
  }
  list.sort((p, q) => p[0] - q[0]);
  const bySys = new Map<number, [number, ShipState][]>();
  for (const e of list) {
    const sys = InSystem.systemId[e[0]];
    let l = bySys.get(sys);
    if (!l) bySys.set(sys, (l = []));
    l.push(e);
  }
  const log = ctx.contactLog, seq0 = ctx.ownCauses.peek();
  const pairs: ContactPair[] = [];
  for (const [sys, l] of bySys) {
    if (l.length < 2 && !log.wanted) continue;
    const entries = l.map(([id, s]) => ({ id, x: Position.x[id], y: Position.y[id], r: s.derived.radius, link: ctx.clamps.partner(id, tick) }));
    const from = pairs.length;
    if (l.length >= 2) contactPairs(entries, pairs);
    // (What a client finding its own pairs needs of this pass: net/causes/contactLog.ts)
    if (log.wanted) {
      const pinned: number[] = [], ap: number[] = [];
      for (const e of entries) if (ctx.pinned.has(e.id)) pinned.push(e.id);
      for (let k = from; k < pairs.length; k++) ap.push(pairs[k][0], pairs[k][1]);
      log.note(tick, sys, { ids: entries.map((e) => e.id), rebuilds: l.map(([, s]) => s.rebuilds), pinned, pairs: ap, seq: seq0 });
    }
  }
  return pairs;
}

/**
 * Push overlapping bodies apart, exchange an impulse along the contact
 * normal, and damage the touching parts on both sides when the closing speed
 * is high enough (scaled by the other body's share of the mass).
 *
 * Pairs are found by system, swept along x (bounding circles, padded by
 * CONTACT_MARGIN for the pushes earlier pairs make this pass: common ships/contactPass.ts), then taken in order of
 * their ships' ids, lower first, as a client finding them takes them. Pieces are only tested against
 * pieces whose bounding boxes they meet: the rest can't overlap.
 */
export function resolveContacts(ctx: BridgeCtx): void {
  const ct = ctx.tuning.collision;
  const tick = ctx.host.getTick();
  // (The tick's pairs, found once by the one function a client finding its own takes them by: sim/c-contactCache.ts)
  let caches = PAIRS.get(ctx);
  if (!caches) PAIRS.set(ctx, (caches = new Map()));
  const pass = SimPass.main ? -1 : SimPass.system;
  let cache = caches.get(pass);
  if (!cache) caches.set(pass, (cache = new ContactPairCache((t) => findPairs(ctx, t), 2)));
  const pairs = cache.pairs(tick);

  const pieces = new Map<number, ContactPiece[]>();
  // A small body's pieces are kept for the pass (until it's pushed); a big one's (a boss's) are only those near the other body
  const piecesOf = (eid: number, ship: ShipState, other: number, os: ShipState) => {
    if (ship.blueprint.parts.length > BIG_BODY) return ctx.worldPieces(eid, ship, { x: Position.x[other], y: Position.y[other], r: os.derived.radius });
    let p = pieces.get(eid);
    if (!p) { p = ctx.worldPieces(eid, ship); pieces.set(eid, p); }
    return p;
  };
  for (let k = 0; k < pairs.length; k++) {
    const [ea, eb] = pairs[k];
    const A = ctx.bodies.get(ea), B = ctx.bodies.get(eb);
    if (!A || !B) continue;
    const dx = Position.x[eb] - Position.x[ea], dy = Position.y[eb] - Position.y[ea];
    if (dhypot(dx, dy) > A.derived.radius + B.derived.radius) continue;
    const pa = piecesOf(ea, A, eb, B), pb = piecesOf(eb, B, ea, A);
    // Pinned structures don't give: whatever hits them takes all the push
    const pinA = ctx.pinned.has(ea), pinB = ctx.pinned.has(eb);
    const invA = pinA ? 0 : 1 / A.derived.mass, invB = pinB ? 0 : 1 / B.derived.mass;
    // (The bodies as they are before this pair, for a pilot's client to work its push out: common ships/contact.ts)
    const a = { x: Position.x[ea], y: Position.y[ea], vx: Velocity.x[ea], vy: Velocity.y[ea] };
    const b = { x: Position.x[eb], y: Position.y[eb], vx: Velocity.x[eb], vy: Velocity.y[eb] };
    const preA = { ...a, angle: Rotation.angle[ea] }, preB = { ...b, angle: Rotation.angle[eb] };
    const res = contactPair(pa, pb, a, b, invA, invB, ct.restitution);
    if (!res) continue;
    Position.x[ea] = a.x; Position.y[ea] = a.y;
    Position.x[eb] = b.x; Position.y[eb] = b.y;
    pieces.delete(ea);
    pieces.delete(eb);
    Velocity.x[ea] = a.vx; Velocity.y[ea] = a.vy;
    Velocity.x[eb] = b.vx; Velocity.y[eb] = b.vy;
    // Both pushed: their clients work the push out (a pilot's own ship, CAPS.OWN_SIM, network/ownTick.ts; any ship a
    // client holds, CAPS.CAUSES, network/causes.ts), told whom each touched
    const shapeA = ownShape(A, ctx.geometry(A)), shapeB = ownShape(B, ctx.geometry(B)), seq = ctx.ownCauses.next();
    ctx.ownCauses.add(ea, { kind: 1, other: eb, flags: (pinB ? CONTACT_FLAG.OTHER_PINNED : 0) | (pinA ? CONTACT_FLAG.SELF_PINNED : 0), pre: preB, self: shapeA, otherShape: shapeB, otherRebuilds: B.rebuilds, seq });
    ctx.ownCauses.add(eb, { kind: 1, other: ea, flags: CONTACT_FLAG.SECOND | (pinA ? CONTACT_FLAG.OTHER_PINNED : 0) | (pinB ? CONTACT_FLAG.SELF_PINNED : 0), pre: preA, self: shapeB, otherShape: shapeA, otherRebuilds: A.rebuilds, seq });
    const { nx, ny, at, partsA, partsB } = res;
    if (res.closing <= 0) continue; // already separating
    const closing = res.closing;
    // Sparks and a thud, at most once per pair per cooldown (a client deriving the pair draws its own: ContactWorld)
    {
      const fk = ea < eb ? `${ea}:${eb}` : `${eb}:${ea}`;
      if (contactFxDue(closing, ctx.contactFx.get(fk), tick, ctx.tuning)) {
        ctx.contactFx.set(fk, tick);
        ctx.host.notifyContact?.({ systemId: InSystem.systemId[ea], x: at[0], y: at[1], nx, ny, speed: closing, a: ea, b: eb, tick });
      }
    }
    if (closing <= ct.minDamageSpeed) continue;
    if (ctx.host.canDamage && !(ctx.host.canDamage(ea, eb) && ctx.host.canDamage(eb, ea))) continue;
    // (hostiles of one faction bump without hurting each other: hitRules.ts contactHurts)
    if (ctx.host.contactHurts && !ctx.host.contactHurts(ea, eb)) continue;
    const base = (closing - ct.minDamageSpeed) * ct.damagePerSpeed;
    const total = A.derived.mass + B.derived.mass;
    ctx.damageContact(ea, A, partsA, base * (2 * B.derived.mass / total), eb);
    ctx.damageContact(eb, B, partsB, base * (2 * A.derived.mass / total), ea);
  }
}

export function damageContact(b: BridgeCtx, eid: number, ship: ShipState, parts: Set<number>, amount: number, source: number): void {
  let dealt = 0;
  // A wedge nose turns a blow aside; brittle material shatters
  for (const p of parts) dealt += b.hurt(eid, ship, p, (amount / parts.size) * b.contactScale(ship, p), source);
  if (dealt > 0) {
    b.lastDamaged.set(eid, b.host.getTick());
    b.host.notifyDamage(eid, dealt, source);
  }
}

/** How hard a collision lands on a part: its piece's `contact` share, doubled for brittle material */
export function contactScale(b: BridgeCtx, ship: ShipState, part: number): number {
  const q = ship.blueprint.parts[part];
  const piece = b.catalog.pieces.get(q.piece);
  return (piece?.contact ?? 1) * (partMaterial(b.catalog, q)?.traits?.includes('brittle') ? 2 : 1);
}
