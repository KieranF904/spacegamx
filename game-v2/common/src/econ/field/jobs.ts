/**
 * A field machine's job and how it progresses (docs/design/field-fabrication.md, "Jobs"). A fabricator's build runs in
 * two phases, MAKE then ATTACH, so a hold full of finished parts can't mend a ship at once: a part taken from the hold
 * starts at ATTACH. Repairs, recycles and refining have only MAKE.
 *
 * Progress is in units the machine's own clock gives: eu taken in for a powered machine (PortsState.machEu: the power
 * it gets is its speed), ticks for the core's. Both sides step the same arithmetic, so the server sends a job only when
 * it starts, finishes or is called off (a decision or a rare event), never its progress; the client works progress out
 * from its own counter (jobAt).
 */

import type { Bag } from '../stacks.js';

/** (`rearm`: refill a Mine Bay's magazine, `uid` the bay, `count` the mines: rules.ts REARM) */
export type FieldJobKind = 'build' | 'repair' | 'recycle' | 'refine' | 'rearm';
export type FieldJobPhase = 'make' | 'attach' | 'done';

export interface FieldJob {
  /** Unique on the ship (server-chosen) */
  id: number;
  kind: FieldJobKind;
  /** The blueprint uid it is for: a build's planned spot, a repair's or recycle's part. Absent: refining */
  uid?: number;
  /** What it makes: a part item id (build), a refined item (refine) */
  item?: string;
  /** A refine's recipe id, and batches */
  recipe?: string;
  /** A rearm's mines */
  count?: number;
  /** Inputs taken from the hold at its start and held in the machine (given back, or kept in it, if called off) */
  held: Bag;
  /** MAKE: units needed and done */
  need: number;
  done: number;
  /** ATTACH (builds only): units needed and done */
  attachNeed: number;
  attachDone: number;
  phase: FieldJobPhase;
  /** The share of its units packs paid (it went faster by it: rules.ts jobTicks) */
  packShare: number;
}

/** Add `units` of progress; returns what is left over once the job is done (0 while it runs) */
export function stepJob(job: FieldJob, units: number): number {
  let u = units > 0 ? units : 0;
  if (job.phase === 'make') {
    const k = Math.min(u, job.need - job.done);
    job.done += k; u -= k;
    if (job.done >= job.need) job.phase = job.attachNeed > 0 ? 'attach' : 'done';
  }
  if (job.phase === 'attach') {
    const k = Math.min(u, job.attachNeed - job.attachDone);
    job.attachDone += k; u -= k;
    if (job.attachDone >= job.attachNeed) job.phase = 'done';
  }
  return job.phase === 'done' ? u : 0;
}

/** Progress 0..1 over both phases */
export function jobFraction(job: Readonly<FieldJob>): number {
  const all = job.need + job.attachNeed;
  return all > 0 ? Math.min(1, (job.done + job.attachDone) / all) : 1;
}

/**
 * A job as it stands now, from a copy sent at a known reading of the machine's clock (`at`: machEu or the tick then)
 * and its reading now: what the client shows between the server's events
 */
export function jobAt(sent: Readonly<FieldJob>, at: number, now: number): FieldJob {
  const j: FieldJob = { ...sent, held: { ...sent.held } };
  stepJob(j, now - at);
  return j;
}
