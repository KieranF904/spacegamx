/**
 * @contract server.gameserver.hooks
 * owns:       the small hooks GameServer's constructor installs: feature messages joining the table, pilots' login events, the station a connection is at, the error log tail
 * needs:      GameServer (type); npm: @space-game/common, bitecs
 * invariants: called in constructor order, each where it was inline — server/src/golden/frameHash.test.ts
 * extend:     a new login-time hook is a pilots.onEvent in installLoginHooks
 */

import { hasComponent, entityExists } from 'bitecs';
import { Player, Station, Dead } from '@space-game/common';
import type { GameServer } from '../GameServer.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import type { Handler } from '../net/dispatch.js';

const MAX_ERRORS = 50;

/** A feature's messages join the table (the handlers field is built before the constructor body; the table is a Map) */
export function joinFeatureMessages(gs: GameServer): void {
  for (const [type, fn] of gs.features.messages) {
    (gs.handlers as Map<string, Handler>).set(type, (_ctx, conn, msg) => {
      if (!hasComponent(gs.world, Player, conn.playerId)) return;
      fn(conn.playerId, msg);
    });
  }
}

/** The station a connection is docked at or in range of, if it is alive and a pilot */
export function stationAtConn(gs: GameServer) {
  return (conn: unknown) => {
    const c = conn as ClientConnection;
    const st = c.docked && entityExists(gs.world, c.docked.station) ? c.docked.station : gs.stationInRange(c.playerId);
    return st >= 0 && hasComponent(gs.world, Player, c.playerId) && !hasComponent(gs.world, Dead, c.playerId)
      ? gs.gameData.getStationByNum(Station.stationId[st]) ?? null : null;
  };
}

/** The hangar and first ammo issue at login */
export function installHangarLogin(gs: GameServer): void {
  gs.pilots.onEvent((conn, ev) => {
    if (ev.type !== 'login') return;
    gs.hangar.send(conn);
    gs.ammo.firstIssue(conn, gs.ships.get(conn.playerId));
  });
}

/** Friends hear of a login; new arrivals hear about this week's hunt */
export function installSocialLogin(gs: GameServer): void {
  gs.pilots.onEvent((conn, ev) => { if (ev.type === 'login') gs.social.join(conn); });
  gs.pilots.onEvent((conn, ev) => {
    if (ev.type !== 'login') return;
    const h = gs.hunted();
    if (h) gs.send((conn as ClientConnection).ws, { type: 'news', text: `This week's hunt: ${h.name} in ${gs.gameData.getSystem(h.system)?.name ?? h.system}. Double XP and credits for everyone in on the kill`, kind: 'hunt', at: gs.clock(), old: true });
  });
}

/** Keep the last errors for the admin stats */
export function trackErrors(gs: GameServer): void {
  const origConsoleError = console.error;
  console.error = (...args: any[]) => {
    origConsoleError.apply(console, args);
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    gs.recentErrors.push(`[${new Date().toISOString()}] ${msg}`);
    if (gs.recentErrors.length > MAX_ERRORS) gs.recentErrors.shift();
  };
}
