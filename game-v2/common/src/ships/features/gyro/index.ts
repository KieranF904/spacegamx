/**
 * @contract feature.gyro.common
 * owns:       the Gyro and Heavy Gyro part feature, shared half: turn torque a rebuild derives and three flight hooks
 *             that draw power only while the ship turns
 * needs:      PartFeature, FlightCtx (types.ts), flight.ts turnScale / wrapAngle, gyro/gyro.ts
 * events:     flight hooks at preJump, thrustGate and impulse
 * invariants: the feature is in the registry, its folder matches its id and its wire slots and input bits are the
 *             pinned ones (none dropped) — common/src/ships/features/gyro/contract.test.ts
 *             a ship without the part carries nothing of the feature, and facts are finite, labelled and repeat
 *             exactly — common/src/ships/features/gyro/contract.test.ts
 * extend:     a new flight behaviour is a hook entry in the feature object below (phases: plan.ts FLIGHT_PHASES)
 */

/**
 * The Gyro and Heavy Gyro as a part feature (features/README.md; the part and its arithmetic: gyro.ts). Shared half
 * only: what a rebuild derives (its torque goes into the ship's turning caps through DeriveCtx.turn) and three flight
 * hooks that make it draw power only while the ship turns. No input, no wire slot, no server or client half.
 *
 * (No imported value is used at module scope here: flight.ts, rebuild.ts and energy.ts reach this file through the plan.)
 */

import type { FlightCtx, PartFeature } from '../types.js';
import { turnScale, wrapAngle } from '../../flight.js';
import { gyroLoad, gyroPart, gyroTorque, gyroUse } from './gyro.js';

const n0 = (v: number) => Math.round(v).toLocaleString('en-GB');

/** preJump: the spin before the ship turns this tick */
function gyroBefore(c: FlightCtx): void {
  if (c.d.fx?.gyro) c.scratch.gyroW = c.body.angVel;
}

/** thrustGate (after the turn): ask power for the share of the gyros' torque this tick's turn used */
function gyroAsk(c: FlightCtx): void {
  c.scratch.gyroAlpha = 0;
  const d = c.d;
  if (!d.fx?.gyro || !(d.inertia > 0)) return;
  const alpha = c.body.angVel - (c.scratch.gyroW as number);
  // (A replica asks nothing, but browns out by the share its control bits carry, as the ship did: flight.ts shareOfCtl)
  if (!c.accounted) { if (c.replay) c.scratch.gyroAlpha = gyroPart(d, alpha); return; }
  const use = gyroUse(d, alpha, turnScale(d, c.cargo) * (c.k.hazard?.control ?? 1));
  const l = gyroLoad(d, use);
  if (!l) return;
  c.load[c.feature] = l;
  c.loads++;
  c.scratch.gyroAlpha = gyroPart(d, alpha);
}

/** impulse: short of power, the gyros' unpaid share of this tick's turn is taken back */
function gyroBrownOut(c: FlightCtx): void {
  const a = c.scratch.gyroAlpha as number;
  if (!a) return;
  const share = c.shares?.[c.feature] ?? 1;
  if (share >= 1) return;
  const undo = a * (1 - share);
  c.body.angVel -= undo;
  c.body.angle = wrapAngle(c.body.angle - undo);
}

export const feature: PartFeature = {
  id: 'gyro',
  applies: (fn) => (fn.gyro ?? 0) > 0,
  // (After the others: feature numbers follow (order, id), so theirs do not move)
  order: 60,
  // It draws by the tick, only while the ship turns, and Drive Cell banks touching it feed it as they do engines
  burst: 'engine',
  derive(c) {
    let torque = 0;
    const parts: number[] = [];
    for (const i of c.parts) {
      if (c.satisfaction[i] <= 0) continue;
      parts.push(i);
      torque += gyroTorque(c.fns[i], c.area[i], c.mats[i]) * c.satisfaction[i];
    }
    if (!parts.length) return;
    torque = Math.round(torque * 1000) / 1000;
    c.out.gyro = { parts, torque };
    c.turn.torque += torque;
  },
  // (Replicas fly on derived.maxTorque, already in the flight signature; the hooks only act on a ship whose power is accounted)
  flight: [
    { phase: 'preJump', order: 0, step: gyroBefore },
    { phase: 'thrustGate', order: 0, step: gyroAsk },
    { phase: 'impulse', order: 0, step: gyroBrownOut },
  ],
  describe({ fn, mat, area }) {
    const t = gyroTorque(fn, area ?? 1, mat);
    return [{
      feature: 'gyro', key: 'torque', label: 'Turning force', value: Math.round(t), tier: 'stat',
      sentence: `adds ${n0(t)} turning force anywhere on the hull; draws power only while turning`,
      dim: 'no push of its own; heavier than plain hull',
      short: `+${n0(t)} turning force`,
      chip: `+${n0(t)} turning`,
      drawWhen: 'turning',
    }];
  },
};
