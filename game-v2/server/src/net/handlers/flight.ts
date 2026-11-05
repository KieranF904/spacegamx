/**
 * Flight messages, the prediction-sensitive ones: input (queued for the tick boundary), ping, stateHash, mapView,
 * interact, respawn, trainingDrone, and target (the Tow Beam's `tow` is a part feature's: ships/features/tow). Moved verbatim from GameServer (the receiver `this` became `ctx`;
 * the helpers take ctx first).
 *
 * Order matters here and was kept to the statement: GameServer.drainInputQueue (still in GameServer, run right before
 * each tick) calls handleInput and applyInputToEntity through its one-line delegates, and recordSelfHashes runs from
 * the tick list right after replication.endTick (tickOrder.ts). Changing anything below can desync client prediction.
 */
import { hasComponent, entityExists, removeEntity, defineQuery } from 'bitecs';
import {
  Position, Velocity, Rotation, Health, Player, Input, Boost, Portal, InSystem, Dead,
  TICK_RATE, inSafeSpace, unwrapTick16, computeStateHash, PROTOCOL_VERSION,
  replicaAngle, quantizeReplicaAngle, pilotAimQ, ReplicaMode, INPUT_BOOLS, INPUT_HELD, controlBits, buildFlightInputs, dcos, dsin, hashUnit, CURSOR_DIST_MAX,
} from '@space-game/common';
import type { FactionsFile } from '../../game/Enemies.js';
import type { ClientConnection } from '../ClientConnection.js';
import { MAX_INPUTS_PER_TICK, type HandlerRegistry } from '../dispatch.js';
import type { ServerCtx } from '../ServerCtx.js';
import { SimPass } from '../../sim/SystemClocks.js';

/** Input flood guards (the per-tick one, MAX_INPUTS_PER_TICK, is in net/dispatch.ts): how far ahead one may be scheduled, and how many may wait */
const MAX_INPUT_LEAD = 64;
const MAX_SCHEDULED_INPUTS = 32;

/** Jump gates and rifts (GameServer uses the same query) */
export const portalQuery = defineQuery([Portal, Position]);

export function registerFlightHandlers(t: HandlerRegistry): void {
  t.on('input', (ctx, conn, msg) => {
    // (Debris it worked out, confirmed straight away: they ride on inputs, protocol 25)
    if (Array.isArray(msg.acks) && msg.acks.length) ctx.snapshots.ackDebris(conn, msg.acks);
    // (Client-detected hits: its hit chain's report rides here too, protocol 28: net/hits/HitLedger.ts)
    if (msg.hitReport) ctx.hits.report(conn, msg.hitReport);
    // (Its own ship's check, CAPS.OWN_SIM: net/own/OwnChecks.ts)
    if (msg.ownCheck) ctx.ownChecks.check(conn, msg.ownCheck);
    // (The bosses' bodies it runs, CAPS.BODIES: net/decisions/BodyNet.ts)
    if (msg.bodyCheck) ctx.bodies.check(conn, msg.bodyCheck);
    // Queue for next tick boundary — don't apply mid-frame.
    // Messages still arrive instantly via setImmediate event loop.
    // (Dropped: a client stepping its own ship had it on its target tick, so its ship is off: Replication ownLate)
    if (++conn.inputsThisTick > MAX_INPUTS_PER_TICK) { conn.ownLate = true; return; }
    ctx.inputQueue.push({ conn, msg });
  });
  t.on('ping', handlePing);
  // (Confirmed hits: its copy of these ships' HP is off, so all of it goes again: net/hits/HitLedger.ts)
  t.on('hpResync', (ctx, conn, msg) => {
    if (Array.isArray(msg.ids)) ctx.hits.resync(conn, msg.ids);
  });
  // (Bit-packed frames: a packed message didn't decode, so its next one starts afresh: net/snapshot/PackedLink.ts)
  t.on('packedResync', (ctx, conn) => {
    conn.packed?.resync();
  });
  t.on('mapView', (ctx, conn, msg) => {
    // (Opened: the far ships at once, then once a second while it's open)
    conn.mapOpen = msg.open === true;
    if (conn.mapOpen) { conn.mapDotsDue = true; conn.mapFresh = true; conn.mapSent?.clear(); }
  });
  t.on('interact', (ctx, conn, msg) => {
    handleInteract(ctx, conn, msg);
  });
  t.on('respawn', (ctx, conn, msg) => {
    handleRespawn(ctx, conn, typeof msg.rally === 'string' ? msg.rally : undefined);
  });
  t.on('trainingDrone', (ctx, conn, msg) => {
    trainingDrone(ctx, conn);
  });
  t.on('target', (ctx, conn, msg) => {
    ctx.ships.setTarget(conn.playerId, Number(msg.id) || 0);
  });
  t.on('stateHash', (ctx, conn, msg) => {
    handleStateHash(ctx, conn, msg as any);
  });
}

/** The client's prediction of its ship at a tick, checked against what the ship really did then */
export function handleStateHash(ctx: ServerCtx, conn: ClientConnection, msg: { tick: number; hash: number }): void {
  conn.liveTick = ctx.currentTick;
  conn.hashSeen = true;
  if (!hasComponent(ctx.world, Player, conn.playerId)) return;
  const tick = Number(msg.tick);
  // The client predicts ahead of us: a hash for a tick we haven't reached is checked when we get there
  if (tick > ctx.currentTick) {
    if (tick - ctx.currentTick < 120 && conn.aheadHashes.size < 8) conn.aheadHashes.set(tick, msg.hash);
    return;
  }
  const h = conn.selfHashes.get(tick);
  if (h !== undefined && h !== msg.hash) conn.forceSnapshot = true;
}

/** End of tick: remember each pilot's ship state hash for the last couple of seconds */
export function recordSelfHashes(ctx: ServerCtx, ): void {
  for (const conn of ctx.clients.values()) {
    const eid = conn.playerId;
    if (!hasComponent(ctx.world, Player, eid) || hasComponent(ctx.world, Dead, eid) || !SimPass.on(InSystem.systemId[eid])) continue;
    const h = computeStateHash(Position.x[eid], Position.y[eid], Rotation.angle[eid], Velocity.x[eid], Velocity.y[eid],
      Health.current[eid], Boost.fuel[eid], ctx.gameData.getSystemByNum(InSystem.systemId[eid])?.id || 'sol');
    conn.selfHashes.set(ctx.currentTick, h);
    conn.selfHashes.delete(ctx.currentTick - 180);
    const ahead = conn.aheadHashes.get(ctx.currentTick);
    if (ahead !== undefined) {
      if (ahead !== h) conn.forceSnapshot = true;
      conn.aheadHashes.delete(ctx.currentTick);
    }
    for (const t of conn.aheadHashes.keys()) if (t < ctx.currentTick) conn.aheadHashes.delete(t);
  }
}

/**
 * Schedule an input for future application at its targetTick.
 * If no targetTick or it's in the past, apply immediately (backward compat).
 *
 * The rules (net/handlers/inputRules.test.ts): an input never rewrites a tick already stepped (a late one is applied
 * on the next step, and its client corrected); one stamped more than MAX_INPUT_LEAD ticks ahead is dropped, as is one
 * past MAX_SCHEDULED_INPUTS waiting; and while berthed (conn.docked) the controls stay as the dock left them (neutral):
 * an input its client sent before it knew is dropped (only its seq is taken), and the client sends none meanwhile
 * (client app/inputSend.ts).
 */
export function handleInput(ctx: ServerCtx, conn: ClientConnection, msg: any): void {
  const eid = conn.playerId;
  if (!hasComponent(ctx.world, Player, eid)) return;
  if (conn.docked) {
    const seq = Number.isFinite(msg.seq) ? msg.seq : 0;
    Input.sequence[eid] = seq;
    conn.lastInputSeq = seq;
    conn.liveTick = ctx.currentTick;
    return;
  }
  
  // Inputs carry the low 16 bits of their target tick: the one nearest ours
  if (msg.targetTick !== undefined) msg.targetTick = unwrapTick16(msg.targetTick & 0xFFFF, ctx.currentTick);
  const targetTick = msg.targetTick;
  conn.liveTick = ctx.currentTick;
  if (targetTick !== undefined && targetTick > ctx.currentTick) {
    // Schedule for future tick (no further ahead than a client could predict, and only so many)
    if (targetTick > ctx.currentTick + MAX_INPUT_LEAD) { conn.ownLate = true; return; }
    conn.scheduledInputs.push({ targetTick, msg });
    if (conn.scheduledInputs.length > MAX_SCHEDULED_INPUTS) { conn.scheduledInputs.shift(); conn.ownLate = true; }
  } else {
    // No targetTick (old client) or late arrival — apply immediately. The client
    // predicted it on an earlier tick, so its ship needs correcting, unless its controls are the ones the ship flew
    // since (a client catching up after a hitch, the keys held: its own ship stepped by itself is the server's)
    const held = conn.ownCtl, now = ownControlsOf(msg);
    applyInputToEntity(ctx, conn, msg);
    conn.selfLate = true;
    if (targetTick === undefined || !held || held.bits !== now.bits || held.q !== now.q) conn.ownLate = true;
  }
}

/** Write input state to ECS components for a player entity. */
export function applyInputToEntity(ctx: ServerCtx, conn: ClientConnection, msg: any): void {
  const eid = conn.playerId;
  // The on/off keys (inputFields.ts); the numbers below each have their own coercion
  for (let i = 0; i < INPUT_BOOLS.length; i++) { const k = INPUT_BOOLS[i]; Input[k][eid] = msg[k] ? 1 : 0; }
  // (The binary input carries it in 4-unit steps, the compact one on its grid, both up to CURSOR_DIST_MAX: a jump aimed
  // far out in a star's ring goes that far. A JSON one could say NaN, Infinity or a string)
  const cursorDist = Number(msg.cursorDist);
  Input.cursorDist[eid] = Number.isFinite(cursorDist) ? Math.min(CURSOR_DIST_MAX, Math.max(0, cursorDist)) : 0;
  // The client sends dequantized(quantized(rawAngle)) as a float32, which is already on the
  // replicated grid (replicaAngle gives back exactly that value). Anything else (a JSON input,
  // a bot) is put on the grid too, so every client replays this ship's turning exactly.
  Input.targetAngle[eid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Number(msg.targetAngle) || 0));
  const seq = Number.isFinite(msg.seq) ? msg.seq : 0;
  Input.sequence[eid] = seq;
  
  conn.lastInputSeq = seq;
  // What its client steps its own ship with from this tick (CAPS.OWN_SIM: Replication compares the controls flown)
  conn.ownCtl = ownControlsOf(msg);
}

/**
 * The controls an input says, as a client stepping its own ship works them out (client OwnTick.noteInput: no EMP, no
 * power; the aim as the pilot's step flies it, common sim/ownStep.ts pilotAimQ)
 */
export function ownControlsOf(msg: any): { bits: number; q: number } {
  return { bits: controlBits(buildFlightInputs(msg, false)), q: pilotAimQ(Number(msg.targetAngle) || 0) };
}

export function handlePing(ctx: ServerCtx, conn: ClientConnection, msg: any): void {
  const receiveTime = performance.now();
  const serverNow = Date.now();
  // Rough estimate for admin display (includes clock skew, but close enough)
  const clientTime = Number.isFinite(msg.clientTime) ? msg.clientTime : 0;
  conn.ping = Math.max(0, serverNow - clientTime);
  ctx.send(conn.ws, {
    type: 'pong',
    clientTime,
    serverTime: serverNow,
    tick: ctx.currentTick,
    serverProcessing: Math.round((performance.now() - receiveTime) * 100) / 100,
  });
}

export function handleInteract(ctx: ServerCtx, conn: ClientConnection, msg: any): void {
  const playerEid = conn.playerId;
  if (!hasComponent(ctx.world, Player, playerEid)) return;
  // Someone out here to talk to (People.ts)
  const person = hasComponent(ctx.world, Dead, playerEid) ? null : ctx.people.nearby(conn);
  if (person) return ctx.people.talkTo(conn, person.id);
  
  const playerX = Position.x[playerEid];
  const playerY = Position.y[playerEid];
  const playerSystemId = InSystem.systemId[playerEid];
  
  // In orbit over a planet with a surface: down you go
  const here = ctx.gameData.getSystemByNum(playerSystemId);
  // A boss arena's barrier: through it (game/arenas/ArenaGates.ts)
  if (!hasComponent(ctx.world, Dead, playerEid) && ctx.arenaGates.interact(playerEid)) return;
  if (here && !hasComponent(ctx.world, Dead, playerEid) && ctx.surfaces.descend(conn, here, playerX, playerY)) return;

  // Check for nearby jump gates (rifts trigger on their own when flown into)
  for (const portalEid of portalQuery(ctx.world)) {
    if (InSystem.systemId[portalEid] !== playerSystemId || Portal.kind[portalEid] !== 0) continue;

    const dx = Position.x[portalEid] - playerX;
    const dy = Position.y[portalEid] - playerY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Portal interaction radius
    if (dist < 300) {
      const targetSystemNum = Portal.targetSystem[portalEid];
      const targetData = ctx.gameData.getSystemByNum(targetSystemNum);
      if (!targetData) return;
      // Pilots' own stations: in by a site's jump point, out by their station's gate
      if (here?.private && ctx.homes.leave(conn, playerSystemId)) return;
      if (targetData.private) return ctx.homes.jump(conn, here?.id ?? '', Position.x[portalEid], Position.y[portalEid]);
      const barred = ctx.quests.canEnter(conn, targetData.id);
      if (barred) return ctx.pilots.toast(conn, barred, 'warn');
      // Arrive beside the gate that leads back here (or any gate if there's no return gate)
      let arrival: number | null = null;
      for (const g of portalQuery(ctx.world)) {
        if (InSystem.systemId[g] !== targetSystemNum || Portal.kind[g] !== 0) continue;
        if (arrival === null || Portal.targetSystem[g] === playerSystemId) arrival = g;
      }
      const ax = arrival !== null ? Position.x[arrival] + 500 : 0;
      const ay = arrival !== null ? Position.y[arrival] : 0;
      ctx.travelTo(conn, targetSystemNum, ax, ay, false);
      return;
    }
  }
}

export function handleRespawn(ctx: ServerCtx, conn: ClientConnection, rally?: string): void {
  const eid = conn.playerId;
  // cleanupSystem removes dead entities the same tick they die, so by the time
  // a respawn request arrives the entity is usually gone rather than Dead.
  if (hasComponent(ctx.world, Dead, eid) || !entityExists(ctx.world, eid)) {
    // Remove dead component and reset health
    // For now, just recreate the player
    const newPlayerId = ctx.createPlayer();
    conn.playerId = newPlayerId;
    // A new ship's controls start neutral (aim and distance 0) on both sides: its client sent none while dead, and
    // starts again from there (client app/inputSend.ts forgetSent); nothing from before waits for a tick
    neutralInput(newPlayerId);
    conn.scheduledInputs.length = 0;
    Player.clientId[newPlayerId] = Player.clientId[eid];
    if (hasComponent(ctx.world, Dead, eid)) removeEntity(ctx.world, eid);
    ctx.pilots.onRespawn(conn);
    // Rally: come back beside a party member (if they aren't in the thick of a fight)
    if (rally) {
      const m = ctx.party.members(conn).find((x) => x !== conn && x.username === rally) as ClientConnection | undefined;
      const me = m?.playerId ?? -1;
      if (!m || !ctx.flying(me)) ctx.pilots.toast(conn, `${rally} isn't flying right now: you're back at your home station`, 'warn');
      else if (ctx.currentTick - ctx.ships.lastDamagedTick(me) < 60 * 8) ctx.pilots.toast(conn, `${rally} is under fire: you're back at your home station`, 'warn');
      else {
        // (where beside them: seeded by the pilot and the tick, a server decision: math/rng.ts)
        const a = hashUnit(me, ctx.currentTick, 0x7a11) * Math.PI * 2;
        ctx.placePlayer(conn, InSystem.systemId[me], Position.x[me] + dcos(a) * 450, Position.y[me] + dsin(a) * 450);
        ctx.pilots.toast(conn, `Rallied with ${rally}`, 'good');
      }
    }

    ctx.send(conn.ws, {
      type: 'welcome',
      playerId: newPlayerId,
      protocol: PROTOCOL_VERSION,
      tickRate: TICK_RATE,
      serverTime: Date.now(),
    });
  }
}

/**
 * Let go of every key (aim and helm stay as they are: inputFields.ts INPUT_HELD). Docking and quitting mid-fight
 * (the linger) let go the same way, the dodge control included: a dodge held then would fire later with nobody flying
 */
export function releaseControls(eid: number): void {
  for (let i = 0; i < INPUT_HELD.length; i++) Input[INPUT_HELD[i]][eid] = 0;
}

/** Every control at rest, the aim and distance 0 and helm off: a new ship's (handleRespawn) */
export function neutralInput(eid: number): void {
  for (let i = 0; i < INPUT_BOOLS.length; i++) Input[INPUT_BOOLS[i]][eid] = 0;
  Input.targetAngle[eid] = 0;
  Input.cursorDist[eid] = 0;
}

/** A Helios drone 1400 ahead of a pilot in safe space, to practise on: it only fights back once shot */
export function trainingDrone(ctx: ServerCtx, conn: ClientConnection): void {
  const eid = conn.playerId;
  const num = InSystem.systemId[eid];
  const prev = ctx.trainers.get(eid);
  if (prev !== undefined && ctx.enemies.isAlive(prev)) return;
  if (!inSafeSpace(ctx.gameData.getSystemByNum(num), Position.x[eid], Position.y[eid]) || !(ctx.gameData.factionsFile as FactionsFile).factions?.helios) return;
  const a = Rotation.angle[eid];
  const [d] = ctx.enemies.spawnPack(num, { faction: 'helios', ships: ['helios_drone'], passive: true }, Position.x[eid] + dcos(a) * 1400, Position.y[eid] + dsin(a) * 1400);
  if (d !== undefined) ctx.trainers.set(eid, d);
}
