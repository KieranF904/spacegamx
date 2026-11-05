/**
 * The v5 ship wipe, run over every saved profile in PostgreSQL at once (common/src/econ/profile.ts
 * migrateProfileShips: every ship broken down into storage, a fresh starter in slot 1). The game does the same
 * to any save it loads below v5, so a profile this misses is wiped at its next login; this is so it happens to
 * everyone at the deploy, with a report.
 *
 * Usage (DATABASE_URL in the environment; it is never printed):
 *   npx tsx scripts/db/shipWipe.ts --dry-run [--game-data <data dir>]
 *   npx tsx scripts/db/shipWipe.ts --apply   [--game-data <data dir>]
 *     --dry-run    reads the profiles and writes nothing: prints one row per player and the totals, as JSON
 *     --apply      the same, then writes every changed profile in one transaction (rows locked while it runs);
 *                  profiles already at v5 or later are skipped
 *     --game-data  the folder holding items.json, recipes.json and ships/ (default: this repo's data/). Use the
 *                  release being deployed: the fresh starter is whatever its ships/blueprints/sparrow-t.json is
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
  Economy, loadCatalog, migrateProfile, starterKit, PROFILE_VERSION,
  type Bag, type Catalog, type PlayerProfile, type ShipWipeReport, type StarterKit,
} from '../../common/src/index.js';

/** What the wipe runs with: the game's starter kit, ship catalogue and economy, as the server builds them */
export interface WipeContext { kit: StarterKit; catalog: Catalog; econ: Economy }

export function loadWipeContext(gameDataDir: string): WipeContext {
  const cfg = loadShipConfigFromDisk(gameDataDir);
  const files = readGameDataFiles(gameDataDir);
  // (As GameServer: createShipBridge's catalogue, the Economy over it, starterKit around the starter ship)
  const catalog = loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink });
  const econ = new Economy(files.items, files.recipes, catalog, cfg.library ?? {});
  econ.tuning = cfg.tuning;
  return { kit: starterKit(cfg.starter), catalog, econ };
}

/** One player's line in the report */
export interface WipeRow extends ShipWipeReport {
  userId: number;
  /** Version before */
  from: number;
  level: number;
}

export interface WipeTotals {
  players: number;
  skipped: number;
  slotsDeleted: number;
  designsDeleted: number;
  refund: Bag;
  cargoMoved: Bag;
  jobsDetached: number;
  debtForgiven: number;
  planItemsDropped: Bag;
}

export interface WipePlan {
  rows: WipeRow[];
  /** Already at v5 or later: left alone */
  skipped: { userId: number; version: number }[];
  totals: WipeTotals;
  /** The profiles to write, by account id */
  write: Map<number, PlayerProfile>;
}

const sumInto = (into: Bag, bag: Bag) => { for (const [id, n] of Object.entries(bag)) into[id] = (into[id] ?? 0) + n; };
const sorted = (bag: Bag): Bag => Object.fromEntries(Object.entries(bag).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The wipe over these saved profiles (raw, as the store holds them): nothing is changed in `profiles` */
export function planShipWipe(profiles: { userId: number; data: unknown }[], ctx: WipeContext): WipePlan {
  const rows: WipeRow[] = [];
  const skipped: WipePlan['skipped'] = [];
  const write = new Map<number, PlayerProfile>();
  for (const { userId, data } of [...profiles].sort((a, b) => a.userId - b.userId)) {
    const from = typeof (data as { version?: unknown })?.version === 'number' ? (data as { version: number }).version : 1;
    if (from >= 5) { skipped.push({ userId, version: from }); continue; }
    let report: ShipWipeReport | null = null;
    const p = migrateProfile(structuredClone(data), ctx.kit, ctx.catalog, { econ: ctx.econ, onShipWipe: (r) => { report = r; } });
    if (!report || p.version !== PROFILE_VERSION) throw new Error(`profile ${userId}: the migration did not reach v${PROFILE_VERSION}`);
    const r = report as ShipWipeReport;
    rows.push({ userId, from, level: p.level, ...r, refund: sorted(r.refund), cargoMoved: sorted(r.cargoMoved), planItemsDropped: sorted(r.planItemsDropped) });
    write.set(userId, p);
  }
  const totals: WipeTotals = { players: rows.length, skipped: skipped.length, slotsDeleted: 0, designsDeleted: 0, refund: {}, cargoMoved: {}, jobsDetached: 0, debtForgiven: 0, planItemsDropped: {} };
  for (const r of rows) {
    totals.slotsDeleted += r.slotsDeleted;
    totals.designsDeleted += r.designsDeleted;
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

/** The printed report (no secrets: account ids and game items only) */
export function reportJson(plan: WipePlan, mode: 'dry-run' | 'apply'): string {
  return JSON.stringify({ mode, version: PROFILE_VERSION, rows: plan.rows, skipped: plan.skipped, totals: plan.totals }, null, 2);
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

/**
 * Reads every profile and plans the wipe; with `apply`, in one transaction with the rows locked, writes each
 * wiped profile back (as PostgresProfileStore.save stores it) and commits. Without, nothing is written.
 */
export async function runShipWipe(databaseUrl: string, ctx: WipeContext, apply: boolean): Promise<WipePlan> {
  const pool = await pgPool(databaseUrl);
  const client = await pool.connect();
  try {
    if (!apply) {
      const r = await client.query('SELECT user_id, data FROM profiles ORDER BY user_id');
      return planShipWipe(r.rows.map((x) => ({ userId: Number(x.user_id), data: x.data })), ctx);
    }
    await client.query('BEGIN');
    const r = await client.query('SELECT user_id, data FROM profiles ORDER BY user_id FOR UPDATE');
    const plan = planShipWipe(r.rows.map((x) => ({ userId: Number(x.user_id), data: x.data })), ctx);
    for (const [id, p] of plan.write) {
      // (Only a row still below v5: never over one the game wiped meanwhile)
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
    const ctx = loadWipeContext(resolve(args.gameData ?? defaultGameData()));
    const plan = await runShipWipe(url, ctx, args.mode === 'apply');
    console.log(reportJson(plan, args.mode));
    console.error(args.mode === 'apply'
      ? `applied: ${plan.rows.length} profile(s) wiped to v${PROFILE_VERSION}, ${plan.skipped.length} already done`
      : `dry run: ${plan.rows.length} profile(s) would be wiped, ${plan.skipped.length} already done; nothing written`);
    return 0;
  } catch (e) {
    console.error(scrub(`error: ${(e as Error).message}`));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
