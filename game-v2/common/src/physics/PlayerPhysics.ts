/**
 * Shared Player Physics - Used by both client prediction and server simulation
 * 
 * CRITICAL: This file must be identical on client and server to prevent desync.
 * Any changes here affect both prediction and authoritative simulation.
 * 
 * All state values are quantized to BitBuffer precision to ensure determinism.
 */

import { ACCEL_BASE, FRICTION, BOOST_FACTOR, TURN_SPEED, WORLD_SIZE } from '../constants.js';
import { 
  quantizePosition, 
  quantizeVelocity, 
  quantizeAngle,
  quantizeBoost,
  normalizeAngle,
} from '../networking/Precision.js';

/**
 * Minimal player state needed for physics simulation
 */
export interface PhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

/**
 * Input state for physics step
 */
export interface PhysicsInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  boost: boolean;
  targetAngle: number;
}

/**
 * Boost state for fuel consumption
 */
export interface BoostState {
  fuel: number;
  drainRate: number;
}

/**
 * Result of physics step including updated boost fuel
 */
export interface PhysicsStepResult {
  state: PhysicsState;
  boostFuel: number;
  isBoosting: boolean;
}

/**
 * Apply one tick of player physics
 * 
 * @param state Current physics state (will be mutated)
 * @param input Player input for this tick
 * @param boost Boost state (fuel will be consumed if boosting)
 * @param accelMultiplier Equipment acceleration multiplier (default 1.0)
 * @returns Physics step result with updated state and boost info
 * 
 * NOTE: All output values are quantized to BitBuffer precision for determinism.
 */
export function stepPlayerPhysics(
  state: PhysicsState,
  input: PhysicsInput,
  boost: BoostState,
  accelMultiplier: number = 1.0
): PhysicsStepResult {
  // --- Rotation ---
  let currentAngle = state.angle;
  let angleDiff = normalizeAngle(input.targetAngle - currentAngle);
  
  // Apply turn speed limit
  if (Math.abs(angleDiff) > TURN_SPEED) {
    currentAngle += Math.sign(angleDiff) * TURN_SPEED;
  } else {
    currentAngle = input.targetAngle;
  }
  // Quantize angle to network precision
  state.angle = quantizeAngle(currentAngle);
  
  // --- Thrust calculation ---
  let thrustX = 0;
  let thrustY = 0;
  
  if (input.forward) thrustY -= 1;
  if (input.backward) thrustY += 1;
  if (input.left) thrustX -= 1;
  if (input.right) thrustX += 1;
  
  // Normalize diagonal movement to prevent faster diagonal speed
  const thrustMag = Math.sqrt(thrustX * thrustX + thrustY * thrustY);
  if (thrustMag > 0) {
    thrustX /= thrustMag;
    thrustY /= thrustMag;
  }
  
  // --- Acceleration with boost ---
  let accel = ACCEL_BASE * accelMultiplier;
  let isBoosting = false;
  let newBoostFuel = boost.fuel;
  
  if (input.boost && boost.fuel > 0 && thrustMag > 0) {
    accel *= BOOST_FACTOR;
    newBoostFuel = Math.max(0, boost.fuel - boost.drainRate);
    isBoosting = true;
  }
  
  // --- Apply forces ---
  state.vx += thrustX * accel;
  state.vy += thrustY * accel;
  
  // --- Friction ---
  state.vx *= FRICTION;
  state.vy *= FRICTION;
  
  // Quantize velocity to network precision
  state.vx = quantizeVelocity(state.vx);
  state.vy = quantizeVelocity(state.vy);
  
  // --- Position update ---
  state.x += state.vx;
  state.y += state.vy;
  
  // --- World bounds ---
  state.x = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, state.x));
  state.y = Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, state.y));
  
  // Quantize position to network precision
  state.x = quantizePosition(state.x);
  state.y = quantizePosition(state.y);
  
  // Quantize boost fuel
  newBoostFuel = quantizeBoost(newBoostFuel);
  
  return {
    state,
    boostFuel: newBoostFuel,
    isBoosting,
  };
}

/**
 * Calculate thrust direction from input (normalized)
 */
export function getThrustDirection(input: PhysicsInput): { x: number; y: number; magnitude: number } {
  let x = 0;
  let y = 0;
  
  if (input.forward) y -= 1;
  if (input.backward) y += 1;
  if (input.left) x -= 1;
  if (input.right) x += 1;
  
  const magnitude = Math.sqrt(x * x + y * y);
  if (magnitude > 0) {
    x /= magnitude;
    y /= magnitude;
  }
  
  return { x, y, magnitude };
}

/**
 * Clamp position to world bounds
 */
export function clampToWorld(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, x)),
    y: Math.max(-WORLD_SIZE, Math.min(WORLD_SIZE, y)),
  };
}
