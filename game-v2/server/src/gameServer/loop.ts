/**
 * @contract server.gameserver.loop
 * owns:       the real-time loop, one step, the guarded tick table and its per-tick passes
 * needs:      GameServer (type), tickOrder, gameServer/* systems, sim/SystemClocks
 * invariants: tick table order — server/src/tickOrder.test.ts
 *             one step is inputs, tick, own passes, snapshots, in that order — server/src/golden/frameHash.test.ts
 * extend:      a new tick system is one entry in buildTickSystems (and tickOrder.json)
 */

import { hasComponent } from 'bitecs';
import { Player, InSystem, TICK_MS } from '@space-game/common';
import { Achievements } from '../game/Achievements.js';
import { checkTickOrder, type TickSystem } from '../tickOrder.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import * as flight from '../net/handlers/flight.js';
import { SimPass } from '../sim/SystemClocks.js';
import { INPUT_TIMEOUT_TICKS, scheduleImmediate, LOOP_SPIN_MS } from './shared.js';
import { watchComet } from './hosts/mining.js';
import { reportAdminStats, updatePerfMetrics } from './admin.js';
import { asteroidDeathSystem } from './asteroids.js';
import { weaponSystem, projectileSystem, collisionSystem } from './combat.js';
import { playerMovementSystem, stationOrbitSystem, buildSpatialGrid, lifetimeSystem, cleanupSystem } from './systems.js';
import { trafficSystem } from './traffic.js';
import { lingerSystem } from './session.js';
import { recordSelfHashes } from './messages.js';
import { riftSystem } from './travel.js';
import type { GameServer } from '../GameServer.js';

/** Run exactly one simulation tick (inputs drained first), as the real-time loop does. */
export function step(gs: GameServer): void {
  gs.net.batching++;
  try {
    gs.guard('inputs', () => gs.drainInputQueue());
    gs.tick();
    gs.ownPasses();
    gs.guard('snapshots', () => gs.snapshotRound());
    gs.crowd?.endTick();
  } finally {
    gs.net.batching--;
    gs.flushOutbox();
  }
}

/** The snapshot round when one is due, then the crowd levels (their costs: this tick's and its round's) */
export function snapshotRound(gs: GameServer): void {
  const skip = gs.snapshots.due();
  if (skip !== false) gs.sendSnapshots(skip);
}

/**
 * Systems with a clock of their own (crowd dilation, sim/SystemClocks.ts), after the main pass: each one due a step
 * has its pass at its own tick (its clients' inputs, the tick entries that touch its world, then its snapshot round
 * when its window comes round), charged to it
 */
export function ownPasses(gs: GameServer): void {
  if (!gs.clocks || !SimPass.own.size) { gs.clocks?.due(); return; }
  const base = gs.currentTick;
  for (const sys of gs.clocks.due()) {
    const t0 = performance.now();
    SimPass.main = false;
    SimPass.system = sys;
    try {
      // (Its clients' inputs at its last tick, as the main pass drains them before it moves on: one for the tick
      // about to run is on time, not late, and one for the tick after waits for it)
      gs.currentTick = gs.clocks.tickOf(sys);
      gs.guard('inputs', () => gs.drainInputQueue());
      gs.currentTick = gs.clocks.step(sys);
      gs.tick(true);
      const skip = gs.snapshots.ownRound(sys);
      if (skip) gs.guard('snapshots', () => gs.sendSnapshots(skip));
    } finally {
      SimPass.main = true;
      SimPass.system = -1;
      gs.currentTick = base;
    }
    gs.crowd?.charge(sys, performance.now() - t0);
  }
}

/**
 * Real-time loop: sleeps until the next tick is due, runs the ticks the
 * accumulator owes (catch-up capped), then the snapshot round and one flush
 * of everyone's outbox.
 *
 * WebSocket messages (inputs, pongs, chat) are handled as they arrive,
 * between wakeups: inputs are queued and batch-applied right before each
 * tick for deterministic simulation, and replies to a request are flushed
 * straight after it (pongs go at once), so a wakeup that runs no tick has
 * no snapshot due and nothing waiting to flush.
 */
export function gameLoop(gs: GameServer): void {
  const now = performance.now();
  const deltaMs = now - gs.lastTickTime;
  gs.lastTickTime = now;

  gs.tickAccumulator += deltaMs;
  if (gs.paused) gs.tickAccumulator = 0;

  // Fixed timestep updates— cap catch-up to avoid spiral of death
  let ticksThisFrame = 0;
  const maxTicksPerFrame = 4;
  // (Woken a little early, or paused: no tick, so nothing to do but sleep again)
  if (gs.tickAccumulator >= TICK_MS) {
    gs.net.batching++;
    try {
      while (gs.tickAccumulator >= TICK_MS && ticksThisFrame < maxTicksPerFrame) {
        // Drain queued inputs right before each tick so they take effect
        // on the earliest possible tick boundary.
        gs.guard('inputs', () => gs.drainInputQueue());

        gs.tick();
        gs.ownPasses();
        gs.crowd?.endTick();
        gs.tickAccumulator -= TICK_MS;
        ticksThisFrame++;
      }

      // If we're still behind, drop accumulated time to avoid spiral
      if (gs.tickAccumulator > TICK_MS * maxTicksPerFrame) {
        gs.tickAccumulator = 0;
      }

      // Send snapshots at snapshot rate (each system at its own window: crowd fallbacks)
      gs.guard('snapshots', () => gs.snapshotRound());
    } catch (e) {
      // (Whatever got past the guards: logged, and the loop goes on: it's scheduled below either way)
      gs.tickAccumulator = 0;
      gs.fault('gameLoop', e);
    } finally {
      gs.net.batching--;
      gs.guard('flushOutbox', () => gs.flushOutbox());
    }
  }

  // Sleep until the next tick is due. Busy-waiting (setImmediate) burns CPU
  // between ticks (the last 1-1.5 ms of every tick was spun through: thousands
  // of wakeups a second for 60 ticks), which starves co-located processes and
  // invites scheduler preemption mid-tick. Timers fire on whole milliseconds,
  // so a sleep lands up to ~1 ms either side of the deadline: early, the
  // wakeup just sleeps the rest; late, the accumulator absorbs it (the next
  // sleep is that much shorter). Only the last LOOP_SPIN_MS isn't slept.
  const msUntilNextTick = TICK_MS - gs.tickAccumulator;
  if (msUntilNextTick > LOOP_SPIN_MS) {
    gs.gameLoopTimer = setTimeout(() => gs.gameLoop(), Math.max(1, Math.floor(msUntilNextTick)));
  } else {
    // Tick due now (or behind) — run on the next event loop pass
    gs.gameLoopTimer = scheduleImmediate(() => gs.gameLoop());
  }
}

/**
 * Apply all queued player inputs.  Called once per tick, right before
 * simulation, so every input lands on the earliest tick boundary.
 */
export function drainInputQueue(gs: GameServer): void {
  // (Systems with a clock of their own, crowd dilation: each pass drains its own clients' inputs, at its tick)
  const sysOf = (c: ClientConnection) => (hasComponent(gs.world, Player, c.playerId) ? InSystem.systemId[c.playerId] : -1);
  const mine = SimPass.all ? null : (c: ClientConnection) => SimPass.on(sysOf(c));
  // 1. Process newly received inputs (may schedule them for future ticks)
  let kept = 0;
  for (let i = 0; i < gs.inputQueue.length; i++) {
    const q = gs.inputQueue[i];
    if (mine && !mine(q.conn)) { gs.inputQueue[kept++] = q; continue; }
    // (One bad input is dropped on its own; the queue's still cleared below)
    gs.guard('input', () => gs.handleInput(q.conn, q.msg));
  }
  gs.inputQueue.length = kept; // clear without re-allocation

  // 2. Apply per-player scheduled inputs whose targetTick has arrived
  const nextTick = gs.currentTick + 1;
  let drainedCount = 0;
  for (const conn of gs.clients.values()) {
    if (mine && !mine(conn)) continue;
    conn.inputsThisTick = 0;
    // A client whose game loop has gone quiet (a hidden tab, a hung browser) stops flying and firing
    if (conn.hashSeen && gs.currentTick - conn.liveTick > INPUT_TIMEOUT_TICKS) gs.releaseControls(conn.playerId);
    const scheduled = conn.scheduledInputs;
    // Everything due, oldest first (the last one applied is the one in effect)
    const due = scheduled.filter((s) => s.targetTick <= nextTick);
    if (due.length) {
      due.sort((a, b) => a.targetTick - b.targetTick || (a.msg.seq ?? 0) - (b.msg.seq ?? 0));
      for (const s of due) gs.guard('input', () => gs.applyInputToEntity(conn, s.msg));
      drainedCount += due.length;
      conn.scheduledInputs = scheduled.filter((s) => s.targetTick > nextTick);
    }
  }
  void drainedCount;
}

/** Let go of every key (net/handlers/flight.ts) */
export function releaseControls(gs: GameServer, eid: number): void {
  flight.releaseControls(eid);
}

/**
 * The tick's guarded systems as an ordered table (tickOrder.ts), built once. tick() walks it; the order is the
 * simulation order (golden/tickOrder.json pins it).
 */
export function buildTickSystems(gs: GameServer): readonly TickSystem[] {
  const systems: TickSystem[] = [
    // ---- pilots-move ----
    // (Asteroids aren't moved: their positions are worked out when something needs them, see placeAsteroid)
    { name: 'stationOrbitSystem', pass: true, phase: 'pilots-move', run: () => stationOrbitSystem(gs) },
    // Systems pilots are in or coming to are in the world; ones left a while are put away (before anything's spawned)
    { name: 'memory', phase: 'pilots-move', scene: 'sectors', run: () => gs.memory.tick() },
    // Reset spatial grid and rebuild
    { name: 'spatialGrid', phase: 'pilots-move', run: () => { gs.spatialGrid.clear(); buildSpatialGrid(gs); } },
    { name: 'playerMovementSystem', pass: true, phase: 'pilots-move', run: () => playerMovementSystem(gs) },
    // (Part features tick here, after the pilots fly and before wrecks and pods move: a Tow Beam pulls what it tows. ships/features/host.ts)
    { name: 'towing', pass: true, phase: 'pilots-move', run: () => { gs.features.tick(); } },
    { name: 'dockingSystem', pass: true, phase: 'pilots-move', run: () => gs.docking.dockingSystem() },
    { name: 'riftSystem', pass: true, phase: 'pilots-move', run: () => riftSystem(gs) },
    // ---- combat ----
    // (Boost fuel is the ship's battery now: it charges in the flight step, energy.ts)
    { name: 'weaponSystem', pass: true, phase: 'combat', run: () => weaponSystem(gs) },
    { name: 'projectileSystem', pass: true, phase: 'combat', run: () => projectileSystem(gs) },
    { name: 'enemies', pass: true, phase: 'combat', scene: 'sectors', run: () => { gs.enemies.tick(); gs.range?.tick(); gs.recovery.tick(); } },
    { name: 'bosses', pass: true, phase: 'combat', scene: 'sectors', run: () => { gs.bosses.tick(); gs.bossDev.tick(); gs.dens.tick(); } },
    { name: 'mobs', pass: true, phase: 'combat', scene: 'sectors', run: () => gs.mobs.tick() },
    { name: 'events', phase: 'combat', scene: 'sectors', run: () => gs.events.tick() },
    { name: 'surfaces', phase: 'combat', scene: 'sectors', run: () => gs.surfaces.tick() },
    { name: 'sieges', phase: 'combat', scene: 'sectors', run: () => gs.sieges.tick() },
    { name: 'arenas', phase: 'combat', scene: 'sectors', run: () => gs.arenas.tick() },
    { name: 'collisionSystem', pass: true, phase: 'combat', run: () => collisionSystem(gs) },
    // Check for destroyed asteroids
    { name: 'asteroidDeathSystem', phase: 'combat', run: () => asteroidDeathSystem(gs) },
    { name: 'lod', pass: true, phase: 'combat', run: () => gs.lod.tick() },
    { name: 'ships', pass: true, phase: 'combat', run: () => gs.ships.tick() },
    { name: 'replication.endTick', pass: true, phase: 'combat', run: () => gs.replication.endTick() },
    { name: 'recordSelfHashes', pass: true, phase: 'combat', run: () => recordSelfHashes(gs) },
    // ---- world ----
    { name: 'pods', phase: 'world', run: () => gs.pods.tick() },
    { name: 'mining', phase: 'world', run: () => gs.mining.tick() },
    { name: 'hazards', phase: 'world', run: () => gs.hazards.tick() },
    { name: 'warmth', phase: 'world', run: () => gs.warmth.tick() },
    { name: 'homes', phase: 'world', run: () => gs.homes.tick() },
    { name: 'watchComet', phase: 'world', run: () => watchComet(gs) },
    // (per-client entries guard each client themselves)
    { name: 'outpost', phase: 'world', every: 60, when: () => !!gs.outpost, perClient: true, run: () => {
      for (const c of gs.clients.values()) gs.guard('outpost', () => gs.outpost!.finish(c));
    } },
    { name: 'pilots', phase: 'world', run: () => gs.pilots.tick() },
    { name: 'quests', phase: 'world', run: () => gs.quests.tick() },
    { name: 'codex', phase: 'world', run: () => gs.codex.tick() },
    { name: 'party', phase: 'world', run: () => gs.party.tick() },
    { name: 'trade', phase: 'world', run: () => gs.trade.tick(gs.currentTick) },
    { name: 'achievements', phase: 'world', every: 60, perClient: true, run: () => {
      for (const c of gs.clients.values()) {
        if (gs.flying(c.playerId)) gs.guard('achievements', () => gs.achievements.visit(c, gs.gameData.getSystemByNum(InSystem.systemId[c.playerId])?.id ?? ''));
      }
      gs.achievements.save().catch((e) => console.error('[Achievements] save failed:', e));
    } },
    { name: 'ops', phase: 'world', scene: 'sectors', run: () => gs.ops.tick() },
    { name: 'services', phase: 'world', every: 60, perClient: true, run: () => {
      for (const c of gs.clients.values()) gs.guard('services', () => { gs.services.tick(c); gs.hangar.tick(c); gs.hangar.fill(c); });
    } },
    // ---- persist ----
    { name: 'lingerSystem', phase: 'persist', run: () => lingerSystem(gs) },
    { name: 'derelictRespawnSystem', phase: 'persist', run: () => gs.derelictsMod.derelictRespawnSystem() },
    { name: 'trafficSystem', phase: 'persist', run: () => trafficSystem(gs) },
    { name: 'lifetimeSystem', pass: true, phase: 'persist', run: () => lifetimeSystem(gs) },
    { name: 'cleanupSystem', phase: 'persist', run: () => cleanupSystem(gs) },
  ];
  checkTickOrder(systems);
  return systems;
}

export function tick(gs: GameServer, own = false): void {
  const tickStart = performance.now();
  // (A system with a clock of its own: its pass, its tick already set, ownPasses)
  if (!own) gs.currentTick++;

  // The guarded systems, in order: tickOrder.ts (the table is built once, in buildTickSystems)
  const tick = gs.currentTick, scene = gs.scene;
  for (const s of gs.tickSystems) {
    if (own && !s.pass) continue;
    if (s.scene !== undefined && s.scene !== scene) continue;
    if (s.every !== undefined && tick % s.every !== 0) continue;
    if (s.when !== undefined && !s.when()) continue;
    if (s.perClient) s.run();
    else gs.guard(s.name, s.run);
  }
  
  if (own) return;
  if (gs.afterTick.length) for (const h of gs.afterTick) gs.guard('afterTick', h);
  // Report to admin server and update performance metrics
  const tickTime = performance.now() - tickStart;
  // (Crowd fallbacks: the tick's time charged to the systems by their ships)
  gs.crowd?.shareByBodies(tickTime, gs.ships.bodies.keys(), (s) => SimPass.on(s));
  updatePerfMetrics(gs, tickTime);
  reportAdminStats(gs, tickTime);
}
