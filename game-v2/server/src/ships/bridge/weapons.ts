/**
 * ShipBridge weapons: what a ship's guns do each tick. Firing (stepWeapons, fireWeapons, pulses, miners), beams
 * (fireBeam, beamFrom; the Repair Beam and point defence are weapon roles of features/support), the casts that find what a beam or shot meets (alongBeam,
 * segmentHit, castShip, cover, partAt), a projectile's hit on a ship (hitProjectile), targets, and damage scaling.
 * ShipBridge keeps one-line delegators with the same names.
 *
 * Damage goes through the bridge (b.hurt), never an import of the damage module, so the modules can't form a cycle.
 */

import { rayTerrain } from '@space-game/common';
import { hasComponent } from 'bitecs';
import {
  Position, Input, Player, InSystem, Projectile, ShipState, Vec2, damagePart, weaponHit, shooterGrade, localToWorldDir,
  castParts, partDistance, pointInConvex, standing, deciding, stageOf, currentStage, stageParts, shipPointToWorld,
  WeaponInfo, WeaponTuning, firesStraight, partWeaponDef, stepGuns, ammoCode, outputOf, payMining, MINE_CYCLE,
  MINING_PULSE, MINE_TAIL, mineFalloff, type Charge, pulseProfile, beamFalloff,
} from '@space-game/common';
import { K, BEAM_PAD, GLANCING, type BridgeCtx } from './core.js';
import { fireBeamHook, tickWeaponHooks } from '../features/weapons.js';

export function lastFiredTick(b: BridgeCtx, eid: number): number {
  return b.lastFired.get(eid) ?? -Infinity;
}

export function setDamageScale(b: BridgeCtx, eid: number, k: number): void {
  if (k !== 1) b.damageMuls.set(eid, k);
  else b.damageMuls.delete(eid);
}

export function setWingBonus(b: BridgeCtx, eid: number, k: number): void {
  if (k !== 1) b.wing.set(eid, k);
  else b.wing.delete(eid);
}

export function wingBonus(b: BridgeCtx, eid: number): number {
  return b.wing.get(eid) ?? 1;
}

export function damageMul(b: BridgeCtx, eid: number): number {
  return (b.damageMuls.get(eid) ?? 1) * (b.wing.get(eid) ?? 1);
}

export function setTarget(b: BridgeCtx, eid: number, target: number): void {
  if (target > 0 && target !== eid) b.targets.set(eid, target);
  else b.targets.delete(eid);
}

/** A player's selected target, if it's still there and in the same system */
export function targetOf(b: BridgeCtx, eid: number): number {
  const t = b.targets.get(eid);
  if (t === undefined) return -1;
  if (!b.bodies.has(t) || InSystem.systemId[t] !== InSystem.systemId[eid]) { b.targets.delete(eid); return -1; }
  return t;
}

/** Nearest ship `eid` may attack within `range` of (x, y) (missile targets) */
/** `hull`: by the distance to its hull (hullDistance), not to its centre (a boss's centre is far inside it) */
export function nearestTarget(b: BridgeCtx, eid: number, x: number, y: number, range: number, filter?: (other: number) => boolean, hull = false): number {
  let best = -1, bd = range;
  for (const [other, ship] of b.bodies) {
    if (other === eid || ship.kind !== 'ship' || InSystem.systemId[other] !== InSystem.systemId[eid] || b.dormant.has(other)) continue;
    // Distance first: it rules out nearly everything, and the checks after it are lookups
    let d = Math.hypot(Position.x[other] - x, Position.y[other] - y);
    if (hull) {
      if (d - ship.derived.radius - b.tuning.cellSize >= bd) continue;
      d = b.hullDistance(other, x, y, bd);
    }
    if (d >= bd || b.isJumping(ship)) continue;
    if (b.host.canDamage && !b.host.canDamage(eid, other)) continue;
    if (filter && !filter(other)) continue;
    bd = d; best = other;
  }
  return best;
}

/**
 * Player weapons. Left mouse fires the guns; right mouse runs the mining
 * lasers (or fires the guns too, on a ship without any).
 */
export function stepWeapons(b: BridgeCtx, eid: number): boolean {
  const ship = b.bodies.get(eid);
  if (!ship || ship.kind !== 'ship') return false;
  // No firing mid-jump (the guns would be left behind by their own shots), nor from inside a station
  const jumping = b.isJumping(ship) || b.isEmped(eid) || !!b.host.sheltered?.(eid);
  const hasMiners = ship.derived.miners.length > 0;
  const firing = (Input.fireLeft[eid] === 1 || (Input.fireRight[eid] === 1 && !hasMiners)) && !jumping;
  // Shots spend stored energy (energy.ts); then the mining lasers pay for their segment from what's left
  const energy = { charge: b.chargeOf(eid) };
  b.fireWeapons(eid, ship, firing, Input.targetAngle[eid], Input.cursorDist[eid], b.targetOf(eid), energy);
  if (jumping) ship.mineUntil = 0;
  const mining = payMining(ship, Input.fireRight[eid] === 1 && hasMiners && !jumping, b.host.getTick(), energy);
  b.setCharge(eid, energy.charge);
  b.stepMiners(eid, ship, mining, Input.targetAngle[eid], Input.cursorDist[eid]);
  return true;
}

/**
 * Mining lasers: each one projects a beam out of its facing edge, swivelled a
 * little towards the cursor point. The beam stops at the first asteroid or
 * hull; asteroids are mined, ship parts take a little damage.
 */
export function stepMiners(b: BridgeCtx, eid: number, ship: ShipState, on: boolean, aimWorld: number, aimDist: number): void {
  const mt = b.tuning.miner;
  if (!on || !mt) { b.beams.delete(eid); return; }
  const pose = b.pose(eid);
  const cs = b.tuning.cellSize;
  const gimbal = mt.gimbalDeg * Math.PI / 180;
  const aimX = pose.x + Math.cos(aimWorld) * Math.max(aimDist, mt.range);
  const aimY = pose.y + Math.sin(aimWorld) * Math.max(aimDist, mt.range);
  let nearest = 1;
  // The cutting is focused at the pulse's flare (the same curve as its look; a whole pulse still cuts what it did)
  const prof = pulseProfile(MINING_PULSE);
  const age = Math.max(0, Math.min(prof.ticks - 1, b.host.getTick() - ((ship.mineUntil ?? 0) - MINE_CYCLE)));
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
    for (const other of b.alongBeam(InSystem.systemId[eid], x, y, x1, y1, 0)) {
      const os = b.bodies.get(other);
      if (!os || other === eid || InSystem.systemId[other] !== InSystem.systemId[eid] || b.dormant.has(other) || b.intangible.has(other) || !b.nearSegment(other, os, x, y, x1, y1) || b.isJumping(os)) continue;
      if (b.host.canDamage && !b.host.canDamage(eid, other)) continue;
      const h = b.castShip(other, os, x, y, x1, y1);
      if (h && (!shipHit || h.t < shipHit.t)) shipHit = { eid: other, ship: os, ...h };
    }
    const sat = m.satisfaction;
    const rockT = b.host.mineBeam?.(eid, x, y, angle, shipHit ? shipHit.t * range : range, (mt.dps / 60) * sat * focus, m.material, m.gas, mt.range) ?? 1;
    const rockFrac = rockT * (shipHit ? shipHit.t : 1);
    if (shipHit && rockT >= 0.999) {
      // A mining laser is a poor weapon: a tenth or so of a same-grade laser
      b.hurt(shipHit.eid, shipHit.ship, shipHit.part, (mt.shipDps / 60) * outputOf(b.catalog.materials.get(m.material)) * sat * mineFalloff(shipHit.t * range, mt.range), eid,
        { hit: { type: 'thermal', pen: shooterGrade(b.catalog, { material: m.material } as never) }, at: b.worldToGrid(shipHit.eid, shipHit.ship, x + (x1 - x) * shipHit.t, y + (y1 - y) * shipHit.t) });
      nearest = Math.min(nearest, shipHit.t);
    } else {
      nearest = Math.min(nearest, rockFrac);
    }
  }
  b.beams.set(eid, nearest);
}

/**
 * Cool down every weapon, slew turrets towards the cursor, and fire what's
 * ready. The cursor is `aimWorld` (angle from the ship) at `aimDist`; each
 * turret aims at that point from its own pivot so the battery converges
 * (parallel fire when the distance is unknown). Fixed weapons fire straight
 * out; turrets only fire when on target and pointing through an open part
 * of their window.
 */
export function fireWeapons(b: BridgeCtx, eid: number, ship: ShipState, firing: boolean, aimWorld?: number, aimDist = 0, target = -1, energy?: { charge: Charge }): void {
  const tick = b.host.getTick();
  const pose = b.pose(eid);
  const def = (w: WeaponInfo) => partWeaponDef(b.tuning, w.kind, ship.blueprint.parts[w.part], w);
  let beamHit = -1;
  const beamed = new Set<number>();
  // The guns' tick (shared with the pilot's client, which fires its own shells on the same tick: guns.ts)
  const { shots, beams, pulses } = stepGuns(ship, pose, { firing, aimWorld, aimDist, energy, slow: b.coldStage(eid).guns }, tick, b.tuning);
  for (const w of beams) {
    beamed.add(w.part);
    // (A beam of a weapon role fires its own way: a Repair Beam mends a friendly hull instead, features/support)
    const hook = fireBeamHook(def(w));
    const t = hook ? hook(b, eid, ship, w, def(w)) : b.fireBeam(eid, ship, w, def(w));
    beamHit = beamHit < 0 ? t : Math.min(beamHit, t);
  }
  // A pulse laser starts a pulse: it runs its course along its aim from now (a fire event with no shells tells clients when)
  for (const { w, aimQ } of pulses) {
    let list = b.pulsing.get(eid);
    if (!list) b.pulsing.set(eid, (list = []));
    list.push({ part: w.part, start: tick });
    b.fired.push({ owner: eid, tick, part: w.part, aimQ, ids: [] });
  }
  b.stepPulses(eid, ship, tick);
  // Weapon roles' own ticks: point defence fires on its own, whatever the trigger (features/support)
  tickWeaponHooks(b, eid, ship, pose, def);
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
        lock = b.nearestTarget(eid, ax, ay, 1400, undefined, true);
      }
    }
    const round = b.host.spendAmmo?.(eid, w.kind, !d.ammo);
    const ids = b.host.fireBaseShot(eid, shot.x, shot.y, shot.angle, shot.damageScale * b.damageMul(eid) * (round?.scale ?? 1),
      { speedScale: shot.speedScale, sizeScale: shot.sizeScale, turret: shot.mount === 'turret', kind: w.kind, target: lock, seed: `${eid}:${ship.blueprint.parts[w.part].uid}`, mods: gunMods, dry: round?.dry, ammoMods: round?.mods,
        reach: d.lob ? Math.max(200, aimDist) : undefined, grade: w.grade, size: w.size, model: w.model });
    if (ids?.length && firesStraight(d)) b.fired.push({ owner: eid, tick, part: w.part, aimQ, ids, ...(round?.item ? { ammo: ammoCode(round.item) } : {}) });
  }
  if (beamHit >= 0) b.weaponBeams.set(eid, beamHit);
  else b.weaponBeams.delete(eid);
  if (shots.length || beams.length || pulses.length) b.lastFired.set(eid, tick);
  // Beam weapons cool while they aren't firing
  for (let i = 0; i < ship.heat.length; i++) {
    if (ship.heat[i] <= 0 || beamed.has(i)) continue;
    const w = ship.derived.weapons.find((x) => x.part === i);
    ship.heat[i] = Math.max(0, ship.heat[i] - (w ? def(w).coolPerSec ?? 30 : 30) / 60);
    if (ship.overheated[i] && ship.heat[i] < 30) ship.overheated[i] = false;
  }
}

/** Each pulse under way burns its tick's share along its gun's aim, as wide as its curve says; done, it's dropped */
export function stepPulses(b: BridgeCtx, eid: number, ship: ShipState, tick: number): void {
  const list = b.pulsing.get(eid);
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const w = ship.derived.weapons.find((x) => x.part === p.part);
    const def = w && partWeaponDef(b.tuning, w.kind, ship.blueprint.parts[w.part], w);
    const prof = def?.pulse && pulseProfile(def.pulse);
    const age = tick - p.start;
    const tell = () => { if (p.hit && p.hit.dealt > 0) b.host.notifyDamage(p.hit.eid, p.hit.dealt, eid); p.hit = undefined; };
    // (Its gun shot away, or its pulse over)
    if (!w || !def || !prof || age >= prof.ticks) { tell(); list.splice(i, 1); continue; }
    b.pulseHit = null;
    b.fireBeam(eid, ship, w, def, { damage: (def.damage ?? 0) * prof.share[age], width: (def.width ?? 0) * prof.width[age] });
    // The damage it does is told once a pulse (or when it swings on to another ship)
    const h = b.pulseHit as { eid: number; dealt: number } | null;
    if (h) {
      if (p.hit && p.hit.eid !== h.eid) tell();
      p.hit = { eid: h.eid, dealt: (p.hit?.dealt ?? 0) + h.dealt };
    }
    if (age === prof.ticks - 1) tell();
  }
  if (!list.length) b.pulsing.delete(eid);
}

/**
 * One tick of a beam weapon: out of its muzzle along its aim, it burns the
 * first hull (more against armour for the lance) or asteroid it meets, and
 * heats up; at 100 it overheats and must cool. Returns how far along it hit.
 * A pulse laser's tick (`pulse`) burns its share of the pulse, that wide, and doesn't heat.
 */
export function fireBeam(b: BridgeCtx, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, pulse?: { damage: number; width: number }): number {
  const pose = b.pose(eid);
  const cs = b.tuning.cellSize;
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
  const npc = hasComponent(b.host.world, Player, eid) ? 1 : def.npcScale ?? 1;
  const dmg = (pulse ? pulse.damage : (def.dps ?? 50) / 60) * Math.max(w.satisfaction, b.tuning.flow.minWeaponSatisfaction) * w.strength * b.damageMul(eid) * npc;
  let shipHit: { eid: number; ship: ShipState; part: number; t: number } | null = null;
  // It burns `width` wide: a hull that close to its line is hit (its edges are tried when the line itself misses)
  const half = (pulse ? pulse.width : def.width ?? 0) / 2;
  for (const other of b.alongBeam(InSystem.systemId[eid], x, y, x1, y1, half)) {
    const os = b.bodies.get(other);
    if (!os || other === eid || InSystem.systemId[other] !== InSystem.systemId[eid] || b.isJumping(os) || b.intangible.has(other) || b.dormant.has(other)) continue;
    if (!b.nearSegment(other, os, x, y, x1, y1, half)) continue;
    if (b.host.canDamage && !b.host.canDamage(eid, other)) continue;
    // (Its whole width against the parts' real shapes: a capsule, collide.ts)
    const h = b.castShip(other, os, x, y, x1, y1, half);
    if (h && (!shipHit || h.t < shipHit.t)) shipHit = { eid: other, ship: os, ...h };
  }
  // A surface's rock stops it before anything behind
  const wall = rayTerrain(b.host.terrainAt?.(eid), x, y, x1, y1);
  if (shipHit && shipHit.t > wall) shipHit = null;
  const rockT = Math.min(wall, b.host.beamAsteroid?.(eid, x, y, angle, shipHit ? shipHit.t * range : range * wall, dmg, w.kind) ?? 1);
  // (Mobs along its line burn too, up to whatever stops it: they don't stop it themselves)
  if (b.host.beamMobs) {
    const stop = rockT * (shipHit ? shipHit.t : 1);
    b.host.beamMobs(InSystem.systemId[eid], x, y, x + (x1 - x) * stop, y + (y1 - y) * stop, half * 2, dmg * beamFalloff(def, stop * range * 0.5), eid);
  }
  if (!pulse) {
    ship.heat[w.part] = Math.min(100, ship.heat[w.part] + ((def.heatPerSec ?? 20) / 60) * (b.host.hazardScale?.(eid, 'heat') ?? 1));
    if (ship.heat[w.part] >= 100) ship.overheated[w.part] = true;
  }
  if (shipHit && rockT >= 0.999) {
    if (def.chill) {
      // Each tick on a ship takes its warmth (frozen through from warm in holdTicks), and frozen through it seizes up
      b.frostHit(shipHit.eid, 1 / def.chill.holdTicks, def.chill.ticks);
    }
    const armor = shipHit.ship.blueprint.parts[shipHit.part].fn === 'armor' ? def.armorBonus ?? 1 : 1;
    // Past its effective range a fading beam (the laser's) burns ever weaker, out to where it gives out (pulse.ts beamFalloff)
    const fade = beamFalloff(def, shipHit.t * range);
    const at = b.worldToGrid(shipHit.eid, shipHit.ship, x + (x1 - x) * shipHit.t, y + (y1 - y) * shipHit.t);
    const dealt = b.hurt(shipHit.eid, shipHit.ship, shipHit.part, dmg * armor * fade, eid, { hit: weaponHit(w.kind, def, shooterGrade(b.catalog, ship.blueprint.parts[w.part])), at });
    if (pulse) b.pulseHit = { eid: shipHit.eid, dealt };
    else if (dealt > 0 && b.host.getTick() % 10 === 0) b.host.notifyDamage(shipHit.eid, dealt * 10, eid);
    return shipHit.t;
  }
  return rockT * (shipHit ? shipHit.t : 1);
}

/** A beam's muzzle (world) and angle, along its gun's aim */
export function beamFrom(b: BridgeCtx, eid: number, ship: ShipState, w: WeaponInfo): { x: number; y: number; angle: number } {
  const pose = b.pose(eid);
  let muzzle = w.muzzle, dir = w.dir;
  if (w.mount === 'turret' && w.window) {
    const a = w.window.center + ship.aim[w.part];
    dir = [Math.cos(a), Math.sin(a)];
    muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
  } else if (ship.aim[w.part]) {
    const a = Math.atan2(dir[1], dir[0]) + ship.aim[w.part];
    dir = [Math.cos(a), Math.sin(a)];
  }
  const [x, y] = shipPointToWorld(ship, pose, muzzle, b.tuning.cellSize);
  const [dx, dy] = localToWorldDir(dir, pose.angle);
  return { x, y, angle: Math.atan2(dy, dx) };
}

/**
 * The bodies a beam might meet: the host's broadphase (ships filed by their
 * bounding circles when the tick began, so padded by how far one can have
 * moved since), or every body
 */
export function alongBeam(b: BridgeCtx, systemNum: number, x0: number, y0: number, x1: number, y1: number, half: number): Iterable<number> {
  const near = b.host.shipsAlong?.(systemNum, x0, y0, x1, y1, half + BEAM_PAD);
  if (!near) return b.bodies.keys();
  // (and what's come or been moved since it was filed: spawned this tick, a boss's blink)
  if (!b.ungridded.size) return near;
  const out = [...near];
  for (const e of b.ungridded) out.push(e);
  return out;
}

/**
 * Projectile vs ship parts. The engine's broadphase gives `nearby`; each
 * candidate ship is tested part by part in its local grid space, and the
 * first part the segment touches takes the damage.
 */
export function hitProjectile(
  b: BridgeCtx, proj: number, ownerId: number, x0: number, y0: number, x1: number, y1: number,
  nearby: { id: number }[], exclude?: Set<number>, radius = 0,
): { eid: number; x: number; y: number; part: number } | null {
  let best: { eid: number; ship: ShipState; part: number; t: number } | null = null;
  const systemNum = InSystem.systemId[proj];
  for (const { id: eid } of nearby) {
    // (Instanced copies share coordinates: only ships in the shot's own copy)
    if (eid === ownerId || exclude?.has(eid) || InSystem.systemId[eid] !== systemNum || b.intangible.has(eid)) continue;
    const ship = b.bodies.get(eid);
    if (!ship) continue;
    // Shots pass straight through ships they may not hurt
    if (b.host.canDamage && !b.host.canDamage(ownerId, eid)) continue;
    const hit = b.segmentHit(eid, ship, x0, y0, x1, y1, radius);
    if (hit && (!best || hit.t < best.t)) best = { eid, ship, ...hit };
  }
  if (!best) return null;
  const hx = x0 + (x1 - x0) * best.t, hy = y0 + (y1 - y0) * best.t;
  const dealt = b.hurt(best.eid, best.ship, best.part, Projectile.damage[proj], ownerId, { ...b.host.shotVs?.(proj), at: b.worldToGrid(best.eid, best.ship, hx, hy) });
  b.host.notifyDamage(best.eid, dealt, ownerId, b.lastThrough < GLANCING);
  b.host.notifyProjectileHit(proj, hx, hy);
  return { eid: best.eid, x: hx, y: hy, part: best.part };
}

/** Does a world-space segment come within a ship's bounding circle (segmentHit's first test) */
export function nearSegment(b: BridgeCtx, eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): boolean {
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
export function segmentHit(b: BridgeCtx, eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null {
  if (!b.nearSegment(eid, ship, x0, y0, x1, y1, margin)) return null;
  return b.castShip(eid, ship, x0, y0, x1, y1, margin);
}

/** segmentHit without its bounding-circle test (for callers that have just made it) */
export function castShip(bridge: BridgeCtx, eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): { part: number; t: number } | null {
  const a = bridge.worldToGrid(eid, ship, x0, y0);
  const b = bridge.worldToGrid(eid, ship, x1, y1);
  bridge.castOn = ship;
  // (shots pass through bones and wrecks: stages.ts standing)
  const h = castParts(bridge.geometry(ship), bridge.castOk, a[0], a[1], b[0], b[1], margin / bridge.tuning.cellSize);
  bridge.castOn = null;
  return h;
}

/**
 * What takes a hit meant for `part` (a boss's stages: stages.ts): itself if it's standing in the stage being fought;
 * otherwise (a later stage's, or a wreck) the nearest part standing in that stage, one that decides it if any does;
 * -1 if nothing stands (between stages). Nearest to where it struck (`at`, grid space) by each part's own outline,
 * when that's known: so a shot at a boss's back goes to the plate nearest that spot (not one by its middle, the
 * first of two equally near: the left one, always); else to the struck part's middle.
 */
export function cover(b: BridgeCtx, ship: ShipState, part: number, at?: Vec2): number {
  if (!stageOf(b.catalog, ship, part)) return part;
  const first = currentStage(b.catalog, ship);
  if (!first) return -1;
  if (stageOf(b.catalog, ship, part) === first && standing(b.catalog, ship, part)) return part;
  // One blast's parts, all from the same point (coverMemo): while the part the last went to still stands, it's the
  // nearest still (in the blast nothing heals or moves, so the parts standing only ever get fewer)
  const memo = b.coverMemo?.ship === ship && b.coverMemo.at === at ? b.coverMemo : null;
  if (memo && memo.first === first && memo.best >= 0 && standing(b.catalog, ship, memo.best)) return memo.best;
  const geoms = b.geometry(ship), [cx, cy] = at ?? geoms[part].centroid;
  let best = -1, bd = Infinity;
  // (That stage's parts, in part order: the first of two equally near wins)
  for (const i of stageParts(b.catalog, ship, first)) {
    const g = geoms[i];
    if (!g || !standing(b.catalog, ship, i)) continue;
    const d = (at ? partDistance(g, cx, cy) : Math.hypot(g.centroid[0] - cx, g.centroid[1] - cy)) + (deciding(b.catalog, ship, i) ? 0 : 1e6);
    if (d < bd) { bd = d; best = i; }
  }
  if (memo) { memo.first = first; memo.best = best; }
  return best;
}

/** The ship part under a world point (debug key K). */
export function partAt(b: BridgeCtx, x: number, y: number): { eid: number; part: number } | null {
  for (const [eid, ship] of b.bodies) {
    const g = b.worldToGrid(eid, ship, x, y);
    const geoms = b.geometry(ship);
    for (let i = 0; i < geoms.length; i++) {
      if (ship.derived.alive[i] && geoms[i].convex.some((c) => pointInConvex(c, g[0], g[1]))) return { eid, part: i };
    }
  }
  return null;
}

export function damagePartFraction(b: BridgeCtx, eid: number, part: number, fraction: number): void {
  const ship = b.bodies.get(eid);
  if (!ship) return;
  damagePart(ship, part, ship.maxHp[part] * fraction, b.tuning);
}
