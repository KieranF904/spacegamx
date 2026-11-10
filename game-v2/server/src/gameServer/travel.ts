/**
 * @contract server.gameserver.travel
 * owns:       moving a pilot between systems, rifts, and the system clock change
 * needs:      GameServer (type), game/SystemMemory; npm: @space-game/common, bitecs
 * invariants: a clock change moves a pilot's tick notes by the delta and drops inputs said in the old ticks — server/src/gameServer/serverParts.test.ts
 * extend:      a new way between systems is a branch of travelTo
 */

import { hasComponent } from 'bitecs';
import { Position, Velocity, Radius, Player, Portal, InSystem, Dead, dhypot } from '@space-game/common';
import { EffectType } from '@space-game/common';
import type { ClientConnection } from '../net/ClientConnection.js';
import { portalQuery } from '../net/handlers/flight.js';
import { SimPass, rebaseShipTicks } from '../sim/SystemClocks.js';
import { RIFT_COOLDOWN_TICKS } from './shared.js';
import type { GameServer } from '../GameServer.js';

/**
 * Whose account a guest's name is (whatever its case): an admin's or a registered pilot's, or nobody's (null).
 * signedInOwner knows those signed in here; accountOwner asks the lobby (when this server may: its admin secret,
 * `userDB.admin`), and a lobby that can't be reached doesn't keep guests out.
 */
/**
 * A wrong password or a refused registration: say why, then hang up, so the
 * connection doesn't stay in the world as a nameless pilot.
 */
/**
 * Move a player to (x, y) in another (or the same) system: jump gates and rifts.
 * Rifts keep the ship's momentum; gates bring it to a stop.
 */
export function travelTo(gs: GameServer, conn: ClientConnection, systemNum: number, x: number, y: number, keepMomentum: boolean): void {
  const eid = conn.playerId;
  const target = gs.gameData.getSystemByNum(systemNum);
  if (!target) return;
  const fromSystem = InSystem.systemId[eid];
  // (A system that was put away is back before the pilot's there: SystemMemory)
  gs.memory.enter(systemNum);
  if (fromSystem !== systemNum && !target.private && !target.surface && !target.pocket) gs.pilots.track(conn, `visit_${target.id}`, { from: gs.gameData.getSystemByNum(fromSystem)?.id }, true);
  gs.broadcastToSystem(fromSystem, { type: 'effect', effectType: EffectType.WarpOut, x: Position.x[eid], y: Position.y[eid] });
  InSystem.systemId[eid] = systemNum;
  // (From or into a system with a clock of its own, crowd dilation: what it keeps as ticks moves with it)
  if (gs.clocks && fromSystem !== systemNum) changeClock(gs, conn, gs.clocks.tickOf(systemNum) - gs.clocks.tickOf(fromSystem));
  Position.x[eid] = x;
  Position.y[eid] = y;
  if (!keepMomentum) {
    Velocity.x[eid] = 0;
    Velocity.y[eid] = 0;
  }
  if (fromSystem !== systemNum) {
    conn.knownEntities.clear();
    gs.lastEntityStates.delete(eid); // the client drops the old system, so resend everything
    conn.lastSystemId = -1; // re-send the new system's static entities and asteroid seed
    gs.send(conn.ws, { type: 'systemMessage', text: `Arrived in ${target.name}`, color: '#44ff44' });
  }
  conn.forceSnapshot = true;
  gs.broadcastToSystem(systemNum, { type: 'effect', effectType: EffectType.WarpIn, x, y });
  gs.sendPlayerState(conn);
}

/**
 * A pilot gone to a system whose tick differs by `delta` (crowd dilation: sim/SystemClocks.ts): its ship's ticks and
 * the server's notes of its client keyed by tick move with it; inputs and checks said in the old system's ticks go
 */
export function changeClock(gs: GameServer, conn: ClientConnection, delta: number): void {
  if (!delta) return;
  const eid = conn.playerId, ship = gs.ships.get(eid);
  if (ship) rebaseShipTicks(ship, delta);
  conn.scheduledInputs = [];
  conn.aheadHashes.clear();
  conn.selfHashes.clear();
  conn.liveTick += delta;
  conn.lastSnapshotSentTick += delta;
  const rift = gs.riftCooldown.get(eid);
  if (rift !== undefined) gs.riftCooldown.set(eid, rift + delta);
  gs.hits.restart(conn);
}

/** Rifts fast-travel any player ship that flies into them. */
export function riftSystem(gs: GameServer): void {
  for (const conn of gs.clients.values()) {
    const eid = conn.playerId;
    if (!hasComponent(gs.world, Player, eid) || hasComponent(gs.world, Dead, eid) || !SimPass.on(InSystem.systemId[eid])) continue;
    const cooling = (gs.riftCooldown.get(eid) ?? 0) > gs.currentTick;
    for (const rift of portalQuery(gs.world)) {
      if (Portal.kind[rift] !== 1 || InSystem.systemId[rift] !== InSystem.systemId[eid]) continue;
      if (dhypot(Position.x[rift] - Position.x[eid], Position.y[rift] - Position.y[eid]) > Radius.value[rift]) continue;
      // Just come through (or thrown back out): not again until you've been clear of it a moment, however long you sit in it
      if (cooling) { gs.riftCooldown.set(eid, Math.max(gs.riftCooldown.get(eid)!, gs.currentTick + 30)); break; }
      gs.riftCooldown.set(eid, gs.currentTick + RIFT_COOLDOWN_TICKS);
      const barred = gs.quests.canEnter(conn, gs.gameData.getSystemByNum(Portal.targetSystem[rift])?.id ?? '');
      if (barred) {
        // The rift throws unlicensed ships back out
        const dx = Position.x[eid] - Position.x[rift], dy = Position.y[eid] - Position.y[rift];
        const d = dhypot(dx, dy) || 1;
        const push = Math.max(12, dhypot(Velocity.x[eid], Velocity.y[eid]));
        Velocity.x[eid] = (dx / d) * push;
        Velocity.y[eid] = (dy / d) * push;
        gs.pilots.toast(conn, barred, 'warn');
        break;
      }
      gs.travelTo(conn, Portal.targetSystem[rift], Portal.targetX[rift], Portal.targetY[rift], true);
      break;
    }
  }
}
