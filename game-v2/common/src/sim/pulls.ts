/**
 * The step's pull phase: env.pulls' forces added to the velocity after the motion, before any of the tick's causes,
 * each put on the PULL grid (ownTick.ts quantizePull) and the velocity back on its own grid at once (addPull), each with
 * a 'pull' event. Where they come from: sim/pullFields.ts (fields both ends work out), or pulls the server told for that
 * tick (a client's source hands those in their place: they are the same pushes, from the same step).
 *
 * Every pull on a pilot goes through addPull, wherever it is applied (this phase, the server's push of a pull only it
 * works out, a shadow's told pull rows): the same arithmetic in the same order on every end.
 */

import { quantizePull, addPull } from '../network/ownTick.js';
import type { SimShipState } from './state.js';
import type { SimEnv } from './env.js';
import type { SimEvent } from './events.js';

export function applyPulls(state: SimShipState, env: Readonly<SimEnv>, events: SimEvent[]): void {
  stepPulls(state.id, state.body, env, events);
}

/** The pull phase on a body (replicaStep's view has no id of its own: the caller gives it) */
export function stepPulls(id: number, body: SimShipState['body'], env: Readonly<SimEnv>, events?: SimEvent[]): void {
  const src = env.pulls;
  if (!src) return;
  const list = src.on(id, env.tick, body);
  for (let i = 0; i < list.length; i++) {
    const [from, ax, ay] = list[i];
    const dvx = quantizePull(ax), dvy = quantizePull(ay);
    if (dvx === 0 && dvy === 0) continue;
    addPull(body, dvx, dvy);
    events?.push({ k: 'pull', tick: env.tick, target: id, from, dvx, dvy });
  }
}
