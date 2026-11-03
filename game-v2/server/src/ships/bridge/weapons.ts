/**
 * ShipBridge weapons: what a ship's guns do each tick. Firing (stepWeapons, fireWeapons, pulses, miners), beams
 * (fireBeam, beamFrom; the Repair Beam and point defence are weapon roles of features/support), the casts that find what a beam or shot meets (alongBeam,
 * segmentHit, castShip, cover, partAt), a projectile's hit on a ship (hitProjectile), targets, and damage scaling.
 * ShipBridge keeps one-line delegators with the same names.
 *
 * Damage goes through the bridge (b.hurt), never an import of the damage module, so the modules can't form a cycle.
 */

import { rayTerrain, portsDamageMul, portsPiecePhase, portsMinePhase, miningPulse, shotAimQ, TELL_BEAM_PIECE, TELL_MINE_PULSE, type PortsState, stackMods, coverPart, nearShipSegment, castShipAt } from '@space-game/common';
import { hasComponent } from 'bitecs';
import {
  Position, Rotation, Input, Player, InSystem, Projectile, ShipState, Vec2, damagePart, weaponHit, shooterGrade, localToWorldDir,
  pointInConvex, shipPointToWorld,
  WeaponInfo, WeaponTuning, firesStraight, partWeaponDef, stepGuns, ammoCode, outputOf, payMining, MINE_CYCLE,
  MINING_PULSE, MINE_TAIL, mineFalloff, type Charge, pulseProfile, beamFalloff, windupScale, TELL_CHARGE_START, TELL_CHARGE_CANCEL,
  endsAtAim, aimReach, buildShot,
} from '@space-game/common';
import { K, BEAM_PAD, GLANCING, type BridgeCtx, type PendingSalvoShell } from './core.js';
import { lastHurtSoak } from './damage.js';
import { fireBeamHook, tickWeaponHooks } from '../features/weapons.js';
import { datan2, dcos, dhypot, dsin } from '@space-game/common';

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
    let d = dhypot(Position.x[other] - x, Position.y[other] - y);
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

/** The `n` ships nearest (x, y) within `range` that `eid` may attack, nearest first (a spread volley's targets: the Hive) */
export function nearestTargets(b: BridgeCtx, eid: number, x: number, y: number, range: number, n: number): number[] {
  const out: number[] = [];
  const fresh = (o: number) => !out.includes(o);
  for (let i = 0; i < n; i++) {
    const t = nearestTarget(b, eid, x, y, range, fresh, true);
    if (t < 0) break;
    out.push(t);
  }
  return out;
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
  const mining = payMining(ship, Input.fireRight[eid] === 1 && hasMiners && !jumping, b.host.getTick(), energy, jumping);
  // (A ports ship's mining laser starting a pulse: a fire event with no shells, so every client draws it from this tick, at its fulfilment)
  const pz = ship.derived.ports, pe = energy.charge.e;
  if (mining && pz && pe) for (const m of ship.derived.miners) if (portsMinePhase(pz, pe, m.part) === 0) b.fired.push({ owner: eid, tick: b.host.getTick(), part: m.part, aimQ: pe.sat[m.part], ids: [], ammo: TELL_MINE_PULSE });
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
  const aimX = pose.x + dcos(aimWorld) * Math.max(aimDist, mt.range);
  const aimY = pose.y + dsin(aimWorld) * Math.max(aimDist, mt.range);
  let nearest = 1;
  // The cutting is focused at the pulse's flare (the same curve as its look; a whole pulse still cuts what it did)
  const prof = pulseProfile(MINING_PULSE);
  const age = Math.max(0, Math.min(prof.ticks - 1, b.host.getTick() - ((ship.mineUntil ?? 0) - MINE_CYCLE)));
  // (A ports ship's mining lasers each run their own pulse, and cut by the share of their draw they got: power/ports.ts portsMineStep)
  const pz = ship.derived.ports, pe = pz ? b.chargeOf(eid).e : undefined;
  for (const m of ship.derived.miners) {
    const ph = pz && pe ? portsMinePhase(pz, pe, m.part) : -2;
    if (ph === -1) continue;
    const mp = ph >= 0 ? pulseProfile(miningPulse(pz!.minePulse[m.part])) : prof, ma = ph >= 0 ? Math.min(mp.ticks - 1, ph) : age;
    const focus = mp.share[ma] * mp.ticks;
    const fill = ph >= 0 ? pe!.sat[m.part] / 255 : 1;
    if (m.satisfaction * fill <= 0.01) continue;
    const [x, y] = shipPointToWorld(ship, pose, m.muzzle, cs);
    const facing = pose.angle + Math.PI / 2 + datan2(m.dir[1], m.dir[0]);
    let off = datan2(aimY - y, aimX - x) - facing;
    while (off > Math.PI) off -= 2 * Math.PI;
    while (off < -Math.PI) off += 2 * Math.PI;
    const angle = facing + Math.max(-gimbal, Math.min(gimbal, off));
    // (It reaches past its range, fading: mineFalloff)
    const range = mt.range * (1 + MINE_TAIL);
    const x1 = x + dcos(angle) * range, y1 = y + dsin(angle) * range;
    // Nearest hull along the beam (not our own)
    let shipHit: { eid: number; ship: ShipState; part: number; t: number } | null = null;
    for (const other of b.alongBeam(InSystem.systemId[eid], x, y, x1, y1, 0)) {
      const os = b.bodies.get(other);
      if (!os || other === eid || InSystem.systemId[other] !== InSystem.systemId[eid] || b.dormant.has(other) || b.intangible.has(other) || !b.nearSegment(other, os, x, y, x1, y1) || b.isJumping(os)) continue;
      if (b.host.canDamage && !b.host.canDamage(eid, other)) continue;
      const h = b.castShip(other, os, x, y, x1, y1);
      if (h && (!shipHit || h.t < shipHit.t)) shipHit = { eid: other, ship: os, ...h };
    }
    const sat = m.satisfaction * fill;
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
  // The guns' tick (shared with the pilot's client, which fires its own shells on the same tick: guns.ts)
  const { shots, beams, pulses, tells } = stepGuns(ship, pose, { firing, aimWorld, aimDist, energy }, tick, b.tuning);
  // Where the guns aim this tick and whether the trigger is held: a guided shell steers to it (features/weaponry guided; Weapons.guide)
  noteGuide(b, eid, tick, firing, pose, aimWorld, aimDist);
  // A walking salvo's later shells, on their ticks (features/weaponry walk)
  const pending = b.salvos.get(eid);
  if (pending) stepSalvos(b, eid, ship, pose, tick, pending);
  // A charge gun starting to charge, or let go early: a fire event with no shells, so everyone sees its tell (ammo code: guns.ts TELL_CHARGE_*)
  for (const t of tells) b.fired.push({ owner: eid, tick, part: t.w.part, aimQ: t.aimQ, ids: [], ammo: t.start ? TELL_CHARGE_START : TELL_CHARGE_CANCEL });
  const pz = ship.derived.ports, pe = pz ? (energy?.charge.e as PortsState | undefined) : undefined;
  for (const w of beams) {
    // (A beam in pieces that spent a piece this tick: a fire event with no shells, so every client draws its pulse from this tick)
    if (pz && pe && portsPiecePhase(pz, pe, w.part) === 0) b.fired.push({ owner: eid, tick, part: w.part, aimQ: shotAimQ(ship.aim[w.part]), ids: [], ammo: TELL_BEAM_PIECE });
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
  for (const { w, aimQ, shot, aug } of shots) {
    const d = def(w);
    const gunMods = ship.blueprint.parts[w.part].mods;
    // Missiles lock on to the ship nearest the aim point (the cursor), else the target given (a guided one is steered instead)
    let lock = -1;
    // (A volley that spreads over several targets, the Hive's: each of its seekers takes the next of the ships nearest the cursor)
    let locks: number[] | undefined;
    if (d.homing && !d.guided) {
      if (aimWorld !== undefined) {
        const ax = pose.x + dcos(aimWorld) * Math.max(aimDist, 400), ay = pose.y + dsin(aimWorld) * Math.max(aimDist, 400);
        if (d.volleyTargets && d.volleyTargets > 1) {
          locks = nearestTargets(b, eid, ax, ay, 1400, d.volleyTargets);
          lock = locks.length ? locks[0] : -1;
        } else lock = b.nearestTarget(eid, ax, ay, 1400, undefined, true);
      }
      if (lock < 0) lock = target;
    }
    // (An ammunition gun's shot costs its `rounds` from the hold; Ammo.ts: an empty hold fires plain rounds, as it always has)
    let round = b.host.spendAmmo?.(eid, w.kind, !d.ammo);
    for (let k = 1; k < (w.fire.model === 'ammo' ? w.fire.rounds ?? 1 : 1); k++) round = b.host.spendAmmo?.(eid, w.kind, !d.ammo) ?? round;
    // (A ports ship's augmented shot: its augment's mods on the round's, power/ports.ts)
    const mods = stackMods(round?.mods, aug);
    const damageScale = shot.damageScale * b.damageMul(eid) * (round?.scale ?? 1);
    // (A straight flyer's shells carry their gun, packed as its fire event's part: clients work their hits out from it)
    const straight = firesStraight(d), ammo = round?.item ? ammoCode(round.item) : 0;
    // (A shell that ends at the aim flies the aim distance: a lobbed mortar's, an aim burst's, a walking salvo's first)
    const ids = b.host.fireBaseShot(eid, shot.x, shot.y, shot.angle, damageScale,
      { speedScale: shot.speedScale, sizeScale: shot.sizeScale, turret: shot.mount === 'turret', kind: w.kind, target: lock, seed: `${eid}:${ship.blueprint.parts[w.part].uid}`, mods: gunMods, dry: round?.dry, ammoMods: mods,
        reach: endsAtAim(d) ? aimReach(aimDist, d, 0) : undefined, grade: w.grade, size: w.size, model: w.model, gun: straight ? w.part + 256 * ammo + (aug ? 65536 : 0) : undefined });
    if (ids?.length && straight) b.fired.push({ owner: eid, tick, part: w.part, aimQ, ids, ...(round?.item ? { ammo } : {}), ...(aug ? { aug: 1 as const } : {}) });
    // A rippling salvo: the rest of its shells, `gap` ticks apart, on the same lock
    if (d.salvo && d.salvo.count > 1) {
      let list = b.salvos.get(eid);
      if (!list) b.salvos.set(eid, (list = []));
      const uid = ship.blueprint.parts[w.part].uid;
      for (let i = 1; i < d.salvo.count; i++) list.push({ uid, due: tick + d.salvo.gap * i, index: i, reach: 0, target: locks && locks.length ? locks[i % locks.length] : lock, damageScale, dry: round?.dry, ammoMods: round?.mods });
    }
    // A walking salvo: the rest of its shells, `gap` ticks apart, each landing at its fraction of this aim distance
    if (d.walk && d.walk.at.length > 1) {
      let list = b.salvos.get(eid);
      if (!list) b.salvos.set(eid, (list = []));
      const uid = ship.blueprint.parts[w.part].uid;
      for (let i = 1; i < d.walk.at.length; i++) {
        list.push({ uid, due: tick + d.walk.gap * i, index: i, reach: aimReach(aimDist, d, i), damageScale, dry: round?.dry, ammoMods: round?.mods });
      }
    }
  }
  if (beamHit >= 0) b.weaponBeams.set(eid, beamHit);
  else b.weaponBeams.delete(eid);
  if (shots.length || beams.length || pulses.length || tells.length) b.lastFired.set(eid, tick);
}

/** Note where a ship's guns aim this tick (the cursor point) and whether the trigger is held (allocation-free after its first) */
function noteGuide(b: BridgeCtx, eid: number, tick: number, firing: boolean, pose: { x: number; y: number }, aimWorld: number | undefined, aimDist: number): void {
  let g = b.guides.get(eid);
  if (!g) b.guides.set(eid, (g = { tick, held: false, x: 0, y: 0 }));
  g.tick = tick;
  g.held = firing && aimWorld !== undefined;
  if (aimWorld === undefined) return;
  // (No cursor distance known: a point well out along the aim, as a missile's lock looks)
  const d = Math.max(aimDist, 400);
  g.x = pose.x + dcos(aimWorld) * d;
  g.y = pose.y + dsin(aimWorld) * d;
}

/** Where a ship's guns aimed and whether its trigger was held, if they stepped this tick or the last (undefined: stale, or no guns) */
export function guideOf(b: BridgeCtx, eid: number, tick: number): { held: boolean; x: number; y: number } | undefined {
  const g = b.guides.get(eid);
  return g && tick - g.tick <= 1 ? g : undefined;
}

/**
 * A walking salvo's later shells (features/weaponry walk), each on its tick from its gun's barrel as it points now,
 * landing at its own fraction of the aim distance the salvo was fired at. A gun shot away drops what it had left.
 */
function stepSalvos(b: BridgeCtx, eid: number, ship: ShipState, pose: { x: number; y: number; angle: number }, tick: number, list: PendingSalvoShell[]): void {
  let keep = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.due > tick) { list[keep++] = p; continue; }
    let w: WeaponInfo | undefined;
    for (const x of ship.derived.weapons) if (x.uid === p.uid) { w = x; break; }
    if (!w) continue;
    const shot = buildShot(w, ship, pose, tick, b.tuning);
    b.host.fireBaseShot(eid, shot.x, shot.y, shot.angle, p.damageScale,
      { speedScale: shot.speedScale, sizeScale: shot.sizeScale, turret: shot.mount === 'turret', kind: w.kind, target: p.target, seed: `${eid}:${p.uid}:w${p.index}`, mods: ship.blueprint.parts[w.part]?.mods,
        dry: p.dry, ammoMods: p.ammoMods, reach: p.reach, grade: w.grade, size: w.size, model: w.model });
    b.lastFired.set(eid, tick);
  }
  list.length = keep;
  if (!keep) b.salvos.delete(eid);
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
 * first hull (more against armour for the lance) or asteroid it meets, for as
 * long as the power lasts (no heat). Returns how far along it hit.
 * A pulse laser's tick (`pulse`) burns its share of the pulse, that wide.
 */
export function fireBeam(b: BridgeCtx, eid: number, ship: ShipState, w: WeaponInfo, def: WeaponTuning, pulse?: { damage: number; width: number }): number {
  const pose = b.pose(eid);
  const cs = b.tuning.cellSize;
  let muzzle = w.muzzle, dir = w.dir;
  if (w.mount === 'turret' && w.window) {
    const a = w.window.center + ship.aim[w.part];
    dir = [dcos(a), dsin(a)];
    muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
  } else if (ship.aim[w.part]) {
    const a = datan2(dir[1], dir[0]) + ship.aim[w.part];
    dir = [dcos(a), dsin(a)];
  }
  const [x, y] = shipPointToWorld(ship, pose, muzzle, cs);
  const [dx, dy] = localToWorldDir(dir, pose.angle);
  const angle = datan2(dy, dx);
  const range = def.range ?? 800;
  const x1 = x + dcos(angle) * range, y1 = y + dsin(angle) * range;
  // (A hostile's beam burns at its kind's npcScale: the laser was made better for pilots, not for the scrap that fires it)
  const npc = hasComponent(b.host.world, Player, eid) ? 1 : def.npcScale ?? 1;
  // (A held beam with a windup burns up to full over its first ticks: guns.ts windupScale)
  // (A zapping beam, the Tesla's, burns its dps x zap / 60 all at once every `zap` ticks, and nothing in between)
  const zapping = !pulse && !!def.zap;
  const zapK = zapping ? (b.host.getTick() % def.zap! === 0 ? def.zap! : 0) : 1;
  // (A ports ship's gun: its infrastructure tier's damage and its material's, power/ports.ts)
  const pz = ship.derived.ports, pc = pz ? b.chargeOf(eid).e : undefined;
  const dmg = zapK * (pulse ? pulse.damage : ((def.dps ?? 50) / 60) * windupScale(ship, w)) * Math.max(w.satisfaction, b.tuning.flow.minWeaponSatisfaction) * w.strength * b.damageMul(eid) * npc * (pz && pc ? portsDamageMul(pz, pc, w.part) : 1);
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
  b.beamStruck = -1;
  if (shipHit && rockT >= 0.999) {
    // (What it burned: a marking or slowing beam's role reads it, features/weaponry. Beams no longer chill: a
    // Frostbite slows what it lights instead)
    b.beamStruck = shipHit.eid;
    const armor = shipHit.ship.blueprint.parts[shipHit.part].fn === 'armor' ? def.armorBonus ?? 1 : 1;
    // A ramping beam (the Cutter's) burns deeper the longer it stays on this one part
    const deeper = def.ramp && !pulse ? rampScale(b, eid, w.part, shipHit.eid * 1024 + shipHit.part, def) : 1;
    // Past its effective range a fading beam (the laser's) burns ever weaker, out to where it gives out (pulse.ts beamFalloff)
    const fade = beamFalloff(def, shipHit.t * range);
    const at = b.worldToGrid(shipHit.eid, shipHit.ship, x + (x1 - x) * shipHit.t, y + (y1 - y) * shipHit.t);
    if (zapping) {
      // (Between zaps it only lights the line; on a zap it hurts the first hull, then leaps on from where it struck)
      if (dmg > 0) zap(b, eid, w, def, shipHit.eid, shipHit.ship, shipHit.part, dmg * armor * fade, at, ship, x + (x1 - x) * shipHit.t, y + (y1 - y) * shipHit.t);
      return shipHit.t;
    }
    const dealt = b.hurt(shipHit.eid, shipHit.ship, shipHit.part, dmg * armor * fade * deeper, eid, { hit: weaponHit(w.kind, def, shooterGrade(b.catalog, ship.blueprint.parts[w.part])), at });
    if (pulse) b.pulseHit = { eid: shipHit.eid, dealt };
    else if (dealt > 0 && b.host.getTick() % 10 === 0) b.host.notifyDamage(shipHit.eid, dealt * 10, eid);
    return shipHit.t;
  }
  // (Off every part: a ramping beam starts over)
  if (def.ramp) b.ramps.delete(eid * 1024 + w.part);
  return rockT * (shipHit ? shipHit.t : 1);
}

/** Ticks a ramping beam may skip (a brownout sputter, a flick off the part) before it starts over */
const RAMP_GRACE = 4;

/**
 * How much more a ramping beam burns this tick than at its base dps (`dps` rising to `ramp.to` over `ramp.ticks` burned
 * ticks on one part): the beam of `eid`'s gun `part` is on `target` (ship * 1024 + part). A new part, or a gap of more
 * than RAMP_GRACE ticks, starts it over. Allocation-free once the gun has a run.
 */
function rampScale(b: BridgeCtx, eid: number, part: number, target: number, def: WeaponTuning): number {
  const ramp = def.ramp!, key = eid * 1024 + part, tick = b.host.getTick();
  let r = b.ramps.get(key);
  if (!r) b.ramps.set(key, (r = { target, ticks: 0, last: tick }));
  else if (r.target !== target || tick - r.last > RAMP_GRACE) { r.target = target; r.ticks = 0; }
  r.last = tick;
  const base = Math.max(1e-9, def.dps ?? 50);
  const k = base + (ramp.to - base) * Math.min(1, r.ticks / Math.max(1, ramp.ticks));
  r.ticks++;
  return k / base;
}

/**
 * One zap of a Tesla: `dmg` into the part it struck, then it leaps to up to `chain.count` more ships within
 * `chain.radius` of where it last struck (the nearest not yet struck, by hull), each time `chain.falloff` of the
 * last, on the part nearest where it leapt from. Each hop is shown to everyone (host.arcHop).
 */
function zap(b: BridgeCtx, eid: number, w: WeaponInfo, def: WeaponTuning, target: number, tship: ShipState, part: number, dmg: number, at: Vec2, ship: ShipState, hx: number, hy: number): void {
  const hit = weaponHit(w.kind, def, shooterGrade(b.catalog, ship.blueprint.parts[w.part]));
  const dealt = b.hurt(target, tship, part, dmg, eid, { hit, at });
  if (dealt > 0) b.host.notifyDamage(target, dealt, eid);
  const c = def.chain;
  if (!c) return;
  const sys = InSystem.systemId[eid];
  // (A zap strikes a handful of ships, a few times a second: the small list costs nothing)
  const struck = [eid, target];
  let fx = hx, fy = hy, d = dmg;
  for (let i = 0; i < c.count; i++) {
    const next = nearestTarget(b, eid, fx, fy, c.radius, (o) => !struck.includes(o), true);
    if (next < 0) break;
    struck.push(next);
    d *= c.falloff;
    const p = b.nearestPartPoint(next, fx, fy);
    const tx = p ? p[0] : Position.x[next], ty = p ? p[1] : Position.y[next];
    b.splashAt(sys, tx, ty, 30, d, eid, hit);
    b.host.arcHop?.(sys, tx, ty, fx, fy);
    fx = tx; fy = ty;
  }
}

/** A beam's muzzle (world) and angle, along its gun's aim */
export function beamFrom(b: BridgeCtx, eid: number, ship: ShipState, w: WeaponInfo): { x: number; y: number; angle: number } {
  const pose = b.pose(eid);
  let muzzle = w.muzzle, dir = w.dir;
  if (w.mount === 'turret' && w.window) {
    const a = w.window.center + ship.aim[w.part];
    dir = [dcos(a), dsin(a)];
    muzzle = [w.window.pivot[0] + dir[0] * w.window.barrel, w.window.pivot[1] + dir[1] * w.window.barrel];
  } else if (ship.aim[w.part]) {
    const a = datan2(dir[1], dir[0]) + ship.aim[w.part];
    dir = [dcos(a), dsin(a)];
  }
  const [x, y] = shipPointToWorld(ship, pose, muzzle, b.tuning.cellSize);
  const [dx, dy] = localToWorldDir(dir, pose.angle);
  return { x, y, angle: datan2(dy, dx) };
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
  const glancing = b.lastThrough < GLANCING;
  b.host.notifyDamage(best.eid, dealt, ownerId, glancing);
  b.host.notifyProjectileHit(proj, hx, hy, { target: best.eid, part: best.part, dealt, glancing, soak: dealt > 0 ? lastHurtSoak() : 0, rebuilds: best.ship.rebuilds });
  return { eid: best.eid, x: hx, y: hy, part: best.part };
}

/** Does a world-space segment come within a ship's bounding circle (segmentHit's first test) */
export function nearSegment(b: BridgeCtx, eid: number, ship: ShipState, x0: number, y0: number, x1: number, y1: number, margin = 0): boolean {
  // (common hitRules.ts: a client finding its own hits runs the same test)
  return nearShipSegment(Position.x[eid], Position.y[eid], ship.derived.radius, x0, y0, x1, y1, margin);
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
  bridge.castOn = ship;
  // (shots pass through bones and wrecks: stages.ts standing. The cast is common's, hitRules.ts castShipAt: a client
  // finding its own hits runs it on the pose it has)
  const h = castShipAt(bridge.geometry(ship), bridge.castOk, bridge.tuning.cellSize, ship.derived.com, Position.x[eid], Position.y[eid], Rotation.angle[eid], x0, y0, x1, y1, margin);
  bridge.castOn = null;
  return h;
}

/**
 * What takes a hit meant for `part` (a boss's stages: stages.ts): itself if it's standing in the stage being fought;
 * otherwise (a later stage's, or a wreck) the nearest part standing in that stage, one that decides it if any does;
 * -1 if nothing stands (between stages). Nearest to where it struck (`at`, grid space) by each part's own outline,
 * when that's known: so a shot at a boss's back goes to the plate nearest that spot (not one by its middle, the
 * first of two equally near: the left one, always); else to the struck part's middle. The rule is common's
 * (hitRules.ts coverPart), with this bridge's memo of the blast being dealt out.
 */
export function cover(b: BridgeCtx, ship: ShipState, part: number, at?: Vec2): number {
  return coverPart(b, ship, part, at, b.coverMemo);
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
