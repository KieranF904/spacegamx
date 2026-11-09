/**
 * @contract server.gameserver.combat-lock
 * owns:       the combat lock (dealing or taking damage lately), a pilot's ship lingering after they quit in it, taking
 *             that same ship back on rejoining, and telling the pilot's HUD how long the lock has left
 * needs:      GameServer (type), @space-game/common, CombatClock (gs.combat), ShipBridge lastDamagedTick, Pilots.adopt; npm: bitecs
 * invariants: a pilot who quits inside the lock leaves a live ship that rejoining takes back whole (same entity) —
 *             server/src/gameServer/combatLock.test.ts
 *             the linger runs from the last combat event, and shutdown saves lingering ships as they are (Pilots.saveAll
 *             walks every session, a lingering one included) — server/src/gameServer/combatLock.test.ts
 * extend:     the numbers are COMBAT_RULES (common/network/combatProtocol.ts); a new kind of combat event feeds gs.combat (hosts/ship.ts notifyDamage)
 */

import { hasComponent, entityExists, addComponent } from 'bitecs';
import { Player, Dead, TICK_RATE, PROTOCOL_VERSION, COMBAT_RULES } from '@space-game/common';
import type { ClientConnection } from '../net/ClientConnection.js';
import type { GameServer } from '../GameServer.js';

// (The numbers live in common/network/combatProtocol.ts, which the field guide quotes too)
export { COMBAT_RULES };

const ticks = (seconds: number): number => Math.round(seconds * TICK_RATE);

/** Last tick this ship dealt or took damage (-Infinity: never) */
export function lastCombatTick(gs: GameServer, eid: number): number {
  return Math.max(gs.ships.lastDamagedTick(eid), gs.combat.lastOf(eid));
}

/** Ticks of lock the ship has left (0: free to leave) */
export function combatLeft(gs: GameServer, eid: number): number {
  return Math.max(0, ticks(COMBAT_RULES.lockSeconds) - (gs.currentTick - lastCombatTick(gs, eid)));
}

const isLive = (gs: GameServer, eid: number): boolean =>
  entityExists(gs.world, eid) && hasComponent(gs.world, Player, eid) && !hasComponent(gs.world, Dead, eid);

/**
 * A pilot's connection closed: does their ship stay? Only a signed-in pilot (a guest has nothing to save) whose ship is
 * alive and in combat. It lingers from the last combat event: lock plus linger seconds after it. Returns true if it stays.
 */
export function startLinger(gs: GameServer, conn: ClientConnection): boolean {
  const eid = conn.playerId;
  if (conn.userId === null || !isLive(gs, eid) || combatLeft(gs, eid) <= 0) return false;
  gs.releaseControls(eid);
  gs.lingering.set(eid, { conn, until: lastCombatTick(gs, eid) + ticks(COMBAT_RULES.lockSeconds + COMBAT_RULES.lingerSeconds) });
  return true;
}

/**
 * `conn` has just signed in as `userId`: if that account's ship is still lingering, they fly that very ship (same
 * entity: position, velocity, part HP, cargo, ammo, energy and guns all as it was), no respawn. The fresh ship the
 * connection was given on joining is dropped. Returns false when there is none to take back (or its time is up: the
 * normal login then finishes it and loads the profile).
 */
export function reinhabit(gs: GameServer, conn: ClientConnection, userId: number): boolean {
  for (const [eid, l] of gs.lingering) {
    if (l.conn.userId !== userId || l.conn === conn) continue;
    if (!isLive(gs, eid) || gs.currentTick >= l.until) return false;
    if (!gs.pilots.get(l.conn)) return false;
    const guest = conn.playerId;
    gs.lingering.delete(eid);
    conn.playerId = eid;
    conn.docked = l.conn.docked;
    l.conn.userId = null;
    Player.clientId[eid] = Player.clientId[guest];
    // (The fresh ship the join made goes the way a guest's does when the account signs in)
    if (guest !== eid && hasComponent(gs.world, Player, guest)) addComponent(gs.world, Dead, guest);
    conn.scheduledInputs.length = 0;
    conn.knownEntities.clear();
    conn.lastSystemId = -1;
    conn.forceSnapshot = true;
    gs.lastEntityStates.delete(eid);
    toldAt.delete(conn);
    gs.pilots.adopt(l.conn, conn);
    // The client knows its ship by number: tell it this one, then its state, as a respawn does
    gs.send(conn.ws, { type: 'welcome', playerId: eid, protocol: PROTOCOL_VERSION, tickRate: TICK_RATE, serverTime: Date.now() });
    gs.sendPlayerState(conn);
    return true;
  }
  return false;
}

const toldAt = new WeakMap<ClientConnection, { until: number; at: number }>();

/** Tell each signed-in pilot's HUD when their lock starts, ends and (once a second) is renewed */
export function tellCombatLocks(gs: GameServer): void {
  const every = ticks(COMBAT_RULES.tellEverySeconds);
  for (const conn of gs.clients.values()) {
    if (conn.userId === null) continue;
    const eid = conn.playerId;
    const left = isLive(gs, eid) ? combatLeft(gs, eid) : 0;
    const told = toldAt.get(conn);
    if (left > 0) {
      const until = gs.currentTick + left;
      if (told && told.until > gs.currentTick && (told.until === until || gs.currentTick - told.at < every)) continue;
      toldAt.set(conn, { until, at: gs.currentTick });
      gs.send(conn.ws, { type: 'combatLock', left: Math.round(left * 1000 / TICK_RATE) });
    } else if (told && told.until > 0) {
      toldAt.set(conn, { until: 0, at: gs.currentTick });
      gs.send(conn.ws, { type: 'combatLock', left: 0 });
    }
  }
}
