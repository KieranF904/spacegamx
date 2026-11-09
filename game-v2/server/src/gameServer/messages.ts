/**
 * @contract server.gameserver.messages
 * owns:       the client message table and the dev message handlers (teleport, spawn), chat and input forwarding
 * needs:      GameServer (type), net/dispatch, net/handlers/*; npm: @space-game/common, bitecs
 * invariants: every client message type has one handler — golden clientMessages.json
 *             dev handlers refuse without devTeleport or admin — none pinned
 * extend:      a new message type is registered in buildMessageHandlers (or in its net/handlers/* file)
 */

import { hasComponent } from 'bitecs';
import { Position, Player, Portal, InSystem, Dead, dhypot } from '@space-game/common';
import { ClientMessage } from '@space-game/common';
import { portsSwitchFeeds } from '@space-game/common';
import { stationTable } from '@space-game/common';
import { FactionsFile } from '../game/Enemies.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import { registerModuleHandlers } from '../net/handlers/modules.js';
import { registerAuthHandlers } from '../net/auth.js';
import { activity } from '../activity/index.js';
import { registerShipEditHandlers } from '../net/handlers/shipEdit.js';
import { registerWeaponGroupsHandlers } from '../net/handlers/weaponGroups.js';
import { registerBankHandlers } from '../net/handlers/bank.js';
import { stationQuery } from '../game/Docking.js';
import { HandlerRegistry, dispatch, registerHandlers, type HandlerTable } from '../net/dispatch.js';
import * as flight from '../net/handlers/flight.js';
import { registerFlightHandlers, portalQuery } from '../net/handlers/flight.js';
import { registerSocialHandlers } from '../net/handlers/social.js';
import { registerGunRangeHandlers } from '../net/handlers/gunRange.js';
import { SimPass } from '../sim/SystemClocks.js';
import { designHash } from '../net/SnapshotBuilder.js';
import type { GameServer } from '../GameServer.js';

/**
 * The client message handlers, by type (net/dispatch.ts runs them after its drops and limits). The bodies are
 * the old handleMessage switch's cases, unchanged but for `break` becoming `return`; later cuts move them out.
 */
export function buildMessageHandlers(gs: GameServer): HandlerTable {
  const t = new HandlerRegistry();
  registerHandlers(t, registerModuleHandlers);
  registerHandlers(t, registerAuthHandlers);
  registerHandlers(t, registerShipEditHandlers);
  registerHandlers(t, registerWeaponGroupsHandlers);
  registerHandlers(t, registerBankHandlers);
  registerHandlers(t, registerFlightHandlers);
  registerHandlers(t, registerSocialHandlers);
  registerHandlers(t, registerGunRangeHandlers);
  t.on('chat', (_ctx, conn, msg) => {
    handleChat(gs, conn, msg);
  });
  t.on('devStation', (_ctx, conn, msg) => {
    // Dev (or an admin): a station at Sol's site with every track at a tier, and in you go
    if (!gs.devTeleport && !conn.isAdmin) return;
    const p = gs.pilots.get(conn), file = stationTable();
    if (!p || !file) return;
    const tier = Math.max(0, Math.min(5, Math.floor(Number((msg as { tier?: number }).tier ?? 3))));
    p.outpost = { site: 'sol_outer', tracks: Object.fromEntries(Object.keys(file.tracks).map((t) => [t, tier])) };
    gs.pilots.sendProfile(conn);
    const sol = gs.gameData.getSystemNum('sol');
    const jp = [...portalQuery(gs.world)].find((g) => InSystem.systemId[g] === sol && gs.gameData.getSystemByNum(Portal.targetSystem[g])?.private);
    if (jp !== undefined) gs.homes.jump(conn, 'sol', Position.x[jp], Position.y[jp]);
  });
  t.on('devTeleport', (_ctx, conn, msg) => {
    handleDevTeleport(gs, conn, msg);
  });
  t.on('devSpawn', (_ctx, conn, msg) => {
    handleDevSpawn(gs, conn, msg);
  });
  t.on('devShip', (_ctx, conn, msg) => {
    if (!gs.devTeleport && !conn.isAdmin) return;
    const name = typeof msg.ship === 'string' ? msg.ship : '';
    const bp = name ? gs.ships.library.get(name) ?? gs.ships.enemyDesigns[name] ?? gs.ships.devDesigns[name] ?? null : null;
    if (name && !bp) { gs.pilots.toast(conn, `No library ship called ${name}`, 'warn'); return; }
    if (gs.pilots.devSwapShip(conn, bp ?? null)) {
      gs.ammo.restock(conn, { report: true, quiet: true });
      gs.pilots.toast(conn, bp ? `Flying the ${bp.name} (dev: not saved)` : 'Back in your own ship', 'info');
    }
  });
  // A ports ship's Selectors flipped (common/src/ships/power/ports.ts): the pilot's own, nothing spent
  t.on('feedSwitch', (_ctx, conn) => {
    const ship = gs.ships.get(conn.playerId), c = gs.ships.chargeOf(conn.playerId);
    if (!ship?.derived.ports || !c.e) return;
    if (!ship.derived.ports.selectors.length) { gs.pilots.toast(conn, 'No Selector fitted: nothing to switch', 'warn'); return; }
    portsSwitchFeeds(ship.derived.ports, c.e);
    gs.pilots.toast(conn, 'Feeds switched: the old material runs out first', 'info');
  });
  t.on('devBoss', (_ctx, conn, msg) => {
    if (!gs.devTeleport && !conn.isAdmin) return;
    const pid = conn.playerId, num = InSystem.systemId[pid];
    let boss = -1, bd = Infinity;
    for (const b of gs.bosses.inSystem(num)) {
      const d = dhypot(Position.x[b] - Position.x[pid], Position.y[b] - Position.y[pid]);
      if (d < bd) { bd = d; boss = b; }
    }
    if (boss < 0) { gs.pilots.toast(conn, 'No boss in this system', 'warn'); return; }
    if (msg.shed !== undefined) { gs.bosses.brainOf(boss)?.forceShed?.(Number(msg.shed) || 0); gs.pilots.toast(conn, `Boss shed ${msg.shed} steps`, 'info'); return; }
    if (msg.reset) { gs.bosses.remove(boss); gs.pilots.toast(conn, 'Boss reset: it comes back fresh in a moment', 'info'); return; }
    // Knock parts off (never the core, nor what holds the rest together) until it's worn that far, credited to you
    const at = Math.max(0.02, Math.min(1, Number(msg.wear) || 0.5));
    const ship = gs.ships.get(boss)!;
    // (A share of each part at a time, round and round: parts are worn, not shot off, so it keeps its shape)
    for (let pass = 0; pass < 12 && gs.ships.integrity(boss) >= at; pass++) {
      for (let i = 0; i < ship.hp.length && gs.ships.integrity(boss) >= at; i++) {
        const fn = ship.blueprint.parts[i].fn;
        if (fn === 'core' || ship.hp[i] <= 1) continue;
        gs.bosses.onDamage(boss, gs.ships.hurt(boss, ship, i, ship.hp[i] * 0.3), pid);
      }
    }
    gs.pilots.toast(conn, `Boss worn to ${Math.round(gs.ships.integrity(boss) * 100)}%`, 'info');
  });
  // The boss tools (game/dev/bossDev.ts): dev servers and admins, never in production
  t.on('bossDevTool', (_ctx, conn, msg) => {
    if (process.env.NODE_ENV === 'production' || (!gs.devTeleport && !conn.isAdmin)) return;
    gs.bossDev.handle(conn, msg);
  });
  t.on('shipNeed', (_ctx, conn, msg) => {
    // The client lost a ship's blueprint (or a ship it kept while away, CAPS.FOCUS): the next snapshot sends it in full
    conn.shipSynced.delete(Number(msg.id));
    conn.sentNames.delete(Number(msg.id));
    gs.lastEntityStates.get(conn.playerId)?.delete(Number(msg.id));
    const bp = gs.ships.get(Number(msg.id))?.blueprint;
    if (bp) conn.designs.delete(designHash(bp));
  });
  return t.freeze();
}

export function handleMessage(gs: GameServer, conn: ClientConnection, msg: ClientMessage): void {
  // (Its system keeps a clock of its own, crowd dilation: handled at that system's tick)
  if (SimPass.own.size && gs.clocks && hasComponent(gs.world, Player, conn.playerId) && gs.clocks.owns(InSystem.systemId[conn.playerId])) {
    const was = gs.currentTick;
    gs.currentTick = gs.clocks.tickOf(InSystem.systemId[conn.playerId]);
    try { dispatch(gs.handlers, gs, conn, msg); } finally { gs.currentTick = was; }
    return;
  }
  dispatch(gs.handlers, gs, conn, msg);
}

/**
 * Map click-to-warp (dev tool). Without coordinates, arrive somewhere sensible:
 * beside the system's first station, else clear of the central body.
 */
export function handleDevTeleport(gs: GameServer, conn: ClientConnection, msg: { systemId: string; x?: number; y?: number }): void {
  if (!gs.devTeleport && !conn.isAdmin) {
    gs.send(conn.ws, { type: 'systemMessage', text: 'Map warp is a dev tool (not enabled on this server)', color: '#f2d24b' });
    return;
  }
  const system = gs.gameData.getSystem(msg.systemId);
  if (!system || !hasComponent(gs.world, Player, conn.playerId) || hasComponent(gs.world, Dead, conn.playerId)) return;
  // (The gun range is gone into from a station only, in its own ship: game/gunRange)
  if (system.gunRange) { gs.pilots.toast(conn, "The gun range is reached from any station's Gun range button", "warn"); return; }
  const systemNum = gs.gameData.getSystemNum(system.id);
  let x = msg.x, y = msg.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    let station = -1;
    for (const st of stationQuery(gs.world)) if (InSystem.systemId[st] === systemNum) { station = st; break; }
    if (station >= 0 && gs.scene === 'sectors') {
      x = Position.x[station] + 900;
      y = Position.y[station];
    } else {
      x = Math.max(8000, (system.centralBody?.radius ?? system.starRadius ?? 1000) + 7000);
      y = 0;
    }
  }
  conn.docked = null;
  gs.travelTo(conn, systemNum, x, y, false);
}

/** Dev tool: a hostile pack here (the system's own kind unless given) */
export function handleDevSpawn(gs: GameServer, conn: ClientConnection, msg: { x: number; y: number; faction?: string; ships?: string[] }): void {
  if ((!gs.devTeleport && !conn.isAdmin) || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return;
  const num = InSystem.systemId[conn.playerId];
  const sys = gs.gameData.getSystemByNum(num);
  const groups = ((gs.gameData.factionsFile as FactionsFile).spawns?.[sys?.id ?? '']?.groups ?? []).filter((g) => !g.passive);
  const g = msg.faction && msg.ships?.length ? { faction: msg.faction, ships: msg.ships.slice(0, 8) }
    : groups.length ? groups[Math.floor(gs.rng() * groups.length)] : { faction: 'pirates', ships: ['pirate_skiff', 'pirate_raider'] };
  gs.enemies.spawnPack(num, { faction: g.faction, ships: g.ships }, msg.x, msg.y);
}

export function handleChat(gs: GameServer, conn: ClientConnection, msg: any): void {
  // Broadcast chat to all clients
  const text = String(msg.text || '').slice(0, 200).trim();
  if (!text) return;
  // Admin commands (/help lists them for admins)
  if (conn.isAdmin && gs.admin.chat(conn, text)) return;
  // Party commands
  const cmd = /^\/(\w+)\s*(.*)$/.exec(text);
  if (cmd) {
    const [, c, arg] = cmd;
    // Private messages and friends (/w name message, /friend name)
    if (gs.social.chatCommand(conn, c.toLowerCase(), arg)) return;
    switch (c.toLowerCase()) {
      case 'p': case 'party': if (arg) gs.party.chat(conn, arg); return;
      case 'invite': gs.party.invite(conn, { name: arg }); return;
      case 'leave': gs.party.leave(conn); return;
      case 'kick': gs.party.kick(conn, arg); return;
      case 'promote': gs.party.promote(conn, arg); return;
      case 'help':
        gs.send(conn.ws, { type: 'systemMessage', text: 'Chat commands: /p message (party chat) · /w name message (private) · /friend name · /invite name · /leave · /kick name · /promote name', color: '#7dd3fc' });
        return;
    }
  }
  activity.chat(conn, text);
  for (const client of gs.clients.values()) {
    gs.send(client.ws, {
      type: 'chat',
      playerId: conn.playerId,
      playerName: conn.username,
      text,
      timestamp: Date.now(),
    });
  }
}

/** Apply or schedule one queued input (net/handlers/flight.ts; drainInputQueue calls it) */
export function handleInput(gs: GameServer, conn: ClientConnection, msg: any): void {
  flight.handleInput(gs, conn, msg);
}

/** Write input state to ECS components for a player entity (net/handlers/flight.ts) */
export function applyInputToEntity(gs: GameServer, conn: ClientConnection, msg: any): void {
  flight.applyInputToEntity(gs, conn, msg);
}

/** End of tick: remember each pilot's ship state hash (net/handlers/flight.ts; run from the tick list) */
export function recordSelfHashes(gs: GameServer): void {
  flight.recordSelfHashes(gs);
}
