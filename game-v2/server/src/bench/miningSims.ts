/**
 * Mining strategy simulations: every rock-picking strategy (bots/tasks/rockStrategies.ts) x Taenite on/off x a few
 * starting variations, on the player-bot bench (playerBot.ts), reporting time to afford a Prospector and a Mk I laser,
 * ore per hour (iron, nickel, copper) and the travel share. Taenite off = the Sol belt's Taenite weight set to 0 for the
 * run through the bench's FIELDS override; the data files are untouched.
 *
 *   npx tsx src/bench/miningSims.ts run <strategy> <on|off> [client|npc] [minutes=60] [outdir]   one cell: every variation
 *   npx tsx src/bench/miningSims.ts report [outdir]                                              the markdown table from the cells
 *
 * Variations (a starting rock each trip): `skip` the k nearest rocks at the first pick of every trip, k = 0, 2, 4, 7, 11;
 * plus, on the client driver, a "3 bots at once" run (the same task, so they compete for rocks; the NPC driver's bots block each other at the dock).
 * One cell takes about 5 x 65 s wall on the client driver (60 game minutes each), a few seconds a run on the NPC.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runBench, type GoalResult } from './playerBot.js';
import type { DriverKind } from '../bots/index.js';
import { strategyNames } from '../bots/tasks/rockStrategies.js';

const here = dirname(fileURLToPath(import.meta.url));
const SKIPS = [0, 2, 4, 7, 11];

interface Sample { variation: string; orePerHour: number; perHour: Record<string, number>; travelShare: number; miningShare: number; trips: number; goals: GoalResult[] }
interface Cell { strategy: string; taenite: 'on' | 'off'; driver: DriverKind; minutes: number; samples: Sample[] }

/** A cell's strategy label: `name`, or `name@N` (taenite-on-sight with sight N, value with radius N) */
function optsOf(label: string): { strategy: string; extra: Record<string, number> } {
  const [strategy, n] = label.split('@');
  return { strategy, extra: n ? { [strategy === 'value' ? 'radius' : 'sight']: Number(n) } : {} };
}

function runCell(label: string, taenite: 'on' | 'off', driver: DriverKind, minutes: number): Cell {
  const { strategy, extra } = optsOf(label);
  const fields = taenite === 'off' ? 'sol_belt.rock_taenite=0' : undefined;
  const samples: Sample[] = [];
  const take = (variation: string, r: ReturnType<typeof runBench>) => {
    (r.summaries as { trips: number; tripSeconds: number; deposited: Record<string, number>; orePerHour: number; travelShare: number; miningShare: number }[]).forEach((s, i) => {
      const hours = s.tripSeconds / 3600 || 1;
      samples.push({
        variation: r.summaries.length > 1 ? `${variation} bot${i + 1}` : variation,
        orePerHour: s.orePerHour, perHour: Object.fromEntries(['iron_ore', 'nickel_ore', 'copper_ore'].map((k) => [k, (s.deposited[k] ?? 0) / hours])),
        travelShare: s.travelShare, miningShare: s.miningShare, trips: s.trips, goals: r.goals[i] ?? [],
      });
    });
  };
  for (const k of SKIPS) take(`skip ${k}`, runBench(driver, minutes, 'mine-and-deposit', 1, { strategy, skip: k, ...extra }, '', fields, true));
  if (driver === 'client') take('3 bots', runBench(driver, minutes, 'mine-and-deposit', 3, { strategy, skip: 0, ...extra }, '', fields, true));
  return { strategy: label, taenite, driver, minutes, samples };
}

const stat = (xs: number[]) => (xs.length ? { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null);
const f1 = (n: number) => n.toFixed(1);
const range = (xs: number[], reached: number, total: number) => {
  const s = stat(xs);
  return s ? `${f1(s.mean)} (${f1(s.min)}-${f1(s.max)})${reached < total ? ` ${reached}/${total} reached` : ''}` : `not in run (0/${total})`;
};

/** One table: a row per strategy and Taenite setting */
export function tableOf(cells: Cell[], driver: DriverKind): string {
  const L = [
    '| strategy | Taenite | time to Prospector, run (min, mean (min-max)) | time to Prospector, by rate (min) | time to Mk I laser, run (min) | iron/h | nickel/h | copper/h | ore/h | travel share |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of cells.filter((x) => x.driver === driver).sort((a, b) => strategyNames().indexOf(a.strategy.split('@')[0]) - strategyNames().indexOf(b.strategy.split('@')[0]) || a.strategy.localeCompare(b.strategy) || (a.taenite === 'on' ? -1 : 1))) {
    const g = (i: number, key: 'actualMinutes' | 'rateMinutes') => c.samples.map((s) => s.goals[i]?.[key]).filter((v): v is number => typeof v === 'number');
    const m = (f: (s: Sample) => number) => { const s = stat(c.samples.map(f)); return s ? `${Math.round(s.mean).toLocaleString('en')} (${Math.round(s.min).toLocaleString('en')}-${Math.round(s.max).toLocaleString('en')})` : '-'; };
    const n = c.samples.length;
    const travel = stat(c.samples.map((s) => s.travelShare * 100));
    L.push(`| ${c.strategy} | ${c.taenite} | ${range(g(1, 'actualMinutes'), g(1, 'actualMinutes').length, n)} | ${range(g(1, 'rateMinutes'), g(1, 'rateMinutes').length, n)} | ${range(g(0, 'actualMinutes'), g(0, 'actualMinutes').length, n)} | ${m((s) => s.perHour.iron_ore)} | ${m((s) => s.perHour.nickel_ore)} | ${m((s) => s.perHour.copper_ore)} | ${m((s) => s.orePerHour)} | ${travel ? `${Math.round(travel.mean)}% (${Math.round(travel.min)}-${Math.round(travel.max)})` : '-'} |`);
  }
  return L.join('\n');
}

const argv = process.argv.slice(2);
const dirOf = (a: string | undefined) => a ?? join(here, '../../stats/mining-sims');
if (argv[0] === 'run') {
  const [, strategy, taenite, driver = 'client', mins = '60', out] = argv;
  const dir = dirOf(out);
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const cell = runCell(strategy, taenite as 'on' | 'off', driver as DriverKind, Number(mins));
  writeFileSync(join(dir, `${driver}-${strategy}-${taenite}.json`), JSON.stringify(cell, null, 1));
  console.log(`${driver} ${strategy} taenite ${taenite}: ${cell.samples.length} samples, wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(0);
} else if (argv[0] === 'report') {
  const dir = dirOf(argv[1]);
  const cells = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Cell);
  for (const d of ['client', 'npc'] as const) if (cells.some((c) => c.driver === d)) console.log(`\n### ${d} driver\n\n${tableOf(cells, d)}`);
  process.exit(0);
}
