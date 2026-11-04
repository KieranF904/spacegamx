/**
 * Adaptive validation, one client's confirmation level (CAPS.ROUGH; docs/design/confirmed-hits.md part E; the levels'
 * rules are common hits.ts CONFIRM_RULES). A finding client's tick-aligned layer is exact by construction, so the
 * check is rough while it keeps agreeing and close once it hasn't:
 *
 *   NORMAL  where every client starts (part D as it was)
 *   ROUGH   after CLEAN_TICKS at NORMAL with no disagreement: a report a second, judged that much later
 *   STRICT  after any correction (hitFix), at any level: every hit told, two ticks more delay
 *
 * A level steps down one after CLEAN_TICKS with no disagreement at it (STRICT -> NORMAL -> ROUGH); a disagreement
 * starts the stretch again. A change takes effect at a snapshot's end, on both sides at once (HitLedger.endSnapshot
 * sends netCaps.lvl), as a caps switch does. Without ROUGH a client stays NORMAL.
 *
 * Three numbers a client: what the server keeps beyond part D's journal.
 */
import { CONFIRM, confirmRules, type ConfirmRules } from '@space-game/common';

/** Ticks with no disagreement before a level steps down (10 s) */
export const CLEAN_TICKS = 600;

export class ConfirmLevel {
  /** The level in effect (its rules: `rules`) */
  level: number = CONFIRM.NORMAL;
  /** The level from the next snapshot on (endSnapshot applies it) */
  private next: number = CONFIRM.NORMAL;
  /** When the clean stretch at this level began (the level's start, or its last disagreement) */
  private since: number;
  /** Changes, [tick, level] (the probe, tests; the last 64) */
  readonly history: [number, number][] = [];

  constructor(now: number, readonly adaptive: boolean) {
    this.since = now;
  }

  get rules(): ConfirmRules {
    return confirmRules(this.level);
  }

  /** A judging disagreed (not yet a correction): the clean stretch starts again */
  disagreed(now: number): void {
    this.since = now;
  }

  /** A correction went: STRICT from the next snapshot */
  corrected(now: number): void {
    if (!this.adaptive) return;
    this.next = CONFIRM.STRICT;
    this.since = now;
  }

  /** Each snapshot: a clean stretch long enough steps it down a level (from the next snapshot) */
  step(now: number): void {
    if (!this.adaptive || this.next !== this.level || this.level === CONFIRM.ROUGH) return;
    if (now - this.since >= CLEAN_TICKS) this.next = this.level - 1;
  }

  /** At a snapshot's end: the next level takes effect. True if it changed (the client is told) */
  apply(now: number): boolean {
    if (this.next === this.level) return false;
    this.level = this.next;
    this.since = now;
    this.history.push([now, this.level]);
    if (this.history.length > 64) this.history.shift();
    return true;
  }
}
