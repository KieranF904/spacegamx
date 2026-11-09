/**
 * @contract server.gameserver.wiring.game
 * owns:       constructor argument objects for the game modules (weapons, market, services, hazards, homes, bosses support, social, trade and more)
 * needs:      GameServer (type); npm: @space-game/common, bitecs
 * invariants: called in constructor order; evaluation order is kept — server/src/golden/frameHash.test.ts
 * extend:      a new dependency for one of these modules is a member of its *Deps function
 */

import { removeEntity, addComponent, hasComponent, entityExists } from 'bitecs';
import { Position, Velocity, Radius, Player, Station, InSystem, Dead, dhypot } from '@space-game/common';
import { EffectType } from '@space-game/common';
import { Pilots } from '../../game/Pilots.js';
import { Hazards } from '../../game/Hazards.js';
import { Warmth } from '../../game/Warmth.js';
import { HomeStations } from '../../game/HomeStations.js';
import { StationServices } from '../../game/StationServices.js';
import { Weapons } from '../../game/Weapons.js';
import { Codex } from '../../game/Codex.js';
import { ArenaGates } from '../../game/arenas/ArenaGates.js';
import { BossDev } from '../../game/dev/bossDev.js';
import { EnemyRecovery } from '../../game/enemies/recovery.js';
import { Dens } from '../../game/dens/Dens.js';
import { ContributorNotes } from '../../game/ContributorNotes.js';
import { Social } from '../../game/social/Social.js';
import { Trade } from '../../game/Trade.js';
import { Market } from '../../game/Market.js';
import { Achievements } from '../../game/Achievements.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { Docking, stationQuery } from '../../game/Docking.js';
import { Derelicts } from '../../game/Derelicts.js';
import { SimPass } from '../../sim/SystemClocks.js';
import { DERELICT_LOG_RANGE } from '../shared.js';
import { GameServerOptions } from '../options.js';
import { createBossHost } from '../hosts/boss.js';
import { releaseUsedTraces } from '../hosts/mining.js';
import { createStation, createPortal } from '../world.js';
import { devStartSpot } from '../session.js';
import { releaseControls, tick } from '../loop.js';
import type { GameServer } from '../../GameServer.js';

export function dockingDeps(gs: GameServer): ConstructorParameters<typeof Docking>[0] {
  return {
    world: gs.world,
    gameData: gs.gameData,
    clients: gs.clients,
    shipEditAnywhere: gs.shipEditAnywhere,
    pilots: gs.pilots,
    ammo: gs.ammo,
    quests: gs.quests,
    send: (ws, msg) => gs.send(ws, msg),
    clock: gs.clock,
    releaseControls: (eid) => gs.releaseControls(eid),
    berthed: (eid) => gs.features.onBerthed(eid),
    docked: (conn, station) => gs.tutorial?.docked(conn, station),
  };
}

export function pilotsOpts(gs: GameServer, opts: GameServerOptions): ConstructorParameters<typeof Pilots>[4] {
  return {
    starter: gs.starterKit(),
    guestShips: process.env.NODE_ENV !== 'production' ? opts.guestShips : undefined,
    spawn: gs.devStartNum >= 0 ? (eid) => devStartSpot(gs, eid) : undefined,
    autosaveMs: 30_000,
    now: opts.clock,
  };
}

export function weaponsDeps(gs: GameServer): ConstructorParameters<typeof Weapons>[0] {
  return {
    world: gs.world,
    tick: () => gs.currentTick,
    broadcast: (num, msg) => gs.broadcastToSystem(num, msg),
    hitFx: (proj, msg) => gs.hits.hitFx(proj, msg),
    guided: (proj, tick, op, args) => gs.guides.record(proj, tick, op, args),
    remove: (eid) => { addComponent(gs.world, Dead, eid); gs.pendingRemovedEntities.add(eid); },
    // (A pilot's push is told to its client, TEMPORARY: ShipBridge.push)
    nudge: (eid, ax, ay) => gs.ships.push(eid, ax, ay),
    miningTool: (kind, turret) => {
      const t = gs.gameData.miningTable.tools as unknown as Record<string, { yield: number; hardness: number }>;
      // (A kind with no entry of its own mines like a fixed gun's shells)
      return kind === 'cannon' ? t[turret ? 'turret' : 'fixed'] : t[kind] ?? t.fixed;
    },
  };
}

export function marketDeps(gs: GameServer, opts: GameServerOptions, stationAtConn: ConstructorParameters<typeof Market>[0]['stationAt']): ConstructorParameters<typeof Market>[0] {
  return {
    now: opts.clock ?? (() => Date.now()),
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    stations: () => gs.gameData.getAllStations(),
    systemName: (id) => gs.gameData.getSystem(id)?.name ?? id,
    stationAt: stationAtConn,
  };
}

export function servicesDeps(gs: GameServer, opts: GameServerOptions): ConstructorParameters<typeof StationServices>[0] {
  return {
    stationAt: (conn) => {
      const c = conn as ClientConnection;
      const st = c.docked && entityExists(gs.world, c.docked.station) ? c.docked.station : gs.stationInRange(c.playerId);
      return st >= 0 && hasComponent(gs.world, Player, c.playerId) && !hasComponent(gs.world, Dead, c.playerId)
        ? gs.gameData.getStationByNum(Station.stationId[st]) ?? null : null;
    },
    stationName: (id) => gs.gameData.getStation(id)?.name ?? id,
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    now: opts.clock ?? (() => Date.now()),
    delivered: (conn) => gs.hangar?.fill(conn),
    cancelled: (conn, job) => gs.hangar?.jobCancelled(conn, job),
    jobsChanged: (conn) => gs.hangar?.send(conn),
    refined: (conn, used) => { releaseUsedTraces(gs, conn, used); gs.tutorial?.refined(conn as ClientConnection, used); },
    station: (id) => gs.gameData.getStation(id) ?? null,
    stationsWith: (service) => gs.gameData.getAllStations().filter((st) => st.services.includes(service as never)),
  };
}

export function hazardsDeps(gs: GameServer): ConstructorParameters<typeof Hazards>[0] {
  return {
    flying: () => [...gs.clients.values()].filter((c) => gs.flying(c.playerId)).map((c) => ({ conn: c, eid: c.playerId })),
    system: (eid) => gs.gameData.getSystemByNum(InSystem.systemId[eid]),
    position: (eid) => ({ x: Position.x[eid], y: Position.y[eid] }),
    toast: (conn, text, kind) => gs.pilots.toast(conn as ClientConnection, text, kind),
    tick: () => gs.currentTick,
  };
}

export function warmthDeps(gs: GameServer): ConstructorParameters<typeof Warmth>[0] {
  return {
    flying: () => [...gs.clients.values()].filter((c) => gs.flying(c.playerId)).map((c) => ({ conn: c, eid: c.playerId })),
    system: (eid) => gs.gameData.getSystemByNum(InSystem.systemId[eid]),
    systemNum: (eid) => InSystem.systemId[eid],
    position: (eid) => ({ x: Position.x[eid], y: Position.y[eid] }),
    docked: (eid) => gs.dockedShips.has(eid),
    stations: (eid) => [...stationQuery(gs.world)].filter((st) => InSystem.systemId[st] === InSystem.systemId[eid]).map((st) => ({ x: Position.x[st], y: Position.y[st], radius: Radius.value[st] })),
    toast: (conn, text, kind) => gs.pilots.toast(conn as ClientConnection, text, kind),
    tick: () => gs.currentTick,
  };
}

export function homesDeps(gs: GameServer): ConstructorParameters<typeof HomeStations>[0] {
  return {
    tick: () => gs.currentTick,
    instances: (id) => gs.gameData.getSystemInstances(id),
    pilots: (num) => [...gs.clients.values()].filter((c) => gs.flying(c.playerId) && InSystem.systemId[c.playerId] === num),
    travel: (conn, num, x, y) => { (conn as ClientConnection).docked = null; gs.travelTo(conn as ClientConnection, num, x, y, false); },
    systemNum: (id) => gs.gameData.getSystemNum(id),
    stationSystem: (id) => gs.gameData.getStation(id)?.system,
    spawnDock: (num) => { const d = gs.gameData.getStation('homestead_dock'); return d ? createStation(gs, d, num) : -1; },
    spawnGate: (num, x, y, to) => createPortal(gs, { position: { x, y }, targetSystem: to }, num),
    spawnStructure: (bp, num, x, y, name) => {
      const eid = gs.ships.spawnDummy(bp, x, y, 0, num);
      gs.ships.pin(eid);
      // Named, and out of every fight (as people's craft are)
      gs.personCraft.set(eid, name);
      return eid;
    },
    remove: (eid) => {
      if (eid < 0) return;
      if (gs.ships.has(eid)) { gs.personCraft.delete(eid); gs.ships.removeShip(eid); return; }
      if (!entityExists(gs.world, eid)) return;
      gs.pendingRemovedEntities.add(eid);
      removeEntity(gs.world, eid);
    },
    toast: (conn, text, kind) => gs.pilots.toast(conn as ClientConnection, text, kind),
  };
}

export function arenaGatesDeps(gs: GameServer): ConstructorParameters<typeof ArenaGates>[0] {
  return {
    tick: () => gs.currentTick,
    arenaOf: (num) => gs.gameData.getSystemByNum(num)?.arena,
    players: (num) => gs.bosses.livePlayers(num),
    shipRadius: (eid) => gs.ships.get(eid)?.derived.radius ?? -1,
    teleport: (eid, x, y) => gs.ships.teleport(eid, x, y),
    toast: (eid, text, kind) => { const pc = gs.pilots.connOf(eid); if (pc) gs.pilots.toast(pc, text, kind); },
    warpFx: (num, x, y, out) => gs.broadcastToSystem(num, { type: 'effect', effectType: out ? EffectType.WarpOut : EffectType.WarpIn, x: Math.round(x), y: Math.round(y) }),
    combat: gs.combat,
  };
}

export function recoveryDeps(gs: GameServer): ConstructorParameters<typeof EnemyRecovery>[0] {
  return {
    tick: () => gs.currentTick,
    heals: (eid) => gs.enemies.isAlive(eid) && !gs.bosses.life.holds(eid),
    active: (eid) => SimPass.on(InSystem.systemId[eid]),
    custom: (eid) => gs.enemies.custom.has(eid),
    lastCombat: (eid) => gs.combat.lastOf(eid),
    heal: (eid, share) => gs.ships.healAll(eid, share),
    restore: (eid) => gs.ships.repair(eid),
  };
}

export function bossDevDeps(gs: GameServer): ConstructorParameters<typeof BossDev<ClientConnection>>[0] {
  return {
    tick: () => gs.currentTick,
    bosses: gs.bosses,
    gates: gs.arenaGates,
    ships: gs.ships,
    send: (conn, msg) => gs.send(conn.ws, msg),
    toast: (conn, text, kind) => gs.pilots.toast(conn, text, kind),
    nameOf: (eid) => gs.pilots.connOf(eid)?.username ?? (gs.bosses.unhurt.has(eid) ? `dummy ${eid}` : `#${eid}`),
    teleport: (eid, x, y) => { gs.ships.teleport(eid, x, y); Velocity.x[eid] = 0; Velocity.y[eid] = 0; },
    slow: (num, rate) => {
      if (!gs.crowd || !gs.clocks) return false;
      // (a crowd level with that rate, pinned: CrowdControl leaves a forced level alone; 60 lets it go)
      gs.crowd.force(num, rate === 30 ? 7 : rate === 15 ? 9 : null);
      return true;
    },
    rateOf: (num) => gs.clocks?.rateOf(num) ?? 60,
    live: (conn) => gs.clients.has(conn.ws),
  };
}

export function densDeps(gs: GameServer, bossHost: ReturnType<typeof createBossHost>): ConstructorParameters<typeof Dens>[0] {
  return {
    tick: () => gs.currentTick, ships: gs.ships, players: bossHost.players, send: bossHost.send, terrain: bossHost.terrain, payout: gs.payout,
    systems: () => gs.gameData.getAllSystems().filter((s) => s.den?.length).map((s) => ({ num: gs.gameData.getSystemNum(s.id), den: s.den! })),
    who: (eid) => gs.pilots.connOf(eid)?.username ?? null,
    toast: (eid, text, kind) => { const pc = gs.pilots.connOf(eid); if (pc) gs.pilots.toast(pc, text, kind); },
    reward: (eid, items, text) => {
      const pc = gs.pilots.connOf(eid);
      if (!pc) return;
      gs.pilots.give(pc, items, { toStorage: true, source: 'den', at: { x: Position.x[eid], y: Position.y[eid] } });
      gs.pilots.toast(pc, text, 'good');
      gs.pilots.saveNow(pc);
    },
  };
}

export function contribDeps(gs: GameServer): ConstructorParameters<typeof ContributorNotes<ClientConnection>>[0] {
  return {
    conns: () => gs.clients.values(),
    send: (c, msg) => gs.send(c.ws, msg),
    bodies: (id) => {
      const sys = gs.gameData.getSystem(id);
      if (!sys) return null;
      return { planets: sys.planets, nests: sys.nests, lodestones: sys.lodestones, stations: gs.gameData.getSystemStations(id) };
    },
    tick: () => gs.currentTick,
  };
}

export function codexDeps(gs: GameServer): ConstructorParameters<typeof Codex>[0] {
  return {
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    ctx: (conn, p) => gs.people.ctx(conn, p),
    wreckLogs: (conn) => {
      const eid = (conn as ClientConnection).playerId;
      if (!gs.derelicts.some((d) => d.data.log) || !gs.flying(eid)) return [];
      const num = InSystem.systemId[eid], x = Position.x[eid], y = Position.y[eid];
      return gs.derelicts.filter((d) => d.data.log && d.systemNum === num && d.eid >= 0 && gs.ships.has(d.eid)
        && dhypot(Position.x[d.eid] - x, Position.y[d.eid] - y) < DERELICT_LOG_RANGE).map((d) => d.data.log!.codex);
    },
  };
}

export function achievementsDeps(gs: GameServer): ConstructorParameters<typeof Achievements>[0] {
  return {
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    broadcast: (msg) => { for (const c of gs.clients.values()) gs.send(c.ws, msg); },
    now: gs.clock,
  };
}

export function socialDeps(gs: GameServer): ConstructorParameters<typeof Social>[0] {
  return {
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    toast: (conn, text, kind) => gs.pilots.toast(conn as ClientConnection, text, kind),
    note: (conn, text, color) => gs.send((conn as ClientConnection).ws, { type: 'systemMessage', text, color }),
    conns: () => gs.clients.values(),
    now: gs.clock,
  };
}

export function derelictsDeps(gs: GameServer): ConstructorParameters<typeof Derelicts>[0] {
  return {
    world: gs.world,
    gameData: gs.gameData,
    clients: gs.clients,
    ships: gs.ships,
    pilots: gs.pilots,
    pods: gs.pods,
    codex: gs.codex,
    people: gs.people,
    memory: gs.memory,
    econ: gs.econ,
    send: (ws, msg) => gs.send(ws, msg),
    tick: () => gs.currentTick,
  };
}

export function tradeDeps(gs: GameServer): ConstructorParameters<typeof Trade>[0] {
  return {
    send: (conn, msg) => gs.send((conn as ClientConnection).ws, msg),
    byEntity: (eid) => gs.liveConn(eid),
    distance: (a, b) => {
      const ea = a.playerId, eb = b.playerId;
      if (!gs.flying(ea) || !gs.flying(eb) || InSystem.systemId[ea] !== InSystem.systemId[eb]) return Infinity;
      return dhypot(Position.x[ea] - Position.x[eb], Position.y[ea] - Position.y[eb]);
    },
    now: gs.clock,
    log: (t) => console.log(`[Trade] ${t}`),
  };
}
