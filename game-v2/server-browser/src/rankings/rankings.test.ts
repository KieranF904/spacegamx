import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from '../accounts/JsonUserStore.js';
import { RankingRoutes, REPORT_MAX } from './routes.js';
import { JsonRankingStore } from './JsonRankingStore.js';
import { RANKINGS_SCHEMA } from './PostgresRankingStore.js';
import { applyImport, applyReport, buildView, emptyRecord, weekOf } from './board.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lobby-rankings-')); dirs.push(d); return d; };

const SECRET = 'sssh';
const T0 = Date.UTC(2026, 9, 21, 12);

async function setup(file: string | null = null) {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const ids: Record<string, number> = {};
  for (const name of ['ash', 'bree', 'cole']) {
    const r = await users.register(name, `${name}@example.com`, 'password1');
    if (!r.success) throw new Error(r.error);
    ids[name] = r.user.id;
  }
  const clock = { t: T0 };
  const store = new JsonRankingStore(file);
  let body: unknown = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const routes = await RankingRoutes.create(users, (_, status, b) => { out = { status, body: b }; }, async () => body, () => '1.2.3.4',
    { store, adminSecret: SECRET, dataDir: tmp(), now: () => clock.t });
  const call = async (method: string, url: string, b: unknown, auth: string | null = SECRET) => {
    body = b;
    const req = { method, headers: auth !== null ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    out = { status: 0, body: null };
    const handled = await routes.handle(req, {} as http.ServerResponse, url);
    return handled ? out : null;
  };
  const report = (server: string, batch: string, players: unknown[], week = weekOf(clock.t)) => call('POST', '/admin/rankings/report', { server, batch, week, players });
  const view = (token?: string) => call('POST', '/rankings/view', token ? { token } : {});
  return { users, store, routes, call, report, view, ids, clock, users2: users };
}

const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe('rankings board rules (pure)', () => {
  it('weekly reports add, all-time reports only raise, a new week clears the weekly numbers', () => {
    const w = weekOf(T0);
    let r = emptyRecord(1, 'ash', w);
    r = applyReport(r, w, { kills: 3 }, { kills: 10 });
    r = applyReport(r, w, { kills: 2 }, { kills: 8 });
    expect(r.weekly.kills).toBe(5);
    expect(r.allTime.kills).toBe(10);
    r = applyReport(r, w + 1, { kills: 1 }, {});
    expect(r.weekly.kills).toBe(1);
    expect(r.allTime.kills).toBe(10);
  });

  it('a row from an earlier week shows no weekly numbers, and you are placed', () => {
    const w = weekOf(T0);
    const old = applyReport(emptyRecord(1, 'old', w - 1), w - 1, { kills: 99 }, { kills: 99 });
    const fresh = applyReport(emptyRecord(2, 'fresh', w), w, { kills: 4 }, { kills: 4 });
    const v = buildView([old, fresh], w, T0, 2);
    const kills = v.boards.find((b) => b.key === 'kills')!;
    expect(names(kills.weekly)).toEqual(['fresh']);
    expect(names(kills.allTime)).toEqual(['old', 'fresh']);
    expect(kills.you).toEqual({ weekly: 4, allTime: 4, weeklyRank: 1, allTimeRank: 2 });
    expect(buildView([old, fresh], w, T0, null).boards[0].you).toBeUndefined();
  });

  it('an import raises to the larger, so twice is once', () => {
    const w = weekOf(T0);
    const once = applyImport(emptyRecord(1, 'a', w), w, { kills: 3 }, { kills: 9 });
    expect(applyImport(once, w, { kills: 3 }, { kills: 9 })).toEqual(once);
  });

  it('the Postgres schema names its table', () => {
    expect(RANKINGS_SCHEMA.join('')).toContain('ranking_rows');
  });
});

describe('rankings routes', () => {
  it('two game servers report the same pilot and different ones: the lobby ranks them together', async () => {
    const s = await setup();
    const { ash, bree } = s.ids;
    expect((await s.report('AUS', 'b1', [{ userId: ash, weekly: { earned: 300 }, allTime: { earned: 1300 } }, { userId: bree, weekly: { earned: 500 }, allTime: { earned: 500 } }]))!.body.applied).toBe(2);
    expect((await s.report('EU', 'b2', [{ userId: ash, weekly: { earned: 400 }, allTime: { earned: 1700 } }]))!.body.applied).toBe(1);
    const v = (await s.view())!.body;
    const earned = v.boards.find((b: any) => b.key === 'earned');
    expect(earned.weekly).toEqual([{ name: 'ash', value: 700 }, { name: 'bree', value: 500 }]);
    expect(earned.allTime).toEqual([{ name: 'ash', value: 1700 }, { name: 'bree', value: 500 }]);
    expect(v.boards.map((b: any) => b.key)).toEqual(['earned', 'kills', 'bosses', 'quests', 'mined']);
    expect(earned.you).toBeUndefined();
  });

  it('a retried batch counts once; a report from last week adds no weekly numbers', async () => {
    const s = await setup();
    const p = [{ userId: s.ids.ash, weekly: { kills: 5 }, allTime: { kills: 5 } }];
    await s.report('AUS', 'same', p);
    expect((await s.report('AUS', 'same', p))!.body).toMatchObject({ success: true, applied: 0 });
    await s.report('AUS', 'late', p, weekOf(s.clock.t) - 1);
    const kills = (await s.view())!.body.boards.find((b: any) => b.key === 'kills');
    expect(kills.weekly).toEqual([{ name: 'ash', value: 5 }]);
  });

  it('the weekly boards start again next week; all time keeps', async () => {
    const s = await setup();
    await s.report('AUS', 'b1', [{ userId: s.ids.ash, weekly: { mined: 20 }, allTime: { mined: 20 } }]);
    s.clock.t += 8 * 24 * 3600 * 1000;
    const mined = (await s.view())!.body.boards.find((b: any) => b.key === 'mined');
    expect(mined.weekly).toEqual([]);
    expect(mined.allTime).toEqual([{ name: 'ash', value: 20 }]);
  });

  it("`you` comes from a good session token", async () => {
    const s = await setup();
    await s.report('AUS', 'b1', [{ userId: s.ids.ash, weekly: { kills: 1 }, allTime: { kills: 1 } }, { userId: s.ids.bree, weekly: { kills: 9 }, allTime: { kills: 9 } }]);
    const login = await s.users.login('ash', 'password1');
    if (!login.success) throw new Error('login');
    const kills = (await s.view(login.token))!.body.boards.find((b: any) => b.key === 'kills');
    expect(kills.you).toEqual({ weekly: 1, allTime: 1, weeklyRank: 2, allTimeRank: 2 });
    expect((await s.view('nonsense'))!.body.boards[1].you).toBeUndefined();
  });

  it('only the shared secret reports or imports; junk is dropped; nobody without an account gets a row', async () => {
    const s = await setup();
    expect((await s.call('POST', '/admin/rankings/report', { batch: 'x', players: [] }, 'wrong'))!.status).toBe(403);
    expect((await s.call('POST', '/admin/rankings/import', { allTime: {} }, null))!.status).toBe(403);
    const r = (await s.report('AUS', 'b1', [
      { userId: 9999, weekly: { kills: 5 }, allTime: { kills: 5 } },
      { userId: s.ids.cole, weekly: { kills: -4, nonsense: 9, earned: 'lots' }, allTime: { bosses: Infinity } },
      { userId: 'x' },
    ]))!;
    expect(r.body.applied).toBe(0);
    expect(r.body.skipped).toBe(3);
    expect((await s.store.all()).length).toBe(0);
    const big = Array.from({ length: REPORT_MAX + 1 }, () => ({ userId: s.ids.ash }));
    expect((await s.report('AUS', 'b2', big))!.status).toBe(413);
  });

  it('the old rankings document is imported once: a second import changes nothing, and gone accounts are skipped', async () => {
    const s = await setup();
    const { ash, bree } = s.ids;
    const doc = {
      week: weekOf(T0),
      weekly: { [ash]: { name: 'ash', v: { kills: 4 } }, 9999: { name: 'ghost', v: { kills: 40 } } },
      allTime: { [ash]: { name: 'ash', v: { kills: 40, earned: 100 } }, [bree]: { name: 'bree', v: { kills: 7 } }, 9999: { name: 'ghost', v: { kills: 40 } } },
    };
    const first = (await s.call('POST', '/admin/rankings/import', doc))!.body;
    expect(first).toMatchObject({ success: true, allTime: 2, weekly: 1, skipped: 1 });
    const rows1 = JSON.stringify((await s.store.all()).sort((a, b) => a.userId - b.userId));
    await s.call('POST', '/admin/rankings/import', doc);
    expect(JSON.stringify((await s.store.all()).sort((a, b) => a.userId - b.userId))).toBe(rows1);
    // Live reports since the import still add on top
    await s.report('AUS', 'b1', [{ userId: ash, weekly: { kills: 1 }, allTime: { kills: 41 } }]);
    const kills = (await s.view())!.body.boards.find((b: any) => b.key === 'kills');
    expect(kills.weekly).toEqual([{ name: 'ash', value: 5 }]);
    expect(kills.allTime).toEqual([{ name: 'ash', value: 41 }, { name: 'bree', value: 7 }]);
    // An old week's document brings its all-time numbers only
    const stale = (await s.call('POST', '/admin/rankings/import', { week: weekOf(T0) - 3, weekly: { [bree]: { v: { kills: 99 } } }, allTime: {} }))!.body;
    expect(stale.weekly).toBe(0);
  });

  it('rows survive a restart (the JSON file) and a deleted account goes off the boards', async () => {
    const file = join(tmp(), 'rankings.json');
    const s = await setup(file);
    await s.report('AUS', 'b1', [{ userId: s.ids.ash, weekly: { kills: 2 }, allTime: { kills: 2 } }]);
    await s.routes.close();
    const again = new JsonRankingStore(file);
    expect((await again.all()).map((r) => r.name)).toEqual(['ash']);
    await again.forgetUser(s.ids.ash);
    expect(await again.all()).toEqual([]);
    await again.close();
  });
});
