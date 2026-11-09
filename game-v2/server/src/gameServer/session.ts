/**
 * @contract server.gameserver.session
 * owns:       connecting, creating and placing a player, logging a pilot in, lingering, saving and forgetting accounts
 * needs:      GameServer (type), game/Pilots, net/ClientConnection, common/network; npm: bitecs
 * invariants: a new connection gets its player entity before any message is handled — none pinned
 *             saveAll saves every live pilot once — none pinned
 * extend:      a new join/leave step is a function here called from connect or loginPilot
 */

import { addEntity, addComponent, hasComponent } from 'bitecs';
import { Position, Velocity, Rotation, Radius, Health, Player, Input, Boost, Inventory, Station, NetworkSync, InSystem, Dead, TICK_RATE, BOOST_DRAIN, BOOST_REGEN, BOOST_REGEN_DELAY, BOOST_FUEL_DEFAULT, PLAYER_MAX_HP, PLAYER_RADIUS, stationInteractRadius, dcos, dsin } from '@space-game/common';
import { ClientMessage, PROTOCOL_VERSION } from '@space-game/common';
import type { ClientSocket, ClientLink } from '@space-game/common';
import type { ClientConnection } from '../net/ClientConnection.js';
import { activity } from '../activity/index.js';
import { stationQuery } from '../game/Docking.js';
import { startLinger, reinhabit, tellCombatLocks } from './combatLock.js';
import type { GameServer } from '../GameServer.js';

/**
 * Register a new client. The transport owns the socket; it decodes incoming
 * data and feeds messages through the returned link.
 */
export function connect(gs: GameServer, ws: ClientSocket, address?: string): ClientLink {
  console.log('Client connected');
  gs.totalConnectionsEver++;

  // Create player entity
  const playerId = gs.createPlayer();
  const clientId = gs.clientIdCounter++;

  const conn: ClientConnection = {
    ws,
    address,
    playerId,
    lastInputSeq: 0,
    lastPingTime: Date.now(),
    ping: 0,
    knownEntities: new Set(),
    lastSystemId: -1,
    lastSystemInfoId: null,
    username: `Player${clientId}`,
    userId: null,
    isAdmin: gs.everyoneAdmin,
    isContributor: false,
    authToken: null,
    scheduledInputs: [],
    joined: false,
    inputsThisTick: 0,
    liveTick: 0,
    hashSeen: false,
    forceSnapshot: true,
    lastSnapshotSentTick: 0,
    blueprint: null,
    docked: null,
    shipSynced: new Map(),
    shipHpSent: new Map(),
    sentNames: new Map(),
    repKnown: new Map(),
    debrisHeld: new Map(),
    debrisRowOk: new Set(),
    shipView: new Set(),
    mapNamed: new Set(),
    aheadHashes: new Map(),
    designs: new Set(),
    playerStateKey: '',
    selfLate: false,
    selfVersion: 0,
    selfHashes: new Map(),
  };
  
  gs.clients.set(ws, conn);
  Player.clientId[playerId] = clientId;
  gs.pilots.attach(conn);

  // Send welcome message
  gs.send(ws, {
    type: 'welcome',
    playerId,
    protocol: PROTOCOL_VERSION,
    tickRate: TICK_RATE,
    serverTime: Date.now(),
    threats: gs.threats(),
    regionThreats: gs.regionThreats(),
  });

  // Send initial state
  gs.sendPlayerState(conn);

  return {
    receive: (msg: ClientMessage) => {
      gs.net.batching++;
      try {
        gs.handleMessage(conn, msg);
      } catch (e) {
        // (Logged a line every 10 s at most per type: a hostile client could send thousands)
        gs.fault(`message:${typeof msg?.type === 'string' ? msg.type.slice(0, 32) : '?'}`, e);
      } finally {
        gs.net.batching--;
        // Answers to requests go now, together (inputs only queue, so usually nothing)
        if (!gs.net.batching) gs.flushOutbox();
      }
    },
    close: () => {
      console.log('Client disconnected');
      gs.guard('close', () => activity.leave(conn));
      // Off a siege moon first (paid what they're owed, back in orbit), so that's where they're saved
      // (Each step on its own: one that throws mustn't stop the rest, or the save, from happening)
      gs.guard('close', () => gs.sieges.leave(conn));
      gs.guard('close', () => gs.people.leave(conn));
      gs.guard('close', () => gs.arenas.leave(conn));
      // Out of the gun range: their own ship and profile back, in the berth they left (game/gunRange)
      gs.guard('close', () => gs.gunRange.leave(conn));
      gs.clients.delete(ws);
      gs.net.outbox.delete(ws);
      gs.net.lazy.delete(ws);
      gs.guard('close', () => gs.party.remove(conn));
      gs.guard('close', () => gs.social.leave(conn));
      gs.guard('close', () => gs.tutorial?.forget(conn));
      gs.guard('close', () => gs.trade.remove(conn));
      gs.guard('close', () => gs.admin.forget(conn));
      gs.guard('close', () => gs.contrib.forget(conn));
      gs.guard('close', () => gs.ammo.forget(conn));
      const eid = conn.playerId;
      // Leaving mid-fight doesn't save you: the ship stays put (hands off the controls) for a while (combatLock.ts)
      // (saved where they sit now: a server suspended or lost before the linger ends still has it)
      if (startLinger(gs, conn)) { gs.pilots.saveNow(conn); return; }
      gs.pilots.detach(conn).catch((e) => gs.fault('detach', e));
      if (hasComponent(gs.world, Player, eid)) addComponent(gs.world, Dead, eid);
    },
  };
}

export function createPlayer(gs: GameServer): number {
  const eid = addEntity(gs.world);
  
  addComponent(gs.world, Position, eid);
  addComponent(gs.world, Velocity, eid);
  addComponent(gs.world, Rotation, eid);
  addComponent(gs.world, Radius, eid);
  addComponent(gs.world, Health, eid);
  addComponent(gs.world, Player, eid);
  addComponent(gs.world, Input, eid);
  addComponent(gs.world, Boost, eid);
  addComponent(gs.world, Inventory, eid);
  addComponent(gs.world, InSystem, eid);
  addComponent(gs.world, NetworkSync, eid);
  
  // Spawn beside the starter station (a pilot with a profile is placed where they left off when it loads)
  const at = starterSpot(gs);
  Position.x[eid] = at.x;
  Position.y[eid] = at.y;
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  Rotation.angle[eid] = 0;
  Radius.value[eid] = PLAYER_RADIUS;
  
  // Health mirrors the ship's core HP (the ship bridge keeps it in sync)
  Health.current[eid] = PLAYER_MAX_HP;
  Health.max[eid] = PLAYER_MAX_HP;
  Health.regenRate[eid] = 0;
  Health.lastDamageTick[eid] = 0;

  Player.level[eid] = 1;
  Player.xp[eid] = 0;
  Player.credits[eid] = 500;
  Player.systemId[eid] = 0; // Sol
  
  Boost.fuel[eid] = BOOST_FUEL_DEFAULT;
  Boost.maxFuel[eid] = BOOST_FUEL_DEFAULT;
  Boost.drainRate[eid] = BOOST_DRAIN;
  Boost.regenRate[eid] = BOOST_REGEN;
  Boost.regenDelay[eid] = BOOST_REGEN_DELAY;
  Boost.lastUseTick[eid] = 0;
  
  InSystem.systemId[eid] = 0;
  // (The dev server's start system instead, the Rockery: guests are never placed again)
  if (gs.devStartNum >= 0) {
    const dev = devStartSpot(gs, eid);
    Player.systemId[eid] = InSystem.systemId[eid] = dev.system;
    Position.x[eid] = dev.x;
    Position.y[eid] = dev.y;
  }

  gs.ships.onPlayerCreated(eid);

  return eid;
}

/** Put a player somewhere without travel effects (logging in, respawning) */
export function placePlayer(gs: GameServer, conn: ClientConnection, systemNum: number, x: number, y: number): void {
  const eid = conn.playerId;
  if (!gs.gameData.getSystemByNum(systemNum)) return;
  const from = InSystem.systemId[eid];
  InSystem.systemId[eid] = systemNum;
  Position.x[eid] = x;
  Position.y[eid] = y;
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  if (from !== systemNum) {
    conn.knownEntities.clear();
    gs.lastEntityStates.delete(eid);
    conn.lastSystemId = -1;
  }
  conn.forceSnapshot = true;
  gs.sendPlayerState(conn);
}

/**
 * Logged in: one account flies in one place at a time. Any other session
 * on it (another tab, another computer) is saved and signed out, and any
 * ship left lingering by an earlier connection finished; then the profile
 * loads (after those saves, so it's the latest).
 */
export async function loginPilot(gs: GameServer, conn: ClientConnection, userId: number): Promise<void> {
  for (const other of [...gs.clients.values()]) {
    if (other === conn || other.userId !== userId) continue;
    const eid = other.playerId;
    // Saved where they are; then it's a stranger's connection (so closing it doesn't save over the new one)
    await gs.pilots.detach(other);
    other.userId = null;
    if (hasComponent(gs.world, Player, eid) && !hasComponent(gs.world, Dead, eid)) addComponent(gs.world, Dead, eid);
    gs.rejectAuth(other, 'You signed in somewhere else, so this session has ended.');
  }
  // (Back inside the time their ship lingers: it is theirs again as it was, combatLock.ts)
  if (reinhabit(gs, conn, userId)) return;
  for (const [eid, l] of [...gs.lingering]) {
    if (l.conn.userId !== userId) continue;
    gs.lingering.delete(eid);
    await gs.pilots.detach(l.conn);
    if (hasComponent(gs.world, Player, eid)) addComponent(gs.world, Dead, eid);
  }
  if (!(await claimProfile(gs, conn, userId))) return;
  await gs.pilots.login(conn, userId);
}

/** One game server per account: refused (and signed out) while another region still holds this pilot */
async function claimProfile(gs: GameServer, conn: ClientConnection, userId: number): Promise<boolean> {
  const lease = await gs.pilots.claimLease(userId);
  if (lease.ok) {
    if (!gs.clients.has(conn.ws)) { await gs.pilots.releaseLease(userId); return false; } // (left while claiming)
    return true;
  }
  conn.userId = null; // (a stranger's connection: closing it must not save over the other server's profile)
  gs.rejectAuth(conn, "You're still in another region; try again in a moment.");
  return false;
}

/** Ships left in space by players who quit mid-fight: saved and removed once the time is up */
export function lingerSystem(gs: GameServer): void {
  tellCombatLocks(gs);
  for (const [eid, l] of [...gs.lingering]) {
    const dead = !hasComponent(gs.world, Player, eid) || hasComponent(gs.world, Dead, eid);
    if (!dead && gs.currentTick < l.until) continue;
    gs.lingering.delete(eid);
    gs.pilots.detach(l.conn).catch((e) => gs.fault('detach', e));
    if (!dead) addComponent(gs.world, Dead, eid);
  }
}

/** Accounts the lobby has deleted: disconnect anyone on them and delete their profiles and ranks */
export async function forgetAccounts(gs: GameServer, ids: number[]): Promise<void> {
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0 || gs.forgotten.has(id)) continue;
    try {
      for (const conn of await gs.pilots.forgetAccount(id)) gs.rejectAuth(conn as ClientConnection, 'This account has been deleted.');
      gs.achievements.forget(id);
      gs.social.forget(id);
      gs.forgotten.add(id);
    } catch (e) {
      console.error(`[Accounts] could not delete the profile of account ${id}:`, e);
    }
  }
  await gs.achievements.save();
}

/** Save everyone (server shutdown) */
export async function saveAll(gs: GameServer): Promise<void> {
  // (Each on its own: one store failing mustn't keep the others from being saved)
  const results = await Promise.allSettled([
    () => gs.pilots.saveAll(),
    () => gs.contrib.flush(),
    () => gs.achievements.save(true),
    () => gs.social.save(),
    () => gs.memory.save(),
  ].map(async (save) => save()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.error('[Save] a store failed to save:', f.reason);
  if (failed.length) throw new Error(`${failed.length} store(s) failed to save`);
}

/** Just outside the starter station's docking ring (Sol Central), wherever it is on its orbit */
export function starterSpot(gs: GameServer): { x: number; y: number } {
  const id = gs.gameData.getStation('sol_station_central') ? 'sol_station_central' : undefined;
  const st = id ? [...stationQuery(gs.world)].find((e) => gs.gameData.getStationByNum(Station.stationId[e])?.id === id) : undefined;
  const a = gs.rng() * Math.PI * 2;
  if (st !== undefined) {
    // (Inside its docking ring, where the tutorial's first stop is, clear of its hull)
    const d = gs.gameData.getStation(id!);
    const r = Math.max((d?.radius ?? 0) + 120, stationInteractRadius(d?.radius ?? 0, d?.design) * 0.85);
    return { x: Position.x[st] + dcos(a) * r, y: Position.y[st] + dsin(a) * r };
  }
  // (No station yet: well clear of the star)
  const sys = gs.gameData.getSystem('sol');
  const r = (sys?.centralBody?.radius ?? sys?.starRadius ?? 0) + 12000;
  return { x: dcos(a) * r, y: dsin(a) * r };
}

/**
 * Where a pilot appears in the dev start system: on a ring well clear of the star, just inside the asteroid belt's
 * inner edge (rocks close by, none underneath), each pilot at their own angle
 */
export function devStartSpot(gs: GameServer, eid: number): { system: number; x: number; y: number } {
  const sys = gs.gameData.getSystemByNum(gs.devStartNum);
  const star = sys?.centralBody?.radius ?? sys?.starRadius ?? 0;
  const belt = sys?.asteroidBelt?.innerRadius ?? 0;
  const r = Math.max(star + 1500, belt - 600);
  const a = (eid * 2.399) % (Math.PI * 2);
  return { system: gs.devStartNum, x: dcos(a) * r, y: dsin(a) * r };
}
