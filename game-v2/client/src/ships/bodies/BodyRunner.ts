/**
 * Bosses flown by their bodies on this client's tick-aligned layer (CAPS.BODIES; common bodies/, docs/design/
 * decision-inputs.md). The server's brain decides; its decisions come in each snapshot's `decisions` rows, each at its
 * tick, and the boss's replica is stepped from its body (common bodies/stagedFlight.ts) instead of control rows: the
 * same controls and drive push the server's step had, from the same decisions and the same replicas.
 *
 *   SYNC   the whole body state at a tick, with a keyframe of the boss: it runs from there
 *   OFF    it stops (the rows fly it again: the server sends them)
 *   other  folded in at their tick (bodies/decisions.ts applyDecision); a tick already stepped is stepped again
 *
 * Its target is read as the server's step reads it: after the target's own step, before that tick's pulls and contacts
 * (ShipReplicaSet.preAt). Each snapshot the bodies are stepped again from just after the one before (what they read of
 * other ships through that window is final only now). Its check (takeCheck): the low byte of the sum of every body's
 * hash at the last snapshot's tick, on an input that goes anyway, every CHECK_EVERY ticks at most.
 */
import {
  DECISION, BODY_KINDS, applyDecision, bodyStateOfSync, cloneBodyState, stagedFlight, bodyHash, bodyCheckByte,
  type BodyState, type BodyDriver, type ShipReplicaSet, type FlightBody,
} from '@space-game/common';

/** Ticks between its checks (riding an input) */
const CHECK_EVERY = 30;
/** Ticks of states and decisions kept */
const KEEP_TICKS = 600;

export interface BodyRunnerHost {
  reps: ShipReplicaSet;
}

interface Run {
  /** Decisions by tick ([op, ...args]), after its SYNC */
  log: Map<number, number[][]>;
  /** Its state as of each tick stepped */
  states: Map<number, BodyState>;
  syncTick: number;
}

export class BodyRunner {
  on = false;
  private readonly runs = new Map<number, Run>();
  private snapTick = -Infinity;
  private lastCheck = { tick: -Infinity, snap: -Infinity };
  readonly stats = { syncs: 0, offs: 0, decisions: 0, blind: 0, checks: 0 };

  constructor(private readonly host: BodyRunnerHost) {}

  /** Switched on or off (netCaps): off, every boss goes back to its rows */
  setOn(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    if (!on) for (const id of [...this.runs.keys()]) this.stop(id);
  }

  /** Bosses it runs now */
  ids(): IterableIterator<number> {
    return this.runs.keys();
  }

  /** A snapshot's decisions, after its keyframes and rows went in (ShipReplicaSet.apply) */
  onSnapshot(tick: number, rows: readonly (readonly number[])[] | undefined): void {
    const prev = this.snapTick;
    this.snapTick = tick;
    if (!this.on) return;
    for (const row of rows ?? []) {
      const [id, dt, op] = row, t = tick + dt, args = row.slice(3);
      if (op === DECISION.SYNC) {
        const run: Run = { log: new Map(), states: new Map([[t, bodyStateOfSync(args, t)]]), syncTick: t };
        this.runs.set(id, run);
        this.host.reps.setDriver(id, this.driver(id, run));
        this.stats.syncs++;
        continue;
      }
      const run = this.runs.get(id);
      if (!run || t <= run.syncTick) continue;
      // (Its OFF for this client: the rows fly it from here)
      if (op === DECISION.OFF && dt === 0 && t === tick) { this.stop(id); this.stats.offs++; continue; }
      let at = run.log.get(t);
      if (!at) run.log.set(t, (at = []));
      at.push([op, ...args]);
      this.stats.decisions++;
      this.rewind(id, run, t);
    }
    // (What it read of other ships through the last window is final only now: stepped again from just after the last snapshot)
    for (const [id, run] of this.runs) {
      this.rewind(id, run, Math.max(prev + 1, run.syncTick + 1));
      for (const k of run.log.keys()) if (k < tick - KEEP_TICKS) run.log.delete(k);
    }
  }

  /** A ship gone (removed, out of view) */
  remove(id: number): void {
    if (this.runs.has(id)) this.stop(id);
  }

  private stop(id: number): void {
    this.runs.delete(id);
    this.host.reps.setDriver(id, null);
  }

  private rewind(id: number, run: Run, t: number): void {
    for (const k of [...run.states.keys()]) if (k >= t && k !== run.syncTick) run.states.delete(k);
    this.host.reps.rewind(id, t);
  }

  /** Its body state at tick t: the last one worked out at or before it, with the decisions since folded in */
  private stateAt(run: Run, t: number): BodyState | null {
    const have = run.states.get(t);
    if (have) return have;
    if (t < run.syncTick) return null;
    let from = t - 1;
    while (from >= run.syncTick && !run.states.has(from)) from--;
    const base = run.states.get(from);
    if (!base) return null;
    let s = base;
    for (let k = from + 1; k <= t; k++) {
      s = cloneBodyState(s);
      for (const d of run.log.get(k) ?? []) applyDecision(s, d[0], d.slice(1), k);
      run.states.set(k, s);
    }
    for (const k of run.states.keys()) if (k < t - KEEP_TICKS && k !== run.syncTick) run.states.delete(k);
    return s;
  }

  private driver(id: number, run: Run): BodyDriver {
    return {
      step: (t: number, prev: FlightBody) => {
        const s = this.stateAt(run, t);
        if (!s?.on || s.target < 0) return null;
        const tg = this.host.reps.preAt(s.target, t);
        if (!tg) { this.stats.blind++; return null; }
        const kind = BODY_KINDS[s.kind];
        if (!kind) return null;
        return stagedFlight(kind.flight, s, prev, tg, t);
      },
    };
  }

  /** Its check, if one is due (`riding`: an input goes anyway): the low byte of its bodies' hashes at the last snapshot's tick */
  takeCheck(riding: boolean, tick: number): { hash: number; tick: number } | undefined {
    if (!this.on || !riding || !this.runs.size || this.snapTick === this.lastCheck.snap || tick - this.lastCheck.tick < CHECK_EVERY) return undefined;
    let sum = 0;
    for (const [id, run] of this.runs) {
      const st = this.host.reps.at(id, this.snapTick), s = this.stateAt(run, this.snapTick);
      if (st && s) sum = (sum + bodyHash(id, st.body, s)) >>> 0;
    }
    this.lastCheck = { tick, snap: this.snapTick };
    this.stats.checks++;
    return { hash: bodyCheckByte(sum), tick: this.snapTick & 0xfff };
  }
}
