/**
 * @contract server.gameserver.admin
 * owns:       the admin host, admin stats and perf metrics
 * needs:      GameServer (type), game/AdminTools; npm: @space-game/common, bitecs
 * invariants: tick times kept for the admin stats are the last 120, sent to open admin sockets once a second — server/src/gameServer/serverParts.test.ts
 * extend:      a new admin command is an AdminHost member here
 */

import { hasComponent, entityExists } from 'bitecs';
import { Position, Velocity, Player, Station, InSystem, Dead, dhypot, coreIndex } from '@space-game/common';
import { FactionsFile } from '../game/Enemies.js';
import { BossesFile } from '../game/Bosses.js';
import { type AdminConn, type AdminHost } from '../game/AdminTools.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import { stationQuery } from '../game/Docking.js';
import { playerQuery, projectileQuery } from '../net/SnapshotBuilder.js';
import { asteroidQuery } from './shared.js';
import { perfMetrics } from './perf.js';
import type { GameServer } from '../GameServer.js';

/** What the admin tools reach into (AdminTools.ts) */
export function createAdminHost(gs: GameServer): AdminHost {
  const C = (c: AdminConn) => c as ClientConnection;
  const sysNum = (id: string) => (gs.gameData.getSystem(id) ? gs.gameData.getSystemNum(id) : -1);
  const factions = () => gs.gameData.factionsFile as FactionsFile;
  const alive = (eid: number) => entityExists(gs.world, eid) && hasComponent(gs.world, Player, eid) && !hasComponent(gs.world, Dead, eid);
  const hostilesIn = (num: number) => [...gs.ships.bodies.keys()].filter((eid) => gs.enemies.factionOf(eid) && InSystem.systemId[eid] === num);
  return {
    conns: () => [...gs.clients.values()].filter((c) => c.username),
    where: (c) => {
      const eid = c.playerId;
      if (!entityExists(gs.world, eid) || !hasComponent(gs.world, Player, eid)) return null;
      return { system: gs.gameData.getSystemByNum(InSystem.systemId[eid])?.id ?? '?', x: Position.x[eid], y: Position.y[eid], dead: !alive(eid) };
    },
    systems: () => gs.gameData.getAllSystems().map((s) => ({ id: s.id, name: s.name })),
    stations: () => [...stationQuery(gs.world)].map((st) => {
      const d = gs.gameData.getStationByNum(Station.stationId[st]);
      return { id: d?.id ?? String(st), name: d?.name ?? 'Station', system: gs.gameData.getSystemByNum(InSystem.systemId[st])?.id ?? '?', x: Math.round(Position.x[st]), y: Math.round(Position.y[st]) };
    }),
    factions: () => Object.fromEntries(Object.entries(factions().factions).map(([id, f]) => [id, Object.keys(f.ships)])),
    bosses: () => Object.keys((gs.gameData.bossesFile as BossesFile).bosses ?? {}),
    items: () => gs.econ.items.all().map((d) => ({ id: d.id, name: d.name })),
    itemName: (id) => (gs.econ.items.has(id) ? gs.econ.items.name(id) : null),
    travel: (c, system, x, y) => {
      const num = sysNum(system);
      if (num < 0 || !alive(c.playerId) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      C(c).docked = null;
      gs.travelTo(C(c), num, x, y, false);
      return true;
    },
    heal: (c) => { if (alive(c.playerId)) gs.ships.repair(c.playerId); },
    destroy: (c) => {
      const ship = gs.ships.get(c.playerId);
      const core = coreIndex(ship?.blueprint.parts);
      if (ship && core >= 0) gs.ships.damagePartFraction(c.playerId, core, 1);
    },
    addCredits: (c, n) => gs.pilots.addCredits(C(c), n),
    addXp: (c, n) => gs.pilots.addXp(C(c), n),
    give: (c, items) => {
      // (what won't fit in the hold goes to station storage, not lost)
      const left = gs.pilots.give(C(c), items, { source: 'admin' });
      if (Object.keys(left).length) gs.pilots.give(C(c), left, { source: 'admin', toStorage: true });
      return Object.values(left).reduce((a, k) => a + k, 0);
    },
    skillPoints: (c, n) => gs.pilots.grant(C(c), { skillPoints: n }),
    codex: (c, what) => gs.codex.admin(C(c), what),
    kick: (c, reason) => gs.rejectAuth(C(c), reason),
    spawnPack: (system, x, y, faction, ships, count) => {
      const num = sysNum(system);
      if (num < 0) return 0;
      const f = factions();
      let group: { faction: string; ships: string[] };
      if (faction && f.factions[faction]) group = { faction, ships: ships?.length ? ships : Object.keys(f.factions[faction].ships) };
      else if (ships?.length) group = { faction: Object.keys(f.factions).find((k) => ships.some((t) => t in f.factions[k].ships)) ?? 'pirates', ships };
      else {
        const groups = (f.spawns?.[system]?.groups ?? []).filter((g) => !g.passive);
        group = groups.length ? groups[Math.floor(gs.rng() * groups.length)] : { faction: 'pirates', ships: ['pirate_skiff', 'pirate_raider'] };
      }
      const valid = group.ships.filter((t) => gs.ships.enemyDesigns[t]);
      if (!valid.length) return 0;
      const list = count ? Array.from({ length: Math.min(20, count) }, (_, i) => valid[i % valid.length]) : valid;
      return gs.enemies.spawnPack(num, { faction: group.faction, ships: list }, x, y).length;
    },
    spawnBoss: (id) => gs.bosses.spawn(id) >= 0,
    clearHostiles: (system, explode, at) => {
      let n = 0;
      for (const eid of hostilesIn(sysNum(system))) {
        if (at && dhypot(Position.x[eid] - at.x, Position.y[eid] - at.y) > at.radius) continue;
        const ship = gs.ships.get(eid);
        const core = coreIndex(ship?.blueprint.parts);
        if (explode && ship && core >= 0) gs.ships.damagePartFraction(eid, core, 1);
        else gs.ships.removeShip(eid);
        n++;
      }
      return n;
    },
    clearPods: (system) => gs.pods.clear(sysNum(system)),
    startEvent: (system, kind) => {
      const num = sysNum(system);
      if (kind === 'siege') return num >= 0 && gs.surfaces.startSiege(num);
      return num >= 0 && !!(kind === 'raid' ? gs.events.startRaid(num) : kind === 'peak' ? gs.events.startPeak(num) : gs.events.startSalvage(num));
    },
    announce: (text) => { for (const c of gs.clients.values()) gs.send(c.ws, { type: 'systemMessage', text: `📢 ${text}`, color: '#fbbf24' }); },
    reply: (c, msg) => gs.send(C(c).ws, msg as any),
    setContributor: (name, online, on, by) => gs.contrib.setRank(name, online ? C(online) : null, on, by.username),
    contributors: () => gs.contrib.contributors().map((r) => r.username),
    accounts: gs.userDB.admin ?? null,
    freeBuildAllowed: () => gs.freeBuildAllowed,
    hitStats: () => gs.hits.stats,
    crowd: (c, to) => gs.crowd?.admin(InSystem.systemId[C(c).playerId], to) ?? { ok: false, text: "This server doesn't take crowd fallbacks" },
    freeBuildChanged: (c) => gs.hangar.send(C(c)),
    devBank: (c, action, items) => (gs.pilots.devBank(C(c), action, items) ? { ok: true, text: `Repair bank: ${action}` } : { ok: false, text: 'Nothing to do' }),
    setAdminLive: (c, on) => {
      C(c).isAdmin = on;
      // Their client opens (or puts away) the admin and contributor tools as it does on signing in
      gs.send(C(c).ws, { type: 'authResult', success: true, username: c.username, isAdmin: on, isContributor: gs.contrib.allowed(C(c)) });
    },
  };
}

/**
 * Report stats to the admin clients (call from game loop)
 */
export function reportAdminStats(gs: GameServer, tickTime: number): void {
  // Track tick time history
  gs.tickTimeHistory.push(tickTime);
  if (gs.tickTimeHistory.length > 120) gs.tickTimeHistory.shift();
  
  // Count entities
  let entityCount = 0;
  entityCount += playerQuery(gs.world).length;
  entityCount += projectileQuery(gs.world).length;
  entityCount += asteroidQuery(gs.world).length;
  
  // Send detailed admin stats to admin clients every ~60 ticks (~1 second)
  if (gs.currentTick % 60 === 0) {
    const avgTickTime = gs.tickTimeHistory.length > 0
      ? gs.tickTimeHistory.reduce((a, b) => a + b, 0) / gs.tickTimeHistory.length
      : 0;
    const maxTickTime = gs.tickTimeHistory.length > 0
      ? Math.max(...gs.tickTimeHistory)
      : 0;
    // (The proto build runs this server in the browser: no process there)
    const proc = typeof process !== 'undefined' ? process : null;
    const mem = proc?.memoryUsage() ?? { heapUsed: 0 };
    
    const admins = [...gs.clients.values()].filter((c) => c.isAdmin && c.ws.isOpen());
    const adminStatsMsg = admins.length > 0 && {
      type: 'adminStats' as const,
      tick: gs.currentTick,
      playerCount: gs.clients.size,
      entityCount,
      tickTimeMs: tickTime,
      avgTickTimeMs: Math.round(avgTickTime * 100) / 100,
      maxTickTimeMs: Math.round(maxTickTime * 100) / 100,
      memoryMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      uptime: proc?.uptime() ?? 0,
      snapshotBytes: gs.net.snapshotBytesSent,
      bytesByType: { ...gs.net.bytesByType },
      connectionsTotal: gs.totalConnectionsEver,
      errors: gs.recentErrors.slice(-10),
      playerList: gs.admin.players(),
    };
    
    // Send to all admin clients
    if (adminStatsMsg) for (const c of admins) gs.send(c.ws, adminStatsMsg as any);
    
    // Reset byte counters
    gs.net.snapshotBytesSent = 0;
    gs.net.bytesByType = {};
  }
}

export function updatePerfMetrics(gs: GameServer, tickTime: number): void {
  perfMetrics.lastTickMs = tickTime;
  perfMetrics.ticksProcessed++;
  
  // Update running average
  const alpha = 0.1; // Smoothing factor
  perfMetrics.avgTickMs = perfMetrics.avgTickMs * (1 - alpha) + tickTime * alpha;
  perfMetrics.avgCollisionChecks = perfMetrics.avgCollisionChecks * (1 - alpha) + perfMetrics.collisionChecks * alpha;
  
  // Track min/max
  if (tickTime > perfMetrics.maxTickMs) perfMetrics.maxTickMs = tickTime;
  if (tickTime > perfMetrics.windowMaxMs) perfMetrics.windowMaxMs = tickTime;
  if (tickTime < perfMetrics.minTickMs) perfMetrics.minTickMs = tickTime;
  
  // Warn if tick is taking too long (>14ms leaves buffer for 60Hz)
  if (tickTime > 14 && perfMetrics.ticksProcessed > 100) {
    console.warn(`⚠️ Tick ${gs.currentTick} took ${tickTime.toFixed(2)}ms (avg: ${perfMetrics.avgTickMs.toFixed(2)}ms, collisions: ${perfMetrics.collisionChecks})`);
  }
  
  // Reset per-tick counters
  perfMetrics.collisionChecks = 0;
  perfMetrics.spatialQueries = 0;
}
