/**
 * Shared pieces of the input sources (sim foundation, Stage 1 section D): the plumbing the server's and the client's
 * adapters (server/src/ships/bridge/inputs.ts, client/src/ships/inputs.ts) and the bots (server/src/bots) build on. Since
 * Stage 3 the client's replica set (network/replication.ts stepPreNow) picks each ship's input through
 * CtlChangeInputs (own timeline: known; control rows: assumed) and DriverInputs (a body's driver: decided).
 */

import { controlBits, flightControls } from '../ships/replica.js';
import type { FlightBody, FlightControls } from '../ships/flight.js';
import type { BodyDriver } from '../network/replication.js';
import { quantizeCursorDist } from '../network/protocol.js';
import { NO_INPUT, simAimQ, type InputKnowledge, type InputPrev, type InputSource, type SimInput } from './input.js';

/** A SimInput from held flight controls (their `targetAngle` onto the grid), as controlBits/simAimQ have them */
export function inputOfControls(
  c: Partial<FlightControls> & { targetAngle: number },
  extra: { jumpDist?: number; fire?: boolean; fireAlt?: boolean; aimDist?: number; impulse?: readonly [number, number] } = {},
): SimInput {
  const out: SimInput = {
    bits: controlBits(c), q: simAimQ(c.targetAngle), jumpDist: extra.jumpDist ?? -1,
    fire: !!extra.fire, fireAlt: !!extra.fireAlt, aimDist: extra.aimDist ?? 0,
  };
  if (extra.impulse) out.impulse = extra.impulse;
  return out;
}

/** A SimInput's held controls (the other direction of inputOfControls; the aim is left to simAim(input.q)) */
export function controlsOfInput(input: Readonly<SimInput>, body: { angle: number }): FlightControls {
  return flightControls({ bits: input.bits, targetAngle: 0 }, body as never);
}

/** A cursor distance (world units) as SimInput.aimDist has it */
export const aimDistOf = (d: number): number => quantizeCursorDist(d);

/**
 * A source that answers from a function (a decided source: an AI order, a bot's controls). Remembers the last tick it
 * answered for: that is as far as it is final.
 */
export class FnInputs implements InputSource {
  private answered = -Infinity;
  constructor(readonly knowledge: InputKnowledge, private readonly fn: (t: number, prev: InputPrev) => SimInput) {}
  inputAt(t: number, prev: InputPrev): SimInput {
    if (t > this.answered) this.answered = t;
    return this.fn(t, prev);
  }
  confirmedThrough(): number { return this.answered; }
}

/**
 * The held-last-input source: another pilot's inputs as last heard, held until the next is heard (`assumed`), final up to
 * the tick a row confirmed (`confirm`). `hear` records the change that took effect on tick t (control rows are changes
 * only, so a tick without one flies the last). Answers any tick again: rollback safe.
 */
export class HeldInputs implements InputSource {
  private readonly ticks: number[] = [];
  private readonly at = new Map<number, SimInput>();
  private through = -Infinity;

  constructor(readonly knowledge: InputKnowledge = 'assumed', private readonly base: Readonly<SimInput> = NO_INPUT) {}

  /** The input that took effect on tick t */
  hear(t: number, input: SimInput): void {
    if (!this.at.has(t)) {
      const n = this.ticks.length;
      this.ticks.push(t);
      if (n && this.ticks[n - 1] > t) this.ticks.sort((a, b) => a - b);
    }
    this.at.set(t, input);
  }

  /** Every tick up to `t` is final (a row/snapshot at t has arrived) */
  confirm(t: number): void { if (t > this.through) this.through = t; }

  inputAt(t: number): SimInput {
    const k = this.ticks;
    let lo = 0, hi = k.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (k[m] <= t) lo = m + 1; else hi = m; }
    return lo ? this.at.get(k[lo - 1])! : (this.base as SimInput);
  }

  confirmedThrough(): number { return this.through; }

  /** Forget what took effect before tick t (keeping the one in force at t) */
  prune(t: number): void {
    const k = this.ticks;
    let i = 0;
    while (i + 1 < k.length && k[i + 1] <= t) { this.at.delete(k[i]); i++; }
    if (i) k.splice(0, i);
  }
}

/** Where a ship's control changes are held: the [bits, q] that took effect on tick t, if one did */
export type CtlChanges = (t: number) => readonly [number, number] | undefined;

/**
 * Controls that change only where a change took effect (control rows; the own timeline's input messages) and are
 * otherwise held: what the ship flew tick t - 1 with, read off the ship itself (`prev.ctl`). Stateless, so a rollback's
 * re-ask answers the same. The answer is a scratch object, read at once (the replica set's stepPreNow)
 */
export class CtlChangeInputs implements InputSource {
  private through = -Infinity;
  private readonly out: SimInput = { ...NO_INPUT };
  constructor(readonly knowledge: InputKnowledge, private readonly changes: CtlChanges) {}

  inputAt(t: number, prev: InputPrev): SimInput {
    const ev = this.changes(t), o = this.out;
    o.bits = ev ? ev[0] : prev.ctl.bits;
    o.q = ev ? ev[1] : prev.ctl.q;
    return o;
  }

  /** Every change up to tick t has arrived */
  confirm(t: number): void { if (t > this.through) this.through = t; }
  confirmedThrough(): number { return this.through; }
}

/**
 * A ship flown by a driver (decided: a BodyRunner's, CAPS.BODIES): its controls and push each tick, from the ship
 * before it (`prev`, its body and controls: no memory here, rollback safe); where it doesn't fly the ship (null), the
 * fallback answers (the ship's rows; set by the caller before asking). The answer is a scratch object, read at once
 */
export class DriverInputs implements InputSource {
  readonly knowledge = 'decided' as const;
  /** Who answers where the driver doesn't fly the ship (none: it holds its last controls) */
  fallback: InputSource | null = null;
  private answered = -Infinity;
  private readonly out: SimInput = { ...NO_INPUT };
  private readonly push: [number, number] = [0, 0];
  constructor(readonly driver: BodyDriver) {}

  inputAt(t: number, prev: InputPrev): SimInput {
    if (t > this.answered) this.answered = t;
    const by = this.driver.step(t, prev.body as FlightBody, prev.ctl.q, prev.ctl.bits);
    const o = this.out;
    if (!by) {
      if (this.fallback) return this.fallback.inputAt(t, prev);
      o.bits = prev.ctl.bits; o.q = prev.ctl.q; o.impulse = undefined;
      return o;
    }
    o.bits = by.bits; o.q = by.q;
    this.push[0] = by.ix; this.push[1] = by.iy;
    o.impulse = this.push;
    return o;
  }

  confirmedThrough(): number { return this.answered; }
}
