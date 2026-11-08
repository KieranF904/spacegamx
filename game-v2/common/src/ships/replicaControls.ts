/**
 * Replicated ships' control bits and modes: the leaf the sim reads (sim/*.ts) and replica.ts re-exports, so replica.ts
 * (which delegates its step to the sim) and the sim files do not import each other.
 */

import type { FlightBody, FlightControls } from './flight.js';
import { CTL_NO_BOOST, CTL_POWER_MASK, CTL_SHARE_MASK } from './flight.js';
import { getPlan } from './features/plan.js';

/** How a ship moves */
export enum ReplicaMode {
  /** A pilot's ship (charging fields speed up its jump drive: jumpFields.ts) */
  Player = 0,
  /** Flown by the AI or an autopilot */
  Pilotless = 1,
  /** Debris: drifts */
  Drift = 2,
  /** A wreck held in place: coasts and spins, no gravity */
  Anchored = 3,
  /** Berthed at a station: rides along with it (no physics) */
  Docked = 4,
}

/** Control bits */
export const CTL = {
  forward: 1, backward: 2, left: 4, right: 8, boost: 16, helm: 32, strafeLeft: 64, strafeRight: 128, jump: 256,
  /** EMP'd: the drive crippled (thrust and steering × EMP_CONTROL) */
  emp: 512,
  /** Nobody flying: hold the current heading */
  hold: 1024,
  /** Numb with cold: thrust and steering × the numb stage's (warmth.ts) */
  numb: 2048,
  /** Slowed (a Frostbite beam, features/weaponry: thrust and turning × SLOW_CONTROL, flight.ts withSlowed); pinned in features.wire.json */
  slowed: 4096,
  /** Burst Strafer: dodge held (its way comes from the movement bits): features/strafer, whose input owns it (features.wire.json). (16384 is free) */
  dodge: 8192,
  /** The stores refused a boost this step (flight.ts CTL_NO_BOOST). Above it, from bit 15, the engines' power (flight.ts ctlOfPower) */
  noBoost: CTL_NO_BOOST,
  /** The engines' power (6 bits from bit 15: flight.ts ctlOfPower), a mask */
  power: CTL_POWER_MASK,
  /** What the part features' bursts got (6 bits from bit 21: flight.ts ctlOfShare), a mask */
  share: CTL_SHARE_MASK,
} as const;

export interface ReplicaControls {
  bits: number;
  targetAngle: number;
  /** Where its jump goes (its pilot's cursor distance), where that is known: a pilot's own ship as its client steps it (the server's shadow of it). Else -1 */
  jumpDist?: number;
}

export function controlBits(c: Partial<FlightControls>): number {
  let bits = (c.forward ? CTL.forward : 0) | (c.backward ? CTL.backward : 0) | (c.left ? CTL.left : 0) | (c.right ? CTL.right : 0)
    | (c.boost ? CTL.boost : 0) | (c.helm ? CTL.helm : 0) | (c.strafeLeft ? CTL.strafeLeft : 0) | (c.strafeRight ? CTL.strafeRight : 0)
    | (c.jump ? CTL.jump : 0);
  // (Part features' held inputs with a control bit: the Burst Strafer's dodge, features/plan.ts controls)
  const X = getPlan().controls, held = c as Record<string, unknown>;
  for (let i = 0; i < X.length; i++) if (held[X[i].name]) bits |= X[i].bit;
  return bits;
}

export function flightControls(c: ReplicaControls, body: FlightBody): FlightControls {
  const b = c.bits;
  const out: FlightControls = {
    forward: (b & CTL.forward) !== 0, backward: (b & CTL.backward) !== 0, left: (b & CTL.left) !== 0, right: (b & CTL.right) !== 0,
    boost: (b & CTL.boost) !== 0, helm: (b & CTL.helm) !== 0, strafeLeft: (b & CTL.strafeLeft) !== 0, strafeRight: (b & CTL.strafeRight) !== 0,
    jump: (b & CTL.jump) !== 0,
    targetAngle: (b & CTL.hold) !== 0 ? body.angle : c.targetAngle,
    // Where a jump lands isn't replicated: -1, not known, so the charge waits (flight.ts jumpChargeNeed), and the
    // burn's start brings a keyframe. (The charge's lock, flight.ts FlightBody.jumpAim/jumpTo, is the replica's own,
    // taken on its first charging tick: its heading as the pilot's, its distance -1; a keyframe mid-charge carries both)
    jumpDist: -1,
  };
  // (Part features' held inputs from their control bits: the Burst Strafer's dodge)
  const X = getPlan().controls, held = out as unknown as Record<string, boolean>;
  for (let i = 0; i < X.length; i++) held[X[i].name] = (b & X[i].bit) !== 0;
  return out;
}
