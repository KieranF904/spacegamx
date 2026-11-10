/**
 * Player-bot bench: a real GameServer stepped without real time (the clock is the tick count), with bots flying a task for
 * a set game duration, then their stats. The main tool for "how much does this loop yield, and how long would a player take".
 *
 *   npx tsx src/bench/playerBot.ts [minutes=30]
 *   env TASK=mine-and-deposit  DRIVER=client|npc|both  BOTS=1  MODE=store|sell  SEED=n  STATS=<dir> (default server/stats/bots)
 *       OPTS="dockWait=10 standoff=0.55 strategy=metal skip=3 ..."  (task options, key=value; strategies: tasks/rockStrategies.ts)  QUIET=1 (no per-trip lines)
 *       FIELDS="sol_belt.rock_taenite=0,..."  (belt weights overridden for the run, not in the data files: Taenite off)
 *
 * `DRIVER=both` runs the client-input and the server-NPC driver on the same task, one after the other on fresh servers.
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as bitecs from 'bitecs';
import { TICK_RATE } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { BotManager, type DriverKind } from '../bots/index.js';
import type { TaskOpts } from '../bots/index.js';
import { targetsFor, timeToTargets, targetsText } from '../bots/stats/targets.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '../../../data');
const minutes = Number(process.argv[2]) || 30;
const TASK = process.env.TASK ?? 'mine-and-deposit';
const BOTS = Number(process.env.BOTS ?? 1);
const which = (process.env.DRIVER ?? 'client') as DriverKind | 'both';
const statsDir = process.env.STATS ?? join(here, '../../stats/bots');

// (The payout dice's secret fixed too, as Math.random is: the same run every time. game/payoutDice.ts)
process.env.PAYOUT_SECRET ??= 'bench';
{
  let seed = Number(process.env.SEED ?? 0x2545f491);
  Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const opts: TaskOpts = {};
if (process.env.MODE) opts.mode = process.env.MODE;
for (const w of (process.env.OPTS ?? '').split(/\s+/).filter(Boolean)) { const [k, v] = w.split('='); opts[k] = v; }

/** What one bot's run says about the goals: minutes by its ore rates (the bench's usual) and the first moment its deposits covered the cost */
export interface GoalResult { name: string; rateMinutes: number | null; limiting: string; actualMinutes: number | null }
export interface BenchResult { driver: DriverKind; text: string; summaries: unknown[]; wallSeconds: number; goals: GoalResult[][] }

/** `FIELDS` overrides: "field.type=weight,..." applied to the loaded data (the files stay as they are) */
export function applyFieldWeights(files: ReturnType<typeof readGameDataFiles>, spec: string | undefined): void {
  if (!spec) return;
  const fields = (files.mining as unknown as { fields: Record<string, Record<string, number>> }).fields;
  for (const item of spec.split(',').filter(Boolean)) {
    const [path, w] = item.split('=');
    const [field, type] = path.split('.');
    fields[field][type] = Number(w);
  }
}

export function runBench(kind: DriverKind, mins: number, task = TASK, n = BOTS, taskOpts: TaskOpts | ((i: number) => TaskOpts) = opts, dir: string | undefined = statsDir, fieldSpec: string | undefined = process.env.FIELDS, quiet = !!process.env.QUIET): BenchResult {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const clock = { t: 1_000_000 };
  const files = readGameDataFiles(dataDir);
  applyFieldWeights(files, fieldSpec);
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, devTeleport: true, guestAdmin: true,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
  } as never);
  const mgr = new BotManager(server, { statsDir: dir, log: quiet ? () => {} : (l) => console.log(l) });
  const t0 = Date.now();
  for (let i = 0; i < n; i++) mgr.spawn(task, kind, typeof taskOpts === 'function' ? taskOpts(i) : taskOpts);
  const ticks = Math.round(mins * 60 * TICK_RATE);
  for (let i = 0; i < ticks; i++) {
    clock.t += 1000 / TICK_RATE;
    server.step();
  }
  let text = mgr.summarize();
  // (What the loop's ore could buy: minutes of it for a Mk I mining laser and a whole Prospector)
  const prospector = server.getShips().library.get('prospector');
  const goals: GoalResult[][] = [];
  for (const b of mgr.bots) {
    const s = b.stats.summary();
    if (!prospector || !s.trips) { goals.push([]); continue; }
    const perHour = Object.fromEntries(Object.entries(s.deposited).map(([k, n]) => [k, n / (s.tripSeconds / 3600)]));
    const targets = targetsFor(server.econ, prospector), times = timeToTargets(targets, perHour);
    text += `
${targetsText(times)}`;
    // (and when the deposits first covered each target, trip by trip from the run's start)
    const t0 = b.stats.trips[0]?.startTick ?? 0, got: Record<string, number> = {};
    const actual: (number | null)[] = targets.map(() => null);
    for (const t of b.stats.trips) {
      for (const [k, n] of Object.entries(t.deposited)) got[k] = (got[k] ?? 0) + n;
      targets.forEach((g, i) => { if (actual[i] === null && Object.entries(g.raw).every(([k, n]) => (got[k] ?? 0) >= n)) actual[i] = (t.endTick - t0) / TICK_RATE / 60; });
    }
    goals.push(times.map((t, i) => ({ name: t.name, rateMinutes: t.minutes, limiting: t.limiting, actualMinutes: actual[i] })));
  }
  const summaries = mgr.bots.map((b) => b.stats.summary());
  const wallSeconds = (Date.now() - t0) / 1000;
  mgr.stop();
  return { driver: kind, text, summaries, wallSeconds, goals };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('bench/playerBot.ts')) {
  for (const k of which === 'both' ? (['client', 'npc'] as const) : [which]) {
    console.log(`\n##### ${TASK}, ${BOTS} ${k} bot(s), ${minutes} game minutes #####`);
    const r = runBench(k, minutes);
    console.log(r.text);
    console.log(`(wall ${r.wallSeconds.toFixed(1)} s for ${minutes} game minutes)`);
  }
  process.exit(0);
}
