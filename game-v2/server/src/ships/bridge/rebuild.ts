/**
 * ShipBridge rebuild: a ship's body coming and going. Its geometry (cached per blueprint), spawning (spawnOn,
 * dummies, wrecks, players), removal (removeShip, forget, removeBody), the rebuild after parts are lost (rebuildNow,
 * shed, spawnDebris, decay), and repair (kits, station repair, respawnInPlace). ShipBridge keeps one-line delegators with the same names.
 *
 * Modules reach each other through the bridge (b.hurt, b.rebuildNow), never by import, so they can't form a cycle.
 */

import { hasComponent } from 'bitecs';
import {
  Position, Velocity, Rotation, Radius, Health, Player, Dead, InSystem, Blueprint, ShipState, Vec2,
  validateBlueprint, ValidationResult, createShipState, rebuildShip, damagePart, repairShip, healPart, restorePart,
  computeJoins, localToWorldDir, seededRng, hashInts, shipPointToWorld, remapCharge, chargeTotal, blueprintGeometry,
  type PlacedGeom,
} from '@space-game/common';
import { type BridgeCtx } from './core.js';

/** A blueprint's placed geometry, built once per blueprint (geomCache) */
export function geometry(b: BridgeCtx, ship: ShipState): PlacedGeom[] {
  let g = b.geomCache.get(ship.blueprint);
  if (!g) {
    g = blueprintGeometry(b.catalog, ship.blueprint);
    b.geomCache.set(ship.blueprint, g);
  }
  return g;
}

export function spawnOn(b: BridgeCtx, eid: number, bp: Blueprint, kind: 'ship' | 'debris', hp?: number[], angVel = 0): ShipState {
  const t0 = b.now();
  const ship = createShipState(b.catalog, b.tuning, eid, bp, b.host.getTick(), { kind, hp, angVel });
  b.noteRebuild(t0);
  // A new ship on a body that had one (a refit, a swap): its stores start as full, all told, as the old one's were
  const was = b.bodies.get(eid), had = b.charge.get(eid);
  if (was && had && ship.derived.power) {
    const p = chargeTotal(was.derived, had);
    b.charge.set(eid, { g: p, b: ship.derived.power.banks.map(() => p) });
  }
  b.bodies.set(eid, ship);
  b.ungridded.add(eid);
  Radius.value[eid] = Math.max(1, ship.derived.radius);
  return ship;
}

export function onPlayerCreated(b: BridgeCtx, eid: number): void {
  const ship = b.spawnOn(eid, b.playerBlueprint, 'ship');
  b.syncHealth(eid, ship);
}

/** A pilotless ship (debug key B). Returns its entity id. */
export function spawnDummy(b: BridgeCtx, bp: Blueprint, x: number, y: number, angle: number, systemId = 0): number {
  const eid = b.host.createBody();
  InSystem.systemId[eid] = systemId;
  Position.x[eid] = x;
  Position.y[eid] = y;
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  Rotation.angle[eid] = angle;
  b.spawnOn(eid, bp, 'ship');
  return eid;
}

/**
 * A derelict hulk: a pilotless ship with seeded battle damage (a few parts
 * shot away, many scorched) that drifts in place. Returns its entity id.
 */
export function spawnWreck(b: BridgeCtx, bp: Blueprint, x: number, y: number, angle: number, systemId: number, seed: number): number {
  const eid = b.spawnDummy(bp, x, y, angle, systemId);
  const ship = b.bodies.get(eid)!;
  const rng = seededRng(seed);
  ship.blueprint.parts.forEach((p, i) => {
    if (p.fn === 'core') return;
    const r = rng();
    if (r < 0.07) ship.hp[i] = 0; // holes in the hull (orphaned bits drift off as debris)
    else if (r < 0.55) ship.hp[i] = ship.maxHp[i] * (0.2 + 0.55 * rng());
  });
  ship.dirty = true;
  b.rebuildNow(eid, ship);
  ship.angVel = (rng() - 0.5) * 0.0006;
  b.anchored.add(eid);
  return eid;
}

export function setSkills(b: BridgeCtx, eid: number, _skills: Record<string, number>): void {
  b.setDamageScale(eid, 1);
}

export function removeShip(b: BridgeCtx, eid: number): void {
  if (b.bodies.has(eid)) b.removeBody(eid);
  else b.forget(eid);
}

/**
 * Drop everything kept about an entity id. Ids are reused once enough are
 * freed, so a new ship must never inherit a dead one's battery, heading,
 * a boss's damage scale.
 */
export function forget(b: BridgeCtx, eid: number): void {
  b.lastHitBy.delete(eid);
  b.intangible.delete(eid);
  b.anchored.delete(eid);
  b.pinned.delete(eid);
  b.charge.delete(eid);
  b.autopilot.delete(eid);
  b.decayAt.delete(eid);
  b.lastDamaged.delete(eid);
  b.restoreProgress.delete(eid);
  b.empUntil.delete(eid);
  b.warmth.delete(eid);
  b.weaponBeams.delete(eid);
  b.pulsing.delete(eid);
  b.pdOn.delete(eid);
  b.replicaCtl.delete(eid);
  b.apHeading.delete(eid);
  b.controllers.delete(eid);
  b.damageMuls.delete(eid);
  b.wing.delete(eid);
  b.targets.delete(eid);
  b.kits.delete(eid);
  b.ghosts.delete(eid);
  b.beams.delete(eid);
  b.dormant.delete(eid);
  b.lastFired.delete(eid);
  b.ungridded.delete(eid);
  b.host.shipForgotten?.(eid);
  for (const [k, v] of b.targets) if (v === eid) b.targets.delete(k);
}

/** Is there anything a repair kit could do for this ship? */
export function needsRepair(b: BridgeCtx, eid: number): boolean {
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return false;
  return ship.hp.some((h, i) => (ship.derived.alive[i] && h < ship.maxHp[i] - 1e-6) || (!ship.derived.alive[i] && !b.isGhost(eid, i)));
}

/** Start a kit (another one adds to the budget and keeps the faster rate) */
export function startRepairKit(b: BridgeCtx, eid: number, kit: { budget: number; hpPerSec: number; restoreSec: number }): void {
  const cur = b.kits.get(eid);
  const restoreTicks = Math.max(30, Math.round(kit.restoreSec * 60));
  if (cur) {
    cur.left += kit.budget;
    cur.total += kit.budget;
    cur.hpPerSec = Math.max(cur.hpPerSec, kit.hpPerSec);
    cur.restoreTicks = Math.min(cur.restoreTicks, restoreTicks);
  } else {
    b.kits.set(eid, { left: kit.budget, total: kit.budget, hpPerSec: kit.hpPerSec, restoreTicks, progress: 0, since: b.host.getTick() });
  }
  const k = b.kits.get(eid)!;
  b.host.onRepairKit?.(eid, k.left, k.total);
}

export function repairKitLeft(b: BridgeCtx, eid: number): number {
  return b.kits.get(eid)?.left ?? 0;
}

export function stepRepairKits(b: BridgeCtx, tick: number): void {
  const step = 15;
  for (const [eid, kit] of b.kits) {
    const ship = b.bodies.get(eid);
    if (!ship || ship.kind !== 'ship' || ship.derived.root < 0) { b.kits.delete(eid); continue; }
    // A hit or moving off breaks the repair: whatever was left of the kit is wasted
    const broken = (b.lastDamaged.get(eid) ?? -1e9) > kit.since ? 'hit' : !b.isStill(eid) ? 'moved' : null;
    if (broken) {
      b.kits.delete(eid);
      b.host.onRepairKit?.(eid, 0, kit.total, broken);
      continue;
    }
    const value = (i: number) => Math.max(1, b.host.partValue?.(ship.blueprint.parts[i]) ?? 20);
    const alive = ship.derived.alive;
    let healed = false;
    // 1. Damaged parts: heal each a little, paying for the HP restored
    for (let i = 0; i < ship.hp.length && kit.left > 0; i++) {
      if (!alive[i] || ship.hp[i] >= ship.maxHp[i] - 1e-6) continue;
      const want = Math.min(ship.maxHp[i] - ship.hp[i], ship.maxHp[i] * kit.hpPerSec * step / 60);
      const cost = (value(i) * want) / ship.maxHp[i];
      const frac = Math.min(1, kit.left / Math.max(1e-6, cost));
      const got = healPart(ship, i, want * frac, b.tuning);
      kit.left -= (value(i) * got) / ship.maxHp[i];
      healed = true;
    }
    // 2. All sound: rebuild missing parts (not ghosts) one at a time, nearest the core first
    if (!healed && kit.left > 0) {
      const pick = b.nextMissing(eid, ship);
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
      b.kits.delete(eid);
      b.host.onRepairKit?.(eid, 0, kit.total);
    } else if (tick % 60 === 0) {
      b.host.onRepairKit?.(eid, kit.left, kit.total);
    }
  }
}

/** The missing part (not a ghost) that joins the structure, nearest the core */
export function nextMissing(b: BridgeCtx, eid: number, ship: ShipState): number {
  const n = ship.hp.length;
  const alive = ship.derived.alive;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, c] of b.joinsOf(ship)) { adj[a].push(c); adj[c].push(a); }
  const depth = new Array<number>(n).fill(Infinity);
  depth[ship.derived.root] = 0;
  const queue = [ship.derived.root];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj[u]) if (depth[v] === Infinity) { depth[v] = depth[u] + 1; queue.push(v); }
  }
  let pick = -1;
  for (let i = 0; i < n; i++) {
    if (alive[i] || b.isGhost(eid, i) || !adj[i].some((j) => alive[j])) continue;
    if (pick < 0 || depth[i] < depth[pick]) pick = i;
  }
  return pick;
}

/**
 * Validate a blueprint against the catalog, the rules and the inventory stub. `mounting: false` for a saved ship
 * being loaded: one fitted before a weapon's mounting rules changed still flies (a refit must keep them).
 */
export function validate(b: BridgeCtx, bp: Blueprint, opts: { mounting?: boolean } = {}): ValidationResult {
  return validateBlueprint(b.catalog, bp, b.tuning, b.inventory, opts);
}

/** Hangar save: swap the ship's blueprint and respawn in place at full HP. */
export function respawnInPlace(b: BridgeCtx, eid: number, bp: Blueprint): void {
  b.ghosts.delete(eid);
  const ship = b.spawnOn(eid, bp, 'ship');
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  b.syncHealth(eid, ship);
}

/** Proto debug key U. */
export function repair(b: BridgeCtx, eid: number): void {
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return;
  repairShip(ship);
  b.rebuildNow(eid, ship);
  b.syncHealth(eid, ship);
}

/** Joins between every part of a blueprint, intact or not (where missing parts would reattach) */
export function joinsOf(b: BridgeCtx, ship: ShipState): [number, number][] {
  let j = b.joinCache.get(ship.blueprint);
  if (!j) { j = computeJoins(b.geometry(ship)); b.joinCache.set(ship.blueprint, j); }
  return j;
}

export function partWorld(b: BridgeCtx, eid: number, ship: ShipState, part: number): Vec2 {
  return shipPointToWorld(ship, b.pose(eid), b.geometry(ship)[part].centroid, b.tuning.cellSize);
}

/**
 * Debris has no core holding it together: each part crumbles away at its own
 * time (spread around decayTicks), and what is left splits as it goes.
 */
export function decay(b: BridgeCtx, eid: number, ship: ShipState, tick: number): void {
  let at = b.decayAt.get(eid);
  if (!at) {
    const life = b.tuning.debris.decayTicks ?? 1200;
    const rng = seededRng(hashInts(eid, ship.spawnTick, 77));
    at = ship.hp.map(() => tick + Math.round(life * (0.25 + rng())));
    b.decayAt.set(eid, at);
  }
  at.forEach((t, i) => {
    if (tick < t || ship.hp[i] <= 0 || ship.detached[i]) return;
    damagePart(ship, i, Infinity, b.tuning);
    b.crumbled.add(`${eid}:${i}`);
  });
}

/**
 * Near a station (and not hit recently): heal every damaged part a little, and
 * regrow missing parts one at a time, nearest the core first. A part can only
 * come back where it joins something still attached, so ships rebuild from
 * the core outwards.
 */
export function repairStep(b: BridgeCtx, eid: number, ship: ShipState, tick: number): void {
  const rp = b.tuning.repair!;
  if (ship.kind !== 'ship' || ship.derived.root < 0) return;
  if (tick - (b.lastDamaged.get(eid) ?? -1e9) < rp.combatPauseTicks) return;
  if (!b.host.nearRepairSite?.(eid)) { b.restoreProgress.delete(eid); return; }
  const alive = ship.derived.alive;
  let heal = rp.healPerSecond * rp.intervalTicks / 60;
  // The owner pays for what the crews mend
  if (b.host.payRepair) {
    let want = 0;
    ship.hp.forEach((hp, i) => { if (alive[i] && hp > 0 && !ship.detached[i]) want += Math.min(ship.maxHp[i] * heal, ship.maxHp[i] - hp); });
    if (want > 0) heal *= b.host.payRepair(eid, want);
  }
  if (heal > 0) ship.hp.forEach((_, i) => { if (alive[i]) healPart(ship, i, ship.maxHp[i] * heal, b.tuning); });

  // Missing parts that join the attached structure, by distance (in joins) from the core
  const n = ship.hp.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, c] of b.joinsOf(ship)) { adj[a].push(c); adj[c].push(a); }
  const depth = new Array<number>(n).fill(Infinity);
  depth[ship.derived.root] = 0;
  const queue = [ship.derived.root];
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj[u]) if (depth[v] === Infinity) { depth[v] = depth[u] + 1; queue.push(v); }
  }
  let pick = -1;
  for (let i = 0; i < n; i++) {
    if (alive[i] || !adj[i].some((j) => alive[j]) || b.isGhost(eid, i)) continue;
    if (pick < 0 || depth[i] < depth[pick]) pick = i;
  }
  if (pick < 0) { b.restoreProgress.delete(eid); return; }
  const progress = (b.restoreProgress.get(eid) ?? 0) + rp.intervalTicks;
  if (progress < rp.restoreTicks) { b.restoreProgress.set(eid, progress); return; }
  // Ready: the owner pays the rebuild bill (or it waits, ready, until they can)
  if (b.host.payRebuild && !b.host.payRebuild(eid, pick)) { b.restoreProgress.set(eid, progress); return; }
  b.restoreProgress.set(eid, 0);
  restorePart(ship, pick, rp.restoreHp);
  // Not "freshly destroyed" if it is lost again before the rebuild
  ship.rebuildHp[pick] = 0;
}

export function noteRebuild(b: BridgeCtx, t0: number): void {
  b.stats.lastRebuildMs = b.now() - t0;
  b.stats.rebuildCount++;
}

export function rebuildNow(b: BridgeCtx, eid: number, ship: ShipState): void {
  const oldCom: Vec2 = ship.derived.com;
  // (Its banks may split or join, its pool grow or shrink: each store keeps what it held, energy.ts remapCharge)
  const before = ship.derived;
  const pose = b.pose(eid);
  const t0 = b.now();
  rebuildShip(ship, b.catalog, b.tuning);
  b.noteRebuild(t0);

  // Orphaned groups leave as debris (for a ship with no core, that's everything)
  const groups = ship.derived.orphanGroups;
  if (groups.length) {
    // (what breaks off debris only to be seen is only to be seen too)
    groups.forEach((g, k) => { const d = b.spawnDebris(eid, ship, g, oldCom, pose, k); if (b.intangible.has(eid)) b.intangible.add(d); });
    for (const g of groups) for (const i of g) ship.detached[i] = true;
    rebuildShip(ship, b.catalog, b.tuning);
  }
  const held = b.charge.get(eid);
  if (held) b.setCharge(eid, remapCharge(before, ship.derived, held));

  // Core loss (or debris shot to nothing): every part has already left as debris
  if (ship.derived.root < 0) {
    if (hasComponent(b.host.world, Player, eid)) {
      // The existing death/respawn flow takes over: health 0 → Dead → respawn.
      // The empty body stays until then so nothing else draws in its place.
      Health.current[eid] = 0;
    } else {
      b.host.onShipDestroyed?.(eid, b.lastHitBy.get(eid), ship);
      b.removeBody(eid);
    }
    return;
  }

  // Keep the remaining parts where they were: the centre of mass moved in grid space
  const newCom = ship.derived.com;
  if (newCom[0] !== oldCom[0] || newCom[1] !== oldCom[1]) {
    const cs = b.tuning.cellSize;
    const [wx, wy] = localToWorldDir([(newCom[0] - oldCom[0]) * cs, (newCom[1] - oldCom[1]) * cs], pose.angle);
    Position.x[eid] += wx;
    Position.y[eid] += wy;
  }
  Radius.value[eid] = Math.max(1, ship.derived.radius);
  b.host.shipRebuilt?.(eid);
}

/**
 * Groups of parts leave a ship whole, each group a debris body of its own (a boss shedding its carapace, a wing
 * breaking away); whatever then hangs off nothing goes too. `fling`: each thrown out from its middle this fast (a
 * boss blowing apart); `crumble`: each crumbles away within this many ticks (not left lying about); `intangible`:
 * only to be seen (nothing hits it, it hits nothing)
 */
export function shed(b: BridgeCtx, eid: number, groups: number[][], fling = 0, crumble = 0, intangible = false): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  const live = groups.map((g) => g.filter((i) => ship.derived.alive[i])).filter((g) => g.length);
  if (!live.length) return;
  const pose = b.pose(eid), com = ship.derived.com;
  live.forEach((g, k) => { const d = b.spawnDebris(eid, ship, g, com, pose, k, fling, crumble); if (intangible) b.intangible.add(d); });
  for (const g of live) for (const i of g) ship.detached[i] = true;
  b.rebuildNow(eid, ship);
}

/** A connected group of parts leaves `ship` as a new debris body built from the same parts and HP. */
export function spawnDebris(b: BridgeCtx, parentEid: number, ship: ShipState, group: number[], parentCom: Vec2, pose: { x: number; y: number; angle: number }, k: number, fling = 0, crumble = 0): number {
  const parts = group.map((i) => ship.blueprint.parts[i]);
  const hp = group.map((i) => ship.hp[i]);
  const bp: Blueprint = { name: `${ship.blueprint.name} debris`, catalogVersion: ship.blueprint.catalogVersion, parts };
  const eid = b.host.createBody();
  InSystem.systemId[eid] = InSystem.systemId[parentEid]; // debris stays in its ship's system
  const rng = seededRng(hashInts(parentEid, b.host.getTick(), k));
  const debris = b.spawnOn(eid, bp, 'debris', hp, ship.angVel + (rng() - 0.5) * 2 * b.tuning.debris.pushSpin);
  // Debris breaking up further keeps its parts' crumble times
  const parentDecay = b.decayAt.get(parentEid);
  if (parentDecay) b.decayAt.set(eid, group.map((i) => parentDecay[i]));
  if (crumble > 0) { const now = b.host.getTick(); b.decayAt.set(eid, group.map(() => now + Math.round(crumble * (0.5 + 0.5 * rng())))); }

  const cs = b.tuning.cellSize;
  const [rx, ry] = localToWorldDir([(debris.derived.com[0] - parentCom[0]) * cs, (debris.derived.com[1] - parentCom[1]) * cs], pose.angle);
  Position.x[eid] = pose.x + rx;
  Position.y[eid] = pose.y + ry;
  Rotation.angle[eid] = pose.angle;
  // Parent's velocity at the group's centre of mass, plus a small seeded push
  const push = b.tuning.debris.pushSpeed * (0.5 + rng());
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

export function removeBody(b: BridgeCtx, eid: number): void {
  b.bodies.delete(eid);
  b.forget(eid);
  for (const k of b.contactFx.keys()) if (k.startsWith(`${eid}:`) || k.endsWith(`:${eid}`)) b.contactFx.delete(k);
  b.host.removeBody(eid);
}
