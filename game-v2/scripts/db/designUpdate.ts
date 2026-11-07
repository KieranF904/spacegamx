/**
 * The design update (PROFILE_VERSION 5), run over every saved profile in PostgreSQL at once
 * (common/src/econ/designUpdate.ts): each account's mapped ships swapped for their remakes on the ports core
 * (data/ships/designUpdate.json, by username), everything else broken down into storage. Only ships change. The game
 * does the same to any save it loads below v5 (with the same mapping), so a profile this misses is swapped at its
 * next login; this is so it happens to everyone at the deploy, with a report.
 *
 * Usage (DATABASE_URL in the environment; it is never printed):
 *   npx tsx scripts/db/designUpdate.ts --dry-run [--game-data <data dir>]
 *   npx tsx scripts/db/designUpdate.ts --apply   [--game-data <data dir>]
 *     --dry-run    reads the profiles (and their usernames) and writes nothing: prints one row per player and the
 *                  totals, as JSON
 *     --apply      the same, then writes every changed profile in one transaction (rows locked while it runs);
 *                  profiles already at v5 or later are skipped
 *     --game-data  the folder holding items.json, recipes.json and ships/ (default: this repo's data/). Use the
 *                  release being deployed: its ships/designUpdate.json, ships/blueprints/remakes and starter are used
 *
 * Stop spacegame-server first (a running server saves over what this writes). Steps: docs/areas/ops-tools.md.
 * Exit codes: 0 done, 1 error (nothing written).
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { readGameDataFiles } from '../../server/src/data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig.js';
import {
  Economy, loadCatalog, migrateProfile, registerAmmo, starterKit, PROFILE_VERSION,
  type Bag, type Catalog, type DesignUpdate, type DesignUpdateReport, type PlayerProfile, type ShipTuning, type StarterKit,
} from '../../common/src/index.js';

/** What the update runs with: the game's starter kit, ship catalogue, tuning and economy as the server builds them, and the mapping */
export interface UpdateContext { kit: StarterKit; catalog: Catalog; econ: Economy; tuning: ShipTuning; designUpdate?: DesignUpdate }

export function loadUpdateContext(gameDataDir: string): UpdateContext {
  const cfg = loadShipConfigFromDisk(gameDataDir);
  const files = readGameDataFiles(gameDataDir);
  // (As GameServer: createShipBridge's catalogue, the Economy over it, starterKit around the starter ship)
  const catalog = loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink });
  const econ = new Economy(files.items, files.recipes, catalog, cfg.library ?? {});
  econ.tuning = cfg.tuning;
  // (Which crates each gun takes, as GameData registers them: a swapped ship keeps the loadout its new guns take)
  registerAmmo(files.items.items);
  return { kit: starterKit(cfg.starter), catalog, econ, tuning: cfg.tuning, designUpdate: cfg.designUpdate };
}

/** Progress that must come through untouched: shown before and after for every player */
export interface Progress { xp: number; level: number; skillPoints: number; credits: number }

/** One player's line in the report */
export interface UpdateRow extends DesignUpdateReport {
  userId: number;
  username: string | null;
  /** Version before */
  from: number;
  before: Progress;
  after: Progress;
}

export interface UpdateTotals {
  players: number;
  skipped: number;
  swapped: number;
  wiped: number;
  freshStarters: number;
  refund: Bag;
  cargoMoved: Bag;
  jobsDetached: number;
  debtForgiven: number;
  planItemsDropped: Bag;
}

export interface UpdatePlan {
  rows: UpdateRow[];
  /** Already at v5 or later: left alone */
  skipped: { userId: number; username: string | null; version: number }[];
  totals: UpdateTotals;
  /** The profiles to write, by account id */
  write: Map<number, PlayerProfile>;
}

export interface SavedProfile { userId: number; username: string | null; data: unknown }

const sumInto = (into: Bag, bag: Bag) => { for (const [id, n] of Object.entries(bag)) into[id] = (into[id] ?? 0) + n; };
const sorted = (bag: Bag): Bag => Object.fromEntries(Object.entries(bag).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The update over these saved profiles (raw, as the store holds them): nothing is changed in `profiles` */
export function planDesignUpdate(profiles: SavedProfile[], ctx: UpdateContext): UpdatePlan {
  const rows: UpdateRow[] = [];
  const skipped: UpdatePlan['skipped'] = [];
  const write = new Map<number, PlayerProfile>();
  for (const { userId, username, data } of [...profiles].sort((a, b) => a.userId - b.userId)) {
    const raw = (data ?? {}) as Record<string, unknown>;
    const from = numOr(raw.version, 1);
    if (from >= 5) { skipped.push({ userId, username, version: from }); continue; }
    let report: DesignUpdateReport | null = null;
    const p = migrateProfile(structuredClone(data), ctx.kit, ctx.catalog, {
      econ: ctx.econ, designUpdate: ctx.designUpdate, username: username ?? undefined, tuning: ctx.tuning, onDesignUpdate: (r) => { report = r; },
    });
    if (!report || p.version !== PROFILE_VERSION) throw new Error(`profile ${userId}: the migration did not reach v${PROFILE_VERSION}`);
    const r = report as DesignUpdateReport;
    const before: Progress = { xp: numOr(raw.xp, 0), level: numOr(raw.level, 1), skillPoints: numOr(raw.skillPoints, 0), credits: numOr(raw.credits, 0) };
    const after: Progress = { xp: p.xp, level: p.level, skillPoints: p.skillPoints, credits: p.credits };
    rows.push({ userId, username, from, before, after, ...r, refund: sorted(r.refund), cargoMoved: sorted(r.cargoMoved), planItemsDropped: sorted(r.planItemsDropped) });
    write.set(userId, p);
  }
  const totals: UpdateTotals = { players: rows.length, skipped: skipped.length, swapped: 0, wiped: 0, freshStarters: 0, refund: {}, cargoMoved: {}, jobsDetached: 0, debtForgiven: 0, planItemsDropped: {} };
  for (const r of rows) {
    totals.swapped += r.swapped.length;
    totals.wiped += r.wiped.length;
    if (r.freshStarter) totals.freshStarters++;
    totals.jobsDetached += r.jobsDetached;
    totals.debtForgiven += r.debtForgiven;
    sumInto(totals.refund, r.refund);
    sumInto(totals.cargoMoved, r.cargoMoved);
    sumInto(totals.planItemsDropped, r.planItemsDropped);
  }
  totals.refund = sorted(totals.refund);
  totals.cargoMoved = sorted(totals.cargoMoved);
  totals.planItemsDropped = sorted(totals.planItemsDropped);
  return { rows, skipped, totals, write };
}

/** The printed report (no secrets: account ids, usernames and game items only) */
export function reportJson(plan: UpdatePlan, mode: 'dry-run' | 'apply'): string {
  return JSON.stringify({ mode, version: PROFILE_VERSION, rows: plan.rows, skipped: plan.skipped, totals: plan.totals }, null, 2);
}

/** One line per player, for reading at a glance (stderr): who swapped what, what was wiped, progress before and after */
export function reportSummary(plan: UpdatePlan): string {
  const lines: string[] = [];
  for (const r of plan.rows) {
    const who = `${r.username ?? '(no name)'} #${r.userId} v${r.from} ${r.mode}`;
    const prog = `xp ${r.before.xp}->${r.after.xp}, level ${r.before.level}->${r.after.level}, credits ${r.before.credits}->${r.after.credits}, skill points ${r.before.skillPoints}->${r.after.skillPoints}`;
    const sw = r.swapped.map((s) => `${s.slot !== undefined ? `slot ${s.slot + 1}` : `design ${s.design! + 1}`} ${s.from.name} (${s.from.parts}) -> ${s.to}${s.onOrder ? ' (on order)' : ''}`);
    const wp = r.wiped.map((w) => `${w.slot !== undefined ? `slot ${w.slot + 1}` : w.design !== undefined ? `design ${w.design + 1}` : 'roster'} ${w.from.name} (${w.from.parts}): ${w.why}`);
    const refund = Object.entries(r.refund).map(([id, n]) => `${n} ${id}`).join(', ');
    lines.push(`${who}: ${prog}`);
    if (sw.length) lines.push(`  swapped: ${sw.join('; ')}`);
    if (wp.length) lines.push(`  wiped: ${wp.join('; ')}`);
    lines.push(`  flies slot ${r.activeSlot + 1}${r.freshStarter ? ' (fresh starter)' : ''}${r.loaner ? ' (loaner)' : ''}${refund ? `; refund: ${refund}` : ''}`);
  }
  for (const s of plan.skipped) lines.push(`${s.username ?? '(no name)'} #${s.userId}: already v${s.version}, skipped`);
  return lines.join('\n');
}

// ============================================================
// Postgres
// ============================================================

interface PgClient { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void }
interface PgPool { connect(): Promise<PgClient>; end(): Promise<void> }

async function pgPool(connectionString: string): Promise<PgPool> {
  const name = 'pg';
  let pg: any;
  try {
    pg = await import(name);
  } catch {
    // (Run from the repo: 'pg' is the server's dependency, not the repo root's)
    const req = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../server/package.json'));
    pg = await import(pathToFileURL(req.resolve(name)).href);
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  return new Pool({ connectionString, max: 1 }) as PgPool;
}

const SELECT = 'SELECT p.user_id, u.username, p.data FROM profiles p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.user_id';
const rowsOf = (rows: any[]): SavedProfile[] => rows.map((x) => ({ userId: Number(x.user_id), username: typeof x.username === 'string' ? x.username : null, data: x.data }));

/**
 * Reads every profile (with its account's username) and plans the update; with `apply`, in one transaction with
 * the rows locked, writes each updated profile back (as PostgresProfileStore.save stores it) and commits. Without,
 * nothing is written.
 */
export async function runDesignUpdate(databaseUrl: string, ctx: UpdateContext, apply: boolean): Promise<UpdatePlan> {
  const pool = await pgPool(databaseUrl);
  const client = await pool.connect();
  try {
    if (!apply) return planDesignUpdate(rowsOf((await client.query(SELECT)).rows), ctx);
    await client.query('BEGIN');
    const plan = planDesignUpdate(rowsOf((await client.query(`${SELECT} FOR UPDATE OF p`)).rows), ctx);
    for (const [id, p] of plan.write) {
      // (Only a row still below v5: never over one the game updated meanwhile)
      await client.query(
        "UPDATE profiles SET version = $2, data = $3, updated_at = now() WHERE user_id = $1 AND COALESCE((data->>'version')::int, 1) < 5",
        [id, p.version, JSON.stringify(p)]);
    }
    await client.query('COMMIT');
    return plan;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// ============================================================
// CLI
// ============================================================

function defaultGameData(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../../data'), join(here, 'data')]) if (existsSync(join(p, 'items.json'))) return p;
  throw new Error('game data not found: pass --game-data');
}

interface Args { mode: 'dry-run' | 'apply'; gameData?: string }

function parseArgs(argv: string[]): Args {
  let mode: Args['mode'] | undefined;
  let gameData: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run' || k === '--apply') {
      if (mode) throw new Error('pass one of --dry-run or --apply');
      mode = k === '--apply' ? 'apply' : 'dry-run';
    } else if (k === '--game-data') {
      gameData = argv[++i];
      if (!gameData) throw new Error('--game-data needs a value');
    } else throw new Error(`unknown option ${k}`);
  }
  if (!mode) throw new Error('pass --dry-run or --apply');
  return { mode, gameData };
}

export async function main(argv: string[]): Promise<number> {
  const url = process.env.DATABASE_URL || '';
  const scrub = (s: string) => (url ? s.split(url).join('<DATABASE_URL>') : s);
  try {
    const args = parseArgs(argv);
    if (!url) throw new Error('DATABASE_URL is not set');
    const ctx = loadUpdateContext(resolve(args.gameData ?? defaultGameData()));
    if (!ctx.designUpdate) throw new Error('no ships/designUpdate.json in the game data: every ship would be wiped');
    const plan = await runDesignUpdate(url, ctx, args.mode === 'apply');
    console.log(reportJson(plan, args.mode));
    console.error(reportSummary(plan));
    console.error(args.mode === 'apply'
      ? `applied: ${plan.rows.length} profile(s) updated to v${PROFILE_VERSION} (${plan.totals.swapped} swapped, ${plan.totals.wiped} wiped), ${plan.skipped.length} already done`
      : `dry run: ${plan.rows.length} profile(s) would be updated (${plan.totals.swapped} swapped, ${plan.totals.wiped} wiped), ${plan.skipped.length} already done; nothing written`);
    return 0;
  } catch (e) {
    console.error(scrub(`error: ${(e as Error).message}`));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
