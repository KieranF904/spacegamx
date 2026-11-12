/**
 * @contract client.state.interpolation
 * owns:       the per-frame draw pass over every entity: snapshot interpolation, dead-reckoning, loot drift, deterministic orbits and the own ship's render pose
 * needs:      GameState (entities, snapshot buffer, clock and prediction fields), common orbit maths, state/drawMode hook
 * invariants: the clock estimate is read once per frame (it has stateful smoothing) — client/src/state/crowdClock.test.ts
 *             far rocks are placed every ORBIT_FAR_TICKS ticks, near ones every tick — client/src/state/rockFocus.test.ts
 * extend:     a new kind of moving entity is one more branch in the entity loop of interpolateFrame()
 */

import { EntityType, podDrift, podHold, podCarry, type PodHold, type LandmarkSet, calcAsteroidPosition, asteroidSpin, scaledOrbitTick, INTERP_MAX_DELAY_MS, INTERP_MIN_DELAY_MS, INTERP_SLEW_MS_PER_SEC } from '@space-game/common';
import type { GameState, BufferedSnapshot } from './GameState';

/** Render lerp rate for local player (1.0 = no smoothing, instant) */
const RENDER_SMOOTH_SELF = 1.0;
/** Render lerp rate for other entities */
const RENDER_SMOOTH_OTHER = 0.25;
/** Rocks out of sight are placed every this many ticks (see GameState.orbitFocus) */
const ORBIT_FAR_TICKS = 8;

export function interpolateFrame(gs: GameState, delta: number): void {
  const now = performance.now();
  gs.frameDrawn();
  
  // Cache the estimated server tick ONCE per frame.
  // getEstimatedServerTick() has stateful EMA smoothing — calling it
  // multiple times per frame (e.g. per-asteroid) causes drift.
  const estimatedTick = gs.getEstimatedServerTick(now);
  const rawTick = gs.getRawServerTick(now);
  const rawTickRounded = Math.round(rawTick);
  
  // Slew interpolation delay toward target
  const maxStep = INTERP_SLEW_MS_PER_SEC * delta;
  const deltaDelay = Math.max(-maxStep, Math.min(maxStep, gs.targetInterpDelayMs - gs.interpDelayMs));
  gs.interpDelayMs = Math.max(INTERP_MIN_DELAY_MS, Math.min(INTERP_MAX_DELAY_MS, gs.interpDelayMs + deltaDelay));
  
  const interpDelayTicks = gs.interpDelayMs / gs.tickMs;
  const renderTick = Math.max(0, estimatedTick - interpDelayTicks);
  gs.renderTickNow = renderTick;
  gs.drawMode?.frame?.(now);
  
  // Find bracketing snapshots
  const buffer = gs.snapshotBuffer;
  if (buffer.length < 2) {
    fallbackInterpolate(gs);
    return;
  }
  
  let from: BufferedSnapshot | null = null;
  let to: BufferedSnapshot | null = null;
  
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i].tick <= renderTick && buffer[i + 1].tick >= renderTick) {
      from = buffer[i];
      to = buffer[i + 1];
      break;
    }
  }
  
  if (!from && !to && renderTick < buffer[0].tick) {
    from = buffer[0];
    to = buffer[1];
  }
  
  if (!from && !to) {
    from = buffer[buffer.length - 2];
    to = buffer[buffer.length - 1];
  }
  
  if (!from || !to || from.tick === to.tick) {
    fallbackInterpolate(gs);
    return;
  }
  
  const t = Math.max(0, Math.min(1.2, (renderTick - from.tick) / (to.tick - from.tick)));
  const focus = gs.orbitFocus;
  
  for (const entity of gs.entities.values()) {
    if (entity.id === gs.playerId) continue;
    // Replicated ships: stepped from their keyframe and controls
    // (A dev prediction mode may place it at another tick, and move it after: state/drawMode.ts)
    const dm = gs.drawMode;
    if (gs.replicaPose?.(entity, dm?.ship ? dm.ship(entity, renderTick) : renderTick)) { dm?.placed?.(entity); continue; }
    // (Or another thing a dev prediction mode steps ahead itself: a homing shell, a mob)
    if (dm?.entity?.(entity, renderTick)) continue;

    // Loot pods drifting from their anchor (data[3] its tick: see podDrift)
    if (entity.type === EntityType.DroppedItem && entity.data && entity.data.length >= 4 && entity.hist?.length) {
      const b = entity.hist[entity.hist.length - 1];
      const at = podDrift(b, renderTick - entity.data[3]);
      // (Anchored in a moving landmark's zone: carried with it, as the server carries it: common world/landmarks.ts podHold)
      const hold = gs.landmarks.length ? podHoldOf(entity, gs.landmarks, b.x, b.y, entity.data[3]) : null;
      if (hold) { podCarry(gs.landmarks, hold, renderTick, POD_CARRY); at.x += POD_CARRY.x; at.y += POD_CARRY.y; }
      entity.x = at.x; entity.y = at.y; entity.vx = at.vx; entity.vy = at.vy;
      entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
      entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
      continue;
    }
    
    // Deterministic asteroids — calculate position from orbit params
    if (entity.isDeterministic && entity.orbitType !== undefined) {
      // An asteroid is placed by the whole tick: nothing to do until the tick changes
      if (entity.orbitTimeScale === undefined) {
        if (entity.orbitTick === rawTickRounded) continue;
        // Out of sight: every few ticks, each rock on its own turn (and at once if it has gone a while). Out of
        // sight means all of it: its reach (as Renderer.radiusOf culls it) is added, or a big rock whose middle is
        // just off the view while its body is on it stepped every ORBIT_FAR_TICKS
        if (focus && (rawTickRounded + entity.id) % ORBIT_FAR_TICKS !== 0 && rawTickRounded - (entity.orbitTick ?? -1e9) < 2 * ORBIT_FAR_TICKS) {
          const r = entity.type === EntityType.Asteroid ? (entity.data?.[0] || 30) * 1.3 : 0;
          if ((Math.abs(entity.x - focus.cx) > focus.hw + r || Math.abs(entity.y - focus.cy) > focus.hh + r)
            && (Math.abs(entity.x - focus.px) > focus.hw + r || Math.abs(entity.y - focus.py) > focus.hh + r)) continue;
        }
      }
      entity.orbitTick = rawTickRounded;
      const { x, y } = calcAsteroidPosition({
        orbitType: entity.orbitType ?? 0,
        semiMajorAxis: entity.semiMajorAxis ?? 0,
        eccentricity: entity.eccentricity ?? 0,
        argPeriapsis: entity.argPeriapsis ?? 0,
        meanAnomaly0: entity.meanAnomaly0 ?? 0,
        epochTick: entity.epochTick ?? 0,
      }, entity.orbitTimeScale !== undefined
        // Stations: slowed orbit clock, evaluated at the exact (fractional) tick for smooth motion
        ? scaledOrbitTick(rawTick, entity.epochTick ?? 0, entity.orbitTimeScale)
        : rawTickRounded);
      entity.x = x;
      entity.y = y;
      // Snap render position — no lerp lag so hitscan visual matches server
      entity.renderX = x;
      entity.renderY = y;
      // Asteroids turn with the tick, exactly as the server's outline does (polygon.ts)
      if (entity.type === EntityType.Asteroid) entity.angle = entity.renderAngle = asteroidSpin(entity.id, rawTickRounded);
      continue;
    }
    const fromState = from.entities.get(entity.id);
    const toState = to.entities.get(entity.id);
    
    if (fromState && toState) {
      entity.x = lerp(fromState.x, toState.x, t);
      entity.y = lerp(fromState.y, toState.y, t);
      entity.angle = lerpAngle(fromState.angle || 0, toState.angle || 0, t);
      entity.vx = toState.vx || 0;
      entity.vy = toState.vy || 0;
    } else if (entity.hist?.length) {
      // Not in both snapshots either side (unchanged, or far away and sent less often):
      // carry on from the latest state at or before now along its velocity
      let base = entity.hist[0];
      for (const s of entity.hist) if (s.tick <= renderTick) base = s;
      const lim = entity.type === EntityType.Projectile ? 900 : 45;
      const dt = Math.max(-lim, Math.min(lim, renderTick - base.tick));
      entity.x = base.x + base.vx * dt;
      entity.y = base.y + base.vy * dt;
      entity.angle = base.angle;
      entity.vx = base.vx;
      entity.vy = base.vy;
    } else if (toState) {
      entity.x = toState.x;
      entity.y = toState.y;
      entity.angle = toState.angle || 0;
      entity.vx = toState.vx || 0;
      entity.vy = toState.vy || 0;
    }
    
    // Smooth render position
    entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
    entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
    entity.renderAngle = lerpAngle(entity.renderAngle, entity.angle, 0.3);
  }
  
  // The local ship: drawn between its last two steps, half a tick behind the estimate, so it
  // moves evenly even when a frame runs no step or two (frames and ticks don't line up)
  const player = gs.entities.get(gs.playerId);
  // (On its tick layer: drawn there at its draw tick, a correction eased in (ShipReplicaSet.pose))
  const drawn = player && gs.predictionEnabled && gs.predictedTick > 0 ? gs.ownPose?.(gs.ownDrawTick()) : null;
  if (player && drawn) {
    player.renderX = drawn.x;
    player.renderY = drawn.y;
    player.renderAngle = drawn.angle;
  } else if (player) {
    const prev = gs.selfPrev;
    if (prev && gs.predictionEnabled && gs.predictedTick > 0) {
      // (the same k as ownDrawTick: your shells are drawn at the tick your ship is)
      const k = Math.max(0, Math.min(1, gs.frameTick - gs.predictedTick + 0.5));
      let da = player.angle - prev.angle;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      player.renderX = prev.x + (player.x - prev.x) * k;
      player.renderY = prev.y + (player.y - prev.y) * k;
      player.renderAngle = prev.angle + da * k;
    } else {
      player.renderX += (player.x - player.renderX) * RENDER_SMOOTH_SELF;
      player.renderY += (player.y - player.renderY) * RENDER_SMOOTH_SELF;
      player.renderAngle = player.angle;
    }
  }
}

export function fallbackInterpolate(gs: GameState): void {
  const now = performance.now();
  for (const entity of gs.entities.values()) {
    if (entity.id === gs.playerId) {
      entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_SELF;
      entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_SELF;
      entity.renderAngle = entity.angle;
      continue;
    }
    // Deterministic asteroids still need position updates even in fallback
    if (entity.isDeterministic && entity.orbitType !== undefined) {
      const currentTick = Math.round(gs.getEstimatedServerTick(now));
      const { x, y } = calcAsteroidPosition({
        orbitType: entity.orbitType ?? 0,
        semiMajorAxis: entity.semiMajorAxis ?? 0,
        eccentricity: entity.eccentricity ?? 0,
        argPeriapsis: entity.argPeriapsis ?? 0,
        meanAnomaly0: entity.meanAnomaly0 ?? 0,
        epochTick: entity.epochTick ?? 0,
      }, currentTick);
      entity.x = x;
      entity.y = y;
      entity.renderX = entity.x;
      entity.renderY = entity.y;
      if (entity.type === EntityType.Asteroid) entity.angle = entity.renderAngle = asteroidSpin(entity.id, currentTick);
      continue;
    }
    entity.renderX += (entity.x - entity.renderX) * RENDER_SMOOTH_OTHER;
    entity.renderY += (entity.y - entity.renderY) * RENDER_SMOOTH_OTHER;
    entity.renderAngle = lerpAngle(entity.renderAngle, entity.angle, 0.3);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

/** A pod's hold on a landmark, worked out once an anchor (podHold: the zone its anchor was laid in) */
const POD_CARRY = { x: 0, y: 0 };
const POD_HOLDS = new WeakMap<object, { set: LandmarkSet; x: number; y: number; t: number; hold: PodHold | null }>();
function podHoldOf(entity: object, set: LandmarkSet, x: number, y: number, t: number): PodHold | null {
  let m = POD_HOLDS.get(entity);
  if (!m || m.set !== set || m.x !== x || m.y !== y || m.t !== t) POD_HOLDS.set(entity, (m = { set, x, y, t, hold: podHold(set, x, y, t) }));
  return m.hold;
}
