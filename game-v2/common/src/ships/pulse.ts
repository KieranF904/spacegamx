/**
 * Pulse lasers: a beam weapon (tuning type 'beam') with a `pulse` block. It
 * charges like a gun reloads (its fireInterval, paid for from the batteries
 * as one shot: guns.ts), and when it's charged and the trigger's held it
 * fires one pulse of `ticks` ticks along its aim, in three phases:
 *
 *   ramp  the beam fades in from nothing: narrow, little damage
 *   peak  one instant (`peakAt` of the way through): the widest beam, the
 *         biggest share of the damage, a flash at both ends
 *   tail  it trails back off to narrow, low and gone
 *
 * The pulse's damage (tuning `damage`, per pulse) is shared out over its ticks
 * by the curve (as its brightness squared), and its width (`width`, at the
 * peak) follows it too. The server burns along the beam each tick of it
 * (ShipBridge.fireBeam); clients
 * draw the same curve from the tick it started (a fire event with no shells),
 * so the bright instant lands where the damage does. No heat: the charge is
 * the limit.
 */

import type { WeaponTuning } from './tuning.js';

export interface PulseTuning {
  /** How long a pulse lasts */
  ticks: number;
  /** Where its peak falls, as a fraction of the way through (0..1) */
  peakAt: number;
}

export interface PulseProfile {
  ticks: number;
  /** The tick of the peak */
  peak: number;
  /** Brightness by tick (0..1: 1 at the peak) */
  intensity: number[];
  /** Share of the pulse's damage dealt on each tick (they sum to 1) */
  share: number[];
  /** Beam width by tick, as a fraction of its peak width */
  width: number[];
}

/** How bright a pulse is `age` ticks in (fractions between ticks interpolate; 0 before it starts and after it ends) */
export function pulseIntensity(p: PulseProfile, age: number): number {
  if (age < 0 || age >= p.ticks) return 0;
  const i = Math.floor(age), f = age - i;
  return p.intensity[i] * (1 - f) + (p.intensity[i + 1] ?? 0) * f;
}

/** A beam's narrowest, against its peak width */
const MIN_WIDTH = 0.18;

const profiles = new WeakMap<PulseTuning, PulseProfile>();

/** A pulse laser's curve (the same object each time for the same tuning) */
/** A mining laser's pulse: its length is MINE_CYCLE (energy.ts); it cuts hardest at the flare, and the client draws the same curve */
export const MINING_PULSE: PulseTuning = { ticks: 54, peakAt: 0.4 };

/** A mining laser reaches this much further than its range, fading out (and mining less) over the extra */
export const MINE_TAIL = 0.4;

/** A mining beam's strength at `dist` along it, given its full-strength `range`: 1 out to it, then trailing off to nothing at range × (1 + MINE_TAIL) */
export function mineFalloff(dist: number, range: number): number {
  if (dist <= range) return 1;
  const x = (dist - range) / Math.max(1, range * MINE_TAIL);
  return x >= 1 ? 0 : (1 - x) * (1 - x);
}

export function pulseProfile(pulse: PulseTuning): PulseProfile {
  let out = profiles.get(pulse);
  if (out) return out;
  const ticks = Math.max(3, Math.round(pulse.ticks));
  const peak = Math.max(1, Math.min(ticks - 2, Math.round(ticks * pulse.peakAt)));
  const intensity: number[] = [];
  for (let k = 0; k < ticks; k++) {
    if (k < peak) {
      // Ramp: fades in from nothing to a fifth of the peak, then a quick swell into it
      const x = (k + 1) / (peak + 1);
      intensity.push(Math.max(0.22 * x * x, k === peak - 1 ? 0.45 : 0));
    } else if (k === peak) intensity.push(1);
    else {
      // Tail: from a flare just after the peak back down to nothing
      const y = (k - peak) / (ticks - peak);
      intensity.push(k === peak + 1 ? 0.5 : 0.3 * Math.pow(1 - y, 1.6));
    }
  }
  // Damage goes as the brightness squared: the flare carries nearly half of it, the fade in and out the rest
  const total = intensity.reduce((a, b) => a + b * b, 0);
  out = { ticks, peak, intensity, share: intensity.map((v) => (v * v) / total), width: intensity.map((v) => MIN_WIDTH + (1 - MIN_WIDTH) * v) };
  profiles.set(pulse, out);
  return out;
}

/**
 * A beam's damage × this at `dist` along it. With a `falloff` (tuning), it
 * burns at full strength out to its effective range (`start` of its range),
 * then tails off steeply, to `floor` at its full range; beyond, nothing.
 */
export function beamFalloff(def: WeaponTuning | undefined, dist: number): number {
  // (Braced by an anchor it reaches further, its falloff stretched with it: anchor.ts)
  const range = (def?.range ?? 800) * (def?.reach ?? 1);
  if (dist > range + 1e-6) return 0;
  const f = def?.falloff;
  if (!f) return 1;
  const eff = range * f.start;
  if (dist <= eff) return 1;
  const x = Math.min(1, (dist - eff) / Math.max(1, range - eff));
  return f.floor + (1 - f.floor) * (1 - x) * (1 - x);
}

/** A beam's effective range: where its falloff starts (its whole range without one) */
export function effectiveRange(def: WeaponTuning | undefined): number {
  return (def?.range ?? 800) * (def?.falloff?.start ?? 1);
}

/** Is this weapon a pulse laser (a beam that fires in pulses) */
export function isPulse(def: WeaponTuning | undefined): boolean {
  return def?.type === 'beam' && !!def.pulse;
}
