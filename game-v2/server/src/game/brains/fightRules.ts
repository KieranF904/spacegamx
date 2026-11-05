/**
 * The rules every staged boss fights by (docs/bosses/rework-2026-11.md 2.1-2.2; the shared maths: common bosses/):
 *
 *   windows    a signature move (its tables' `signature`) is followed by its window: x2 up to the cap, a crack and a
 *              stagger when the cap fills early, x0.35 outside windows. A boss with `exposure` (rework 2026-11 section
 *              15) chains its stage's signature moves into one attack phase and opens one window after the phase, not
 *              one a move (staged.ts). The boss starts no move in a window. Clients are told (bossWindow) at its
 *              opening, as it fills, on a crack and as it closes; their exposure effect is drawn from that alone. A
 *              client running the boss's moves (CAPS.MOVES) draws the opening from its WINDOW decision (`opened`)
 *   personal   each beat every pilot present rolls for a personal attack (its tables' `personal`); a draw is a decision
 *              on the boss's body ({slot, attack, seed, target, name}) and runs as a move of its own beside the boss's
 *              (its moves': common bodies/moves/staged.ts), aimed at that pilot. None starts in a window's rest beat or a
 *              stagger; a boss without `exposure` also holds them through its signature moves
 *   causes     what it's doing now (`cause`): the move, or whose personal attack, for the dev damage log
 *
 * A brain without `signature` takes hits as before (x1), except in a window the dev tools opened (x2).
 */

import {
  DECISION, WINDOW, openWindow, windowOpen, windowOver, staggered, restBeat, windowTaken, noteWindowDamage, windowFill, windowFillStep,
  rollPersonal, type WindowSpec, type WindowState, type PersonalRules, type StagedMoves,
} from '@space-game/common';
import type { BrainHost } from './kit.js';

export interface FightTables {
  /** Its signature moves (by name) and the window each opens */
  signature?: Record<string, WindowSpec>;
  /** Its personal attacks: the pool by stage, the beat and the chance */
  personal?: PersonalRules;
  /**
   * Its attack phases' windows, by stage: its stage's signature moves chained, then this one window (and none after
   * each move). Personal attacks then come during its moves too, held only in the window's rest beat and a stagger
   */
  exposure?: WindowSpec[];
}

/** The meter's updates at most this often */
const FILL_EVERY = 6;
/** Defaults for a window the dev tools open on a boss with none of its own */
export const DEV_WINDOW: WindowSpec = { ticks: 480, cap: 2000 };

export class FightRules {
  window: WindowState | null = null;
  /** Its moves' personal attacks running (StagedMoves.runs, as last seen) */
  private runs: readonly unknown[] = [];
  private sentStep = -1;
  private sentAt = -Infinity;
  private seed: number;
  /** What it's doing now (the dev damage log) */
  cause = '';
  /** A window opened (its brain's WINDOW decision) */
  opened?: (w: WindowState) => void;
  /** Stats for the fight summary: windows opened and cracked, personal attacks drawn per target */
  readonly stats = { windows: 0, cracks: 0, insideDamage: 0, outsideDamage: 0, drawn: new Map<number, number>() };

  constructor(private host: BrainHost, readonly tables: FightTables, seed: number) {
    this.seed = seed >>> 0;
  }

  /** Does it fight by windows (x0.35 outside them) */
  get windowed(): boolean {
    return !!this.tables.signature;
  }

  isSignature(name: string): boolean {
    return !!this.tables.signature?.[name];
  }

  /** What share of a hit it takes now */
  share(now: number): number {
    if (this.windowed) return windowTaken(this.window, now);
    return windowOpen(this.window, now) ? WINDOW.inside : 1;
  }

  /** No move may start: a window is still running (open, or staggered) */
  holding(now: number): boolean {
    return !!this.window && !windowOver(this.window, now);
  }

  staggered(now: number): boolean {
    return staggered(this.window, now);
  }

  /** A move finished: a signature move opens its window (a boss with attack phases opens its own: staged.ts) */
  finished(name: string, eid: number, num: number, now: number): void {
    if (this.tables.exposure) return;
    const spec = this.tables.signature?.[name];
    if (spec) this.open(spec, eid, num, now);
  }

  open(spec: WindowSpec, eid: number, num: number, now: number): void {
    this.window = openWindow(spec, now);
    this.stats.windows++;
    this.sentStep = -1;
    this.opened?.(this.window);
    this.tell(eid, num, now, true);
  }

  /** Damage it took (as taken): counted into an open window; returns the crack's bonus (0: none) */
  landed(amount: number, eid: number, num: number, now: number): number {
    if (windowOpen(this.window, now)) this.stats.insideDamage += amount; else this.stats.outsideDamage += amount;
    const bonus = noteWindowDamage(this.window, amount, now);
    if (bonus > 0) { this.stats.cracks++; this.tell(eid, num, now); }
    return bonus;
  }

  /** Every tick: the meter's updates and its close */
  tickWindow(eid: number, num: number, now: number): void {
    const w = this.window;
    if (!w) return;
    if (windowOver(w, now)) { this.host.send(num, { type: 'bossWindow', bodyId: eid, at: w.at, ticks: 0, cap: w.cap, fill: windowFillStep(w) }); this.window = null; return; }
    if (windowFillStep(w) !== this.sentStep && now - this.sentAt >= FILL_EVERY) this.tell(eid, num, now);
  }

  /** The window as clients draw it: its opening (`opening`: a client running its moves draws that from its WINDOW), its fills */
  private tell(eid: number, num: number, now: number, opening = false): void {
    const w = this.window!;
    this.sentStep = windowFillStep(w);
    this.sentAt = now;
    const msg = { type: 'bossWindow' as const, bodyId: eid, at: w.at, ticks: w.ticks, cap: w.cap, fill: this.sentStep, ...(w.crackAt >= 0 ? { crack: true } : {}) };
    if (opening && this.host.moveFx && this.opened) this.host.moveFx(num, eid, { t: now, who: -1 }, msg);
    else this.host.send(num, msg);
  }

  /**
   * Every tick it's fighting: a beat's rolls (held in a signature move or a rest beat), then every personal attack
   * running steps once (they're its moves'). `present`: its pilots, in the order their slots count; `names` its personal
   * attacks' names (a PERSONAL's name index). A draw is a PERSONAL decision [slot, attack, seed, target + 1, name]
   */
  personal(eid: number, stage: number, now: number, present: readonly number[], inSignature: boolean, moves: StagedMoves,
    names: readonly string[], decide: (op: number, args: readonly number[]) => void): void {
    const rules = this.tables.personal;
    const running = moves.pruneRuns(now);
    if (rules) {
      const held = (inSignature && !this.tables.exposure) || restBeat(this.window, now) || staggered(this.window, now);
      const pool = rules.pool[Math.max(0, Math.min(rules.pool.length - 1, stage - 1))] ?? [];
      for (const d of rollPersonal(rules, stage, this.seed ^ eid, now, present.length, running, held)) {
        const target = present[d.slot], name = pool[d.attack];
        if (this.start(name, target, d.seed, now, moves)) decide(DECISION.PERSONAL, [d.slot, d.attack, d.seed, target + 1, names.indexOf(name)]);
      }
    }
    const main = this.cause;
    moves.stepPersonal((r) => { this.cause = r ? `personal:${r.name}>${r.target}` : main; });
    this.runs = moves.runs;
  }

  /** (dev, or a draw) start one personal attack on a pilot now */
  start(name: string, target: number, seed: number, now: number, moves: StagedMoves): boolean {
    if (!moves.startPersonal(name, target, seed, now, this.tables.personal?.ticks ?? 300)) return false;
    this.stats.drawn.set(target, (this.stats.drawn.get(target) ?? 0) + 1);
    this.runs = moves.runs;
    return true;
  }

  /** How many personal attacks are running */
  get running(): number {
    return this.runs.length;
  }

  /** Its stage beaten, it died, or the dev tools reset it: everything stops */
  clear(): void {
    this.runs = [];
    this.window = null;
  }

  /** The window as the dev panel shows it */
  devWindow(now: number): { fill: number; left: number; crack: boolean } | null {
    const w = this.window;
    return w && !windowOver(w, now) ? { fill: windowFill(w), left: w.at + w.ticks - now, crack: w.crackAt >= 0 } : null;
  }
}
