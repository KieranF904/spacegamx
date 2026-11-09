/**
 * @contract lobby.rankings.routes
 * owns:       the lobby's rankings: game servers report each pilot's ranked stats, the lobby keeps one row per account
 *             and makes the weekly and all-time boards; clients read them here
 * needs:      UserStore (accounts exist, sessions), RankingStore, board.ts rules, accounts/RateLimiter + utils
 * invariants: only a caller with LOBBY_ADMIN_SECRET may report or import — server-browser/src/rankings/rankings.test.ts
 *             servers reporting for the same pilot add up, and a batch sent twice counts once — server-browser/src/rankings/rankings.test.ts
 *             an import is idempotent — server-browser/src/rankings/rankings.test.ts
 *             accounts that don't exist (or were deleted) never get a row — server-browser/src/rankings/rankings.test.ts
 * extend:     a new ranked stat is one entry in board.ts BOARDS; a new route is one case in handle()
 *
 *   POST /admin/rankings/report { server, batch, week, players: [{ userId, weekly: {stat: delta}, allTime: {stat: total} }] }
 *        -> { success, applied, skipped }
 *        From a game server (server/src/game/rankings), `Authorization: Bearer <LOBBY_ADMIN_SECRET>` like the friends
 *        and the activity feed. `weekly` numbers are added to the pilot's week (dropped when `week` isn't this lobby's
 *        week: the report was made across the turn), `allTime` ones are totals and only ever raise the stored one. `batch`
 *        is a random id: the same one again (a retry whose answer was lost) is answered and not counted. At most
 *        REPORT_MAX players a call and REPORTS_PER_MIN calls a minute per server name.
 *   POST /admin/rankings/import { week, weekly: {id: {v}}, allTime: {id: {v}} }
 *        -> { success, allTime, weekly, skipped }
 *        A game server's old per-server rankings document (server/src/game/rankings/rankingsMigration.ts), merged in
 *        once at its start: every number raised to the larger of what's there and what's sent, so twice is once.
 *   POST /rankings/view { token? }   (also GET /rankings: no token)
 *        -> { success, weekEndsIn, boards: [{ key, label, weekly, allTime, you? }] }  (the shape of the game's
 *        'rankings' message). `token` is a session on this lobby: it adds `you`, that account's numbers and ranks.
 *        Open to any caller, limited per address (VIEWS_PER_MIN).
 */

import http from 'http';
import path from 'path';
import type { UserStore } from '../accounts/types.js';
import { safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { Serial } from '../friends/types.js';
import { applyImport, applyReport, buildView, cleanStats, emptyRecord, sameRecord, weekOf, type BoardView, type RankRecord } from './board.js';
import { JsonRankingStore } from './JsonRankingStore.js';
import type { RankingStore } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;
type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export const REPORT_MAX = 200;
export const REPORTS_PER_MIN = 120;
export const IMPORT_LIMIT = 20;
export const IMPORT_MAX = 20_000;
export const VIEWS_PER_MIN = 60;
/** Batch ids remembered (a retry of one of these is not counted again) */
export const BATCHES_KEPT = 1000;
/** The boards are made from the rows at most this often (a report makes them stale at once) */
export const VIEW_CACHE_MS = 5000;

export async function createRankingStore(users: UserStore, jsonPath: string): Promise<RankingStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresRankingStore } = await import('./PostgresRankingStore.js');
    return await PostgresRankingStore.create(pool);
  }
  return new JsonRankingStore(jsonPath);
}

const userIdOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export class RankingRoutes {
  private serial = new Serial();
  private reports: RateLimiter;
  private imports: RateLimiter;
  private views: RateLimiter;
  private batches = new Set<string>();
  private cache: { at: number; rows: RankRecord[] } | null = null;

  private constructor(readonly store: RankingStore | null, private users: UserStore, private sendJson: Json, private parseJson: Body,
    private adminSecret: string, private clientIp: (req: http.IncomingMessage) => string, private now: () => number) {
    this.reports = new RateLimiter(REPORTS_PER_MIN, 60_000, 1000, now);
    this.imports = new RateLimiter(IMPORT_LIMIT, 60 * 60_000, 10, now);
    this.views = new RateLimiter(VIEWS_PER_MIN, 60_000, 10_000, now);
  }

  /** (Tests pass their own store and clock) */
  static async create(users: UserStore, sendJson: Json, parseJson: Body, clientIp: (req: http.IncomingMessage) => string,
    opts: { store?: RankingStore; adminSecret: string; dataDir: string; now?: () => number }): Promise<RankingRoutes> {
    let store: RankingStore | null = opts.store ?? null;
    // (No rankings is better than no lobby)
    if (!store) {
      try { store = await createRankingStore(users, path.join(opts.dataDir, 'rankings.json')); } catch (err) { console.error('[Rankings] off:', (err as Error).message); }
    }
    return new RankingRoutes(store, users, sendJson, parseJson, opts.adminSecret, clientIp, opts.now ?? Date.now);
  }

  /** Handles /admin/rankings/* and /rankings (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (url === '/rankings' || url === '/rankings/view') {
      if (req.method !== 'GET' && req.method !== 'POST') return false;
      await this.view(req, res);
      return true;
    }
    if (req.method !== 'POST' || !url.startsWith('/admin/rankings/')) return false;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return true; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: 'Rankings are unavailable right now' }); return true; }
    const action = url.slice('/admin/rankings/'.length);
    if (action !== 'report' && action !== 'import') { this.sendJson(res, 404, { success: false, error: 'Not found' }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, (err as { status?: number })?.status === 413 ? 413 : 400, { success: false, error: 'Invalid request' }); return true; }
    body ??= {};
    if (action === 'report') await this.report(res, this.store, body);
    else await this.import(res, this.store, body);
    return true;
  }

  private async report(res: http.ServerResponse, store: RankingStore, body: any): Promise<void> {
    const server = typeof body.server === 'string' ? body.server.slice(0, 64) : '';
    const batch = typeof body.batch === 'string' ? body.batch.slice(0, 64) : '';
    if (!Array.isArray(body.players) || !batch) { this.sendJson(res, 400, { success: false, error: 'No players' }); return; }
    if (body.players.length > REPORT_MAX) { this.sendJson(res, 413, { success: false, error: `At most ${REPORT_MAX} players a report` }); return; }
    if (!this.reports.hit(`server:${server}`)) { this.sendJson(res, 429, { success: false, limited: true, error: 'Too many reports' }); return; }
    const out = await this.serial.run(async () => {
      if (this.batches.has(batch)) return { applied: 0, skipped: 0, again: true };
      const week = weekOf(this.now());
      const thisWeek = Number(body.week) === week;
      const ids: number[] = [], players = new Map<number, { weekly: ReturnType<typeof cleanStats>; allTime: ReturnType<typeof cleanStats> }>();
      for (const p of body.players) {
        const id = userIdOf(p?.userId);
        if (id === null) continue;
        const cur = players.get(id);
        // (The same pilot twice in one report: summed, the totals raised)
        const w = thisWeek ? cleanStats(p.weekly) : {}, a = cleanStats(p.allTime);
        if (cur) {
          for (const [k, v] of Object.entries(w)) cur.weekly[k] = (cur.weekly[k] ?? 0) + v;
          for (const [k, v] of Object.entries(a)) if (v > (cur.allTime[k] ?? 0)) cur.allTime[k] = v;
        } else { players.set(id, { weekly: w, allTime: a }); ids.push(id); }
      }
      const have = await this.store!.get(ids);
      const rows: RankRecord[] = [];
      let skipped = body.players.length - ids.length;
      for (const id of ids) {
        const p = players.get(id)!;
        // (Nothing to rank, and no row yet: none made)
        if (!have.has(id) && !Object.keys(p.weekly).length && !Object.keys(p.allTime).length) { skipped++; continue; }
        const user = await this.users.getUserById(id);
        if (!user) { skipped++; continue; }
        const before = have.get(id) ?? emptyRecord(id, user.username, week);
        const after = applyReport({ ...before, name: user.username }, week, p.weekly, p.allTime);
        if (!have.has(id) || !sameRecord(before, after)) rows.push(after);
      }
      await store.put(rows);
      this.batches.add(batch);
      if (this.batches.size > BATCHES_KEPT) this.batches.delete(this.batches.values().next().value as string);
      this.cache = null;
      return { applied: rows.length, skipped, again: false };
    });
    this.sendJson(res, 200, { success: true, ...out });
  }

  private async import(res: http.ServerResponse, store: RankingStore, body: any): Promise<void> {
    const w = body.weekly, a = body.allTime;
    const isMap = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isMap(w) && !isMap(a)) { this.sendJson(res, 400, { success: false, error: 'No rankings' }); return; }
    const weekly = (isMap(w) ? w : {}) as Record<string, { v?: unknown }>, allTime = (isMap(a) ? a : {}) as Record<string, { v?: unknown }>;
    const keys = new Set([...Object.keys(weekly), ...Object.keys(allTime)]);
    if (keys.size > IMPORT_MAX) { this.sendJson(res, 413, { success: false, error: `At most ${IMPORT_MAX} accounts an import` }); return; }
    if (!this.imports.hit('import')) { this.sendJson(res, 429, { success: false, limited: true, error: 'Too many imports' }); return; }
    const out = await this.serial.run(async () => {
      const week = weekOf(this.now());
      // (Its weekly boards count only if they are this week's)
      const thisWeek = Number(body.week) === week;
      const ids = [...keys].map(userIdOf).filter((x): x is number => x !== null);
      const have = await store.get(ids);
      const rows: RankRecord[] = [];
      let skipped = keys.size - ids.length, nAll = 0, nWeek = 0;
      for (const id of ids) {
        const user = await this.users.getUserById(id);
        if (!user) { skipped++; continue; }
        const wk = thisWeek ? cleanStats(weekly[String(id)]?.v) : {}, at = cleanStats(allTime[String(id)]?.v);
        const before = have.get(id) ?? emptyRecord(id, user.username, week);
        const after = applyImport({ ...before, name: user.username }, week, wk, at);
        if (Object.keys(at).length) nAll++;
        if (Object.keys(wk).length) nWeek++;
        if (!have.has(id) || !sameRecord(before, after)) rows.push(after);
      }
      await store.put(rows);
      this.cache = null;
      return { allTime: nAll, weekly: nWeek, skipped };
    });
    console.log(`[Rankings] imported a server's boards: ${out.allTime} all-time rows, ${out.weekly} weekly, ${out.skipped} skipped`);
    this.sendJson(res, 200, { success: true, ...out });
  }

  /** The boards, with `you` when a good session token comes with the call */
  private async view(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.views.hit(`ip:${this.clientIp(req)}`)) { this.sendJson(res, 429, { success: false, limited: true, error: 'Too many requests' }); return; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: 'Rankings are unavailable right now' }); return; }
    let you: number | null = null;
    if (req.method === 'POST') {
      let body: any = {};
      try { body = (await this.parseJson(req)) ?? {}; } catch { /* (no body: no `you`) */ }
      const token = typeof body.token === 'string' ? body.token : '';
      const user = token ? await this.users.validateSession(token) : null;
      you = user ? user.id : null;
    }
    const v = await this.boards(you);
    this.sendJson(res, 200, { success: true, ...v });
  }

  /** The boards as the clients see them (rows read at most every VIEW_CACHE_MS) */
  async boards(you: number | null): Promise<BoardView> {
    const t = this.now();
    if (!this.cache || t - this.cache.at > VIEW_CACHE_MS) this.cache = { at: t, rows: await this.store!.all() };
    return buildView(this.cache.rows, weekOf(t), t, you);
  }

  /** An account was deleted: off the boards */
  forgetUser(userId: number): Promise<void> {
    this.cache = null;
    return (this.store?.forgetUser(userId) ?? Promise.resolve()).catch((err) => console.error('[Rankings] forgetting a deleted account failed:', err));
  }

  async close(): Promise<void> {
    await this.serial.idle();
    await this.store?.close();
  }
}
