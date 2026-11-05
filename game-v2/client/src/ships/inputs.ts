/**
 * The client's input sources (sim foundation, Stage 1 section D), over what ShipReplicaSet steps ships with today:
 *
 *  - `OwnInputSource` (known): the own ship's inputs, over its OwnTimeline's control changes (`ctl(t)`, the input message
 *    with that target tick). Held between changes; ask in tick order (each ask for a tick with a change records it).
 *  - `ReplicaRowSource` (assumed): another ship's control rows (`r.events`: changes only), held until the next row;
 *    `confirm(tick)` when a snapshot at that tick has arrived (rows up to it are final).
 *  - `BodyDriverSource` (decided): a BodyRunner driver (CAPS.BODIES): its bits, q and push each tick; where the body is
 *    off (`step` null) the rows fly it, so it answers from `fallback`.
 *
 * Since Stage 3, replication.ts stepPreNow picks through the shared stateless forms of these (common sim/d-sources.ts
 * CtlChangeInputs for own and rows, DriverInputs for a body's driver); these stay for hosts holding a source per ship.
 */

import { DriverInputs, HeldInputs, InputSlots, NO_INPUT } from '@space-game/common';
import type { BodyDriver, InputSource, OwnTimeline, SimInput } from '@space-game/common';

/** What an input message carries besides the held controls (the own client has it; the timeline's ctl does not) */
export interface OwnExtras { jumpDist?: number; fire?: boolean; fireAlt?: boolean; aimDist?: number }

export class OwnInputSource implements InputSource {
  readonly knowledge = 'known' as const;
  private readonly held = new HeldInputs('known');
  private answered = -Infinity;
  constructor(private readonly timeline: Pick<OwnTimeline, 'ctl'>, private readonly extras?: (t: number) => OwnExtras) {}

  inputAt(t: number): SimInput {
    if (t > this.answered) this.answered = t;
    const ev = this.timeline.ctl(t);
    if (ev) {
      const x = this.extras?.(t);
      this.held.hear(t, { bits: ev[0], q: ev[1], jumpDist: x?.jumpDist ?? -1, fire: !!x?.fire, fireAlt: !!x?.fireAlt, aimDist: x?.aimDist ?? 0 });
    }
    return this.held.inputAt(t);
  }

  confirmedThrough(): number { return this.answered; }
}

export class ReplicaRowSource implements InputSource {
  readonly knowledge = 'assumed' as const;
  private readonly held = new HeldInputs('assumed');
  /** A control row: from tick t the ship flies `bits`/`q` */
  hear(t: number, bits: number, q: number): void {
    this.held.hear(t, { ...NO_INPUT, bits, q });
  }
  /** Rows up to `tick` have arrived: those ticks' inputs are final (a changed one re-steps the ship) */
  confirm(tick: number): void { this.held.confirm(tick); }
  prune(tick: number): void { this.held.prune(tick); }
  inputAt(t: number): SimInput { return this.held.inputAt(t); }
  confirmedThrough(): number { return this.held.confirmedThrough(); }
}

/** (common sim/d-sources.ts DriverInputs: stateless since Stage 3, reading the ship's last controls off `prev.ctl`) */
export class BodyDriverSource extends DriverInputs {
  constructor(driver: BodyDriver, fallback: InputSource = new ReplicaRowSource()) {
    super(driver);
    this.fallback = fallback;
  }
}

/** The client's per-ship sources, with the possess hook (an admin's live known source swaps in for the ship's own) */
export function newClientInputSlots(): InputSlots { return new InputSlots(); }
