/**
 * The step's gun phase (Stage 1B owns this file). Runs after the motion, on the moved pose, and returns fire events
 * with deterministic shot ids (events.ts shotId) instead of calling beamFx / scene / gunSync. Stage 0: a stub that
 * fires nothing and leaves `state.guns` as it was.
 */

import type { SimShipState } from './state.js';
import type { SimInput } from './input.js';
import type { SimEnv } from './env.js';
import type { SimEvent } from './events.js';

export function stepShipGuns(_state: SimShipState, _input: Readonly<SimInput>, _env: Readonly<SimEnv>, _events: SimEvent[]): void {
  // Stage 1B: stepGuns on state.guns + structure, payMining, volleyShells -> 'fire' / 'fx' events
}
