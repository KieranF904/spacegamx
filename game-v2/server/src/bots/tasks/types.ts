/**
 * A bot task: a state machine, one `step` a tick, that flies the ship through a PilotDriver and reports what phase it is
 * in (BotStats times each phase). Tasks are registered by name (tasks/registry.ts); a new one is a file here and a line
 * there.
 */
import type { PilotDriver, Phase } from '../core/types.js';
import type { BotWorld, StationView } from '../core/world.js';
import type { BotStats } from '../stats/BotStats.js';

export interface TaskCtx {
  driver: PilotDriver;
  world: BotWorld;
  stats: BotStats;
  /** The server tick, and ticks a second */
  tick: number;
  tickRate: number;
  /** The system the bot works in (number) */
  system: number;
}

export interface BotTask {
  readonly name: string;
  /** What the ship is doing now (this tick), for the stats */
  readonly phase: Phase;
  /** A line for `/bot list`: the state and the target */
  status(): string;
  step(ctx: TaskCtx): void;
}

/** Options a task takes (from `/bot spawn <task> n key=value ...` or the bench's environment): strings, the task reads what it knows */
export type TaskOpts = Record<string, string | number | boolean>;

export interface TaskDef {
  readonly name: string;
  readonly description: string;
  /** The ship the task is meant for (a library ship id), unless told otherwise */
  readonly ship: string;
  /** The station it starts from (a station id) */
  readonly station: (opts: TaskOpts) => string;
  create(opts: TaskOpts): BotTask;
}

export const num = (o: TaskOpts, k: string, d: number): number => { const v = Number(o[k]); return o[k] !== undefined && Number.isFinite(v) ? v : d; };
export const str = (o: TaskOpts, k: string, d: string): string => (o[k] !== undefined ? String(o[k]) : d);

export type { StationView };
