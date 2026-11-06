/**
 * Friends' routes: the game servers read and change an account's friends, friend requests and saved status here, so
 * they follow the account to every server. Behind LOBBY_ADMIN_SECRET like the rest of /admin/ (nginx doesn't pass it
 * through; the activity ingest uses the same `Authorization: Bearer <secret>`). The game server has checked the
 * pilot's session; it names the account by id (`userId`).
 *
 *   POST /admin/friends/get     { userId }                  -> { success, ...View }
 *   POST /admin/friends/request { userId, name }            -> { success, result, other?, me: View, them?: View }
 *        result: sent | accepted (they had asked already) | already | pending | full | theirFull | busy | self | unknown
 *   POST /admin/friends/respond { userId, name, accept }    -> { success, result: accepted | declined | full | gone, ... }
 *   POST /admin/friends/remove  { userId, name }            -> { success, result: unfriended | removed | none, ... }
 *        (removed: a request either way taken back or turned down)
 *   POST /admin/friends/status  { userId, status }          -> { success, status }
 *   POST /admin/friends/import  { accounts }                -> { success, friends, requests, skipped }
 *        A game server's old per-server friends document (server/src/game/social/friendsMigration.ts), merged in once
 *        at its start. Idempotent (lists.ts importDoc).
 *
 *   View: { status, friends: Entry[], incoming: Entry[], outgoing: Entry[] }; Entry: { id, name }.
 *
 * Checked here whatever the game server did: ids, names (40 characters), the status, the caps (lists.ts), and limits
 * per account (requests REQUEST_LIMIT per 10 minutes, status changes STATUS_LIMIT per 30 s, other changes
 * CHANGE_LIMIT a minute, reads READ_LIMIT a minute), so hopping servers doesn't get round them. Past one: 429 with
 * `limited: true`. An account that doesn't exist (deleted): 404.
 *
 * Presence (who is online where) is not kept here yet: each game server counts only its own pilots as online. When
 * servers talk to each other, they report their online account ids here (the heartbeat to /register is the cheap
 * place) and get their pilots' friends' presence back; cross-server private messages would route the same way.
 */

import http from 'http';
import path from 'path';
import type { UserStore } from '../accounts/types.js';
import { safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { JsonFriendStore } from './JsonFriendStore.js';
import { cleanLists, importDoc, isStatus, request, respond, unfriend, type FriendLists } from './lists.js';
import type { FriendStore } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;
type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export const REQUEST_LIMIT = 10;
export const STATUS_LIMIT = 6;
export const CHANGE_LIMIT = 60;
export const READ_LIMIT = 120;
/** Imports a game server may send an hour (one at each start) */
export const IMPORT_LIMIT = 20;
/** Most accounts one import carries */
export const IMPORT_MAX = 10_000;
export const NAME_MAX = 40;
const LIMITED = 'Too many friends changes lately. Try again in a moment.';

export async function createFriendStore(users: UserStore, jsonPath: string): Promise<FriendStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresFriendStore } = await import('./PostgresFriendStore.js');
    return await PostgresFriendStore.create(pool);
  }
  return new JsonFriendStore(jsonPath, users);
}

const userIdOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const nameOf = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX) : '');

export class FriendRoutes {
  private requests: RateLimiter;
  private statuses: RateLimiter;
  private changes: RateLimiter;
  private reads: RateLimiter;
  private imports: RateLimiter;

  private constructor(readonly store: FriendStore | null, private users: UserStore, private sendJson: Json, private parseJson: Body,
    private adminSecret: string, now: () => number) {
    this.requests = new RateLimiter(REQUEST_LIMIT, 10 * 60_000, 10_000, now);
    this.statuses = new RateLimiter(STATUS_LIMIT, 30_000, 10_000, now);
    this.changes = new RateLimiter(CHANGE_LIMIT, 60_000, 10_000, now);
    this.reads = new RateLimiter(READ_LIMIT, 60_000, 10_000, now);
    this.imports = new RateLimiter(IMPORT_LIMIT, 60 * 60_000, 10, now);
  }

  /** (Tests pass their own store and clock) */
  static async create(users: UserStore, sendJson: Json, parseJson: Body,
    opts: { store?: FriendStore; adminSecret: string; dataDir: string; now?: () => number }): Promise<FriendRoutes> {
    let store: FriendStore | null = opts.store ?? null;
    // (No friends is better than no lobby)
    if (!store) {
      try { store = await createFriendStore(users, path.join(opts.dataDir, 'friends.json')); } catch (err) { console.error('[Friends] off:', (err as Error).message); }
    }
    return new FriendRoutes(store, users, sendJson, parseJson, opts.adminSecret, opts.now ?? Date.now);
  }

  /** Handles /admin/friends/* (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST' || !url.startsWith('/admin/friends/')) return false;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return true; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: 'Friends are unavailable right now' }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, (err as { status?: number })?.status === 413 ? 413 : 400, { success: false, error: 'Invalid request' }); return true; }
    body ??= {};
    const action = url.slice('/admin/friends/'.length);
    if (action === 'import') { await this.import(res, this.store, body); return true; }
    if (!['get', 'request', 'respond', 'remove', 'status'].includes(action)) { this.sendJson(res, 404, { success: false, error: 'Not found' }); return true; }

    const me = userIdOf(body.userId);
    if (me === null) { this.sendJson(res, 400, { success: false, error: 'Which account?' }); return true; }
    const key = `id:${me}`;
    const limiter = action === 'get' ? this.reads : action === 'request' ? this.requests : action === 'status' ? this.statuses : this.changes;
    if (!limiter.hit(key)) { this.sendJson(res, 429, { success: false, limited: true, error: LIMITED }); return true; }
    if (!(await this.users.getUserById(me))) { this.sendJson(res, 404, { success: false, error: 'No such account' }); return true; }
    const store = this.store;

    if (action === 'get') { this.sendJson(res, 200, { success: true, ...(await this.view(store, me)) }); return true; }
    if (action === 'status') {
      if (!isStatus(body.status)) { this.sendJson(res, 400, { success: false, error: 'Not a status' }); return true; }
      await store.update([me], (l) => { l.get(me)!.status = body.status; });
      this.sendJson(res, 200, { success: true, status: body.status });
      return true;
    }

    const name = nameOf(body.name);
    if (!name) { this.sendJson(res, 400, { success: false, error: 'Who?' }); return true; }
    const target = await this.users.getUserByUsername(name);
    if (!target) {
      this.sendJson(res, 200, { success: true, result: action === 'request' ? 'unknown' : action === 'respond' ? 'gone' : 'none', me: await this.view(store, me) });
      return true;
    }
    const other = target.id;
    let result: string;
    if (action === 'request') {
      result = await store.update([me, other], (l) => request(l, me, other));
    } else if (action === 'respond') {
      result = await store.update([me, other], (l) => {
        if (!l.get(me)!.in.includes(other)) return 'gone';
        return respond(l, me, other, body.accept === true) ? 'accepted' : body.accept === true ? 'full' : 'declined';
      });
    } else {
      result = await store.update([me, other], (l) => {
        const wasFriend = l.get(me)!.friends.includes(other);
        return unfriend(l, me, other) ? (wasFriend ? 'unfriended' : 'removed') : 'none';
      });
    }
    this.sendJson(res, 200, {
      success: true, result, other: { id: other, name: target.username },
      me: await this.view(store, me), ...(other !== me ? { them: await this.view(store, other) } : {}),
    });
    return true;
  }

  /** An account's lists with names (accounts gone since are left out) */
  private async view(store: FriendStore, id: number) {
    const l: FriendLists = (await store.get(id)) ?? { status: 'online', friends: [], in: [], out: [] };
    const names = await store.names([...l.friends, ...l.in, ...l.out]);
    const entries = (ids: number[]) => ids.filter((i) => names.has(i)).map((i) => ({ id: i, name: names.get(i)! }));
    return { status: l.status, friends: entries(l.friends), incoming: entries(l.in), outgoing: entries(l.out) };
  }

  private async import(res: http.ServerResponse, store: FriendStore, body: any): Promise<void> {
    const raw = body.accounts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { this.sendJson(res, 400, { success: false, error: 'No accounts' }); return; }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length > IMPORT_MAX) { this.sendJson(res, 413, { success: false, error: `At most ${IMPORT_MAX} accounts an import` }); return; }
    if (!this.imports.hit('import')) { this.sendJson(res, 429, { success: false, limited: true, error: LIMITED }); return; }
    const accounts = new Map<number, FriendLists>();
    for (const [k, v] of entries) {
      const id = userIdOf(k);
      if (id !== null) accounts.set(id, cleanLists(v, id));
    }
    const mentioned = new Set<number>();
    for (const [id, l] of accounts) for (const x of [id, ...l.friends, ...l.in, ...l.out]) mentioned.add(x);
    const exists = new Set((await store.names([...mentioned])).keys());
    const added = await store.update([...exists], (l, had) => importDoc(l, accounts, exists, had));
    const skipped = [...accounts.keys()].filter((id) => !exists.has(id)).length;
    console.log(`[Friends] imported a server's friends: ${accounts.size} accounts, ${added.friends} friendships and ${added.requests} requests added, ${skipped} gone accounts skipped`);
    this.sendJson(res, 200, { success: true, ...added, skipped });
  }

  /** An account was deleted: off every list */
  forgetUser(userId: number): Promise<void> {
    return (this.store?.forgetUser(userId) ?? Promise.resolve()).catch((err) => console.error('[Friends] forgetting a deleted account failed:', err));
  }

  async close(): Promise<void> {
    await this.store?.close();
  }
}
