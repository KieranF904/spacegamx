/**
 * A client's run of one body's moves, tick by tick, from its decisions (decision-inputs stage 4, CAPS.MOVES), in the
 * order the server's brain worked them (server/src/game/brains/staged.ts `orders`; custom enemies: CustomEnemies.step).
 * Stepped forward only, once a tick, over ticks whose decisions and reads are final (a snapshot's window, after the
 * bodies were stepped again: client BodyRunner).
 *
 *   staged   HOLD (a stop clears everything), a MOVE starts its move (seeded), passives, its HARASS shot if it's at this
 *            client's own ship, the move steps, personal attacks whose time is up go, PERSONALs at this client start, every
 *            personal attack steps; a WINDOW is drawn as the bossWindow its opening was
 *   custom   the move its order carries, `k` ticks in (only one that started after the client began running it)
 *
 * What a move does that only the server knows (damage, pulls, homing shells, mobs) has no host work here: those go from
 * the server as before.
 */
import type { ServerMessage } from '../../network/protocol.js';
import { DECISION, MOVES_HOLD } from '../decisions.js';
import { moveAt, CO } from '../custom/order.js';
import { CUSTOM_DESIGNS } from '../custom/index.js';
import { AI_ORDER } from '../aiPilot.js';
import type { WantRec } from '../decisions.js';
import type { StagedMoves, Move } from './staged.js';
import type { MoveHost } from './host.js';
import type { CustomAct, DesignMoves, CustomMoveState } from './custom.js';

/** A staged boss's moves as a client runs them */
export class StagedTrack {
  private cur: Move | null = null;
  private curAt = -Infinity;
  private mode: number = MOVES_HOLD.RUN;
  /** CAP decisions this tick: the k-th volley's dropped shots */
  private caps = new Map<number, number>();
  private capK = 0;

  constructor(readonly moves: StagedMoves, private readonly h: MoveHost, readonly personalNames: readonly string[], readonly personalTicks: number) {}

  /** Its CAP for the volley being shot now (the host's `cap` reads it): the mask of shots dropped (0 none) */
  capNow(): number {
    return this.caps.get(this.capK++) ?? 0;
  }

  /**
   * Tick t's work: `ds` its decisions at t ([op, ...args], in the order they were taken), `self` this client's own ship.
   * Its target, stage and side (as the tick before ended) are set on its moves first. Returns the bossWindow its
   * WINDOW opened, if any
   */
  tick(t: number, ds: readonly (readonly number[])[], self: number, eid: number, hold: number): ServerMessage[] {
    const m = this.moves, out: ServerMessage[] = [];
    this.caps.clear();
    this.capK = 0;
    for (const d of ds) {
      if (d[0] === DECISION.HOLD && d[1] === MOVES_HOLD.STOP) { this.cur = null; m.stop(); }
      else if (d[0] === DECISION.CAP) this.caps.set(d[1] ?? 0, d[2] ?? 0);
      else if (d[0] === DECISION.WINDOW) out.push({ type: 'bossWindow', bodyId: eid, at: t, ticks: d[1] ?? 0, cap: d[2] ?? 0, fill: 0 });
    }
    // (held or stopped: the move under way is dropped, nothing else of its moves runs this tick)
    this.mode = hold;
    if (hold !== MOVES_HOLD.RUN) { this.cur = null; return out; }
    for (const d of ds) {
      if (d[0] !== DECISION.MOVE) continue;
      const name = m.names[d[1] ?? -1];
      m.rage = (d[3] ?? 0) === 1;
      m.begin(d[2] ?? 0, t);
      this.h.origin = { t, who: -1 };
      const mv = name ? m.make(name) : null;
      this.cur = mv && name ? m.around(mv, name) : null;
      this.curAt = t;
    }
    m.passives(t);
    for (const d of ds) {
      if (d[0] !== DECISION.HARASS || (d[1] ?? 0) - 1 !== self) continue;
      this.h.origin = { t, who: self };
      m.harassShot(self);
    }
    if (this.cur) {
      this.h.origin = { t: this.curAt, who: -1 };
      if (this.cur.next().done) this.cur = null;
    }
    m.pruneRuns(t);
    for (const d of ds) {
      // ([slot, attack, seed, target + 1, name]: only this client's own)
      if (d[0] !== DECISION.PERSONAL || (d[4] ?? 0) - 1 !== self) continue;
      const name = this.personalNames[d[5] ?? -1];
      if (name) m.startPersonal(name, self, d[3] ?? 0, t, this.personalTicks);
    }
    m.stepPersonal();
    return out;
  }

  /** Dropped (OFF, gone, resynced): nothing more of it runs */
  stop(): void {
    this.cur = null;
    this.moves.stop();
  }
}

/** A custom enemy's moves as a client runs them: each step of the move its order carries */
export class CustomTrack {
  readonly st: CustomMoveState = {};
  /** `since`: the tick it began running the ship (a move begun before then is sat out) */
  constructor(readonly since: number) {}

  /** Its design (its order's: CO.DESIGN), if the order is a custom one */
  static designOf(w: WantRec): string | null {
    return w[0] === AI_ORDER.CUSTOM ? CUSTOM_DESIGNS[w[CO.DESIGN] ?? -1]?.id ?? null : null;
  }

  /** Tick t's step, from its order then (`act` its reads at t) */
  tick(t: number, w: WantRec, moves: DesignMoves | undefined, act: CustomAct): void {
    const spec = CUSTOM_DESIGNS[w[CO.DESIGN] ?? -1];
    if (!spec || !moves || w[0] !== AI_ORDER.CUSTOM) return;
    const at = moveAt(w, t, (mv) => spec.moves[mv]?.ticks ?? 0);
    const start = w[CO.MSTART] ?? 0;
    if (at && start > this.since) moves.step?.(act, { move: at.move, arg: w[CO.ARG] ?? 0, seed: w[CO.MSEED] ?? 0, start }, at.k);
    // (its guns between moves, on their grid)
    if (t > this.since) moves.always?.(act);
  }
}
