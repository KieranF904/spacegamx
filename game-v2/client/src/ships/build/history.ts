/**
 * @contract client.ships.build-history
 * owns:       the undo / redo history both build editors keep: whole-design snapshots, a cap, and one step per drag
 * needs:      nothing (generic over the snapshot type; no DOM, no editor state)
 * invariants: undo returns the design as it stood before the last step and redo the one after it, in order — client/src/ships/build/history.test.ts
 *             a new edit drops the redo steps — client/src/ships/build/history.test.ts
 *             a drag (begin .. end) is one step, and an edit that changed nothing is none — client/src/ships/build/history.test.ts
 *             the oldest steps fall off past the cap — client/src/ships/build/history.test.ts
 * extend:     an editor snapshots its state (its parts, or its pending edits), records each edit with record(), wraps a drag in begin()/end()
 */

/** Steps kept per session (a design is small, so a snapshot each is cheap) */
export const HISTORY_CAP = 100;

export class History<S> {
  private past: S[] = [];
  private future: S[] = [];
  private group: { at: S } | null = null;

  /**
   * `same`: are two snapshots one design (an edit that changed nothing is no step). Snapshots must be private copies
   * of the live state, never the live objects
   */
  constructor(private same: (a: S, b: S) => boolean, private cap = HISTORY_CAP) {}

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get size(): number { return this.past.length; }

  /** One edit done: `before` is the snapshot taken ahead of it, `after` the one now. Inside a begin()..end() group it is part of that step */
  record(before: S, after: S): void {
    if (this.group) return;
    this.push(before, after);
  }

  /** A drag starts: the edits until end() are one step (a second begin() while one is open is ignored) */
  begin(now: S): void {
    if (!this.group) this.group = { at: now };
  }

  /** The drag ends: its step is recorded if it changed anything */
  end(now: S): void {
    const start = this.group;
    this.group = null;
    if (start) this.push(start.at, now);
  }

  get grouping(): boolean { return this.group !== null; }

  /** The design to go back to (null: nothing to undo). `now` is kept for redo */
  undo(now: S): S | null {
    this.group = null;
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(now);
    return prev;
  }

  /** The design to go forward to (null: nothing to redo) */
  redo(now: S): S | null {
    this.group = null;
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(now);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
    this.group = null;
  }

  private push(before: S, after: S): void {
    if (this.same(before, after)) return;
    this.past.push(before);
    if (this.past.length > this.cap) this.past.shift();
    this.future = [];
  }
}
