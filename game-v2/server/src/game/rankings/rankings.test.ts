import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RANKED, weekOf } from '@space-game/common';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { LobbyRankings, type RankBatch, type RankingsBackend } from './RankingsBackend.js';
import { RankingReporter, SEND_MS, BATCH_MAX } from './RankingReporter.js';
import { migrateRankings, RANKINGS_DOC } from './rankingsMigration.js';
import { Achievements } from '../Achievements.js';
import { BOARDS } from '../../../../server-browser/src/rankings/board.js';
import { RankingRoutes } from '../../../../server-browser/src/rankings/routes.js';
import { JsonRankingStore } from '../../../../server-browser/src/rankings/JsonRankingStore.js';
import { JsonUserStore } from '../../../../server-browser/src/accounts/JsonUserStore.js';
import { readJson } from '../../../../server-browser/src/accounts/request.js';
import { fetchRankings } from '../../../../client/src/network/rankings.js';

const T0 = Date.UTC(2026, 9, 21, 12);
const SECRET = 'sssh';

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'game-rankings-')); dirs.push(d); return d; };

/** A real lobby (the rankings routes over HTTP on a free port) with accounts ash, bree, cole */
async function lobby() {
  const users = new JsonUserStore(join(tmp(), 'users.json'));
  const ids: Record<string, number> = {};
  for (const name of ['ash', 'bree', 'cole']) {
    const r = await users.register(name, `${name}@example.com`, 'password1');
    if (!r.success) throw new Error(r.error);
    ids[name] = r.user.id;
  }
  const send = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const routes = await RankingRoutes.create(users, send, (req) => readJson(req), () => '9.9.9.9',
    { store: new JsonRankingStore(null), adminSecret: SECRET, dataDir: tmp(), now: () => T0 });
  const server = http.createServer(async (req, res) => { if (!(await routes.handle(req, res, req.url!.split('?')[0]))) send(res, 404, {}); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { users, ids, url, routes };
}

function fakeBackend(takes = () => true) {
  const batches: RankBatch[] = [];
  const backend: RankingsBackend = {
    report: async (b) => { batches.push(structuredClone(b)); return takes(); },
    importDoc: async () => {},
    view: async () => null,
  };
  return { batches, backend };
}

describe('the ranked list', () => {
  it("the lobby's boards are the game's RANKED stats, in order", () => {
    expect(BOARDS).toEqual(RANKED);
  });
});

describe('RankingReporter', () => {
  it('sums weekly changes, keeps the all-time total, and sends at the pace', async () => {
    const f = fakeBackend();
    const clock = { t: T0 };
    const rep = new RankingReporter(f.backend, 'AUS', () => clock.t);
    rep.add(7, 'kills', 1, 11);
    rep.add(7, 'kills', 2, 13);
    rep.seed(7, { earned: 50 });
    await rep.flush();
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0]).toMatchObject({ server: 'AUS', week: weekOf(T0), players: [{ userId: 7, weekly: { kills: 3 }, allTime: { kills: 13, earned: 50 } }] });
    // Too soon: held; later: sent
    rep.add(7, 'kills', 1, 14);
    await rep.flush();
    expect(f.batches).toHaveLength(1);
    clock.t += SEND_MS;
    await rep.flush();
    expect(f.batches).toHaveLength(2);
    expect(f.batches[1].batch).not.toBe(f.batches[0].batch);
  });

  it('a batch the lobby did not take goes again unchanged (same id) before newer changes, with backoff', async () => {
    let up = false;
    const f = fakeBackend(() => up);
    const clock = { t: T0 };
    const rep = new RankingReporter(f.backend, 'AUS', () => clock.t);
    rep.add(7, 'kills', 1, 1);
    await rep.flush();
    rep.add(8, 'kills', 5, 5);
    clock.t += SEND_MS;
    await rep.flush(); // (backing off: too soon)
    expect(f.batches).toHaveLength(1);
    up = true;
    await rep.flush(true);
    expect(f.batches).toHaveLength(2);
    expect(f.batches[1]).toEqual(f.batches[0]);
    await rep.flush(true);
    expect(f.batches[2].players.map((p) => p.userId)).toEqual([8]);
    expect(rep.waiting).toBe(0);
  });

  it('a deleted account is dropped from what waits, and a flood goes out in capped batches', async () => {
    const f = fakeBackend();
    const rep = new RankingReporter(f.backend, 'AUS', () => T0);
    rep.add(1, 'kills', 1, 1);
    rep.forget(1);
    expect(rep.waiting).toBe(0);
    for (let i = 1; i <= BATCH_MAX + 5; i++) rep.add(i, 'kills', 1, 1);
    await rep.flush(true);
    await rep.flush(true);
    expect(f.batches.map((b) => b.players.length)).toEqual([BATCH_MAX, 5]);
  });
});

describe('the old rankings document', () => {
  const old = { week: weekOf(T0), weekly: { 1: { name: 'ash', v: { kills: 3 } } }, allTime: { 1: { name: 'ash', v: { kills: 30 } } } };

  it('is sent to the lobby once and marked moved', async () => {
    const store = new MemoryProfileStore();
    await store.saveDoc(RANKINGS_DOC, old);
    const sent: unknown[] = [];
    const backend = { ...fakeBackend().backend, importDoc: async (d: unknown) => { sent.push(d); } };
    expect(await migrateRankings(store, backend, () => 123)).toBe('moved');
    expect(sent).toHaveLength(1);
    expect(await store.loadDoc(RANKINGS_DOC)).toMatchObject({ movedToLobby: 123, allTime: old.allTime });
    expect(await migrateRankings(store, backend)).toBe('already');
    expect(sent).toHaveLength(1);
  });

  it('is left unmarked (and tried again next start) when the lobby cannot take it; nothing to move is "none"', async () => {
    const store = new MemoryProfileStore();
    const down = { ...fakeBackend().backend, importDoc: async () => { throw new Error('down'); } };
    expect(await migrateRankings(store, down)).toBe('none');
    await store.saveDoc(RANKINGS_DOC, old);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await migrateRankings(store, down)).toBe('failed');
    expect((await store.loadDoc(RANKINGS_DOC) as any).movedToLobby).toBeUndefined();
  });

  it('through a real lobby: moved twice (a crash before the mark) the boards are the same as once', async () => {
    const l = await lobby();
    const doc = { week: weekOf(T0), weekly: { [l.ids.ash]: { name: 'ash', v: { kills: 3 } } }, allTime: { [l.ids.ash]: { name: 'ash', v: { kills: 30 } }, [l.ids.bree]: { name: 'bree', v: { kills: 8 } } } };
    const backend = new LobbyRankings(l.url, SECRET);
    for (let i = 0; i < 2; i++) {
      const store = new MemoryProfileStore();
      await store.saveDoc(RANKINGS_DOC, doc);
      expect(await migrateRankings(store, backend)).toBe('moved');
    }
    const kills = (await l.routes.boards(null)).boards.find((b) => b.key === 'kills')!;
    expect(kills.weekly).toEqual([{ name: 'ash', value: 3 }]);
    expect(kills.allTime).toEqual([{ name: 'ash', value: 30 }, { name: 'bree', value: 8 }]);
  });
});

describe('two game servers and the lobby', () => {
  it("both report to the lobby over HTTP, it ranks them together, and the client reads the boards from it", async () => {
    const l = await lobby();
    const mk = (name: string) => {
      const pilots = { onEvent: () => {} } as any;
      const host = { send: () => {}, broadcast: () => {}, now: () => T0 };
      return new Achievements(host, pilots, undefined, new MemoryProfileStore(), new LobbyRankings(l.url, SECRET), name);
    };
    const aus = mk('AUS'), eu = mk('EU');
    // (Each Achievements reports through its own LobbyRankings: the same path the game takes)
    const reporters = [aus, eu].map((a) => (a as any).reporter as RankingReporter);
    reporters[0].add(l.ids.ash, 'earned', 300, 300);
    reporters[0].add(l.ids.bree, 'earned', 500, 500);
    reporters[1].add(l.ids.ash, 'earned', 400, 700);
    reporters[1].add(l.ids.cole, 'earned', 100, 100);
    await aus.save(true);
    await eu.save(true);

    // The client's fetch is pointed at the lobby's real port
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', ((input: string, init?: RequestInit) => real(String(input).replace(/^https?:\/\/[^/]+/, l.url), init)) as typeof fetch);
    const login = await l.users.login('ash', 'password1');
    if (!login.success) throw new Error('login');
    const m = (await fetchRankings(login.token))!;
    const earned = m.boards.find((b) => b.key === 'earned')!;
    expect(m.type).toBe('rankings');
    expect(earned.weekly).toEqual([{ name: 'ash', value: 700 }, { name: 'bree', value: 500 }, { name: 'cole', value: 100 }]);
    expect(earned.you).toEqual({ weekly: 700, allTime: 700, weeklyRank: 1, allTimeRank: 1 });
    // A guest reads the same boards without a "you"
    const guest = (await fetchRankings(null))!;
    expect(guest.boards.find((b) => b.key === 'earned')!.you).toBeUndefined();
  });

  it('a lobby that is down is a null, not a throw', async () => {
    vi.stubGlobal('fetch', (() => Promise.reject(new Error('down'))) as typeof fetch);
    expect(await fetchRankings(null)).toBeNull();
    expect(await new LobbyRankings('http://127.0.0.1:1', SECRET).report({ server: 'x', batch: 'b', week: 1, players: [] })).toBe(false);
  });
});
