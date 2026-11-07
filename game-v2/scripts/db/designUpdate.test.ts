/**
 * The v5 design update tool. The database part runs only when MIGRATE_TEST_DATABASE_URL names a scratch database
 * (it applies the schema; its own accounts 900001-900004 are removed afterwards, but --apply updates every below-v5 profile there):
 *   MIGRATE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/spacetest npx vitest run scripts/db
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { newProfile, resolveDesignUpdate, salvageParts, xpToReach, type ShipRecord } from '../../common/src/index.js';
import { loadUpdateContext, main, planDesignUpdate, reportJson, reportSummary, runDesignUpdate, type UpdateContext } from './designUpdate.js';
import { schemaStatements } from './migrateJsonToPostgres.js';

const real = loadUpdateContext(join(__dirname, '../../data'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const lib = (name: string) => clone(real.econ.plans[name]);
const remake = (id: string) => real.designUpdate!.blueprints[id];

/** The game data's context with a made-up mapping (anonymised accounts), its blueprints found as loadShipConfig finds them */
const ctx: UpdateContext = {
  ...real,
  designUpdate: resolveDesignUpdate({
    accounts: {
      owner: 'wipe',
      swapper: { slots: { 1: { blueprint: 'remakes/player-xire-prospector', was: { name: 'Prospector', parts: 17 } } } },
    },
  }, (id) => (id.startsWith('remakes/') ? real.designUpdate!.blueprints[id] : real.econ.plans[id])),
};

/** Four saves: the owner (to wipe) with a Prospector, cargo, debt and a plan item; a swapped pilot (v2); an unmapped pilot on a loaner; one already done */
function fixtures() {
  const base = () => clone(newProfile(real.kit)) as any;
  const starter = (): ShipRecord => ({ blueprint: clone(real.kit.blueprint), hp: {}, ghosts: [], plan: 'sparrow-t' });
  const a = base();
  const prospector: ShipRecord = { blueprint: lib('prospector'), hp: {}, ghosts: [], plan: 'prospector' };
  Object.assign(a, {
    version: 4, xp: xpToReach(24) + 10, level: 24, skillPoints: 5, credits: 4321, debt: 120, hangar: [starter(), prospector, null, null, null], activeSlot: 1, ship: prospector,
    cargo: [{ id: 'iron_ore', n: 4 }, { id: 'plan:arrow', n: 1 }], designs: [lib('arrow')],
    jobs: [{ id: 1, recipe: 'r', station: 'sol_station_central', out: { copper_wire: 1 }, count: 1, done: 0, unitMs: 1, startedAt: 0, readyAt: 1, for: 'Prospector', slot: 1 }],
  });
  const s = base();
  const mine: ShipRecord = { blueprint: lib('prospector'), hp: {}, ghosts: [], plan: 'prospector' };
  Object.assign(s, { version: 2, xp: 900, hangar: [starter(), mine, null, null, null], activeSlot: 1, ship: mine });
  const b = base();
  const loaner = { ...starter(), loaner: true };
  const lost: ShipRecord = { blueprint: lib('prospector'), hp: {}, ghosts: [], plan: 'prospector', lost: true };
  lost.ghosts = lost.blueprint.parts.map((q) => q.uid);
  Object.assign(b, { version: 4, hangar: [loaner, lost, null, null, null], activeSlot: 0, ship: loaner });
  const c = base(); // (a new pilot's save: v5 already)
  return { a, s, b, c, prospector };
}

describe('design update tool: offline parts', () => {
  it('the real mapping and its remakes load from the game data', () => {
    expect(real.designUpdate).toBeDefined();
    expect(Object.keys(real.designUpdate!.accounts).sort()).toEqual(['I0lOl0I', 'Pig_Benis', 'Xire', 'YuhboiFlappysack', 'brotherk3d']);
    expect(real.designUpdate!.accounts.brotherk3d).toBe('wipe');
    expect(remake('remakes/player-xire-prospector')?.power).toBe('ports');
    expect(remake('prospector')).toEqual(real.econ.plans.prospector);
  });

  it('plans one row per player below v5 (swaps, wipes, progress before and after), with totals, and leaves the input alone', () => {
    const { a, s, b, c, prospector } = fixtures();
    const input = [{ userId: 4, username: 'newbie', data: c }, { userId: 3, username: 'drifter', data: b }, { userId: 2, username: 'swapper', data: s }, { userId: 1, username: 'owner', data: a }];
    const before = JSON.stringify(input);
    const plan = planDesignUpdate(input, ctx);
    expect(JSON.stringify(input)).toBe(before);
    expect(plan.rows.map((r) => r.userId)).toEqual([1, 2, 3]);
    expect(plan.skipped).toEqual([{ userId: 4, username: 'newbie', version: 5 }]);
    const [ra, rs, rb] = plan.rows;
    expect(ra).toMatchObject({ userId: 1, username: 'owner', from: 4, mode: 'wipe', freshStarter: true, slotsDeleted: 2, designsDeleted: 1, jobsDetached: 1, debtForgiven: 120, cargoMoved: { iron_ore: 4 }, planItemsDropped: { 'plan:arrow': 1 } });
    expect(ra.refund).toEqual(salvageParts(real.econ, prospector.blueprint.parts, 1));
    // Only ships change: the owner's XP, level, skill points and credits come through as they were
    expect(ra.before).toEqual({ xp: a.xp, level: 24, skillPoints: 5, credits: 4321 });
    expect(ra.after).toEqual(ra.before);
    // The swapped pilot: slot 2 swapped, the stock Sparrow (not mapped) broken down, the remake flown
    expect(rs).toMatchObject({ userId: 2, from: 2, mode: 'swap', freshStarter: false, activeSlot: 1 });
    expect(rs.swapped).toEqual([{ slot: 1, from: { name: 'Prospector', parts: 17 }, to: 'remakes/player-xire-prospector', name: remake('remakes/player-xire-prospector').name }]);
    expect(rs.wiped).toEqual([{ slot: 0, from: { name: 'Sparrow T', parts: real.kit.blueprint.parts.length }, why: 'not mapped' }]);
    expect(rs.refund).toEqual(salvageParts(real.econ, real.kit.blueprint.parts, 1));
    expect(rb).toMatchObject({ userId: 3, mode: 'wipe', slotsDeleted: 2, refund: {}, debtForgiven: 0 });
    expect(plan.totals).toMatchObject({ players: 3, skipped: 1, swapped: 1, wiped: 6, freshStarters: 2, jobsDetached: 1, debtForgiven: 120, cargoMoved: { iron_ore: 4 }, planItemsDropped: { 'plan:arrow': 1 } });
    // What would be written: v5, the fresh starter or the remake flown, the refund in storage
    expect(plan.write.get(1)!.version).toBe(5);
    expect(plan.write.get(1)!.ship.blueprint).toEqual(real.kit.blueprint);
    expect(plan.write.get(2)!.ship.blueprint).toEqual(remake('remakes/player-xire-prospector'));
    expect(plan.write.has(4)).toBe(false);
    // The printed report: JSON, rows and totals, nothing else; the summary a line or more per player
    const out = JSON.parse(reportJson(plan, 'dry-run'));
    expect(Object.keys(out)).toEqual(['mode', 'version', 'rows', 'skipped', 'totals']);
    expect(out.mode).toBe('dry-run');
    expect(out.rows).toHaveLength(3);
    const summary = reportSummary(plan);
    expect(summary).toMatch(/^owner #1 v4 wipe: xp \d+->\d+, level 24->24, credits 4321->4321, skill points 5->5$/m);
    expect(summary).toMatch(/swapped: slot 2 Prospector \(17\) -> remakes\/player-xire-prospector/);
    expect(summary).toMatch(/wiped: slot 1 Sparrow T \(\d+\): not mapped/);
    expect(summary).toMatch(/newbie #4: already v5, skipped/);
  });

  it('a pilot with no username (no account row) is wiped, never swapped by mistake', () => {
    const { s } = fixtures();
    const plan = planDesignUpdate([{ userId: 7, username: null, data: s }], ctx);
    expect(plan.rows[0]).toMatchObject({ username: null, mode: 'wipe', freshStarter: true });
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

describe.skipIf(!TEST_DB)('design update tool: against a scratch database', () => {
  it('a dry run writes nothing; apply updates below-v5 rows once, in a transaction, by their usernames', async () => {
    const { a, s, b, c } = fixtures();
    // ('pg' is the server's dependency, not the repo root's)
    const pg: any = await import(pathToFileURL(createRequire(join(__dirname, '../../server/package.json')).resolve('pg')).href);
    const pool = new (pg.Pool ?? pg.default.Pool)({ connectionString: TEST_DB });
    const ids = [900001, 900002, 900003, 900004];
    const names = ['owner', 'swapper', 'drifter', 'newbie'];
    try {
      for (const st of schemaStatements(readFileSync(join(__dirname, '../../server-browser/schema.sql'), 'utf-8')).ddl) await pool.query(st);
      await pool.query('DELETE FROM profiles WHERE user_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM users WHERE id = ANY($1) OR username = ANY($2)', [ids, names]);
      for (const [i, id] of ids.entries()) {
        await pool.query("INSERT INTO users (id, username, email, password_hash, salt) VALUES ($1, $2, $3, 'x', 'x')", [id, names[i], `du${id}@example.com`]);
      }
      for (const [i, d] of [a, s, b, c].entries()) await pool.query('INSERT INTO profiles (user_id, version, data) VALUES ($1, $2, $3)', [ids[i], d.version, JSON.stringify(d)]);
      const read = async () => (await pool.query('SELECT user_id, data FROM profiles WHERE user_id = ANY($1) ORDER BY user_id', [ids])).rows;
      const before = JSON.stringify(await read());
      const dry = await runDesignUpdate(TEST_DB!, ctx, false);
      expect(dry.rows.filter((r) => ids.includes(r.userId)).map((r) => [r.username, r.mode])).toEqual([['owner', 'wipe'], ['swapper', 'swap'], ['drifter', 'wipe']]);
      expect(JSON.stringify(await read())).toBe(before);
      await runDesignUpdate(TEST_DB!, ctx, true);
      const after = await read();
      expect(after.map((r: any) => r.data.version)).toEqual([5, 5, 5, 5]);
      expect(after[0].data.hangar[1]).toBeNull();
      expect(after[1].data.hangar[1].blueprint.name).toBe(remake('remakes/player-xire-prospector').name);
      const again = await runDesignUpdate(TEST_DB!, ctx, true);
      expect(again.rows.filter((r) => ids.includes(r.userId))).toEqual([]);
    } finally {
      await pool.query('DELETE FROM profiles WHERE user_id = ANY($1)', [ids]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]).catch(() => {});
      await pool.end();
    }
  });
});
