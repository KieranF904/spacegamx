/**
 * @contract server.gameserver.hosts.gun-range
 * owns:       the host adapter for the gun range (game/gunRange): its system, berths, travel, the target's ship, and the
 *             module's construction
 * needs:      GameServer (type), game/gunRange/GunRange, game/Docking (berths: conn.docked, dockedShips); npm: @space-game/common, bitecs
 * invariants: a server whose data has no gun range builds the module but every entry is refused — server/src/game/gunRange/gunRange.test.ts
 * extend:     a new thing the range needs from the server is a member of GunRangeHost and a line here
 */

import { hasComponent, entityExists } from 'bitecs';
import { InSystem, Player, Position, Rotation, Station, type Charge, type GunRangeDef } from '@space-game/common';
import { GunRange, type GunRangeHost, type RangeBerth } from '../../game/gunRange/GunRange.js';
import type { ClientConnection } from '../../net/ClientConnection.js';
import type { PilotConn } from '../../game/Pilots.js';
import type { GameServer } from '../../GameServer.js';

export function createGunRangeHost(gs: GameServer): GunRangeHost {
  let found: { num: number; def: GunRangeDef } | null | undefined;
  const range = () => {
    if (found === undefined) {
      const sys = gs.gameData.getAllSystems().find((s) => s.gunRange);
      found = sys?.gunRange ? { num: gs.gameData.getSystemNum(sys.id), def: sys.gunRange } : null;
    }
    return found;
  };
  const c = (conn: PilotConn) => conn as ClientConnection;
  return {
    tick: () => gs.currentTick,
    catalog: gs.ships.catalog,
    range,
    send: (conn, msg) => gs.send(c(conn).ws, msg),
    toast: (conn, text, kind) => gs.pilots.toast(conn, text, kind),
    flying: (conn) => gs.flying(conn.playerId),
    training: (conn) => !!gs.tutorial?.active(conn),
    connected: (conn) => gs.clients.get(c(conn).ws) === conn,
    systemOf: (conn) => InSystem.systemId[conn.playerId],
    where: (conn) => ({ x: Position.x[conn.playerId], y: Position.y[conn.playerId] }),
    berthOf: (conn): RangeBerth | null => {
      const d = c(conn).docked;
      if (!d || !entityExists(gs.world, d.station) || !hasComponent(gs.world, Station, d.station)) return null;
      const sd = gs.gameData.getStationByNum(Station.stationId[d.station]);
      return sd ? { station: d.station, id: sd.id, name: sd.name, state: { ...d } } : null;
    },
    unberth: (conn) => {
      c(conn).docked = null;
      gs.dockedShips.delete(conn.playerId);
    },
    travel: (conn, num, x, y, angle) => {
      gs.travelTo(c(conn), num, x, y, false);
      Rotation.angle[conn.playerId] = angle;
    },
    reberth: (conn, berth) => {
      const st = berth.station;
      if (!entityExists(gs.world, st) || !hasComponent(gs.world, Station, st) || gs.gameData.getStationByNum(Station.stationId[st])?.id !== berth.id) return false;
      if (!hasComponent(gs.world, Player, conn.playerId)) return false;
      const conn2 = c(conn);
      gs.travelTo(conn2, InSystem.systemId[st], Position.x[st], Position.y[st], false);
      // (In the berth as it was: Docking's record, held at the station's centre, out where they first came in)
      conn2.docked = { ...(berth.state as NonNullable<ClientConnection['docked']>), station: st };
      gs.dockedShips.add(conn.playerId);
      gs.releaseControls(conn.playerId);
      conn2.scheduledInputs.length = 0;
      gs.send(conn2.ws, { type: 'dockResult', ok: true, station: berth.name });
      return true;
    },
    charge: (conn) => structuredClone(gs.ships.chargeOf(conn.playerId)),
    setCharge: (conn, ch) => { if (ch && gs.ships.has(conn.playerId)) gs.ships.setCharge(conn.playerId, ch as Charge); },
    calm: (conn) => gs.combat.forget(conn.playerId),
    pilotsIn: (num) => [...gs.clients.values()].filter((x) => hasComponent(gs.world, Player, x.playerId) && InSystem.systemId[x.playerId] === num),
    sendHome: (conn) => {
      const at = gs.pilots.homePoint(conn);
      if (at) gs.travelTo(c(conn), at.system, at.x, at.y, false);
    },
    target: {
      spawn: (t) => {
        const r = range();
        return r ? gs.enemies.spawnTarget(r.num, { ship: t.ship, faction: t.faction, grade: t.grade, hp: t.hp }, t.x, t.y, t.angle) : -1;
      },
      alive: (eid) => gs.ships.has(eid) && gs.enemies.isTarget(eid),
      remove: (eid) => { if (gs.ships.has(eid)) gs.ships.removeShip(eid); },
      steer: (eid, to) => gs.enemies.steerTarget(eid, to),
      where: (eid) => ({ x: Position.x[eid], y: Position.y[eid] }),
    },
  };
}

/** The gun range module, wired to this server */
export function setupGunRange(gs: GameServer): GunRange {
  return new GunRange(createGunRangeHost(gs), gs.pilots, gs.ammo);
}
