/**
 * The Gyro and the Heavy Gyro (a part: functions `gyro`): reaction wheels. Each adds `gyro` torque per cell (× its
 * output and its power) to the ship's turning caps, both ways alike, wherever it sits on the hull, and pushes nothing.
 * They are mass like any part (models.mjs `massScale`), so they cost a little thrust: the trade-off.
 *
 * Power (the ports core, power/ports.ts): a gyro draws only while the ship's spin changes (turning, or stopping a
 * turn), in proportion. It is a thruster (TK_GYRO) with its own buffer (`intake`, `buffer`, filled over its ports) that
 * burns `demand` a second when the turn takes every bit of the ship's turning force, a tenth of that at a tenth
 * (gyroLoad asks it by part); short of it, its unpaid share of that tick's turn is taken back (index.ts gyroBrownOut;
 * Kieran, 2026-11-06).
 */

import type { FunctionDef, MaterialDef } from '../../types.js';
import type { ShipDerived } from '../../rebuild.js';
import { fnOutput } from '../../grades.js';

/** What a rebuild derives for a ship with gyros (`derived.fx.gyro`) */
export interface GyroInfo {
  /** The working (powered) gyros, by part index */
  parts: number[];
  /** Their torque together (already in derived.maxTorque, both ways) */
  torque: number;
}

declare module '../types.js' {
  interface FeatureDerived { gyro?: GyroInfo }
}

/** One gyro's torque at full power (both ways) */
export function gyroTorque(fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  return (fn.gyro ?? 0) * area * fnOutput(fn, m);
}

/**
 * How much of the gyros' full torque a turn of `alpha` (this tick's change of spin, rad/tick², + clockwise) used: the
 * ship's torque that way did it, every source in proportion, so the gyros spent |alpha| over the cap that way.
 * `scale`: torque → turning acceleration (flight.ts turnScale × hazards)
 */
export function gyroUse(d: ShipDerived, alpha: number, scale: number): number {
  const cap = (alpha > 0 ? d.maxTorque.cw : d.maxTorque.ccw) * scale;
  if (!alpha || !(cap > 0)) return 0;
  const u = Math.abs(alpha) / cap;
  return u < 1 ? u : 1;
}

/** This tick's spin change the gyros gave: `alpha` × their share of the ship's torque that way */
export function gyroPart(d: ShipDerived, alpha: number): number {
  const g = d.fx?.gyro, side = alpha > 0 ? d.maxTorque.cw : d.maxTorque.ccw;
  return g && side > 0 ? (alpha * g.torque) / side : 0;
}

// (Reused every tick: powerTick reads it before the next ship's step writes it again)
let portsAsk = new Float64Array(0);

/**
 * What the gyros ask this tick at `use` of their full torque, by part (the share of each one's burn), or undefined when
 * none draws. The array is module scratch: good until the next call (pass it straight to powerTick).
 */
export function gyroLoad(d: ShipDerived, use: number): ArrayLike<number> | undefined {
  const g = d.fx?.gyro, P = d.ports;
  if (!g || !(use > 0)) return undefined;
  if (portsAsk.length < P.n) portsAsk = new Float64Array(P.n);
  portsAsk.fill(0);
  let any = false;
  for (const p of g.parts) if (P.burn[p] > 0) { portsAsk[p] = use; any = true; }
  return any ? portsAsk : undefined;
}

/** Energy a second the gyros draw turning flat out (for readouts) */
export function gyroDraw(d: ShipDerived): number {
  const g = d.fx?.gyro, P = d.ports;
  if (!g) return 0;
  let e = 0;
  for (const p of g.parts) e += (P.burn[p] * 60) / 256;
  return e;
}
