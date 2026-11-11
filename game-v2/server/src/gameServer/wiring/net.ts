/**
 * @contract server.gameserver.wiring.net
 * owns:       constructor argument objects for the network modules (features, replication, lod, crowd, clocks, snapshots, own checks, bodies)
 * needs:      GameServer (type); npm: @space-game/common, bitecs
 * invariants: called in constructor order; evaluation order is kept — server/src/golden/frameHash.test.ts
 * extend:      a new dependency for one of these modules is a member of its *Deps function
 */

import { hasComponent } from 'bitecs';
import { Position, Velocity, Rotation, Player, InSystem } from '@space-game/common';
import { countOf } from '@space-game/common';
import { ServerFeatures } from '../../ships/features/host.js';
import { Replication } from '../../net/Replication.js';
import { SimLod } from '../../ships/SimLod.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { OwnChecks } from '../../net/own/OwnChecks.js';
import { BodyNet } from '../../net/decisions/BodyNet.js';
import { CrowdControl } from '../../net/crowd/CrowdControl.js';
import { SystemClocks } from '../../sim/SystemClocks.js';
import { SnapshotBuilder } from '../../net/SnapshotBuilder.js';
import { lodObservers, namedBody } from '../hosts/places.js';
import { asteroidSpawnData } from '../asteroids.js';
import { trafficIntent } from '../traffic.js';
import { canDamage, sideOf } from '../rules.js';
import { tick } from '../loop.js';
import type { GameServer } from '../../GameServer.js';

export function featuresDeps(gs: GameServer): ConstructorParameters<typeof ServerFeatures>[1] {
  return {
    world: gs.world,
    ships: gs.ships,
    pods: gs.pods,
    tuning: gs.ships.tuning,
    getTick: () => gs.currentTick,
    tell: (pilot, text, color) => { for (const c of gs.clients.values()) if (c.playerId === pilot) gs.send(c.ws, { type: 'systemMessage', text, color }); },
    stationInRange: (pilot) => gs.stationInRange(pilot),
    isDocked: (pilot) => gs.dockedShips.has(pilot),
    deliver: (pilot, target, kind) => gs.derelictsMod.towDelivered(pilot, target, kind),
    effect: (eid, type) => gs.broadcastToSystem(InSystem.systemId[eid], { type: 'effect', effectType: type, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), entityId: eid }),
    pilotsIn: (eid) => { const out: number[] = []; for (const c of gs.clients.values()) if (InSystem.systemId[c.playerId] === InSystem.systemId[eid] && hasComponent(gs.world, Player, c.playerId)) out.push(c.playerId); return out; },
    // (Field machines: features/machines)
    econ: gs.econ,
    send: (pilot, msg) => { for (const c of gs.clients.values()) if (c.playerId === pilot) gs.send(c.ws, msg); },
    profile: (pilot) => { const c = gs.pilots.connOf(pilot); return c && gs.pilots.get(c); },
    markDirty: (pilot) => { const c = gs.pilots.connOf(pilot); if (c) gs.pilots.markDirty(c); },
    recordChanged: (pilot) => { const c = gs.pilots.connOf(pilot); if (c) gs.hangar.send(c); },
    holdCount: (pilot, id) => { const c = gs.pilots.connOf(pilot); return c ? countOf(gs.pilots.get(c)?.cargo ?? [], id) : 0; },
    holdTake: (pilot, items) => { const c = gs.pilots.connOf(pilot); return !!c && gs.pilots.take(c, items, 'cargo'); },
    holdGive: (pilot, items) => { const c = gs.pilots.connOf(pilot); return c ? gs.pilots.give(c, items, { quiet: true }) : items; },
    holdRoom: (pilot) => { const c = gs.pilots.connOf(pilot); return c ? gs.pilots.cargoFree(c) : 0; },
    freeBuild: (pilot) => { const c = gs.pilots.connOf(pilot); return !!c && gs.freeBuild(c as ClientConnection); },
    // (The Mine Bay: features/minebay)
    canDamage: (a, b) => gs.canDamage(a, b),
    sameParty: (a, b) => { const ca = gs.pilots.connOf(a), cb = ca && gs.pilots.connOf(b); return !!ca && !!cb && gs.party.same(ca, cb); },
    shipView: (pilot) => (gs.pilots.connOf(pilot) as ClientConnection | undefined)?.shipView,
    sideOf: (eid) => gs.sideOf(eid),
  };
}

export function replicationDeps(gs: GameServer): ConstructorParameters<typeof Replication>[0] {
  return {
    tick: () => gs.currentTick,
    env: (eid) => gs.replicaEnv(InSystem.systemId[eid]),
    dockOf: (eid) => {
      const c = gs.liveConn(eid);
      return c?.docked ? { station: c.docked.station, ox: c.docked.ox, oy: c.docked.oy } : null;
    },
    docks: () => {
      const out = new Map<number, { station: number; ox: number; oy: number }>();
      for (const c of gs.clients.values()) if (c.docked) out.set(c.playerId, { station: c.docked.station, ox: c.docked.ox, oy: c.docked.oy });
      return out;
    },
    occupied: () => {
      const out = new Set<number>();
      for (const c of gs.clients.values()) out.add(InSystem.systemId[c.playerId]);
      return out;
    },
    // (A pilot's client stepping its own ship, CAPS.OWN_SIM: network/ownTick.ts)
    ownSim: (eid) => !!gs.liveConn(eid),
    ownControls: (eid) => gs.liveConn(eid)?.ownCtl ?? null,
    ownLate: (eid) => { const c = gs.liveConn(eid); if (!c?.ownLate) return false; c.ownLate = false; return true; },
  };
}

export function lodDeps(gs: GameServer): ConstructorParameters<typeof SimLod>[0] {
  return {
    tick: () => gs.currentTick,
    observers: () => lodObservers(gs),
    intent: (eid, at) => trafficIntent(gs, eid, at) ?? gs.enemies.intent(eid, at),
    busy: (eid) => (gs.wards.has(eid) && gs.lodOccupied.has(InSystem.systemId[eid])) || gs.bosses.busy(eid),
    watched: () => {
      const out = new Set<number>();
      for (const c of gs.clients.values()) { const t = gs.ships.targetOf(c.playerId); if (t >= 0) out.add(t); }
      return out;
    },
  };
}

export function crowdDeps(gs: GameServer): ConstructorParameters<typeof CrowdControl>[0] {
  return {
    clients: () => gs.clients.values(),
    systemOf: (conn) => (hasComponent(gs.world, Player, conn.playerId) ? InSystem.systemId[conn.playerId] : -1),
    send: (conn, msg) => gs.send(conn.ws, msg),
    tickOf: (s) => gs.clocks?.tickOf(s) ?? gs.currentTick,
    setRate: (s, r, at) => gs.clocks?.setRate(s, r, at),
    ownClock: (s) => !!gs.clocks?.owns(s),
    rateOf: (s) => gs.clocks?.rateOf(s) ?? 60,
  };
}

export function clocksDeps(gs: GameServer): ConstructorParameters<typeof SystemClocks>[0] {
  return {
    baseTick: () => gs.currentTick,
    occupied: (s) => { for (const c of gs.clients.values()) if (hasComponent(gs.world, Player, c.playerId) && InSystem.systemId[c.playerId] === s) return true; return false; },
  };
}

export function snapshotDeps(gs: GameServer): ConstructorParameters<typeof SnapshotBuilder>[0] {
  return {
    world: gs.world,
    gameData: gs.gameData,
    clients: gs.clients,
    scene: gs.scene,
    ships: gs.ships,
    enemies: gs.enemies,
    lod: gs.lod,
    party: gs.party,
    events: gs.events,
    surfaces: gs.surfaces,
    asteroidIdsBySystem: gs.asteroidIdsBySystem,
    asteroidSeedTickBySystem: gs.asteroidSeedTickBySystem,
    asteroidIndexById: gs.asteroidIndexById,
    respawnedAsteroids: gs.respawnedAsteroids,
    send: (ws, msg) => gs.send(ws, msg),
    namedBody: (eid) => gs.namedBody(eid),
    flying: (eid) => gs.flying(eid),
    asteroidSpawnData: (eid) => gs.asteroidSpawnData(eid),
    mineState: (miner, num) => gs.mining.partWorked(miner, num),
    replication: gs.replication,
    mobs: gs.mobs,
    pods: gs.pods,
    features: gs.features,
    personCraft: gs.personCraft,
    wards: gs.wards,
    lingering: gs.lingering,
    pendingRemovedEntities: gs.pendingRemovedEntities,
    lastEntityStates: gs.lastEntityStates,
    hits: gs.hits,
    ownChecks: gs.ownChecks,
    bodies: gs.bodies,
    guides: gs.guides,
    blocks: gs.net.blocks,
    crowd: gs.crowd,
    gunNet: gs.gunNet,
  };
}

export function ownChecksDeps(gs: GameServer): ConstructorParameters<typeof OwnChecks>[0] {
  return {
    tick: () => gs.currentTick,
    // (Its check covers every ship it holds, so all of them go again: OwnChecks)
    rekey: (conn) => { conn.repKnown.clear(); conn.ownSyncDue = true; gs.guides.resync(conn); },
    resyncHp: (conn) => { conn.shipHpSent.delete(conn.playerId); conn.shipSynced.delete(conn.playerId); },
  };
}

export function bodiesDeps(gs: GameServer): ConstructorParameters<typeof BodyNet>[0] {
  return {
    tick: () => gs.currentTick,
    body: (eid) => {
      const s = gs.ships.get(eid);
      return s ? { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], angle: Rotation.angle[eid], angVel: s.angVel } : null;
    },
    has: (eid) => gs.ships.has(eid),
  };
}
