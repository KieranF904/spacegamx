/**
 * Rock-picking strategies for mine-and-deposit (option `strategy=<name>`): which rock the bot flies to next, from the
 * suitable rocks (hardness it can work, not gas, enough ore left) sorted nearest first. Pure functions of what the bot
 * can see, so each is easy to test and a new one is a function and a line in `strategies`.
 *
 *   nearest           the nearest rock (the original behaviour)
 *   metal             the nearest Chondrite or Taenite (`types=a,b` to change which)
 *   taenite-on-sight  the nearest rock, but any Taenite within `sight` units (default 3000) of the ship wins (`target=<type>`)
 *   needs             the rock whose ore mix best fills what is still short for the goal (a whole Prospector), nearer preferred
 *   value             the richest rock by base sale value per unit of ore within `radius` (default 4000) of the ship
 *
 * `skip=k` drops the k nearest suitable rocks from the choice at the first pick of each trip (a starting variation).
 */
import type { Bag } from '../core/types.js';
import type { RockView } from '../core/world.js';
import { num, str, type TaskOpts } from './types.js';

export interface PickEnv {
  /** Suitable rocks, nearest (by the gap to the ship) first */
  rocks: RockView[];
  /** The gap from the ship to a rock's edge */
  gap: (r: RockView) => number;
  /** Ore still short for the goal (ore -> units), when the strategy asks */
  short: () => Bag;
  /** What an ore sells for (base) */
  price: (ore: string) => number;
  opts: StrategyOpts;
}

export interface StrategyOpts { sight: number; radius: number; target: string; types: string[] }
export type Strategy = (env: PickEnv) => RockView | null;

export const strategyOpts = (o: TaskOpts): StrategyOpts => ({
  sight: num(o, 'sight', 3000),
  radius: num(o, 'radius', 4000),
  target: str(o, 'target', 'rock_taenite'),
  types: str(o, 'types', 'asteroid_metal,rock_taenite').split(',').filter(Boolean),
});

const nearest: Strategy = (e) => e.rocks[0] ?? null;

const metal: Strategy = (e) => e.rocks.find((r) => e.opts.types.includes(r.type)) ?? nearest(e);

const taeniteOnSight: Strategy = (e) => e.rocks.find((r) => r.type === e.opts.target && e.gap(r) <= e.opts.sight) ?? nearest(e);

const needs: Strategy = (e) => {
  const short = e.short(), total = Object.values(short).reduce((a, n) => a + Math.max(0, n), 0);
  if (total <= 0) return nearest(e);
  let best: RockView | null = null, bestScore = -1;
  for (const r of e.rocks) {
    let fit = 0;
    for (const [ore, share] of Object.entries(r.ores)) fit += (share * Math.max(0, short[ore] ?? 0)) / total;
    // (a rock nearly spent is worth less; distance counts for something, but a good fit is worth a longer flight)
    const score = (fit * Math.min(1, r.left / 60)) / (1 + e.gap(r) / 3000);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ?? nearest(e);
};

const value: Strategy = (e) => {
  let best: RockView | null = null, bestV = -1;
  for (const r of e.rocks) {
    if (e.gap(r) > e.opts.radius) continue;
    let v = 0;
    for (const [ore, share] of Object.entries(r.ores)) v += share * e.price(ore);
    if (v > bestV) { bestV = v; best = r; }
  }
  return best ?? nearest(e);
};

export const strategies: Record<string, Strategy> = { nearest, metal, 'taenite-on-sight': taeniteOnSight, needs, value };
export const strategyNames = (): string[] => Object.keys(strategies);
