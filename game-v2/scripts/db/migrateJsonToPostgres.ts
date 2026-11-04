/**
 * Copies the game's JSON stores into PostgreSQL, then reads everything back through the Postgres stores' own read
 * paths and checks it against the JSON. It does NOT switch anything over: the game keeps running on JSON until
 * USER_STORE_BACKEND=postgres is set (docs/ops/postgres-migration.md).
 *
 *   accounts  data/lobby/users.json      -> users, sessions (unexpired only), the users id sequence (= nextUserId)
 *   profiles  data/profiles/<id>.json    -> profiles (jsonb, keyed by account id)
 *   docs      data/profiles/_<key>.json  -> game_docs (the rankings)
 *
 * Everything else (world memory, contributor files, the deleted-accounts list, backups, the site) stays on JSON.
 *
 * Usage (DATABASE_URL in the environment; it is never printed):
 *   npx tsx scripts/db/migrateJsonToPostgres.ts --data <data dir> [--dry-run] [--replace] [--verify-only] [--report <file.json>]
 *     --data          the folder holding lobby/ and profiles/ (and ships/, for the profile normalisation check)
 *     --dry-run       load and plan; with DATABASE_URL also run the whole write in a transaction and roll it back
 *     --replace       the target already has data: empty the four tables and copy again (a re-sync)
 *     --verify-only   write nothing: compare the database with the JSON as it is now
 *     --report        also write the verification report (no secrets: hashes, tokens and emails are compared, not shown)
 *     --schema        server-browser/schema.sql (default: beside this script's repo, or ./schema.sql)
 *     --game-data     where ships/ is (default: --data)
 *
 * The JSON is read from a private copy (the JSON stores can write when they load: a .bak, an admin flag), so the
 * live files are only ever read. All writes go in one transaction: a failure leaves the database as it was.
 * Exit codes: 0 all good, 1 error or a failed check, 2 refused (target not empty, no --replace).
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { JsonUserStore } from '../../server-browser/src/accounts/JsonUserStore.js';
import { PostgresUserStore } from '../../server-browser/src/accounts/PostgresUserStore.js';
import type { SessionRecord, UserRecord } from '../../server-browser/src/accounts/types.js';
import { JsonProfileStore } from '../../server/src/profile/JsonProfileStore.js';
import { PostgresProfileStore } from '../../server/src/profile/PostgresProfileStore.js';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig.js';
import { loadCatalog, migrateProfile, type Catalog, type StarterKit } from '../../common/src/index.js';

// ============================================================
// The JSON side
// ============================================================

/** A users.json row (credentials included) */
export interface StoredUser {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  salt: string;
  is_admin: boolean;
  /** Missing in records from before the owner rank: false */
  is_owner?: boolean;
  created_at: string;
  banned_until?: number | null;
  ban_reason?: string | null;
  banned_by?: string | null;
}

export interface JsonSource {
  users: StoredUser[];
  /** Every session in the file (expired ones are not copied) */
  sessions: SessionRecord[];
  nextUserId: number;
  /** Raw profile documents by account id, as JsonProfileStore.load() returns them */
  profiles: Map<number, unknown>;
  profileMtimes: Map<number, Date>;
  /** Game-wide documents (_<key>.json) by key, as JsonProfileStore.loadDoc() returns them */
  docs: Map<string, unknown>;
  /** The deleted-accounts list (stays on JSON; checked for consistency) */
  deletedIds: number[];
  /** What the loaders changed compared with the files (normally nothing) */
  notes: string[];
}

/** Reads the stores from `dataDir` through their own loaders, from a private copy (removed afterwards) */
export async function loadJsonSource(dataDir: string): Promise<JsonSource> {
  const lobby = join(dataDir, 'lobby');
  const profilesDir = join(dataDir, 'profiles');
  if (!existsSync(join(lobby, 'users.json'))) throw new Error(`no accounts file at ${join(lobby, 'users.json')}`);
  const snap = mkdtempSync(join(tmpdir(), 'pg-migrate-snapshot-'));
  try {
    cpSync(lobby, join(snap, 'lobby'), { recursive: true, preserveTimestamps: true });
    if (existsSync(profilesDir)) cpSync(profilesDir, join(snap, 'profiles'), { recursive: true, preserveTimestamps: true });
    const notes: string[] = [];

    // --- accounts: JsonUserStore's own load (normalisation, nextUserId), never seeding an admin
    const usersFile = join(snap, 'lobby', 'users.json');
    const rawFile = JSON.parse(readFileSync(usersFile, 'utf-8'));
    const env = { NODE_ENV: process.env.NODE_ENV, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
    process.env.NODE_ENV = 'production'; // (outside production the store seeds an admin/admin account when there's no admin)
    delete process.env.ADMIN_PASSWORD;
    let users: StoredUser[];
    let sessions: SessionRecord[];
    let nextUserId: number;
    const log = console.log;
    console.log = () => {}; // (its start-up line names the snapshot path: noise)
    try {
      const store = new JsonUserStore(usersFile);
      const s = store as unknown as { users: StoredUser[]; sessions: SessionRecord[]; nextUserId: number };
      users = structuredClone(s.users);
      sessions = structuredClone(s.sessions);
      nextUserId = s.nextUserId;
      await store.close();
    } finally {
      console.log = log;
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const rawUsers = Array.isArray(rawFile.users) ? rawFile.users : rawFile.users ? [rawFile.users] : [];
    if (JSON.stringify(rawUsers) !== JSON.stringify(users)) notes.push('accounts: the loader changed the users list (e.g. the "admin" account made an admin), copied as the lobby would load it');
    if (rawFile.nextUserId === undefined) notes.push(`accounts: users.json has no nextUserId; the loader derives ${nextUserId} (highest id + 1)`);

    // --- profiles and game-wide docs: JsonProfileStore's own load (a broken file falls back to its newest backup)
    const profiles = new Map<number, unknown>();
    const profileMtimes = new Map<number, Date>();
    const docs = new Map<string, unknown>();
    const snapProfiles = join(snap, 'profiles');
    if (existsSync(snapProfiles)) {
      const names = readdirSync(snapProfiles);
      const ids = names.filter((n) => /^\d+\.json$/.test(n)).map((n) => Number(n.slice(0, -5))).sort((a, b) => a - b);
      const keys = names.filter((n) => /^_[a-z0-9_-]+\.json$/i.test(n)).map((n) => n.slice(1, -5)).sort();
      const skipped = names.filter((n) => !/^\d+\.json$/.test(n) && !/^_[a-z0-9_-]+\.json$/i.test(n) && n !== 'backups');
      if (skipped.length) notes.push(`profiles: not profiles, left on disk: ${skipped.join(', ')}`);
      const store = new JsonProfileStore(snapProfiles);
      for (const id of ids) {
        const mtime = statSync(join(snapProfiles, `${id}.json`)).mtime;
        const doc = await store.load(id);
        if (doc === null) { notes.push(`profiles: ${id}.json could not be read and has no backup: not copied`); continue; }
        if (!existsSync(join(snapProfiles, `${id}.json`))) notes.push(`profiles: ${id}.json was unreadable: its newest backup is copied instead`);
        profiles.set(id, doc);
        profileMtimes.set(id, mtime);
      }
      for (const key of keys) {
        const doc = await store.loadDoc(key);
        if (doc === null) { notes.push(`docs: _${key}.json could not be read: not copied`); continue; }
        docs.set(key, doc);
      }
      await store.close();
    }

    // --- the deleted-accounts list (DeletedAccounts' file format; nothing to copy)
    let deletedIds: number[] = [];
    const deletedFile = join(snap, 'lobby', 'deleted-accounts.json');
    if (existsSync(deletedFile)) {
      try {
        const raw = JSON.parse(readFileSync(deletedFile, 'utf-8'));
        deletedIds = Array.isArray(raw) ? raw.filter((e) => Number.isInteger(e?.id)).map((e) => e.id) : [];
      } catch { notes.push('deleted accounts: the list could not be read'); }
    }
    return { users, sessions, nextUserId, profiles, profileMtimes, docs, deletedIds, notes };
  } finally {
    rmSync(snap, { recursive: true, force: true });
  }
}

/** What gets written: orphans (a profile or session of an account that no longer exists) and expired sessions are left out */
export interface Plan {
  users: StoredUser[];
  sessions: SessionRecord[];
  profiles: [number, unknown][];
  docs: [string, unknown][];
  nextUserId: number;
  skipped: string[];
}

export function planMigration(src: JsonSource, now = Date.now()): Plan {
  const ids = new Set(src.users.map((u) => u.id));
  const skipped: string[] = [];
  const expired = src.sessions.filter((s) => s.expires_at < now).length;
  if (expired) skipped.push(`${expired} expired session(s)`);
  const orphanSessions = src.sessions.filter((s) => s.expires_at >= now && !ids.has(s.user_id)).length;
  if (orphanSessions) skipped.push(`${orphanSessions} session(s) of accounts that no longer exist`);
  const orphanProfiles = [...src.profiles.keys()].filter((id) => !ids.has(id));
  if (orphanProfiles.length) skipped.push(`profiles of accounts that no longer exist: ${orphanProfiles.join(', ')}`);
  return {
    users: src.users,
    sessions: src.sessions.filter((s) => s.expires_at >= now && ids.has(s.user_id)),
    profiles: [...src.profiles].filter(([id]) => ids.has(id)),
    docs: [...src.docs],
    nextUserId: src.nextUserId,
    skipped,
  };
}

// ============================================================
// The schema
// ============================================================

/** The DDL of schema.sql (CREATE / ALTER only): its seed admin account (password "admin") is never applied */
export function schemaStatements(sql: string): { ddl: string[]; dropped: string[] } {
  // (Comments out first: they hold semicolons. CRLF too, or the line ends never match)
  const text = sql.replace(/\r/g, '').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  const all = text.split(';').map((s) => s.trim()).filter(Boolean);
  return {
    ddl: all.filter((s) => /^(CREATE|ALTER)\s/i.test(s)),
    dropped: all.filter((s) => !/^(CREATE|ALTER)\s/i.test(s)).map((s) => s.split(/\s+/).slice(0, 3).join(' ')),
  };
}

function defaultSchemaPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../../server-browser/schema.sql'), join(here, 'schema.sql')]) if (existsSync(p)) return p;
  throw new Error('schema.sql not found: pass --schema');
}

// ============================================================
// Postgres
// ============================================================

interface PgClient { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void }
interface PgPool { connect(): Promise<PgClient>; query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; end(): Promise<void> }

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
  return new Pool({ connectionString, max: 2 }) as PgPool;
}

const TABLES = ['users', 'sessions', 'profiles', 'game_docs'] as const;

async function tableCounts(q: { query: PgPool['query'] }): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const exists = await q.query('SELECT to_regclass($1) AS t', [t]);
    out[t] = exists.rows[0].t ? Number((await q.query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n) : 0;
  }
  return out;
}

export class RefusedError extends Error {}

export interface MigrateOptions {
  databaseUrl: string;
  schemaSql: string;
  replace?: boolean;
  /** Run it all, then roll back */
  dryRun?: boolean;
}

export interface MigrateResult {
  before: Record<string, number>;
  written: Record<string, number>;
  nextUserId: number;
  droppedStatements: string[];
  rolledBack: boolean;
}

/** Writes the plan in one transaction (schema included); refuses a target that has data unless `replace` */
export async function writePlan(plan: Plan, opts: MigrateOptions): Promise<MigrateResult> {
  const { ddl, dropped } = schemaStatements(opts.schemaSql);
  const pool = await pgPool(opts.databaseUrl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await tableCounts(client);
    for (const s of ddl) await client.query(s);
    if (Object.values(before).some((n) => n > 0)) {
      if (!opts.replace) {
        throw new RefusedError(`the target already has data (${fmtCounts(before)}): pass --replace to empty it and copy again`);
      }
      // (No CASCADE: if anything else ever references these tables, this fails rather than empty it too)
      await client.query('TRUNCATE sessions, profiles, game_docs, users');
    }
    for (const u of plan.users) {
      await client.query(
        `INSERT INTO users (id, username, email, password_hash, salt, is_admin, is_owner, created_at, banned_until, ban_reason, banned_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [u.id, u.username, u.email, u.password_hash, u.salt, !!u.is_admin, u.is_owner === true, u.created_at, u.banned_until ?? null, u.ban_reason ?? null, u.banned_by ?? null]);
    }
    for (const s of plan.sessions) {
      await client.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [s.token, s.user_id, s.expires_at]);
    }
    for (const [id, doc] of plan.profiles) {
      // (As PostgresProfileStore.write stores it)
      await client.query('INSERT INTO profiles (user_id, version, data, updated_at) VALUES ($1, $2, $3, now())',
        [id, (doc as { version?: number }).version ?? 0, JSON.stringify(doc)]);
    }
    for (const [key, doc] of plan.docs) {
      await client.query('INSERT INTO game_docs (key, data, updated_at) VALUES ($1, $2, now())', [key, JSON.stringify(doc)]);
    }
    // The next account gets nextUserId: never an id the JSON store gave out (deleted accounts included)
    const maxId = plan.users.reduce((m, u) => Math.max(m, u.id), 0);
    const last = Math.max(plan.nextUserId - 1, maxId);
    if (last >= 1) await client.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), $1, true)`, [last]);
    else await client.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), 1, false)`);
    const written = await tableCounts(client);
    await client.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
    return { before, written, nextUserId: last + 1, droppedStatements: dropped, rolledBack: !!opts.dryRun };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

// ============================================================
// Verification: read back through the Postgres stores
// ============================================================

/** Equal as JSON values, whatever the key order (jsonb keeps keys in its own order) */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]]))
    : x));
}

/** The game's profile normalisation (Pilots: migrateProfile with the starter kit and ship catalog) */
export interface Normaliser { kit: StarterKit; catalog: Catalog }

export function loadNormaliser(gameDataDir: string): Normaliser {
  const cfg = loadShipConfigFromDisk(gameDataDir);
  const catalog = loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink });
  // (GameServer.starterKit(): kept in step by hand; it only fills fields a save is missing)
  const kit: StarterKit = {
    blueprint: cfg.starter,
    planFile: 'sparrow-t',
    credits: 300,
    storage: { iron_ore: 40, nickel_ore: 20, silicate: 20, copper_ore: 10, alloy_plate: 14, copper_wire: 6, repair_kit: 2, boost_cell: 2 },
    home: 'sol_station_central',
    position: { system: 'sol', x: 0, y: 0 },
  };
  return { kit, catalog };
}

/** migrateProfile with the clock and randomness pinned, so two runs over equal input can be compared */
function normalise(n: Normaliser, raw: unknown): string {
  const RealDate = Date;
  const realRandom = Math.random;
  const t = RealDate.UTC(2026, 0, 1);
  let seed = 1;
  class FixedDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(t);
      else super(...(a as [string]));
    }
    static now() { return t; }
  }
  globalThis.Date = FixedDate as DateConstructor;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  try {
    return canonical(migrateProfile(structuredClone(raw), n.kit, n.catalog));
  } finally {
    globalThis.Date = RealDate;
    Math.random = realRandom;
  }
}

export interface Check { name: string; ok: boolean; detail: string }

function publicRecord(u: StoredUser): UserRecord {
  return {
    id: u.id, username: u.username, email: u.email, is_admin: u.is_admin, is_owner: u.is_owner === true, created_at: u.created_at,
    banned_until: u.banned_until ?? null, ban_reason: u.ban_reason ?? null, banned_by: u.banned_by ?? null,
  };
}

export async function verify(databaseUrl: string, plan: Plan, src: JsonSource, normaliser: Normaliser | null): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  const pool = await pgPool(databaseUrl);
  const log = console.log;
  console.log = () => {}; // ("pool created")
  const users = await PostgresUserStore.create(databaseUrl);
  console.log = log;
  const profiles = await PostgresProfileStore.create(databaseUrl);
  try {
    // --- counts
    const counts = await tableCounts(pool);
    const want = { users: plan.users.length, sessions: plan.sessions.length, profiles: plan.profiles.length, game_docs: plan.docs.length };
    for (const t of TABLES) add(`count ${t}`, counts[t] === want[t], `postgres ${counts[t]}, json ${want[t]}`);
    add('getUserCount()', (await users.getUserCount()) === plan.users.length, `${await users.getUserCount()}`);
    const listed = await users.listUsers('', 0, 100_000);
    add('listUsers() ids', canonical(listed.users.map((u) => u.id)) === canonical(plan.users.map((u) => u.id).sort((a, b) => a - b)),
      `${listed.total} listed`);

    // --- every account
    for (const u of plan.users) {
      const tag = `account ${u.id} (${u.username})`;
      const got = await users.getUserById(u.id);
      if (!got) { add(tag, false, 'missing'); continue; }
      const exp = publicRecord(u);
      const diffs: string[] = [];
      for (const k of ['id', 'username', 'email', 'is_admin', 'is_owner', 'banned_until', 'ban_reason', 'banned_by'] as const) {
        if (got[k] !== exp[k]) diffs.push(k === 'email' ? 'email differs' : `${k}: ${String(got[k])} vs ${String(exp[k])}`);
      }
      if (Date.parse(got.created_at) !== Date.parse(exp.created_at)) diffs.push(`created_at: ${got.created_at} vs ${exp.created_at}`);
      else if (got.created_at !== exp.created_at) diffs.push(`created_at reads back as ${got.created_at} (the same instant as ${exp.created_at})`);
      const byName = await users.getUserByUsername(u.username);
      if (byName?.id !== u.id) diffs.push('getUserByUsername finds another account');
      // (Compared in SQL: the hash and salt never leave the database or reach this report)
      const cred = await pool.query('SELECT password_hash = $2 AS hash, salt = $3 AS salt FROM users WHERE id = $1', [u.id, u.password_hash, u.salt]);
      if (!cred.rows[0]?.hash) diffs.push('password hash differs');
      if (!cred.rows[0]?.salt) diffs.push('salt differs');
      // The sign-in path reads the row and checks a password against it: a wrong one must fail
      if (await users.checkPassword(u.id, randomBytes(18).toString('base64'))) diffs.push('a random password was accepted');
      add(tag, diffs.length === 0, diffs.length ? diffs.join('; ') : 'id, username, email, admin, ban, created_at equal; password hash + salt identical');
    }

    // --- sessions: signed-in players stay signed in (validateSession only reads a live token)
    let sessionsOk = 0;
    const sessionFails: string[] = [];
    for (const s of plan.sessions) {
      const who = await users.validateSession(s.token);
      if (who?.id === s.user_id) sessionsOk++;
      else if (s.expires_at > Date.now()) sessionFails.push(`a session of account ${s.user_id} does not resolve`);
    }
    add('sessions resolve via validateSession()', sessionFails.length === 0, sessionFails.join('; ') || `${sessionsOk}/${plan.sessions.length}`);

    // --- the id sequence: the next account gets nextUserId
    const seq = await pool.query(`SELECT pg_get_serial_sequence('users', 'id') AS s`);
    const sv = await pool.query(`SELECT last_value, is_called FROM ${seq.rows[0].s}`);
    const next = sv.rows[0].is_called ? Number(sv.rows[0].last_value) + 1 : Number(sv.rows[0].last_value);
    add('next account id', next === plan.nextUserId && next > Math.max(0, ...plan.users.map((u) => u.id)), `next id ${next} (json nextUserId ${plan.nextUserId})`);

    // --- profiles, through PostgresProfileStore.load, for every account (and every profile)
    const ids = [...new Set([...plan.users.map((u) => u.id), ...plan.profiles.map(([id]) => id)])].sort((a, b) => a - b);
    const planned = new Map(plan.profiles);
    for (const id of ids) {
      const exp = planned.get(id) ?? null;
      const got = await profiles.load(id);
      if (exp === null) { add(`profile ${id}`, got === null, got === null ? 'no save on either side' : 'postgres has a save the JSON has not'); continue; }
      if (got === null) { add(`profile ${id}`, false, 'missing in postgres'); continue; }
      const rawEq = canonical(got) === canonical(exp);
      let detail = `v${(exp as { version?: number }).version}, ${canonical(exp).length} bytes: raw ${rawEq ? 'deep-equal' : 'DIFFERS'}`;
      let ok = rawEq;
      if (normaliser) {
        const a = normalise(normaliser, exp);
        const control = normalise(normaliser, exp);
        const b = normalise(normaliser, got);
        if (a !== control) detail += '; migrateProfile is not deterministic here (compared raw only)';
        else { ok &&= a === b; detail += `; after migrateProfile ${a === b ? 'deep-equal' : 'DIFFERS'}`; }
      }
      add(`profile ${id}`, ok, detail);
    }

    // --- game-wide docs (the rankings), through loadDoc
    for (const [key, doc] of plan.docs) {
      const got = await profiles.loadDoc(key);
      add(`doc ${key}`, got !== null && canonical(got) === canonical(doc), got === null ? 'missing' : 'deep-equal');
    }

    // --- the deleted-accounts list stays on JSON: none of its accounts may exist in postgres
    const ghosts = [];
    for (const id of src.deletedIds) if (await users.getUserById(id)) ghosts.push(id);
    add('deleted accounts absent', ghosts.length === 0, ghosts.length ? `present: ${ghosts.join(', ')}` : `${src.deletedIds.length} on the JSON list, none in postgres`);
  } finally {
    await users.close();
    await profiles.close();
    await pool.end();
  }
  return checks;
}

// ============================================================
// CLI
// ============================================================

function fmtCounts(c: Record<string, number>): string {
  return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ');
}

interface Args { data: string; dryRun: boolean; replace: boolean; verifyOnly: boolean; report?: string; schema?: string; gameData?: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { data: '', dryRun: false, replace: false, verifyOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = argv[++i]; if (!v) throw new Error(`${k} needs a value`); return v; };
    if (k === '--data') a.data = val();
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--replace') a.replace = true;
    else if (k === '--verify-only') a.verifyOnly = true;
    else if (k === '--report') a.report = val();
    else if (k === '--schema') a.schema = val();
    else if (k === '--game-data') a.gameData = val();
    else throw new Error(`unknown option ${k}`);
  }
  if (!a.data) throw new Error('--data <dir> is required');
  return a;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const url = process.env.DATABASE_URL || '';
  const scrub = (s: string) => (url ? s.split(url).join('<DATABASE_URL>') : s);
  try {
    const src = await loadJsonSource(resolve(args.data));
    const plan = planMigration(src);
    console.log(`JSON (${resolve(args.data)}): ${plan.users.length} accounts, ${plan.sessions.length} live sessions, `
      + `${plan.profiles.length} profiles, docs [${plan.docs.map(([k]) => k).join(', ')}], next account id ${plan.nextUserId}, `
      + `${src.deletedIds.length} deleted-account ids (stay on JSON)`);
    for (const n of [...src.notes, ...plan.skipped.map((s) => `skipped: ${s}`)]) console.log(`  note: ${n}`);
    if (!url) {
      if (args.dryRun) { console.log('dry run without DATABASE_URL: JSON side only'); return 0; }
      throw new Error('DATABASE_URL is not set');
    }
    let result: MigrateResult | null = null;
    if (!args.verifyOnly) {
      const schemaPath = args.schema ?? defaultSchemaPath();
      result = await writePlan(plan, { databaseUrl: url, schemaSql: readFileSync(schemaPath, 'utf-8'), replace: args.replace, dryRun: args.dryRun });
      console.log(`postgres before: ${fmtCounts(result.before)}`);
      console.log(`${result.rolledBack ? 'would write (rolled back)' : 'written'}: ${fmtCounts(result.written)}; next account id ${result.nextUserId}`);
      console.log(`schema: ${schemaPath} applied (DDL only); not applied: ${result.droppedStatements.join(' | ') || 'nothing'}`);
      if (args.dryRun) return 0;
    }
    let normaliser: Normaliser | null = null;
    try { normaliser = loadNormaliser(resolve(args.gameData ?? args.data)); } catch (e) {
      console.log(`  note: no ship data for the migrateProfile check (${(e as Error).message}): profiles compared raw only`);
    }
    const checks = await verify(url, plan, src, normaliser);
    const failed = checks.filter((c) => !c.ok);
    console.log(`\nverification: ${checks.length - failed.length}/${checks.length} checks passed`);
    for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    if (args.report) {
      writeFileSync(args.report, JSON.stringify({
        at: new Date().toISOString(), source: resolve(args.data), notes: src.notes, skipped: plan.skipped,
        migrate: result, checks, passed: failed.length === 0,
      }, null, 2));
      console.log(`report: ${args.report}`);
    }
    return failed.length ? 1 : 0;
  } catch (e) {
    console.error(scrub(`${e instanceof RefusedError ? 'refused' : 'error'}: ${(e as Error).message}`));
    return e instanceof RefusedError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
