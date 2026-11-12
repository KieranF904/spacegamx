/**
 * One-off, for the 2026-11-13 deploy: bring every saved pilot profile in PostgreSQL up to the current PROFILE_VERSION
 * (6: the field update, common/src/econ/fieldUpdate.ts) in one pass, with a report. The game does the same to any save
 * below v6 at its next login (server/src/game/pilots/session.ts: migrateProfile, then an immediate save); this is so it
 * happens to everyone at the deploy and the v6 step (and ShipRecord.loaner) can be removed straight after
 * (docs/deploy/runbook-2026-11-13.md). Modelled on the v5 tool (scripts/db/designUpdate.ts, removed 2026-11-10: git history).
 *
 * It runs migrateProfile exactly as the game server does (the starter kit, ship catalogue and economy built from the
 * game data of the release being deployed), and nothing else: what a login adds on top (the bank's refill to now, the
 * retired-skill refund, the training yard for returners) still happens at each pilot's next login.
 *
 * Usage (bundle first: scripts/deploy/vps-upgrade-profiles-v6.sh does it; DATABASE_URL in the environment, never printed):
 *   node upgrade.mjs [--dry-run] [--game-data <dir>]          reads every profile, writes nothing (the default)
 *   node upgrade.mjs --dry-run --file <profiles.json>         the same over a JSON copy, no database at all
 *                                                             ([{ userId, username, data }], as the runbook's SELECT makes)
 *   node upgrade.mjs --apply [--game-data <dir>] [--backup-table <name>]
 *       in ONE transaction: copies the whole profiles table to the backup table (default profiles_pre_v6; it must not
 *       exist yet), locks the rows, migrates, checks, writes each changed row (only where it is still below v6), commits.
 *       Refuses (nothing written) if any check fails or a game server still holds a pilot (profile_leases).
 *
 * Checks, per account (any failure: exit 2, and --apply writes nothing):
 *   - the result is at PROFILE_VERSION, and a second migration of it changes nothing (idempotent)
 *   - XP, credits and skill points are unchanged; the level is unchanged
 *   - the ship count is unchanged, or differs only by the loaner records the field update drops (and the fresh starter it
 *     gives a pilot who was flying one with no lost ship to go back to): reported as "loaner"
 *   - no retired kit or bond is left anywhere, and their recipe inputs are all in the bank's deposits
 *   - every ship and saved design kept by the pilot is the same but for guns turned by the gun shape rules
 *     (ships/gunFacing.ts: a part's `rot`, as every load does) and empty flags dropped
 *   - nothing but the fields the field update and the load clean-up own changed (anything else is "unexpected")
 *
 * Stop spacegame-server first (a running server saves over what this writes; a profile it has in memory is still v5).
 * Exit codes: 0 done, 1 error (nothing written), 2 a check failed (nothing written).
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { readGameDataFiles } from '../../server/src/data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig.js';
import {
  Economy, loadCatalog, migrateProfile, registerAmmo, registerRockTypes, setStationTable, setUnlockTable, starterKit,
  refundRetiredSkills, RETIRED_KITS, PROFILE_VERSION, OLDEST_PROFILE_VERSION,
  type Bag, type Catalog, type PlayerProfile, type StarterKit,
} from '../../common/src/index.js';

/** What the upgrade runs with: the starter kit, ship catalogue and economy as the game server builds them */
export interface UpgradeContext { kit: StarterKit; catalog: Catalog; econ: Economy }

export function loadUpgradeContext(gameDataDir: string): UpgradeContext {
  const cfg = loadShipConfigFromDisk(gameDataDir);
  const files = readGameDataFiles(gameDataDir);
  // (As GameData's constructor registers them: hangar bays by level, station tiers, rock types, which crates a gun takes)
  setUnlockTable(files.unlocks);
  setStationTable(files.station);
  registerRockTypes(files.mining);
  registerAmmo(files.items.items);
  // (As createShipBridge and GameServer: the catalogue, the Economy over it with the plan library, starterKit around the starter)
  const catalog = loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink, playerBubbles: (cfg as { playerBubbles?: never }).playerBubbles });
  const econ = new Economy(files.items, files.recipes, catalog, cfg.library ?? {});
  return { kit: starterKit(cfg.starter), catalog, econ };
}

export interface SavedProfile { userId: number; username: string | null; data: unknown }

/** Progress that must come through untouched */
export interface Progress { xp: number; level: number; skillPoints: number; credits: number; ships: number }

export interface UpgradeRow {
  userId: number;
  username: string | null;
  from: number;
  to: number;
  before: Progress;
  after: Progress;
  /** Retired kits and bonds found (storage, hold, unfinished craft runs) and what went into the bank's deposits for them */
  kits: Bag;
  deposited: Bag;
  /** Loaner records dropped, and what a flown loaner gave way to */
  loanersDropped: number;
  flies: string;
  /** Top-level fields that differ, each with a short note */
  changed: Record<string, string>;
  /** Fields that changed and are not the field update's to change */
  unexpected: string[];
  /** What the pilot's next login adds on top (not written by this tool) */
  atLogin: string[];
  /** Failed checks (empty: fine) */
  problems: string[];
}

export interface UpgradePlan {
  rows: UpgradeRow[];
  /** Already at the current version: left alone */
  skipped: { userId: number; username: string | null; version: number }[];
  /** The profiles to write, by account id */
  write: Map<number, PlayerProfile>;
  problems: number;
}

const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const sorted = (bag: Bag): Bag => Object.fromEntries(Object.entries(bag).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const add = (bag: Bag, id: string, n: number) => { if (n) bag[id] = (bag[id] ?? 0) + n; };
const isKit = (id: unknown): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_KITS, id);
/** JSON with sorted keys and undefined dropped: two documents equal as saved compare equal */
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const bagOf = (list: unknown): Bag => { const b: Bag = {}; for (const s of Array.isArray(list) ? list : []) if (s && typeof s.id === 'string') add(b, s.id, numOr(s.n, 0)); return b; };
const bagDiff = (a: Bag, b: Bag): string => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((id) => (a[id] ?? 0) !== (b[id] ?? 0)).map((id) => `${id} ${a[id] ?? 0}->${b[id] ?? 0}`).join(', ');
const shipsOf = (p: Record<string, unknown>) => (Array.isArray(p.hangar) ? p.hangar.filter((r) => r && typeof r === 'object' && Array.isArray((r as { blueprint?: { parts?: unknown } }).blueprint?.parts)) : []) as { blueprint: { name?: string; parts: unknown[] }; loaner?: boolean; lost?: boolean }[];
const shipNames = (p: Record<string, unknown>) => shipsOf(p).map((r) => `${r.blueprint.name ?? '?'}(${r.blueprint.parts.length})${r.loaner ? '[loaner]' : ''}${r.lost ? '[lost]' : ''}`).join(', ');

/** The fields the v6 field update (and the clean-up every load does) may change in a v5 save */
const EXPECTED = new Set(['version', 'storage', 'cargo', 'jobs', 'fabOrders', 'quickbar', 'bank', 'notices', 'hangar', 'ship', 'activeSlot', 'roster', 'tutorial', 'designs', 'ammo']);

/** A ship record (or a saved design) with what a load may change taken out: guns' turns (`rot`) and empty flags */
function normShip(v: unknown): string {
  if (!v || typeof v !== 'object') return 'null';
  const r = v as Record<string, unknown>;
  const strip = (bp: unknown) => (bp && typeof bp === 'object' && Array.isArray((bp as { parts?: unknown }).parts)
    ? { ...(bp as object), parts: ((bp as { parts: Record<string, unknown>[] }).parts).map(({ rot: _rot, ...part }) => part) } : bp);
  if (Array.isArray(r.parts)) return canonical(strip(r));
  const { lost, auto, paused, ghosts, hp, ...rest } = r;
  return canonical({ ...rest, ...(lost ? { lost } : {}), ...(auto ? { auto } : {}), ...(paused ? { paused } : {}), ghosts: Array.isArray(ghosts) ? ghosts : [], hp: hp ?? {}, blueprint: strip(r.blueprint) });
}
const turned = (a: unknown, b: unknown): number => {
  const pa = ((a as { blueprint?: { parts?: { rot?: number }[] }; parts?: { rot?: number }[] })?.blueprint?.parts ?? (a as { parts?: { rot?: number }[] })?.parts ?? []);
  const pb = ((b as { blueprint?: { parts?: { rot?: number }[] }; parts?: { rot?: number }[] })?.blueprint?.parts ?? (b as { parts?: { rot?: number }[] })?.parts ?? []);
  return pa.filter((p, i) => (p?.rot ?? 0) !== (pb[i]?.rot ?? 0)).length;
};

/** The upgrade over these saved profiles (raw, as the store holds them): nothing is changed in `profiles` */
export function planUpgrade(profiles: SavedProfile[], ctx: UpgradeContext, now = Date.now()): UpgradePlan {
  const rows: UpgradeRow[] = [];
  const skipped: UpgradePlan['skipped'] = [];
  const write = new Map<number, PlayerProfile>();
  for (const { userId, username, data } of [...profiles].sort((a, b) => a.userId - b.userId)) {
    const raw = (data ?? {}) as Record<string, unknown>;
    const from = numOr(raw.version, 0);
    if (from >= PROFILE_VERSION) { skipped.push({ userId, username, version: from }); continue; }
    const problems: string[] = [];
    const row: UpgradeRow = {
      userId, username, from, to: from,
      before: { xp: numOr(raw.xp, 0), level: numOr(raw.level, 1), skillPoints: numOr(raw.skillPoints, 0), credits: numOr(raw.credits, 0), ships: shipsOf(raw).length },
      after: { xp: 0, level: 0, skillPoints: 0, credits: 0, ships: 0 },
      kits: {}, deposited: {}, loanersDropped: 0, flies: 'unchanged', changed: {}, unexpected: [], atLogin: [], problems,
    };
    rows.push(row);
    if (from < OLDEST_PROFILE_VERSION) { problems.push(`v${from} is older than v${OLDEST_PROFILE_VERSION}: this build cannot upgrade it`); continue; }
    let p: PlayerProfile;
    try {
      p = migrateProfile(structuredClone(data), ctx.kit, ctx.catalog, { econ: ctx.econ, now });
    } catch (e) {
      problems.push(`migrateProfile threw: ${(e as Error).message}`);
      continue;
    }
    const out = p as unknown as Record<string, unknown>;
    row.to = p.version;
    row.after = { xp: p.xp, level: p.level, skillPoints: p.skillPoints, credits: p.credits, ships: shipsOf(out).length };

    // Kits and bonds as saved, and what their recipes took
    const expectDeposits: Bag = {};
    const kit = (id: string, n: number) => { if (n > 0) { add(row.kits, id, n); for (const [i, k] of Object.entries(RETIRED_KITS[id])) add(expectDeposits, i, k * n); } };
    for (const list of [raw.storage, raw.cargo]) for (const s of Array.isArray(list) ? list : []) if (s && isKit(s.id)) kit(s.id, Math.max(0, Math.floor(numOr(s.n, 0))));
    for (const j of Array.isArray(raw.jobs) ? raw.jobs : []) if (j && isKit(j.recipe)) kit(j.recipe, Math.max(0, Math.floor(numOr(j.count, 1)) - Math.floor(numOr(j.done, 0))));
    row.kits = sorted(row.kits);
    const depositsBefore = ((raw.bank as { deposits?: Bag } | undefined)?.deposits ?? {}) as Bag;
    const depositsAfter = (p.bank?.deposits ?? {}) as Bag;
    for (const id of new Set([...Object.keys(depositsBefore), ...Object.keys(depositsAfter)])) add(row.deposited, id, (depositsAfter[id] ?? 0) - (depositsBefore[id] ?? 0));
    row.deposited = sorted(row.deposited);

    // Loaners
    const loaners = shipsOf(raw).filter((r) => r.loaner).length;
    const flewLoaner = !!(raw.ship as { loaner?: boolean } | undefined)?.loaner;
    row.loanersDropped = loaners - shipsOf(out).filter((r) => r.loaner).length;
    const shipDelta = row.after.ships - row.before.ships;
    if (flewLoaner) row.flies = shipDelta === -loaners ? 'their lost ship (loaner gone)' : 'a fresh starter (loaner gone)';

    // Checks
    if (p.version !== PROFILE_VERSION) problems.push(`reached v${p.version}, not v${PROFILE_VERSION}`);
    if (row.after.xp !== row.before.xp) problems.push(`xp ${row.before.xp} -> ${row.after.xp}`);
    if (row.after.credits !== row.before.credits) problems.push(`credits ${row.before.credits} -> ${row.after.credits}`);
    if (row.after.skillPoints !== row.before.skillPoints) problems.push(`skill points ${row.before.skillPoints} -> ${row.after.skillPoints}`);
    if (row.after.level !== row.before.level) problems.push(`level ${row.before.level} -> ${row.after.level}`);
    if (canonical(p.skills) !== canonical(raw.skills ?? {})) problems.push('skills changed');
    // (ships: the same, or the loaners gone, plus one starter for a pilot who flew a loaner and had no lost ship)
    if (!(shipDelta === 0 && loaners === 0) && !(loaners > 0 && (shipDelta === -loaners || (flewLoaner && shipDelta === -loaners + 1)))) problems.push(`ship count ${row.before.ships} -> ${row.after.ships} (${loaners} loaner record(s))`);
    if (shipsOf(out).some((r) => r.loaner)) problems.push('a loaner record is left');
    if (!p.hangar[p.activeSlot] || p.hangar[p.activeSlot] !== p.ship) problems.push('the flown ship is not the active hangar slot');
    const left = [...p.storage, ...p.cargo].filter((s) => isKit(s.id)).length + p.jobs.filter((j) => isKit(j.recipe)).length + p.quickbar.filter(isKit).length + (p.fabOrders ?? []).filter((o) => isKit(o.item)).length;
    if (left) problems.push(`${left} retired kit reference(s) left`);
    if (canonical(sorted(expectDeposits)) !== canonical(row.deposited)) problems.push(`deposits ${JSON.stringify(row.deposited)} are not the kits' inputs ${JSON.stringify(sorted(expectDeposits))}`);
    if (!p.bank) problems.push('no repair bank');
    // Ships and designs the pilot keeps: the same but for guns turned (loaner records aside)
    let gunsTurned = 0;
    const rawHangar = Array.isArray(raw.hangar) ? raw.hangar as unknown[] : [];
    rawHangar.forEach((r0, i) => {
      if (!r0 || (r0 as { loaner?: boolean }).loaner) return;
      if (normShip(r0) !== normShip(p.hangar[i])) problems.push(`the ship in hangar slot ${i + 1} changed by more than its guns' turns`);
      else gunsTurned += turned(r0, p.hangar[i]);
    });
    const rawDesigns = Array.isArray(raw.designs) ? raw.designs as unknown[] : [];
    rawDesigns.forEach((d0, i) => {
      if (!d0) return;
      if (normShip(d0) !== normShip(p.designs?.[i])) problems.push(`saved design ${i + 1} changed by more than its guns' turns`);
      else gunsTurned += turned(d0, p.designs?.[i]);
    });
    if (canonical((raw.ammo as { open?: unknown } | undefined)?.open ?? {}) !== canonical(p.ammo?.open ?? {})) problems.push('opened ammunition crates changed');
    // (idempotent: the saved result, loaded again, is the same document)
    try {
      const again = migrateProfile(JSON.parse(JSON.stringify(p)), ctx.kit, ctx.catalog, { econ: ctx.econ, now });
      if (canonical(JSON.parse(JSON.stringify(again))) !== canonical(JSON.parse(JSON.stringify(p)))) problems.push('a second migration changes it again');
    } catch (e) { problems.push(`the result does not load again: ${(e as Error).message}`); }

    // What changed, field by field (as saved: JSON)
    const saved = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(raw), ...Object.keys(saved)])].sort()) {
      if (canonical(raw[k]) === canonical(saved[k])) continue;
      let note = raw[k] === undefined ? 'added' : saved[k] === undefined ? 'removed' : 'changed';
      if (k === 'version') note = `${from} -> ${p.version}`;
      else if (k === 'storage' || k === 'cargo') note = bagDiff(bagOf(raw[k]), bagOf(saved[k])) || 'reordered or cleaned (same items)';
      else if (k === 'quickbar') note = `${JSON.stringify(raw[k])} -> ${JSON.stringify(saved[k])}`;
      else if (k === 'hangar') note = `[${shipNames(raw)}] -> [${shipNames(saved)}]${gunsTurned ? ` (${gunsTurned} gun turn(s) across ships and designs: the gun shape rules)` : ''}`;
      else if (k === 'ship') note = `${(raw.ship as { blueprint?: { name?: string } })?.blueprint?.name ?? '?'} -> ${p.ship.blueprint.name ?? '?'} (the active hangar slot's record)`;
      else if (k === 'designs') note = 'guns turned (the gun shape rules); parts otherwise the same';
      else if (k === 'ammo') note = "old saves' unused load/prefer dropped; opened crates the same";
      else if (k === 'activeSlot') note = `${String(raw[k])} -> ${p.activeSlot}`;
      else if (k === 'bank') note = raw[k] === undefined ? `made (free part full; deposits: ${Object.keys(depositsAfter).length ? JSON.stringify(sorted(depositsAfter)) : 'none'})` : 'deposits added';
      else if (k === 'notices') note = `+${(p.notices?.length ?? 0) - (Array.isArray(raw.notices) ? raw.notices.length : 0)}: "${p.notices?.[p.notices.length - 1]?.text ?? ''}"`;
      else if (k === 'jobs') note = `${Array.isArray(raw.jobs) ? raw.jobs.length : 0} -> ${p.jobs.length} job(s)`;
      else if (k === 'tutorial') note = `${JSON.stringify(raw[k])} -> ${JSON.stringify(saved[k])}`;
      row.changed[k] = note;
      if (!EXPECTED.has(k)) row.unexpected.push(k);
    }
    if (row.unexpected.length) problems.push(`unexpected field(s) changed: ${row.unexpected.join(', ')}`);

    // What the next login adds (session.ts login): told, not written
    const probe = structuredClone(p);
    if (refundRetiredSkills(probe)) row.atLogin.push(`skill points ${p.skillPoints} -> ${probe.skillPoints} (retired or over-cap skills refunded, as every login does)`);
    if (!raw.tutorial) row.atLogin.push('enters as a returner (training yard offered; own profile set aside untouched)');

    if (!problems.length) write.set(userId, p);
  }
  return { rows, skipped, write, problems: rows.reduce((n, r) => n + r.problems.length, 0) };
}

/** The printed report (no secrets: account ids, usernames and game items only) */
export function reportJson(plan: UpgradePlan, mode: string): string {
  return JSON.stringify({ mode, version: PROFILE_VERSION, rows: plan.rows, skipped: plan.skipped, problems: plan.problems }, null, 2);
}

/** A few lines per player, for reading at a glance (stderr) */
export function reportSummary(plan: UpgradePlan): string {
  const lines: string[] = [];
  for (const r of plan.rows) {
    const b = r.before, a = r.after;
    lines.push(`${r.username ?? '(no name)'} #${r.userId}: v${r.from} -> v${r.to}  ${r.problems.length ? 'FAILED' : 'ok'}`);
    lines.push(`  xp ${b.xp}->${a.xp}, level ${b.level}->${a.level}, credits ${b.credits}->${a.credits}, skill points ${b.skillPoints}->${a.skillPoints}, ships ${b.ships}->${a.ships}`);
    const kits = Object.entries(r.kits).map(([id, n]) => `${n} ${id}`).join(', ');
    const dep = Object.entries(r.deposited).map(([id, n]) => `${n} ${id}`).join(', ');
    lines.push(`  kits: ${kits || 'none'}${dep ? `  -> bank deposits: ${dep}` : ''}${r.loanersDropped ? `; ${r.loanersDropped} loaner record(s) dropped, now flies ${r.flies}` : ''}`);
    for (const [k, note] of Object.entries(r.changed)) if (k !== 'version') lines.push(`  ${k}: ${note}`);
    for (const n of r.atLogin) lines.push(`  at next login: ${n}`);
    for (const p of r.problems) lines.push(`  PROBLEM: ${p}`);
  }
  for (const s of plan.skipped) lines.push(`${s.username ?? '(no name)'} #${s.userId}: already v${s.version}, skipped`);
  return lines.join('\n');
}

// ============================================================
// Postgres
// ============================================================

interface PgClient { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>; release(): void }
interface PgPool { connect(): Promise<PgClient>; end(): Promise<void> }

async function pgPool(connectionString: string): Promise<PgPool> {
  const name = 'pg';
  let pg: any;
  try {
    pg = await import(name);
  } catch {
    // (Run from the repo: 'pg' is the server's dependency, not the repo root's)
    const req = createRequire(join(process.cwd(), 'server/package.json'));
    pg = await import(pathToFileURL(req.resolve(name)).href);
  }
  const Pool = pg.Pool ?? pg.default?.Pool;
  return new Pool({ connectionString, max: 1 }) as PgPool;
}

const SELECT = 'SELECT p.user_id, u.username, p.data FROM profiles p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.user_id';
const rowsOf = (rows: any[]): SavedProfile[] => rows.map((x) => ({ userId: Number(x.user_id), username: typeof x.username === 'string' ? x.username : null, data: x.data }));

export class ChecksFailed extends Error {
  constructor(readonly plan: UpgradePlan) { super(`${plan.problems} check(s) failed: nothing written`); }
}

/**
 * Reads every profile and plans the upgrade. With `apply`: one transaction, the backup table made from the whole
 * profiles table first, the rows locked, each upgraded profile written back as PostgresProfileStore.save stores it
 * (version column and document), only over a row still below the current version. Any failed check: rolled back.
 */
export async function runUpgrade(databaseUrl: string, ctx: UpgradeContext, apply: boolean, backupTable: string): Promise<UpgradePlan> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(backupTable)) throw new Error('--backup-table: lower-case letters, digits and _ only');
  const pool = await pgPool(databaseUrl);
  const client = await pool.connect();
  try {
    if (!apply) {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const plan = planUpgrade(rowsOf((await client.query(SELECT)).rows), ctx);
      await client.query('ROLLBACK');
      return plan;
    }
    await client.query('BEGIN');
    // A game server that still holds a pilot would save its in-memory (older) copy over ours
    const leases = (await client.query("SELECT to_regclass('profile_leases') AS t")).rows[0]?.t
      ? Number((await client.query('SELECT count(*) AS n FROM profile_leases WHERE expires_at >= now()')).rows[0].n) : 0;
    if (leases) throw new Error(`${leases} pilot(s) are still held by a game server (profile_leases): stop spacegame-server, wait 90 s for the leases to lapse, and run this again`);
    if ((await client.query('SELECT to_regclass($1) AS t', [backupTable])).rows[0]?.t) throw new Error(`the backup table ${backupTable} already exists: pass --backup-table <another name> (or the upgrade was already applied)`);
    await client.query(`CREATE TABLE ${backupTable} AS SELECT * FROM profiles`);
    const plan = planUpgrade(rowsOf((await client.query(`${SELECT} FOR UPDATE OF p`)).rows), ctx);
    if (plan.problems) throw new ChecksFailed(plan);
    for (const [id, p] of plan.write) {
      // (Only a row still below this version: never over one the game upgraded meanwhile)
      const r = await client.query(
        "UPDATE profiles SET version = $2, data = $3, updated_at = now() WHERE user_id = $1 AND COALESCE((data->>'version')::int, 0) < $2",
        [id, p.version, JSON.stringify(p)]);
      if (r.rowCount !== 1) throw new Error(`profile ${id}: expected to write 1 row, wrote ${r.rowCount}`);
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
  for (const p of [join(here, '../../data'), join(here, 'data'), join(process.cwd(), 'data')]) if (existsSync(join(p, 'items.json'))) return p;
  throw new Error('game data not found: pass --game-data');
}

interface Args { mode: 'dry-run' | 'apply'; gameData?: string; file?: string; backupTable: string }

function parseArgs(argv: string[]): Args {
  let mode: Args['mode'] | undefined;
  const a: Args = { mode: 'dry-run', backupTable: 'profiles_pre_v6' };
  const value = (i: number, k: string) => { const v = argv[i]; if (!v) throw new Error(`${k} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run' || k === '--apply') {
      if (mode) throw new Error('pass one of --dry-run or --apply');
      mode = k === '--apply' ? 'apply' : 'dry-run';
    } else if (k === '--game-data') a.gameData = value(++i, k);
    else if (k === '--file') a.file = value(++i, k);
    else if (k === '--backup-table') a.backupTable = value(++i, k);
    else throw new Error(`unknown option ${k}`);
  }
  a.mode = mode ?? 'dry-run';
  if (a.file && a.mode === 'apply') throw new Error('--file is for dry runs only (there is nothing to apply to)');
  return a;
}

export async function main(argv: string[]): Promise<number> {
  const url = process.env.DATABASE_URL || '';
  const scrub = (s: string) => (url ? s.split(url).join('<DATABASE_URL>') : s);
  try {
    const args = parseArgs(argv);
    const ctx = loadUpgradeContext(resolve(args.gameData ?? defaultGameData()));
    let plan: UpgradePlan;
    if (args.file) {
      const list = JSON.parse(readFileSync(args.file, 'utf-8')) as SavedProfile[];
      plan = planUpgrade(list.map((x) => ({ userId: Number(x.userId), username: x.username ?? null, data: x.data })), ctx);
    } else {
      if (!url) throw new Error('DATABASE_URL is not set (or pass --file <profiles.json> for a dry run over a copy)');
      plan = await runUpgrade(url, ctx, args.mode === 'apply', args.backupTable);
    }
    console.log(reportJson(plan, args.file ? 'dry-run (file)' : args.mode));
    console.error(reportSummary(plan));
    const ok = plan.rows.filter((r) => !r.problems.length).length;
    console.error(args.mode === 'apply'
      ? `applied: ${ok} profile(s) upgraded to v${PROFILE_VERSION}, ${plan.skipped.length} already there; the table as it was: ${args.backupTable}`
      : `dry run: ${ok} profile(s) would be upgraded to v${PROFILE_VERSION}, ${plan.rows.length - ok} FAILED their checks, ${plan.skipped.length} already there; nothing written`);
    return plan.problems ? 2 : 0;
  } catch (e) {
    if (e instanceof ChecksFailed) {
      console.log(reportJson(e.plan, 'apply (refused)'));
      console.error(reportSummary(e.plan));
      console.error(`refused: ${e.message}`);
      return 2;
    }
    console.error(scrub(`error: ${(e as Error).message}`));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
