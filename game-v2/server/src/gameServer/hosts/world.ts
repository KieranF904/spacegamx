/**
 * @contract server.gameserver.hosts.world
 * owns:       host adapters for operations, events, mobs and enemies
 * needs:      GameServer (type)
 * invariants: behaviour is unchanged from the class it was split from — none pinned
 * extend:      a new host member is added to the matching create*Host
 */

import { hasComponent } from 'bitecs';
import { Position, Velocity, Radius, Player, Station, Portal, InSystem, Dead, inSafeSpace, beltTotal, beltSegment, dcos, dhypot, dsin } from '@space-game/common';
import { ServerMessage, countOf, mulberry32 } from '@space-game/common';
import { hasAll, removeAll, Bag, lookFn } from '@space-game/common';
import { FactionsFile } from '../../game/Enemies.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { stationQuery } from '../../game/Docking.js';
import { portalQuery } from '../../net/handlers/flight.js';
import type { BodyState, MoveOrigin } from '@space-game/common';
import { playerQuery } from '../../net/SnapshotBuilder.js';
import { hostileShot } from './boss.js';
import { arrivalEffect } from './mining.js';
import type { GameServer } from '../../GameServer.js';

export function createOpsHost(gs: GameServer) {
  const stationPos = (id: string) => {
    const st = gs.gameData.getStation(id);
    if (!st) return null;
    const num = gs.gameData.getSystemNum(st.system);
    const e = gs.stationEntity(id, num);
    return e < 0 ? null : { system: st.system, x: Position.x[e], y: Position.y[e], name: st.name };
  };
  const factions = gs.gameData.factionsFile as FactionsFile;
  return {
    tick: () => gs.currentTick,
    now: gs.clock,
    send: (conn: unknown, msg: ServerMessage) => gs.send((conn as ClientConnection).ws, msg),
    toast: (conn: unknown, text: string, kind?: 'info' | 'good' | 'warn' | 'bad') => gs.pilots.toast(conn as ClientConnection, text, kind),
    pilot: (conn: unknown) => {
      const eid = (conn as ClientConnection).playerId;
      if (!gs.flying(eid)) return null;
      return { system: gs.gameData.getSystemByNum(InSystem.systemId[eid])?.id ?? '', x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid] };
    },
    station: stationPos,
    stationName: (id: string) => gs.gameData.getStation(id)?.name ?? id,
    derelicts: (system: string) => {
      const num = gs.gameData.getSystemNum(system);
      return gs.derelicts.filter((d) => d.systemNum === num && d.eid >= 0 && gs.ships.has(d.eid))
        .map((d) => ({ eid: d.eid, name: d.data.name, x: Position.x[d.eid], y: Position.y[d.eid] }));
    },
    spawnWard: (kind: 'freighter' | 'outpost', system: string, x: number, y: number, angle: number, name: string) => {
      const bp = gs.ships.library.get(kind === 'freighter' ? 'hauler' : 'bulwark');
      if (!bp) return -1;
      const eid = gs.ships.spawnDummy(bp, x, y, angle, gs.gameData.getSystemNum(system));
      gs.ships.scaleHp(eid, kind === 'outpost' ? 4 : 1.6);
      gs.wards.set(eid, name);
      gs.enemies.addWard(eid);
      // (An escorted freighter keeps to its path but shoots back at what hurts it: game/enemies/defenders.ts)
      if (kind === 'freighter') gs.enemies.defend(eid);
      return eid;
    },
    steer: (eid: number, to: { x: number; y: number; arrive: number } | null) => gs.ships.setAutopilot(eid, to ? { x: to.x, y: to.y, arriveRadius: to.arrive } : null),
    removeWard: (eid: number) => {
      // Already gone (shot down: forgotten then): its number may be someone else's by now
      if (!gs.wards.delete(eid)) return;
      gs.enemies.removeWard(eid);
      if (gs.ships.has(eid)) gs.ships.removeShip(eid);
    },
    shipAt: (eid: number) => (eid >= 0 && gs.ships.has(eid) ? { x: Position.x[eid], y: Position.y[eid], hull: gs.ships.integrity(eid) } : null),
    spawnRaid: (system: string, x: number, y: number, size: number, at: { x: number; y: number }) => {
      const num = gs.gameData.getSystemNum(system);
      // Whoever lives where it happens: the zone it's in (the Drift's Scrapborn, the Lanes' pirates), else the system's own packs
      const sp = factions.spawns?.[system];
      const zone = (sp?.zones ?? []).find((z) => { const d = dhypot(at.x - (z.x ?? 0), at.y - (z.y ?? 0)); return d >= z.inner && d <= z.outer && z.groups.some((g) => !g.passive); });
      const groups = (zone?.groups ?? sp?.groups ?? []).filter((g) => !g.passive);
      const g = groups.length ? groups[Math.floor(gs.rng() * groups.length)] : { faction: 'pirates', ships: ['pirate_skiff', 'pirate_skiff'] };
      const ships = Array.from({ length: Math.max(1, Math.min(7, size)) }, (_, i) => g.ships[i % g.ships.length]);
      const eids = gs.enemies.spawnPack(num, { faction: g.faction, ships }, x, y);
      gs.enemies.sendPack(eids, at, 9000);
      return eids;
    },
    sendRaid: (eids: number[], at: { x: number; y: number }) => gs.enemies.sendPack(eids, at, 9000),
    hostileAlive: (eid: number) => gs.enemies.isAlive(eid),
    removeHostile: (eid: number) => { if (gs.ships.has(eid)) gs.ships.removeShip(eid); },
    partyId: (conn: unknown) => gs.party.partyId(conn as ClientConnection),
    danger: (system: string) => gs.gameData.getSystem(system)?.danger ?? 1,
    spawnCargo: (conn: unknown, system: string, x: number, y: number, items: Bag) => {
      const num = gs.gameData.getSystemNum(system);
      const key = gs.pilots.keyOf(conn as ClientConnection);
      if (num < 0) return -1;
      const eid = gs.pods.spawn(num, x, y, 0, 0, items, -1, 0, 60 * 60 * 10);
      if (eid >= 0 && key) gs.pods.keep(eid, key, gs.currentTick + 60 * 60 * 10);
      return eid;
    },
    podAlive: (eid: number) => !!gs.pods.get(eid),
    holds: (conn: unknown, item: string) => countOf(gs.pilots.get(conn as ClientConnection)?.cargo ?? [], item),
    takeCargo: (conn: unknown, items: Bag) => {
      const p = gs.pilots.get(conn as ClientConnection);
      if (!p || !hasAll(p.cargo, items)) return false;
      removeAll(p.cargo, items);
      gs.pilots.markDirty(conn as ClientConnection);
      gs.pilots.sendItems(conn as ClientConnection);
      return true;
    },
    fitted: (conn: unknown, fn: string) => {
      const ship = gs.ships.get((conn as ClientConnection).playerId);
      // (A model is the kind of part it grew from: a Constructor model is a constructor)
      return !!ship && ship.blueprint.parts.some((p, i) => (p.fn === fn || lookFn(p.fn) === fn) && ship.derived.alive[i] && !ship.ghost?.[i]);
    },
  };
}

/**
 * A design a client sent, parsed (throws if it isn't one). Sizes are checked
 * before any work's done on it: parts have unique uids 0..255, so a real design
 * never has more than 256; and the strings in it are kept to a sensible length
 * (they're saved and sent to everyone near).
 */
export function createEventHost(gs: GameServer) {
  const alivePlayers = (num: number) => {
    const out: number[] = [];
    for (const c of gs.clients.values()) {
      const p = c.playerId;
      if (hasComponent(gs.world, Player, p) && !hasComponent(gs.world, Dead, p) && InSystem.systemId[p] === num) out.push(p);
    }
    return out;
  };
  const rng = mulberry32(0x0e7e);
  return {
    tick: () => gs.currentTick,
    systemNum: (id: string) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1),
    systemId: (num: number) => gs.gameData.getSystemByNum(num)?.id,
    systemName: (num: number) => gs.gameData.getSystemByNum(num)?.name ?? 'this system',
    players: alivePlayers,
    stations: (num: number) => {
      // (Stations are made with the world and never change: listed once per system)
      let list = gs.namedStations.get(num);
      if (!list) {
        list = [...stationQuery(gs.world)].filter((st) => InSystem.systemId[st] === num)
          .map((st) => { const d = gs.gameData.getStationByNum(Station.stationId[st]); return { eid: st, name: d?.name ?? 'the station', id: d?.id }; });
        gs.namedStations.set(num, list);
      }
      return list;
    },
    openSpace: (num: number, which?: number) => {
      const sys = gs.gameData.getSystemByNum(num);
      const belt = sys?.asteroidBelt;
      if (!sys || !belt) return null;
      const stations = [...stationQuery(gs.world)].filter((st) => InSystem.systemId[st] === num);
      const players = alivePlayers(num);
      for (let i = 0; i < 40; i++) {
        const seg = which && belt.extra?.[which - 1] ? belt.extra[which - 1] : beltSegment(belt, Math.floor(rng() * beltTotal(belt)));
        const a = rng() * Math.PI * 2, r = seg.innerRadius + rng() * (seg.outerRadius - seg.innerRadius);
        const x = dcos(a) * r, y = dsin(a) * r;
        if (stations.some((s) => dhypot(Position.x[s] - x, Position.y[s] - y) < 8000)) continue;
        if (players.some((p) => dhypot(Position.x[p] - x, Position.y[p] - y) < 2500)) continue;
        return { x, y };
      }
      return null;
    },
    danger: (num: number) => gs.gameData.getSystemByNum(num)?.danger ?? 1,
    send: (num: number, msg: ServerMessage) => gs.broadcastToSystem(num, msg),
    announce: (num: number, text: string, kind: 'info' | 'warn' | 'good' | 'bad') => {
      for (const c of gs.clients.values()) if (InSystem.systemId[c.playerId] === num) gs.pilots.toast(c, text, kind);
    },
    spawnPod: (num: number, x: number, y: number, vx: number, vy: number, items: Bag, life?: number) => { gs.pods.spawn(num, x, y, vx, vy, items, -1, undefined, life ? life * 60 : undefined); },
    reward: (player: number, credits: number, xp: number, reputation: Record<string, number>, why: string) => {
      const pc = gs.pilots.connOf(player);
      if (!pc) return;
      gs.pilots.addCredits(pc, credits);
      gs.pilots.addXp(pc, xp);
      gs.pilots.grant(pc, { reputation });
      gs.pilots.bumpStat(pc, why === 'raid' ? 'raidsDefended' : 'events');
      gs.pilots.bumpStat(pc, `event:${why}`);
      gs.send((pc as ClientConnection).ws, { type: 'gained', items: {}, xp, credits, x: Position.x[player], y: Position.y[player], source: 'event' });
    },
  };
}

export function createMobHost(gs: GameServer) {
  return {
    world: gs.world,
    tick: () => gs.currentTick,
    targetOf: (owner: number) => gs.enemies.targetOf(owner),
    nearestPlayer: (num: number, x: number, y: number, range: number) => {
      let best = -1, bd = range;
      for (const p of playerQuery(gs.world)) {
        if (InSystem.systemId[p] !== num || hasComponent(gs.world, Dead, p) || !gs.ships.has(p)) continue;
        const d = dhypot(Position.x[p] - x, Position.y[p] - y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },
    radiusOf: (eid: number) => gs.ships.get(eid)?.derived.radius ?? Radius.value[eid] ?? 40,
    hullGap: (eid: number, x: number, y: number, within: number) => (gs.ships.has(eid) ? gs.ships.hullDistance(eid, x, y, within) : dhypot(Position.x[eid] - x, Position.y[eid] - y) - (Radius.value[eid] ?? 40)),
    blast: (num: number, x: number, y: number, radius: number, damage: number, owner: number) => gs.ships.splashAt(num, x, y, radius, damage, owner),
    burst: (num: number, x: number, y: number, radius: number, kind: string, fizzle: boolean) =>
      gs.broadcastToSystem(num, { type: 'detonation', kind: fizzle ? 'mob_fizzle' : 'mob_burst', x: Math.round(x), y: Math.round(y), radius: Math.round(radius), mob: kind }),
    removed: (eid: number) => gs.pendingRemovedEntities.add(eid),
    terrain: (num: number) => gs.terrainOf(num),
    alive: (eid: number) => gs.ships.has(eid) && !hasComponent(gs.world, Dead, eid),
    guided: (eid: number, tick: number, op: number, args: number[]) => gs.guides.record(eid, tick, op, args),
  };
}

export function createEnemyHost(gs: GameServer) {
  return {
    world: gs.world,
    tick: () => gs.currentTick,
    players: (num: number) => {
      const out: number[] = [];
      for (const c of gs.clients.values()) {
        const p = c.playerId;
        if (hasComponent(gs.world, Player, p) && !hasComponent(gs.world, Dead, p) && InSystem.systemId[p] === num && !gs.admin.isHidden(p) && !gs.dockedShips.has(p)) out.push(p);
      }
      return out;
    },
    stations: (num: number) => [...stationQuery(gs.world)].filter((st) => InSystem.systemId[st] === num),
    where: (eid: number) => gs.lod.where(eid),
    effect: (num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch') => arrivalEffect(gs, num, x, y, kind),
    gates: (num: number) => [...portalQuery(gs.world)].filter((g) => InSystem.systemId[g] === num && Portal.kind[g] === 0).map((g) => ({ x: Position.x[g], y: Position.y[g] })),
    safeAt: (num: number, x: number, y: number) => inSafeSpace(gs.gameData.getSystemByNum(num), x, y),
    terrain: (num: number) => gs.terrainOf(num),
    // (the enemy AI's pilots' decisions, CAPS.PILOTS: net/decisions/BodyNet.ts)
    decide: (eid: number, op: number, args: readonly number[], state: BodyState) => gs.bodies.decide(eid, op, args, state),
    // (custom enemies' moves: game/custom; their shots go as a boss's do)
    fire: (owner: number, kind: string, x: number, y: number, angle: number, scale: number, opts?: { target?: number; speed?: number; seed?: string }) => { hostileShot(gs, owner, kind, x, y, angle, scale, opts); },
    send: (num: number, msg: ServerMessage) => gs.broadcastToSystem(num, msg),
    // (their moves on their clients' tick layers, CAPS.MOVES: what they work out isn't sent them)
    moveFx: (num: number, eid: number, origin: MoveOrigin, msg: ServerMessage) => gs.moveFx(num, eid, origin, msg),
    moveShot: (owner: number, kind: string, x: number, y: number, angle: number, scale: number, speed: number | undefined, seed: string, origin: MoveOrigin) => gs.moveShot(owner, kind, x, y, angle, scale, speed, seed, origin),
    systemNum: (id: string) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1),
    systemId: (num: number) => gs.gameData.getSystemByNum(num)?.id,
    systemRadius: (num: number) => {
      const s = gs.gameData.getSystemByNum(num);
      return Math.max(20000, (s?.asteroidBelt?.outerRadius ?? 30000) * 1.1);
    },
    unsafe: (num: number, x: number, y: number) => {
      const sys = gs.gameData.getSystemByNum(num);
      const cb = sys?.centralBody;
      const body = Math.max(cb?.gravity?.horizon ?? 0, cb?.radius ?? sys?.starRadius ?? 0);
      return body > 0 && dhypot(x, y) < body + 5000;
    },
    reward: (killer: number, xp: number, credits: number, assist: boolean, label: string) => {
      const pc = gs.pilots.connOf(killer);
      if (!pc) return;
      if (xp > 0) gs.pilots.addXp(pc, xp);
      if (credits > 0) gs.pilots.addCredits(pc, credits);
      gs.pilots.bumpStat(pc, assist ? 'assists' : 'kills');
      gs.send((pc as ClientConnection).ws, { type: 'gained', items: {}, xp, credits, x: Position.x[killer], y: Position.y[killer], source: assist ? `assist:${label}` : `kill:${label}` });
    },
    dropLoot: (num: number, x: number, y: number, vx: number, vy: number, items: Bag) => { gs.pods.spawn(num, x, y, vx, vy, items); },
    questKill: (player: number, type: string, faction: string) => {
      const pc = gs.pilots.connOf(player);
      if (!pc) return;
      gs.pilots.bumpStat(pc, `kills:${faction}`);
      gs.quests.onKill(pc, type, faction, gs.gameData.getSystemByNum(InSystem.systemId[player])?.id);
    },
    stationDefence: (st: number) => gs.gameData.getStationByNum(Station.stationId[st])?.defence,
    stationBeam: (num: number, station: number, target: number, turret: number) => gs.broadcastToSystem(num, { type: 'stationFire', station, target, turret }),
    sheltered: (p: number) => gs.dockedShips.has(p) || (hasComponent(gs.world, Player, p) && gs.stationInRange(p) >= 0),
    docked: (p: number) => gs.dockedShips.has(p),
    partyOf: (player: number) => {
      const pc = gs.pilots.connOf(player);
      return pc ? gs.party.members(pc).filter((m) => m !== pc).map((m) => m.playerId) : [];
    },
    // (Support credit: ships/features/support/Support.ts)
    supportersOf: (player: number) => gs.support.supporters(player, gs.currentTick),
  };
}
