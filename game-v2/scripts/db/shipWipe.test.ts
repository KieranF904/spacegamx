/**
 * The v5 ship wipe tool. The database part runs only when MIGRATE_TEST_DATABASE_URL names a scratch database
 * (it applies the schema; its own accounts 900001-900003 are removed afterwards, but --apply wipes every below-v5 profile there):
 *   MIGRATE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest npx vitest run scripts/db
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { newProfile, salvageParts, type ShipRecord } from '../../common/src/index.js';
import { loadWipeContext, main, planShipWipe, reportJson, runShipWipe } from './shipWipe.js';
import { schemaStatements } from './migrateJsonToPostgres.js';

const ctx = loadWipeContext(join(__dirname, '../../data'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const lib = (name: string) => clone(ctx.econ.plans[name]);

/** Three saves: a v4 pilot with a Prospector, cargo, debt and a plan item; a v4 pilot on a loaner; one already wiped */
function fixtures() {
  const base = () => clone(newProfile(ctx.kit)) as any;
  const starter = (): ShipRecord => ({ blueprint: clone(ctx.kit.blueprint), hp: {}, ghosts: [], plan: 'sparrow-t' });
  const a = base();
  const prospector: ShipRecord = { blueprint: lib('prospector'), hp: {}, ghosts: [], plan: 'prospector' };
  Object.assign(a, {
    version: 4, xp: 3000, debt: 120, hangar: [starter(), prospector, null, null, null], activeSlot: 1, ship: prospector,
    cargo: [{ id: 'iron_ore', n: 4 }, { id: 'plan:arrow', n: 1 }], designs: [lib('arrow')],
    jobs: [{ id: 1, recipe: 'r', station: 'sol_station_central', out: { copper_wire: 1 }, count: 1, done: 0, unitMs: 1, startedAt: 0, readyAt: 1, for: 'Prospector', slot: 1 }],
  });
  const b = base();
  const loaner = { ...starter(), loaner: true };
  const lost: ShipRecord = { blueprint: lib('prospector'), hp: {}, ghosts: [], plan: 'prospector', lost: true };
  lost.ghosts = lost.blueprint.parts.map((q) => q.uid);
  Object.assign(b, { version: 4, hangar: [loaner, lost, null, null, null], activeSlot: 0, ship: loaner });
  const c = base(); // (a new pilot's save: v5 already)
  return { a, b, c, prospector };
}

describe('ship wipe tool: offline parts', () => {
  it('plans one row per player below v5, with totals, and leaves the input alone', () => {
    const { a, b, c, prospector } = fixtures();
    const input = [{ userId: 3, data: c }, { userId: 2, data: b }, { userId: 1, data: a }];
    const before = JSON.stringify(input);
    const plan = planShipWipe(input, ctx);
    expect(JSON.stringify(input)).toBe(before);
    expect(plan.rows.map((r) => r.userId)).toEqual([1, 2]);
    expect(plan.skipped).toEqual([{ userId: 3, version: 5 }]);
    const [ra, rb] = plan.rows;
    expect(ra).toMatchObject({ userId: 1, from: 4, slotsDeleted: 2, designsDeleted: 1, jobsDetached: 1, debtForgiven: 120, cargoMoved: { iron_ore: 4 }, planItemsDropped: { 'plan:arrow': 1 }, plansDropped: [] });
    expect(ra.refund).toEqual(salvageParts(ctx.econ, prospector.blueprint.parts, 1));
    expect(rb).toMatchObject({ userId: 2, slotsDeleted: 2, refund: {}, debtForgiven: 0 });
    expect(plan.totals).toMatchObject({ players: 2, skipped: 1, slotsDeleted: 4, designsDeleted: 1, jobsDetached: 1, debtForgiven: 120, cargoMoved: { iron_ore: 4 }, planItemsDropped: { 'plan:arrow': 1 } });
    expect(plan.totals.refund).toEqual(ra.refund);
    // What would be written: v5, a fresh starter flown, the refund in storage
    const pa = plan.write.get(1)!;
    expect(pa.version).toBe(5);
    expect(pa.ship.blueprint).toEqual(ctx.kit.blueprint);
    expect(plan.write.has(3)).toBe(false);
    // The printed report: JSON, rows and totals, nothing else
    const out = JSON.parse(reportJson(plan, 'dry-run'));
    expect(Object.keys(out)).toEqual(['mode', 'version', 'rows', 'skipped', 'totals']);
    expect(out.mode).toBe('dry-run');
    expect(out.rows).toHaveLength(2);
    expect(out.totals.players).toBe(2);
  });

  it('needs a mode and DATABASE_URL, and never prints the URL', async () => {
    const env = process.env.DATABASE_URL;
    const err: string[] = [];
    const real = console.error;
    console.error = (s: string) => { err.push(String(s)); };
    try {
      delete process.env.DATABASE_URL;
      expect(await main(['--dry-run'])).toBe(1);
      expect(err.pop()).toMatch(/DATABASE_URL is not set/);
      expect(await main([])).toBe(1);
      expect(await main(['--dry-run', '--apply'])).toBe(1);
      process.env.DATABASE_URL = 'postgres://user:hunter2@127.0.0.1:1/nowhere';
      expect(await main(['--dry-run'])).toBe(1);
      expect(err.join('\n')).not.toContain('hunter2');
    } finally {
      console.error = real;
      if (env === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = env;
    }
  });
});

const TEST_DB = process.env.MIGRATE_TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('ship wipe tool: against a scratch database', () => {
  it('a dry run writes nothing; apply wipes below-v5 rows once, in a transaction', async () => {
    const { a, b, c } = fixtures();
    // ('pg' is the server's dependency, not the repo root's)
    const pg: any = await import(pathToFileURL(createRequire(join(__dirname, '../../server/package.json')).resolve('pg')).href);
    const pool = new (pg.Pool ?? pg.default.Pool)({ connectionString: TEST_DB });
    const ids = [900001, 900002, 900003];
    try {
      for (const s of schemaStatements(readFileSync(join(__dirname, '../../server-browser/schema.sql'), 'utf-8')).ddl) await pool.query(s);
      await pool.query('DELETE FROM profiles WHERE user_id = ANY($1)', [ids]);
      for (const id of ids) {
        await pool.query("INSERT INTO users (id, username, email, password_hash, salt) VALUES ($1, $2, $3, 'x', 'x') ON CONFLICT (id) DO NOTHING", [id, `wipe${id}`, `wipe${id}@example.com`]);
      }
      for (const [i, d] of [a, b, c].entries()) await pool.query('INSERT INTO profiles (user_id, version, data) VALUES ($1, $2, $3)', [ids[i], d.version, JSON.stringify(d)]);
      const read = async () => (await pool.query('SELECT user_id, data FROM profiles WHERE user_id = ANY($1) ORDER BY user_id', [ids])).rows;
      const before = JSON.stringify(await read());
      const dry = await runShipWipe(TEST_DB!, ctx, false);
      expect(dry.rows.filter((r) => ids.includes(r.userId))).toHaveLength(2);
      expect(JSON.stringify(await read())).toBe(before);
      await runShipWipe(TEST_DB!, ctx, true);
      const after = await read();
      expect(after.map((r: any) => r.data.version)).toEqual([5, 5, 5]);
      expect(after[0].data.hangar[1]).toBeNull();
      const again = await runShipWipe(TEST_DB!, ctx, true);
      expect(again.rows.filter((r) => ids.includes(r.userId))).toEqual([]);
    } finally {
      await pool.query('DELETE FROM profiles WHERE user_id = ANY($1)', [ids]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]).catch(() => {});
      await pool.end();
    }
  });
});
