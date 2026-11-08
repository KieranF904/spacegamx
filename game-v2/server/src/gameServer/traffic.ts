/**
 * @contract server.gameserver.traffic
 * owns:       freighter traffic between stations
 * needs:      GameServer (type), ships/SimLod
 * invariants: behaviour is unchanged from the class it was split from — none pinned
 * extend:      traffic rules live in trafficSystem and trafficIntent
 */

import { Position, Station, InSystem, dcos, dhypot, dsin } from '@space-game/common';
import { hashString } from '@space-game/common';
import { type Plan, type Intent } from '../ships/SimLod.js';
import { stationQuery } from '../game/Docking.js';
import { TRAFFIC_RESPAWN_TICKS, TRAFFIC_ARRIVE_RADIUS, TRAFFIC_DWELL_TICKS } from './shared.js';
import type { GameServer } from '../GameServer.js';

/** Entity ids of the civilian freighters flying now */
export function getTrafficShips(gs: GameServer): { eid: number; route: string[]; leg: number }[] {
  return gs.traffic.filter((t) => t.eid >= 0).map((t) => ({ eid: t.eid, route: t.data.route, leg: t.leg }));
}

/** A station entity by its data id, in a system */
export function stationEntity(gs: GameServer, stationId: string, systemNum: number): number {
  const num = gs.gameData.getStationNum(stationId);
  for (const st of stationQuery(gs.world)) {
    if (Station.stationId[st] === num && InSystem.systemId[st] === systemNum) return st;
  }
  return -1;
}

/**
 * Freighters fly their loop of stations: cruise to the next one, hold there
 * a few seconds, move on. A destroyed freighter is replaced at the start of
 * its route two minutes later.
 */
export function trafficSystem(gs: GameServer): void {
  for (const slot of gs.traffic) {
    if (!gs.memory.isResident(slot.systemNum)) continue;
    if (slot.eid >= 0 && !gs.ships.has(slot.eid)) {
      slot.eid = -1;
      slot.respawnTick = gs.currentTick + TRAFFIC_RESPAWN_TICKS;
    }
    if (slot.eid < 0) {
      if (gs.currentTick < slot.respawnTick) continue;
      const bp = gs.ships.library.get(slot.data.blueprint);
      const st = gs.stationEntity(slot.data.route[0], slot.systemNum);
      if (!bp || st < 0) continue;
      const a = (hashString(slot.data.id) % 628) / 100;
      slot.eid = gs.ships.spawnDummy(bp, Position.x[st] + dcos(a) * 900, Position.y[st] + dsin(a) * 900, a + Math.PI, slot.systemNum);
      // (It keeps its route, but shoots back at whoever hurts it: game/enemies/defenders.ts)
      gs.enemies.defend(slot.eid);
      slot.leg = 1 % slot.data.route.length;
      slot.dwell = 0;
    }
    // (Distant: its route's planned leg by leg, trafficIntent)
    if (gs.ships.isDormant(slot.eid)) continue;
    const st = gs.stationEntity(slot.data.route[slot.leg], slot.systemNum);
    if (st < 0) continue;
    const dist = dhypot(Position.x[st] - Position.x[slot.eid], Position.y[st] - Position.y[slot.eid]);
    if (dist < TRAFFIC_ARRIVE_RADIUS + 200) {
      if (++slot.dwell > TRAFFIC_DWELL_TICKS) {
        slot.leg = (slot.leg + 1) % slot.data.route.length;
        slot.dwell = 0;
      }
    }
    gs.ships.setAutopilot(slot.eid, { x: Position.x[st], y: Position.y[st], arriveRadius: TRAFFIC_ARRIVE_RADIUS });
  }
}

/**
 * A distant freighter's next leg (ships/SimLod.ts), as trafficSystem flies a
 * live one: on to its next station, holding there a while first; re-aimed
 * now and then (stations go round). undefined: not a freighter.
 */
export function trafficIntent(gs: GameServer, eid: number, at: Plan): Intent | undefined {
  const slot = gs.traffic.find((t) => t.eid === eid);
  if (!slot) return undefined;
  let st = gs.stationEntity(slot.data.route[slot.leg], slot.systemNum);
  if (st >= 0 && dhypot(Position.x[st] - at.x, Position.y[st] - at.y) < TRAFFIC_ARRIVE_RADIUS + 200) {
    const left = TRAFFIC_DWELL_TICKS - slot.dwell;
    if (left > 0) { slot.dwell = TRAFFIC_DWELL_TICKS; return { kind: 'hold', until: at.tick + left }; }
    slot.leg = (slot.leg + 1) % slot.data.route.length;
    slot.dwell = 0;
    st = gs.stationEntity(slot.data.route[slot.leg], slot.systemNum);
  }
  if (st < 0) return { kind: 'hold' };
  return { kind: 'goto', x: Position.x[st], y: Position.y[st], arrive: TRAFFIC_ARRIVE_RADIUS, until: at.tick + 60 * 30 };
}
