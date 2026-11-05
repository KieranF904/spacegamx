/**
 * The step's pull phase (Stage 1C owns this file): env.pulls' forces added to the velocity after the motion,
 * quantised as today's pilot pushes are (ownTick.ts quantizePull), each with a 'pull' event. Stage 0: applies what a
 * PullSource gives (none is wired yet), so the harness can already exercise it.
 */

import { quantizePull } from '../network/ownTick.js';
import type { SimShipState } from './state.js';
import type { SimEnv } from './env.js';
import type { SimEvent } from './events.js';

export function applyPulls(state: SimShipState, env: Readonly<SimEnv>, events: SimEvent[]): void {
  const src = env.pulls;
  if (!src) return;
  const list = src.on(state.id, env.tick, state.body);
  for (let i = 0; i < list.length; i++) {
    const [from, ax, ay] = list[i];
    const dvx = quantizePull(ax), dvy = quantizePull(ay);
    if (dvx === 0 && dvy === 0) continue;
    state.body.vx += dvx;
    state.body.vy += dvy;
    events.push({ k: 'pull', tick: env.tick, target: state.id, from, dvx, dvy });
  }
}
