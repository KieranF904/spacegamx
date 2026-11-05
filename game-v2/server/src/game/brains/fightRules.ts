/**
 * The rules every staged boss fights by (docs/bosses/rework-2026-11.md 2.1-2.2; the shared maths: common bosses/):
 *
 *   windows    a signature move (its tables' `signature`) is followed by its window: x2 up to the cap, a crack and a
 *              stagger when the cap fills early, x0.35 outside windows. A boss with `exposure` (rework 2026-11 section
 *              15) chains its stage's signature moves into one attack phase and opens one window after the phase, not
 *              one a move (staged.ts). The boss starts no move in a window. Clients are told (bossWindow) at its
 *              opening, as it fills, on a crack and as it closes; their exposure effect is drawn from that alone
 *   personal   each beat every pilot present rolls for a personal attack (its tables' `personal`); a draw is a decision
 *              on the boss's body ({slot, attack, seed}) and runs as a move of its own beside the boss's, aimed at that
 *              pilot. None starts in a window's rest beat or a stagger; a boss without `exposure` also holds them
 *              through its signature moves
 *   causes     what it's doing now (`cause`): the move, or whose personal attack, for the dev damage log
 *
 * A brain without `signature` takes hits as before (x1), except in a window the dev tools opened (x2).
 */

import {
  DECISION, WINDOW, openWindow, windowOpen, windowOver, staggered, restBeat, windowTaken, noteWindowDamage, windowFill, windowFillStep,
  rollPersonal, pruneDraws, type WindowSpec, type WindowState, type PersonalRules, type PersonalDraw,
} from '@space-game/common';
import type { BrainHost } from './kit.js';

export type Move = Generator<void, void, void>;

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

/** A personal attack running: what was drawn, on whom, and its move */
interface Run { draw: PersonalDraw; name: string; target: number; move: Move }

/** The meter's updates at most this often */
const FILL_EVERY = 6;
/** Defaults for a window the dev tools open on a boss with none of its own */
export const DEV_WINDOW: WindowSpec = { ticks: 480, cap: 2000 };

export class FightRules {
  window: WindowState | null = null;
  private runs: Run[] = [];
  private sentStep = -1;
  private sentAt = -Infinity;
  private seed: number;
  /** What it's doing now (the dev damage log) */
  cause = '';
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
    this.tell(eid, num, now);
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

  private tell(eid: number, num: number, now: number): void {
    const w = this.window!;
    this.sentStep = windowFillStep(w);
    this.sentAt = now;
    this.host.send(num, { type: 'bossWindow', bodyId: eid, at: w.at, ticks: w.ticks, cap: w.cap, fill: this.sentStep, ...(w.crackAt >= 0 ? { crack: true } : {}) });
  }

  /**
   * Every tick it's fighting: a beat's rolls (held in a signature move or a rest beat), then every personal attack
   * running steps once. `present`: its pilots, in the order their slots count; `make` builds an attack by name
   */
  personal(eid: number, stage: number, now: number, present: readonly number[], inSignature: boolean,
    make: (name: string, target: number, seed: number) => Move | null, decide: (op: number, args: readonly number[]) => void): void {
    const rules = this.tables.personal;
    const draws = this.runs.map((r) => r.draw);
    const running = pruneDraws(draws, now);
    this.runs = this.runs.filter((r) => draws.includes(r.draw));
    if (rules) {
      const held = (inSignature && !this.tables.exposure) || restBeat(this.window, now) || staggered(this.window, now);
      const pool = rules.pool[Math.max(0, Math.min(rules.pool.length - 1, stage - 1))] ?? [];
      for (const d of rollPersonal(rules, stage, this.seed ^ eid, now, present.length, running, held)) {
        const target = present[d.slot];
        if (this.start(pool[d.attack], target, d, make)) decide(DECISION.PERSONAL, [d.slot, d.attack, d.seed]);
      }
    }
    this.step();
  }

  /** (dev, or a draw) start one personal attack on a pilot now */
  start(name: string, target: number, draw: PersonalDraw, make: (name: string, target: number, seed: number) => Move | null): boolean {
    const move = make(name, target, draw.seed);
    if (!move) return false;
    this.runs.push({ draw, name, target, move });
    this.stats.drawn.set(target, (this.stats.drawn.get(target) ?? 0) + 1);
    return true;
  }

  private step(): void {
    const main = this.cause;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i];
      this.cause = `personal:${r.name}>${r.target}`;
      if (r.move.next().done) this.runs.splice(i, 1);
    }
    this.cause = main;
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
