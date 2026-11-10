/**
 * @contract server.gameserver.hosts.mining
 * owns:       host adapter for mining and beams, comets and site exits
 * needs:      GameServer (type); npm: @space-game/common, bitecs
 * invariants: the comet passes for `hours` of every `days` of the clock, and a belt rock is not gas — server/src/gameServer/hosts/hosts.test.ts
 * extend:      a new host member is added to createMiningHost
 */

import { addComponent, hasComponent } from 'bitecs';
import { Position, Asteroid, Portal, InSystem, Dead, dcos, dhypot, dsin } from '@space-game/common';
import { EffectType, getAsteroidPolygon, asteroidSpin, segmentNearCircle, segmentIntersectT } from '@space-game/common';
import { skillValue, Bag, gradeOf, accrueTraces, releaseTraces, stationPerks } from '@space-game/common';
import { type PilotConn } from '../../game/Pilots.js';
import { MiningHost } from '../../game/Mining.js';
import { mineFalloff } from '@space-game/common';
import type { ClientConnection } from '../../net/ClientConnection.js';
import { portalQuery } from '../../net/handlers/flight.js';
import { stationPerksSite } from '../shared.js';
import { shedAsteroid, respawnAsteroid, forgetAsteroid } from '../asteroids.js';
import type { GameServer } from '../../GameServer.js';

/** Ore refined: the rare traces it carried come out (econ/traces.ts) */
export function releaseUsedTraces(gs: GameServer, conn: PilotConn, used: Bag): void {
  const p = gs.pilots.get(conn);
  if (!p?.traces) return;
  const got = releaseTraces(p.traces, gs.gameData.miningTable.traces, used, stationPerks(p.outpost).traceMul);
  if (!Object.keys(p.traces).length) delete p.traces;
  gs.pilots.markDirty(conn);
  if (!Object.keys(got).length) return;
  gs.pilots.give(conn, got, { toStorage: true, source: 'crafted', quiet: true });
  gs.pilots.toast(conn, `Found in the ore: ${Object.entries(got).map(([id, n]) => `${n} × ${gs.econ.items.name(id)}`).join(', ')}`, 'good');
}

export function createMiningHost(gs: GameServer): MiningHost {
  return {
    spawnChunk: (num, x, y, vx, vy, items, miner) => { gs.pods.spawnChunk(num, x, y, vx, vy, items, miner); },
    minerAt: (eid) => (hasComponent(gs.world, Position, eid) ? { x: Position.x[eid], y: Position.y[eid] } : null),
    miningSkill: (eid) => {
      const pc = gs.pilots.connOf(eid);
      // Flying in a wing adds its yield bonus on top of the skill's
      return pc ? skillValue('mining', gs.pilots.skills(pc).mining ?? 0) + (gs.party.wingBonus(pc) - 1) : 0;
    },
    awardXp: (eid, xp) => { const pc = gs.pilots.connOf(eid); if (pc) gs.pilots.addXp(pc, xp); },
    traceTier: (num, type) => {
      const c = gs.gameData.miningTable.comet;
      return c && type === 'comet' && cometNow(gs) && c.systems.includes(gs.gameData.getSystemByNum(num)?.id ?? '') ? c.traceTier : 0;
    },
    mined: (eid, ores, from) => {
      const pc = gs.pilots.connOf(eid), p = pc && gs.pilots.get(pc);
      if (!p) return;
      const ledger = p.traces ?? {};
      for (const [ore, n] of Object.entries(ores)) accrueTraces(ledger, gs.gameData.miningTable.traces, ore, n, from);
      if (Object.keys(ledger).length) { p.traces = ledger; gs.pilots.markDirty(pc); }
    },
    notify: (eid, text) => { const pc = gs.pilots.connOf(eid); if (pc) gs.pilots.toast(pc, text, 'warn'); },
    respawn: (num, index) => respawnAsteroid(gs, num, index),
    shed: (eid, stage, size, left) => shedAsteroid(gs, eid, stage, size, left),
    rockTier: (num) => ((gs.gameData.factionsFile as { spawns?: Record<string, { grade?: number }> }).spawns?.[gs.gameData.getSystemByNum(num)?.id ?? ""]?.grade) || 1,
    crumble: (eid) => {
      if (hasComponent(gs.world, Dead, eid)) return;
      addComponent(gs.world, Dead, eid);
      gs.pendingRemovedEntities.add(eid);
      gs.placeAsteroid(eid);
      gs.broadcastToSystem(InSystem.systemId[eid], { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: [Asteroid.size[eid], 30] });
      gs.mining.onBroken(eid, Position.x[eid], Position.y[eid]);
      forgetAsteroid(gs, eid);
    },
    tick: () => gs.currentTick,
  };
}

/**
 * A mining beam: the first asteroid along it takes `damage` and is mined with
 * the laser's yield. Returns how far along the beam it hit (1 = nothing).
 */
export function mineBeam(gs: GameServer, eid: number, x: number, y: number, angle: number, range: number, damage: number, material: string, gas = false, full = range): number {
  const x1 = x + dcos(angle) * range, y1 = y + dsin(angle) * range;
  const systemNum = InSystem.systemId[eid];
  let best = 1, hit = -1;
  for (const a of gs.asteroidOrbits.query(systemNum, x, y, x1, y1, 120, gs.currentTick)) {
    if (hasComponent(gs.world, Dead, a) || InSystem.systemId[a] !== systemNum) continue;
    // A siphon draws only from gas pockets; a mining laser passes through them
    if (gs.isGas(a) !== gas) continue;
    gs.placeAsteroid(a);
    if (!segmentNearCircle(x, y, x1, y1, Position.x[a], Position.y[a], Asteroid.size[a])) continue;
    const poly = getAsteroidPolygon(a, Position.x[a], Position.y[a], Asteroid.size[a], asteroidSpin(a, gs.currentTick));
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const t = segmentIntersectT(x, y, x1, y1, p1.x, p1.y, p2.x, p2.y);
      if (t !== null && t < best) { best = t; hit = a; }
    }
  }
  if (hit < 0) return 1;
  const tbl = gs.gameData.miningTable;
  const hx = x + (x1 - x) * best, hy = y + (y1 - y) * best;
  damage *= mineFalloff(best * range, full);
  if (damage <= 0) return best;
  // A training drone (game/tutorial): counted for this pilot alone, the body untouched
  if (gs.tutorial?.hit(hit, eid, damage)) return best;
  Asteroid.hp[hit] -= damage;
  const nl = dhypot(hx - Position.x[hit], hy - Position.y[hit]) || 1;
  const siphon = (tbl.tools as unknown as Record<string, { yield: number; hardness: number }>).siphon;
  gs.mining.extract(hit, eid, damage, gas && siphon ? siphon : { yield: tbl.tools.miner.yield, hardness: tbl.tools.minerByMaterial[material] ?? tbl.tools.miner.hardness, grade: gradeOf(gs.ships.catalog.materials.get(material)) },
    hx, hy, (hx - Position.x[hit]) / nl, (hy - Position.y[hit]) / nl);
  if (Asteroid.hp[hit] <= 0 && !hasComponent(gs.world, Dead, hit)) {
    addComponent(gs.world, Dead, hit);
    gs.pendingRemovedEntities.add(hit);
    gs.broadcastToSystem(systemNum, { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(Position.x[hit]), y: Math.round(Position.y[hit]), data: [Asteroid.size[hit], 30] });
    gs.mining.onBroken(hit, Position.x[hit], Position.y[hit]);
    forgetAsteroid(gs, hit);
  }
  return best;
}

/** An arrival's effect: a gate spooling up (a slow amber ring), a ship coming through (warp-in), or launching from a hull */
export function arrivalEffect(gs: GameServer, num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch'): void {
  gs.broadcastToSystem(num, { type: 'effect', effectType: kind === 'launch' ? EffectType.WarpOut : EffectType.WarpIn, x: Math.round(x), y: Math.round(y), data: [kind === 'warning' ? 2 : 0] });
}

/** The jump point at a pilot's station site (where they come out if they were inside when it was unloaded) */
export function siteExit(gs: GameServer, conn: ClientConnection): { num: number; x: number; y: number } | null {
  const site = stationPerksSite(gs.pilots.get(conn)?.outpost?.site);
  const sys = site ? gs.gameData.getStation(site.station)?.system : undefined;
  if (!sys) return null;
  const num = gs.gameData.getSystemNum(sys);
  for (const g of portalQuery(gs.world)) {
    if (InSystem.systemId[g] === num && gs.gameData.getSystemByNum(Portal.targetSystem[g])?.private) return { num, x: Position.x[g], y: Position.y[g] };
  }
  return null;
}

/** A gas pocket (shots and beams pass through; only a siphon draws from it) */
export function isGas(gs: GameServer, asteroid: number): boolean {
  const c = gs.mining.get(asteroid);
  return !!(c && gs.gameData.miningTable.types[c.type]?.gas);
}

/** The comet passing: (now) and where; while it does, comet rocks there carry their traces richly */
export function cometNow(gs: GameServer): boolean {
  const c = gs.gameData.miningTable.comet;
  if (!c) return false;
  return gs.clock() % (c.days * 86_400_000) < c.hours * 3_600_000;
}

export function watchComet(gs: GameServer): void {
  if (gs.currentTick % 600) return;
  const now = cometNow(gs);
  if (now === gs.cometWas) return;
  gs.cometWas = now;
  const c = gs.gameData.miningTable.comet!;
  const where = c.systems.map((s) => gs.gameData.getSystem(s)?.name ?? s).join(' and ');
  const text = now ? `The comet is passing ${where}: its rocks run with pale iridium while it lasts (${c.hours} hours)` : 'The comet has passed on';
  for (const conn of gs.clients.values()) gs.pilots.toast(conn, text, now ? 'good' : 'info');
}

/** A weapon beam (laser, lance) on asteroids: it burns the first one and mines it a little */
export function beamAsteroid(gs: GameServer, eid: number, x: number, y: number, angle: number, range: number, damage: number, kind: string): number {
  const tools = gs.gameData.miningTable.tools as unknown as Record<string, { yield: number; hardness: number; mining?: boolean }>;
  const tool = tools[kind] ?? tools.fixed;
  const x1 = x + dcos(angle) * range, y1 = y + dsin(angle) * range;
  const systemNum = InSystem.systemId[eid];
  let best = 1, hit = -1;
  for (const a of gs.asteroidOrbits.query(systemNum, x, y, x1, y1, 120, gs.currentTick)) {
    if (hasComponent(gs.world, Dead, a) || InSystem.systemId[a] !== systemNum || gs.isGas(a)) continue;
    gs.placeAsteroid(a);
    if (!segmentNearCircle(x, y, x1, y1, Position.x[a], Position.y[a], Asteroid.size[a])) continue;
    const poly = getAsteroidPolygon(a, Position.x[a], Position.y[a], Asteroid.size[a], asteroidSpin(a, gs.currentTick));
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const t = segmentIntersectT(x, y, x1, y1, p1.x, p1.y, p2.x, p2.y);
      if (t !== null && t < best) { best = t; hit = a; }
    }
  }
  if (hit < 0) return 1;
  const hx = x + (x1 - x) * best, hy = y + (y1 - y) * best;
  // A training drone (game/tutorial): counted for this pilot alone, the body untouched
  if (gs.tutorial?.hit(hit, eid, damage)) return best;
  Asteroid.hp[hit] -= damage;
  const nl = dhypot(hx - Position.x[hit], hy - Position.y[hit]) || 1;
  gs.mining.extract(hit, eid, damage, tool, hx, hy, (hx - Position.x[hit]) / nl, (hy - Position.y[hit]) / nl);
  if (Asteroid.hp[hit] <= 0 && !hasComponent(gs.world, Dead, hit)) {
    addComponent(gs.world, Dead, hit);
    gs.pendingRemovedEntities.add(hit);
    gs.broadcastToSystem(systemNum, { type: 'effect', effectType: EffectType.AsteroidBreak, x: Math.round(Position.x[hit]), y: Math.round(Position.y[hit]), data: [Asteroid.size[hit], 30] });
    gs.mining.onBroken(hit, Position.x[hit], Position.y[hit]);
    forgetAsteroid(gs, hit);
  }
  return best;
}
