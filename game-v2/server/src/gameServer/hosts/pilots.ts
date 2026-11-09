/**
 * @contract server.gameserver.hosts.pilots
 * owns:       host adapters for pilots, quests, party, people and arenas
 * needs:      GameServer (type); npm: @space-game/common, bitecs
 * invariants: behaviour is unchanged from the class it was split from — none pinned
 * extend:      a new host member is added to the matching create*Host
 */

import { hasComponent, entityExists } from 'bitecs';
import { Position, Player, Station, InSystem, Dead, inSafeSpace, dhypot } from '@space-game/common';
import { ServerMessage } from '@space-game/common';
import { unlocks, lookFn } from '@space-game/common';
import { PilotHost } from '../../game/Pilots.js';
import { FactionsFile } from '../../game/Enemies.js';
import { type PeopleHost } from '../../game/People.js';
import { type ArenaHost } from '../../game/Arenas.js';
import { insideArena } from '@space-game/common';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { stationQuery } from '../../game/Docking.js';
import { createSurfaceHost, whereIs } from './places.js';
import { siteExit } from './mining.js';
import type { GameServer } from '../../GameServer.js';

export function createPilotHost(gs: GameServer): PilotHost {
  return {
    world: gs.world,
    tick: () => gs.currentTick,
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    stationInRange: (eid) => gs.stationInRange(eid),
    hangarChanged: (conn) => gs.hangar?.send(conn as ClientConnection),
    stationEntity: (id) => {
      const num = gs.gameData.getStationNum(id);
      for (const st of stationQuery(gs.world)) if (Station.stationId[st] === num) return st;
      return -1;
    },
    stationInfo: (st) => {
      const d = gs.gameData.getStationByNum(Station.stationId[st]);
      return d ? { id: d.id, name: d.name, radius: d.dockingRadius ?? d.radius } : null;
    },
    systemId: (num) => gs.gameData.getSystemByNum(num)?.id,
    systemNum: (id) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1),
    safeToAppear: (num, x, y) => {
      const sys = gs.gameData.getSystemByNum(num);
      // (Nobody comes back into the gun range from a save: game/gunRange)
      if (!sys || sys.gunRange) return false;
      const cb = sys.centralBody;
      // (Clear of the star's surface, whatever its size)
      const body = Math.max(cb?.gravity?.horizon ?? 0, cb?.radius ?? sys.starRadius ?? 0);
      return body <= 0 || dhypot(x, y) > body + 4000;
    },
    place: (conn, num, x, y) => {
      // (Logged out inside a boss's arena: back outside its barrier, common world/gates.ts)
      const arena = gs.gameData.getSystemByNum(num)?.arena;
      if (arena && insideArena(arena, x, y)) { x = arena.outside.x; y = arena.outside.y; }
      // Someone's station only exists while it's loaded: back out by its jump point
      if (gs.gameData.getSystemByNum(num)?.private && num !== gs.devStartNum) {
        const out = gs.homes.exitFor(num) ?? siteExit(gs, conn as ClientConnection);
        if (out) return gs.placePlayer(conn as ClientConnection, out.num, out.x + 500, out.y);
      }
      gs.placePlayer(conn as ClientConnection, num, x, y);
    },
    spawnPod: (num, x, y, vx, vy, items, droppedBy) => gs.pods.spawn(num, x, y, vx, vy, items, droppedBy),
    spawnWreck: (num, x, y, vx, vy, items, key, seconds) => {
      const eid = gs.pods.spawn(num, x, y, vx, vy, items, -1, 0, seconds * 60);
      if (eid >= 0) gs.pods.keep(eid, key, gs.currentTick + seconds * 60);
      return eid;
    },
    safeAt: (num, x, y) => inSafeSpace(gs.gameData.getSystemByNum(num), x, y),
    transient: (num) => !!gs.gameData.getSystemByNum(num)?.gunRange,
  };
}

export function createQuestHost(gs: GameServer) {
  const factions = gs.gameData.factionsFile as FactionsFile;
  const stationAt = (conn: ClientConnection): string | null => {
    const st = conn.docked && entityExists(gs.world, conn.docked.station) ? conn.docked.station : gs.stationInRange(conn.playerId);
    if (st < 0 || !hasComponent(gs.world, Player, conn.playerId) || hasComponent(gs.world, Dead, conn.playerId)) return null;
    return gs.gameData.getStationByNum(Station.stationId[st])?.id ?? null;
  };
  const pretty = (id: string) => id.replace(/^boss_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    send: (conn: unknown, msg: ServerMessage) => gs.send((conn as ClientConnection).ws, msg),
    now: gs.clock,
    holdStarters: (conn: unknown) => gs.tutorial?.active(conn as ClientConnection) ?? false,
    stationAt: (conn: unknown) => stationAt(conn as ClientConnection),
    where: (conn: unknown) => whereIs(gs, conn as ClientConnection),
    enterArena: (conn: unknown, arena: string, boss: string) => gs.arenas.enter(conn as ClientConnection, arena, boss),
    systemOf: (conn: unknown) => {
      const eid = (conn as ClientConnection).playerId;
      return hasComponent(gs.world, Player, eid) && !hasComponent(gs.world, Dead, eid) ? gs.gameData.getSystemByNum(InSystem.systemId[eid])?.id : undefined;
    },
    ship: (conn: unknown) => {
      const ship = gs.ships.get((conn as ClientConnection).playerId);
      if (!ship) return null;
      const fns: Record<string, number> = {};
      const materials: Record<string, number> = {};
      let parts = 0;
      ship.blueprint.parts.forEach((p, i) => {
        if (!ship.derived.alive[i]) return;
        parts++;
        fns[p.fn] = (fns[p.fn] ?? 0) + 1;
        // (A model counts as the kind of part it is too: a Mining Laser is a miner, a Pip a weapon)
        const look = lookFn(p.fn);
        if (look !== p.fn) fns[look] = (fns[look] ?? 0) + 1;
        materials[p.material] = (materials[p.material] ?? 0) + 1;
        materials[`${p.fn}:${p.material}`] = (materials[`${p.fn}:${p.material}`] ?? 0) + 1;
      });
      return { parts, fns, materials };
    },
    bountyContext: (stationId: string) => {
      const st = gs.gameData.getStation(stationId);
      const sys = st && gs.gameData.getSystem(st.system);
      if (!st || !sys) return null;
      const danger = sys.danger ?? 1;
      const groups = factions.spawns?.[sys.id]?.groups ?? [];
      const ores = ['iron_ore', 'nickel_ore', 'silicate', 'ice'];
      if (danger >= 2) ores.push('copper_ore');
      if (danger >= 4) ores.push('titanium_ore');
      // Couriers go to stations here or one gate on; escorts to other stations here; scans need wrecks
      const peers = sys.stations.filter((s) => s !== st.id && gs.gameData.getStation(s));
      const destinations = peers.map((id) => ({ id, hops: 0 }));
      for (const g of sys.portals ?? []) {
        if (gs.quests?.file.restricted[g.targetSystem]) continue;
        for (const s of gs.gameData.getSystem(g.targetSystem)?.stations ?? []) destinations.push({ id: s, hops: 1 });
      }
      return { station: { id: st.id, name: st.name, system: sys.id }, danger, factions: [...new Set(groups.map((g) => g.faction))], ores,
        peers, destinations, derelicts: (sys.derelicts ?? []).length };
    },
    stationSystem: (id: string) => gs.gameData.getStation(id)?.system,
    bossLair: (boss: string) => gs.enemies.bossLair(boss),
    party: (conn: unknown) => gs.party.members(conn as ClientConnection),
    leads: (conn: unknown) => gs.party.isLeader(conn as ClientConnection),
    completed: (conn: unknown, q: { chain: string; name: string }) => {
      if (q.chain !== 'fleet') return;
      const c = conn as ClientConnection;
      const names = gs.party.members(c).map((m) => m.username);
      gs.achievements.post(`${names.join(', ')} completed ${q.name.replace(/^Fleet op: /, 'a fleet op: ')}`, 'fleet');
    },
    opTarget: (conn: unknown, id: string) => gs.ops?.target(conn as ClientConnection, id),
    names: {
      item: (id: string) => gs.econ.items.name(id),
      station: (id: string) => gs.gameData.getStation(id)?.name ?? id,
      system: (id: string) => gs.gameData.getSystem(id)?.name ?? id,
      faction: (id: string) => factions.factions?.[id]?.name ?? id,
      enemy: (id: string) => gs.enemies.displayName(id),
      plan: (file: string) => gs.ships.library.get(file)?.name ?? file,
      recipe: (id: string) => {
        const [kind, what] = id.split(':');
        // (a plain recipe, an item's own: Quench Slugs)
        if (what === undefined) return `${gs.econ.items.name(kind)} (recipe)`;
        return `${pretty(what)} fabrication`;
      },
    },
  };
}

export function createPartyHost(gs: GameServer) {
  return {
    send: (conn: unknown, msg: ServerMessage) => gs.send((conn as ClientConnection).ws, msg),
    toast: (conn: unknown, text: string, kind?: 'info' | 'good' | 'warn' | 'bad') => gs.pilots.toast(conn as ClientConnection, text, kind),
    byName: (name: string) => [...gs.clients.values()].find((c) => c.username.toLowerCase() === name.toLowerCase()),
    byEntity: (eid: number) => gs.liveConn(eid),
    status: (conn: unknown) => {
      const c = conn as ClientConnection;
      const eid = c.playerId;
      const p = gs.pilots.get(c);
      if (!gs.flying(eid)) return p ? { system: '', x: 0, y: 0, hull: 0, alive: false, level: p.level, ship: '' } : null;
      return {
        system: gs.gameData.getSystemByNum(InSystem.systemId[eid])?.id ?? '', x: Position.x[eid], y: Position.y[eid],
        hull: gs.ships.integrity(eid), alive: true, level: p?.level ?? 1, ship: gs.ships.get(eid)?.blueprint.name ?? '',
      };
    },
    partySize: (conn: unknown) => { const p = gs.pilots.get(conn as ClientConnection); return p ? unlocks(p).partySize : 4; },
    setWing: (conn: unknown, k: number) => gs.ships.setWingBonus((conn as ClientConnection).playerId, k),
    now: gs.clock,
  };
}

export function createPeopleHost(gs: GameServer): PeopleHost {
  const quests = createQuestHost(gs);
  return {
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    where: (conn) => whereIs(gs, conn as ClientConnection),
    stationAt: (conn) => quests.stationAt(conn),
    stationName: (id) => gs.gameData.getStation(id)?.name ?? id,
    stationSystem: (id) => gs.gameData.getStation(id)?.system,
    itemName: (id) => gs.econ.items.name(id),
    random: () => gs.rng(),
  };
}

export function createArenaHost(gs: GameServer): ArenaHost {
  const surfaceHost = createSurfaceHost(gs);
  return {
    tick: () => gs.currentTick,
    systems: () => gs.gameData.getAllSystems(),
    instances: (id) => gs.gameData.getSystemInstances(id),
    partyId: (conn) => gs.party.partyId(conn as ClientConnection),
    pilots: surfaceHost.pilots,
    travel: surfaceHost.travel,
    toOrbit: (conn, surface, angle) => gs.surfaces.toOrbit(conn, surface, angle),
    toast: (conn, text, kind) => gs.pilots.toast(conn, text, kind),
    spawnBoss: (boss, num, x, y) => gs.bosses.spawnAt(boss, num, x, y),
    bossAlive: (eid) => gs.ships.has(eid),
    removeBoss: (eid) => gs.bosses.remove(eid),
  };
}
