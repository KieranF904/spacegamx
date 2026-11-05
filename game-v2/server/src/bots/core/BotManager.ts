/**
 * The bots on a server: spawns them, steps them from the server's afterTick, answers the `/bot` admin command, and writes
 * their stats. DEV ONLY: constructing one on a production server (NODE_ENV=production) throws, whatever asked for it.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { GameServer } from '../../GameServer.js';
import { ClientDriver } from '../drivers/clientDriver.js';
import { NpcDriver } from '../drivers/npcDriver.js';
import { summaryTable } from '../stats/BotStats.js';
import { taskDef, taskNames } from '../tasks/registry.js';
import type { TaskOpts } from '../tasks/types.js';
import { Bot } from './Bot.js';
import type { PilotDriver } from './types.js';
import { BotWorld } from './world.js';
import type { AdminConn, Result } from '../../game/AdminTools.js';

export type DriverKind = 'client' | 'npc';

export interface BotManagerOpts {
  /** Where the stats go (a folder, made when first written); none: console only */
  statsDir?: string;
  /** Print a line when a trip completes */
  log?: (line: string) => void;
  wall?: () => number;
}

/** Throws on a production server. Every way into the bots calls it. */
export function assertDev(): void {
  if (process.env.NODE_ENV === 'production') throw new Error('bots are dev-only and never run in production');
}

export class BotManager {
  readonly bots: Bot[] = [];
  readonly world: BotWorld;
  private nextId = 1;
  private readonly run = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  private readonly log: (line: string) => void;

  constructor(readonly server: GameServer, readonly opts: BotManagerOpts = {}) {
    assertDev();
    this.world = new BotWorld(server);
    this.log = opts.log ?? ((l) => console.log(l));
    server.afterTick.push(() => this.tick());
    server.admin.extensions.set('bot', (c, words) => this.command(c, words));
  }

  spawn(task: string, kind: DriverKind = 'client', taskOpts: TaskOpts = {}): Bot {
    assertDev();
    const def = taskDef(task);
    if (!def) throw new Error(`no task "${task}" (${taskNames().join(', ')})`);
    const id = this.nextId++;
    const name = `bot_${task.split('-')[0]}_${id}`;
    const station = def.station(taskOpts);
    const shipId = String(taskOpts.ship ?? def.ship);
    const price = (ore: string) => this.world.price(station, ore);
    const stationData = this.server.gameData.getStation(station);
    if (!stationData) throw new Error(`no station ${station}`);
    const system = this.server.gameData.getSystemNum(stationData.system);
    let driver: PilotDriver;
    if (kind === 'npc') {
      const d = new NpcDriver(this.server, name, { name, ship: shipId, station, price });
      const st = this.world.station(station);
      if (st) d.placeAt(st.x + st.interact * 1.3, st.y);
      driver = d;
    } else {
      driver = new ClientDriver(this.server, name, { name, ship: shipId, station, price });
    }
    const bot = new Bot(id, this.server, this.world, def.create(taskOpts), driver, system, this.opts.wall);
    this.bots.push(bot);
    return bot;
  }

  stop(id?: number): number {
    let n = 0;
    for (const b of [...this.bots]) {
      if (id !== undefined && b.id !== id) continue;
      this.flushStats(b);
      b.close();
      this.bots.splice(this.bots.indexOf(b), 1);
      n++;
    }
    return n;
  }

  tick(): void {
    for (const b of this.bots) {
      b.tick();
      this.flushStats(b);
    }
  }

  private statsFile(b: Bot): string | null {
    const dir = this.opts.statsDir;
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.run}-${b.task.name}-${b.driver.kind}-${b.id}.jsonl`);
  }

  /** New trips: a line on the console and a JSON line in the stats file */
  private flushStats(b: Bot): void {
    for (const t of b.takeNewTrips()) {
      const file = this.statsFile(b);
      const meta = { bot: b.label, task: b.task.name, driver: b.driver.kind };
      if (file) appendFileSync(file, JSON.stringify({ kind: 'trip', ...meta, ...t, seconds: Object.fromEntries(Object.entries(t.ticks).map(([k, v]) => [k, +(v / 60).toFixed(2)])) }) + '\n');
      const ore = Object.values(t.deposited).reduce((a, n) => a + n, 0);
      this.log(`[bot ${b.label}] trip ${t.index}: ${((t.endTick - t.startTick) / 60).toFixed(0)} s, ${ore} ore, ${t.distance.toFixed(0)} units`);
    }
  }

  /** Write the closing summary of every bot (a JSON line and the table) */
  summarize(): string {
    const parts: string[] = [];
    for (const b of this.bots) {
      const s = b.stats.summary();
      const table = summaryTable(s, b.label);
      parts.push(table);
      const file = this.statsFile(b);
      if (file) appendFileSync(file, JSON.stringify({ kind: 'summary', bot: b.label, task: b.task.name, driver: b.driver.kind, ...s }) + '\n');
    }
    return parts.join('\n\n');
  }

  list(): string {
    return this.bots.map((b) => `${b.label}: ${b.task.status()} | trips ${b.stats.trips.length} | hold free ${Math.round(b.driver.hold().free)}`).join('\n') || 'No bots';
  }

  /** `/bot spawn <task> [n] [client|npc] [key=value ...]`, `/bot list`, `/bot stats [id]`, `/bot stop [id|all]`, `/bot tasks` */
  private command(_c: AdminConn, words: string[]): Result | null {
    try {
      assertDev();
      const [sub, ...rest] = words;
      switch (sub) {
        case 'spawn': {
          const task = rest.shift() ?? '';
          const o: TaskOpts = {};
          let n = 1, kind: DriverKind = 'client';
          for (const w of rest) {
            if (/^\d+$/.test(w)) n = Math.min(20, Number(w));
            else if (w === 'npc' || w === 'client') kind = w;
            else if (w.includes('=')) { const [k, v] = w.split('='); o[k] = v; }
          }
          const made = Array.from({ length: n }, () => this.spawn(task, kind, o));
          return { ok: true, text: `Spawned ${made.length} ${kind} bot(s) on ${task}: ${made.map((b) => b.driver.name).join(', ')}` };
        }
        case 'list': return { ok: true, text: this.list() };
        case 'stats': {
          const id = rest[0] ? Number(rest[0].replace('#', '')) : undefined;
          const bs = this.bots.filter((b) => id === undefined || b.id === id);
          return { ok: true, text: bs.map((b) => summaryTable(b.stats.summary(), b.label)).join('\n\n') || 'No bots' };
        }
        case 'stop': {
          const id = rest[0] && rest[0] !== 'all' ? Number(rest[0].replace('#', '')) : undefined;
          const text = this.summarize();
          const n = this.stop(id);
          return { ok: true, text: `Stopped ${n} bot(s)\n${text}` };
        }
        case 'tasks': return { ok: true, text: taskNames().map((t) => `${t}: ${taskDef(t)!.description}`).join('\n') };
        default: return { ok: true, text: '/bot spawn <task> [n] [client|npc] [key=value ...] · /bot list · /bot stats [id] · /bot stop [id|all] · /bot tasks' };
      }
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }
}
