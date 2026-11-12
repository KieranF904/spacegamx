/**
 * @contract server.gameserver.hosts.places
 * owns:       host adapters for surfaces, sieges, pods and system memory, plus lod observers and body names
 * needs:      GameServer (type); npm: @space-game/common, bitecs
 * invariants: whereIs answers only for a live pilot, with their system's id and place — server/src/gameServer/hosts/hosts.test.ts
 * extend:      a new host member is added to the matching create*Host
 */

import { addComponent, hasComponent, entityExists } from 'bitecs';
import { Position, Velocity, Rotation, Radius, Player, Portal, InSystem, Dead, regionAt, datan2, dcos, dhypot, dsin } from '@space-game/common';
import { EffectType } from '@space-game/common';
import { jumpTuning, jumpPhase, rateShip, ratingOf, gradeReward } from '@space-game/common';
import { PodHost } from '../../game/LootPods.js';
import { FactionsFile } from '../../game/Enemies.js';
import { type SurfaceHost } from '../../game/Surfaces.js';
import { type SiegeHost } from '../../game/Sieges.js';
import { type FarPose } from '../../ships/SimLod.js';
import { shipMemory, restoreHp, type MemoryHost, type ShipMemory } from '../../game/SystemMemory.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { portalQuery } from '../../net/handlers/flight.js';
import { MEMORY_GATE_MOUTH } from '../shared.js';
import { arrivalEffect } from './mining.js';
import type { GameServer } from '../../GameServer.js';

/** What planet surfaces reach into (Surfaces.ts) */
export function createSurfaceHost(gs: GameServer): SurfaceHost {
  const factions = () => gs.gameData.factionsFile as FactionsFile;
  return {
    tick: () => gs.currentTick,
    systems: () => gs.gameData.getAllSystems(),
    systemNum: (id) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1),
    instances: (id) => gs.gameData.getSystemInstances(id),
    pilots: (num) => {
      const out: { conn: ClientConnection; eid: number; x: number; y: number }[] = [];
      for (const c of gs.clients.values()) {
        const p = c.playerId;
        if (!entityExists(gs.world, p) || !hasComponent(gs.world, Player, p) || hasComponent(gs.world, Dead, p) || InSystem.systemId[p] !== num) continue;
        out.push({ conn: c, eid: p, x: Position.x[p], y: Position.y[p] });
      }
      return out;
    },
    travel: (conn, num, x, y) => { (conn as ClientConnection).docked = null; gs.travelTo(conn as ClientConnection, num, x, y, false); },
    toast: (conn, text, kind) => gs.pilots.toast(conn, text, kind),
    spawnStructure: (design, num, x, y, name, grade) => {
      const bp = grade ? gs.enemies.design(design, grade) : gs.ships.enemyDesigns[design];
      if (!bp) return -1;
      const eid = gs.ships.spawnDummy(bp, x, y, 0, num);
      gs.ships.scaleHp(eid, 3);
      // Built into the ground: rams don't shove it
      gs.ships.pin(eid);
      gs.wards.set(eid, name);
      gs.enemies.addWard(eid);
      return eid;
    },
    removeStructure: (eid) => {
      if (!gs.wards.delete(eid)) return;
      gs.ships.setDamageScale(eid, 1);
      gs.enemies.removeWard(eid);
      if (gs.ships.has(eid)) gs.ships.removeShip(eid);
    },
    shipAt: (eid) => (eid >= 0 && gs.ships.has(eid) ? { x: Position.x[eid], y: Position.y[eid], hull: gs.ships.integrity(eid) } : null),
    repairStructure: (eid) => gs.ships.repair(eid),
    spawnRaid: (num, faction, x, y, size, at) => {
      const kinds = Object.keys(factions().factions[faction]?.ships ?? {}).filter((t) => gs.ships.enemyDesigns[t]);
      if (!kinds.length) return [];
      // Mostly the small ones, a heavier one now and then
      const ships = Array.from({ length: size }, (_, i) => kinds[i % 4 === 3 ? Math.min(kinds.length - 1, 2) : Math.min(kinds.length - 1, i % 2)]);
      const eids = gs.enemies.spawnPack(num, { faction, ships }, x, y);
      gs.enemies.sendPack(eids, at, 40000);
      return eids;
    },
    sendRaid: (eids, at) => gs.enemies.sendPack(eids, at, 40000),
    hostileAlive: (eid) => gs.enemies.isAlive(eid),
    removeHostile: (eid) => { if (gs.ships.has(eid)) gs.ships.removeShip(eid); },
    reward: (conn, xp, credits, label) => {
      const c = conn as ClientConnection;
      gs.pilots.addXp(c, xp);
      gs.pilots.addCredits(c, credits);
      gs.send(c.ws, { type: 'gained', items: {}, xp, credits, x: Position.x[c.playerId], y: Position.y[c.playerId], source: label });
    },
    send: (num, msg) => gs.broadcastToSystem(num, msg),
    announce: (num, text, kind) => {
      const color = { info: '#7dd3fc', warn: '#fbbf24', good: '#86efac', bad: '#f87171' }[kind];
      // Every pilot there gets the toast; only the outcomes (won, lost) are also kept in the chat log
      // (raid starts, siege waves and boss sightings were the spam, and the toast already shows them)
      if (kind === 'good' || kind === 'bad') gs.broadcastToSystem(num, { type: 'systemMessage', text, color });
      for (const c of gs.clients.values()) if (InSystem.systemId[c.playerId] === num) gs.pilots.toast(c, text, kind);
    },
  };
}

export function createSiegeHost(gs: GameServer): SiegeHost {
  const factions = () => gs.gameData.factionsFile as FactionsFile;
  const surfaceHost = createSurfaceHost(gs);
  const still = (a: number) => ({ forward: false, backward: false, left: false, right: false, boost: false, targetAngle: a });
  return {
    tick: () => gs.currentTick,
    instances: (id) => gs.gameData.getSystemInstances(id),
    partyId: (conn) => gs.party.partyId(conn as ClientConnection),
    name: (conn) => (conn as ClientConnection).username,
    pilots: surfaceHost.pilots,
    toOrbit: (conn, surface, angle) => gs.surfaces.toOrbit(conn, surface, angle),
    toast: (conn, text, kind) => gs.pilots.toast(conn, text, kind),
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    spawnStructure: surfaceHost.spawnStructure,
    removeStructure: surfaceHost.removeStructure,
    shipAt: surfaceHost.shipAt,
    healStructure: (eid, fraction) => gs.ships.healAll(eid, fraction),
    refit: (eid) => gs.ships.repair(eid),
    arm: (eid, { range, shot, damage, pick }) => {
      gs.ships.setDamageScale(eid, damage);
      // Aims at what the siege picks (else the nearest hostile in range), where it will be when the shells get there, and fires, turning to face it
      gs.ships.setController(eid, () => {
        const x = Position.x[eid], y = Position.y[eid];
        const picked = pick ? pick() : -1;
        const t = picked >= 0 ? picked : gs.ships.nearestTarget(eid, x, y, range, (o) => !!gs.enemies.factionOf(o));
        if (t < 0) return { controls: still(Rotation.angle[eid]), firing: false };
        const d = dhypot(Position.x[t] - x, Position.y[t] - y), lead = shot > 0 ? d / shot : 0;
        const tx = Position.x[t] + Velocity.x[t] * lead, ty = Position.y[t] + Velocity.y[t] * lead;
        const a = datan2(ty - y, tx - x);
        return { controls: still(a), firing: true, aim: a, aimDist: dhypot(tx - x, ty - y), target: t };
      });
    },
    rateShips: (ships, grade) => {
      let fp = 0, tough = 0;
      for (const s of ships) {
        const bp = gs.enemies.design(s, grade);
        if (!bp) continue;
        const faction = Object.values(factions().factions).find((f) => s in f.ships);
        const r = gs.enemies.designRating(bp, faction?.hpScale ?? 1);
        fp += r.firepower; tough += r.toughness;
      }
      return ratingOf(fp, tough);
    },
    gradeReward: (grade) => gradeReward(gs.ships.catalog, grade),
    spawnHostiles: (num, ships, x, y, at, grade) => {
      // Packs by faction (and plating, and role), eight at most (a big pack would spread out over half the moon), all sent at the bastion
      const byFaction = new Map<string, { s: (typeof ships)[number]; k: number }[]>();
      ships.forEach((s, k) => {
        const f = s.faction ?? Object.keys(factions().factions).find((id) => s.ship in factions().factions[id].ships) ?? 'pirates';
        const key = `${f}|${s.plating ?? 0}|${s.role ?? ''}`;
        byFaction.set(key, [...(byFaction.get(key) ?? []), { s, k }]);
      });
      const packs: [string, { s: (typeof ships)[number]; k: number }[]][] = [];
      for (const [key, list] of byFaction) for (let k = 0; k < list.length; k += 8) packs.push([key, list.slice(k, k + 8)]);
      // (In the order they were asked for: -1 for any that couldn't be made)
      const out: number[] = ships.map(() => -1);
      packs.forEach(([key, entries], i) => {
        const list = entries.map((e) => e.s);
        const faction = key.split('|')[0];
        const a = (i / packs.length) * Math.PI * 2, r = packs.length > 1 ? 500 + packs.length * 60 : 0;
        const eids = gs.enemies.spawnPack(num, { faction, ships: list.map((s) => s.ship), grade, plating: list[0]?.plating }, x + dcos(a) * r, y + dsin(a) * r);
        gs.enemies.sendPack(eids, at, 40000);
        eids.forEach((eid, k) => {
          const s = list[k];
          if (!s) return;
          if (s.hp !== 1) gs.ships.scaleHp(eid, s.hp);
          if (s.damage !== undefined) gs.ships.setDamageScale(eid, s.damage);
          if (s.range !== undefined || s.aggro !== undefined) gs.enemies.tune(eid, { ...(s.range !== undefined ? { range: s.range } : {}), ...(s.aggro !== undefined ? { aggro: s.aggro } : {}) });
          out[entries[k].k] = eid;
        });
      });
      return out;
    },
    order: (eids, { at, prey, only }) => {
      if (at) gs.enemies.sendPack(eids, at, 40000);
      if (prey !== undefined) for (const e of eids) gs.enemies.setPrey(e, prey, only);
    },
    shipName: (design) => gs.enemies.displayName(design),
    effect: (num, x, y, kind) => arrivalEffect(gs, num, x, y, kind),
    pin: (eid) => gs.ships.pin(eid),
    hostileAlive: (eid) => gs.enemies.isAlive(eid),
    removeHostile: (eid) => { if (gs.ships.has(eid)) gs.ships.removeShip(eid); },
    reward: surfaceHost.reward,
  };
}

export function createPodHost(gs: GameServer): PodHost {
  return {
    world: gs.world,
    tick: () => gs.currentTick,
    landmarks: (num) => gs.replicaEnv(num).landmarks,
    keyOf: (eid) => {
      const pc = gs.pilots.connOf(eid);
      return pc ? gs.pilots.keyOf(pc) : undefined;
    },
    emptied: (_eid, key) => gs.pilots.wreckRecovered(key),
    remove: (eid) => {
      addComponent(gs.world, Dead, eid);
      gs.pendingRemovedEntities.add(eid);
    },
    collectors: (num) => {
      const out: number[] = [];
      for (const c of gs.clients.values()) if (InSystem.systemId[c.playerId] === num) out.push(c.playerId);
      for (const l of gs.lingering.keys()) if (InSystem.systemId[l] === num) out.push(l);
      return out;
    },
    give: (eid, items, at, source) => {
      const pc = gs.lingering.get(eid)?.conn ?? gs.pilots.connOf(eid);
      if (!pc) return items;
      const left = gs.pilots.give(pc, items, { source, at });
      if (gs.tutorial) gs.tutorial.collected(pc as never, Object.fromEntries(Object.entries(items).map(([id, n]) => [id, n - (left[id] ?? 0)])));
      gs.broadcastToSystem(InSystem.systemId[eid], { type: 'effect', effectType: EffectType.PickupItem, x: Math.round(at.x), y: Math.round(at.y), targetX: Math.round(Position.x[eid]), targetY: Math.round(Position.y[eid]), entityId: eid });
      return left;
    },
    cargoFree: (eid) => {
      const pc = gs.lingering.get(eid)?.conn ?? gs.pilots.connOf(eid);
      return pc ? gs.pilots.cargoFree(pc) : 0;
    },
    shipRadius: (eid) => gs.ships.get(eid)?.derived.radius ?? 40,
    // (The pickup rules: ore and the hold's ghosts come in by themselves, the rest through the panel: pilots/pickup.ts)
    autoTake: (eid, items) => {
      const pc = gs.lingering.get(eid)?.conn ?? gs.pilots.connOf(eid);
      return pc ? gs.pilots.autoTake(pc, items) : {};
    },
    sendNear: (eid, pods) => {
      const pc = gs.pilots.connOf(eid);
      if (pc) gs.send((pc as ClientConnection).ws, { type: 'lootNear', pods });
    },
    holdFull: (eid) => {
      const pc = gs.pilots.connOf(eid);
      if (pc) gs.pilots.toast(pc, 'Your hold is full', 'warn');
    },
  };
}

/**
 * Where the pilots are, for SimLod: each a point, or while its jump drive
 * spools and burns, the line out along all the jump could reach (whatever
 * it lands near is woken before it gets there)
 */
export function lodObservers(gs: GameServer): Map<number, number[]> {
  const out = new Map<number, number[]>();
  gs.lodOccupied.clear();
  const jt = jumpTuning(gs.ships.tuning);
  for (const c of gs.clients.values()) {
    const p = c.playerId;
    if (!entityExists(gs.world, p) || !hasComponent(gs.world, Player, p)) continue;
    const sys = InSystem.systemId[p];
    gs.lodOccupied.add(sys);
    let list = out.get(sys);
    if (!list) out.set(sys, (list = []));
    const x = Position.x[p], y = Position.y[p];
    const ship = gs.ships.get(p);
    const phase = ship && ship.jump > 0 ? jumpPhase(ship.jump, jt).phase : 'ready';
    if (ship && (phase === 'charging' || phase === 'burn')) {
      // (Its reach with every boost a field can give, and then some)
      const reach = Math.max(jt.baseRange, ship.derived.jumpRange || 0) * 1.6, a = Rotation.angle[p];
      list.push(x, y, x + dcos(a) * reach, y + dsin(a) * reach);
    } else list.push(x, y, x, y);
  }
  // Wards count as someone being there (hostiles near one go for it), while their system's occupied
  for (const w of gs.wards.keys()) {
    const list = out.get(InSystem.systemId[w]);
    if (list && gs.ships.has(w)) list.push(Position.x[w], Position.y[w], Position.x[w], Position.y[w]);
  }
  return out;
}

/** What moon sieges reach into (Sieges.ts) */
/** Where a pilot is flying: their system's id (a surface's own) and position, or null */
export function whereIs(gs: GameServer, conn: ClientConnection): { system: string; x: number; y: number } | null {
  const eid = conn.playerId;
  if (!entityExists(gs.world, eid) || !hasComponent(gs.world, Player, eid) || hasComponent(gs.world, Dead, eid)) return null;
  const sys = gs.gameData.getSystemByNum(InSystem.systemId[eid]);
  return sys ? { system: sys.id, x: Position.x[eid], y: Position.y[eid] } : null;
}

/**
 * What SystemMemory puts away and brings back of a system: its packs and
 * bosses (Enemies, Bosses), its freighters and derelicts (here)
 */
export function createMemoryHost(gs: GameServer): MemoryHost {
  const where = (eid: number) => gs.lod.where(eid);
  const pose = (m: ShipMemory): FarPose => ({ x: m.x, y: m.y, vx: m.vx, vy: m.vy, angle: m.a, angVel: m.av ?? 0 });
  return {
    tick: () => gs.currentTick,
    now: () => gs.clock(),
    // The world's own systems (an arena's copies, surfaces and pilots' stations look after their own)
    systems: () => gs.gameData.getAllSystems().filter((s) => !s.private && !s.surface && !s.instance && !s.tutorial).map((s) => ({ num: gs.gameData.getSystemNum(s.id), id: s.id })),
    occupied: () => {
      const out = new Set<number>();
      for (const c of gs.clients.values()) out.add(InSystem.systemId[c.playerId]);
      for (const l of gs.lingering.keys()) out.add(InSystem.systemId[l]);
      return out;
    },
    // Pilots at a gate's or a rift's mouth: where it goes is brought back before they're through
    approaching: () => {
      const out = new Set<number>();
      for (const c of gs.clients.values()) {
        const p = c.playerId;
        if (!gs.flying(p)) continue;
        for (const g of portalQuery(gs.world)) {
          if (InSystem.systemId[g] !== InSystem.systemId[p]) continue;
          if (dhypot(Position.x[g] - Position.x[p], Position.y[g] - Position.y[p]) < Radius.value[g] + MEMORY_GATE_MOUTH) out.add(Portal.targetSystem[g]);
        }
      }
      return out;
    },
    capture: (num, offset, evict) => {
      const now = gs.currentTick;
      const ship = (eid: number) => shipMemory(gs.ships.get(eid)!, where(eid));
      const due = (t: number) => (t > now ? { respawnAt: t + offset } : {});
      const snap = {
        packs: gs.enemies.capture(num, where, offset, evict),
        bosses: gs.bosses.capture(num, where, evict, offset),
        traffic: gs.traffic.filter((t) => t.systemNum === num).map((t) => ({ id: t.data.id, leg: t.leg, dwell: t.dwell, ...(t.eid >= 0 && gs.ships.has(t.eid) ? { ship: ship(t.eid) } : due(t.respawnTick)) })),
        derelicts: gs.derelicts.filter((d) => d.systemNum === num).map((d) => ({ id: d.data.id, spawns: d.spawns, ...(d.eid >= 0 && gs.ships.has(d.eid) ? { ship: ship(d.eid) } : due(d.respawnTick)) })),
      };
      if (evict) {
        for (const t of gs.traffic) if (t.systemNum === num && t.eid >= 0) { if (gs.ships.has(t.eid)) gs.ships.removeShip(t.eid); t.eid = -1; }
        for (const d of gs.derelicts) if (d.systemNum === num && d.eid >= 0) { if (gs.ships.has(d.eid)) gs.ships.removeShip(d.eid); d.eid = -1; d.respawnTick = 0; }
      }
      return snap;
    },
    restore: (num, snap, offset, mend, from) => {
      // Each straight to sleep, flown on from when it was left (a pilot near wakes it as ever)
      const adopt = (eid: number, at: FarPose) => { if (gs.ships.sleep(eid, { damaged: 0, fired: 0 })) gs.lod.adopt(eid, from, at); };
      const local = (t?: number) => (t === undefined ? gs.currentTick : t - offset);
      gs.enemies.restore(num, snap.packs ?? [], offset, mend.ships, adopt);
      gs.bosses.restore(num, snap.bosses ?? [], mend.bosses, adopt, offset);
      for (const m of snap.traffic ?? []) {
        const slot = gs.traffic.find((t) => t.systemNum === num && t.data.id === m.id);
        if (!slot || slot.eid >= 0) continue;
        slot.leg = m.leg % slot.data.route.length;
        slot.dwell = m.dwell;
        const bp = gs.ships.library.get(slot.data.blueprint);
        if (!m.ship || !bp) { slot.respawnTick = local(m.respawnAt); continue; }
        slot.eid = gs.ships.spawnDummy(bp, m.ship.x, m.ship.y, m.ship.a, num);
        Velocity.x[slot.eid] = m.ship.vx; Velocity.y[slot.eid] = m.ship.vy;
        restoreHp(gs.ships, slot.eid, m.ship.hp, mend.ships);
        gs.enemies.defend(slot.eid);
        adopt(slot.eid, pose(m.ship));
      }
      for (const m of snap.derelicts ?? []) {
        const slot = gs.derelicts.find((d) => d.systemNum === num && d.data.id === m.id);
        if (!slot || slot.eid >= 0) continue;
        if (!m.ship) { slot.spawns = m.spawns; slot.respawnTick = local(m.respawnAt); continue; }
        // The same hulk (its seeded look), where it had drifted, as broken as it was (wrecks don't mend)
        slot.spawns = Math.max(0, m.spawns - 1);
        gs.derelictsMod.spawnDerelict(slot);
        if (slot.eid < 0) continue;
        gs.ships.teleport(slot.eid, m.ship.x, m.ship.y);
        Rotation.angle[slot.eid] = m.ship.a;
        restoreHp(gs.ships, slot.eid, m.ship.hp, 0);
        adopt(slot.eid, pose(m.ship));
      }
    },
    timers: (offset) => ({ enemies: gs.enemies.timers(offset), bosses: gs.bosses.timers(offset) }),
    setTimers: (t, offset) => { gs.enemies.setTimers(t.enemies ?? {}, offset); gs.bosses.setTimers(t.bosses ?? {}, offset); },
    populations: (offset) => gs.enemies.popMemory(offset),
    setPopulations: (p, offset) => gs.enemies.setPopMemory(p, offset),
  };
}

/** What killed a pilot, for telemetry: the last ship to hit them (an enemy's type and faction, or a pilot), the region, their rating */
export function deathCause(gs: GameServer, player: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sys = gs.gameData.getSystemByNum(InSystem.systemId[player]);
  const region = regionAt(sys, Position.x[player], Position.y[player]);
  if (region) out.region = region.id;
  const ship = gs.ships.get(player);
  if (ship) out.rating = Math.round(rateShip(gs.ships.catalog, gs.ships.tuning, ship).rating);
  const h = gs.ships.lastHitter(player);
  const foe = h >= 0 ? gs.enemies.info(h) : null;
  if (foe) { out.by = foe.name; out.faction = foe.faction; if (foe.boss) out.boss = foe.boss; }
  else if (h >= 0 && gs.pilots.connOf(h)) out.by = 'pilot';
  else out.by = 'other';
  return out;
}

/** Names (and kinds) of pilotless ships that have one: 1 = derelict, 2 = traffic, 3 = hostile */
export function namedBody(gs: GameServer, eid: number): { name: string; kind: number } | undefined {
  const foe = gs.enemies.info(eid);
  if (foe) return { name: foe.name, kind: 3 };
  const ward = gs.wards.get(eid) ?? gs.personCraft.get(eid);
  if (ward) return { name: ward, kind: 2 };
  const d = gs.derelicts.find((x) => x.eid === eid);
  if (d) return { name: d.data.name, kind: 1 };
  const t = gs.traffic.find((x) => x.eid === eid);
  if (t) return { name: t.data.name, kind: 2 };
  const den = gs.dens?.nameOf(eid);
  return den ? { name: den, kind: 1 } : undefined;
}
