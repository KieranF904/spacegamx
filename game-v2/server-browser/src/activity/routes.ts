/**
 * The activity feed's routes.
 *
 *   POST /admin/activity/ingest { server, events: [{ at, type, player?, other?, detail? }] } -> { success, stored }
 *     From a game server (server/src/activity), with `Authorization: Bearer <LOBBY_ADMIN_SECRET>` (the secret the game
 *     servers already share with the lobby; nginx doesn't pass /admin/ through). At most INGEST_MAX events a call and
 *     CALLS_PER_MIN calls a minute per server name; "Lobby" is the lobby's own name and can't be sent. Bad events are
 *     skipped, not the batch. Without a secret (production with none set) it answers 403.
 *
 *   POST /activity/read { token, after?, before?, server?, type?, player?, search?, limit? }
 *     -> { success, feed: true, events: ActivityEvent[] (newest first), servers, types, live }
 *     For the website's admin panel (this lobby's own site, or the dev site reading the production lobby through
 *     nginx at /lobby/activity/): `token` is a session on this lobby of an admin (or the owner) who isn't banned.
 *     Signed out or not an admin: 401 / 403, still with `feed: true` (so a caller can tell the route exists).
 *     `live`: the game servers registered now (by name). Limited per address (READS_PER_MIN).
 *     CORS: only the origins in ACTIVITY_CORS_ORIGINS (comma separated; by default the dev site and the real one),
 *     never `*` (the rest of the lobby's answers are open: they carry no cookies either).
 *
 * The lobby's own events (sign-in, sign-out, registrations, account admin) go in through record(), as "Lobby".
 */

import http from 'http';
import path from 'path';
import type { UserStore } from '../accounts/types.js';
import { banMessage, isAdminRank, safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { JsonActivityStore } from './JsonActivityStore.js';
import type { ActivityStore, NewActivity } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;
type Pool = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

export const INGEST_MAX = 200;
export const CALLS_PER_MIN = 120;
/** Most events one read answers */
export const READ_MAX = 500;
/** Reads per address a minute (the panel asks every few seconds) */
export const READS_PER_MIN = 120;
/** Who may read the feed from a browser (the website server's own calls need no CORS) */
export const DEFAULT_CORS_ORIGINS = ['http://localhost:5310', 'http://127.0.0.1:5310', 'https://space.brotherk3d.com'];
/** The lobby's own events' server name (refused from a game server) */
export const LOBBY_NAME = 'Lobby';
const TYPE = /^[a-z][a-z_]{0,23}$/;
/** How far a game server's clock may be off before its stamps are replaced by ours */
const CLOCK_SLACK_MS = 10 * 60_000;

/** One line of plain text: control characters dropped, trimmed, cut to `max` */
export function oneLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f‧-‮]+/g, ' ').trim().slice(0, max);
}

/** An event a game server sent, made safe (null: skipped) */
export function cleanEvent(raw: any, server: string, now: number): NewActivity | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!TYPE.test(type)) return null;
  const at = Number(raw.at);
  return {
    at: Number.isFinite(at) && Math.abs(at - now) < CLOCK_SLACK_MS ? Math.round(at) : now,
    server, type,
    player: oneLine(raw.player, 40),
    other: oneLine(raw.other, 40),
    detail: oneLine(raw.detail, 200),
  };
}

export async function createActivityStore(users: UserStore, jsonPath: string): Promise<ActivityStore> {
  const pool = (users as { sharedPool?: Pool }).sharedPool;
  if (pool) {
    const { PostgresActivityStore } = await import('./PostgresActivityStore.js');
    return await PostgresActivityStore.create(pool);
  }
  return new JsonActivityStore(jsonPath);
}

export class ActivityRoutes {
  private calls = new RateLimiter(CALLS_PER_MIN, 60_000, 1000);
  private reads = new RateLimiter(READS_PER_MIN, 60_000);

  private constructor(readonly store: ActivityStore | null, private users: UserStore, private sendJson: Json, private parseJson: Body,
    private ipOf: (req: http.IncomingMessage) => string, private adminSecret: string, private live: () => string[],
    private now: () => number, private origins: Set<string>) {}

  /** (Tests pass their own store and clock) */
  static async create(users: UserStore, sendJson: Json, parseJson: Body, ipOf: (req: http.IncomingMessage) => string,
    opts: { store?: ActivityStore; adminSecret: string; dataDir: string; live?: () => string[]; now?: () => number; corsOrigins?: string }): Promise<ActivityRoutes> {
    let store: ActivityStore | null = opts.store ?? null;
    // (No feed is better than no lobby)
    if (!store) {
      try { store = await createActivityStore(users, path.join(opts.dataDir, 'activity.json')); } catch (err) { console.error('[Activity] off:', (err as Error).message); }
    }
    const list = (opts.corsOrigins ?? process.env.ACTIVITY_CORS_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
    return new ActivityRoutes(store, users, sendJson, parseJson, ipOf, opts.adminSecret, opts.live ?? (() => []), opts.now ?? Date.now,
      new Set(list.length ? list : DEFAULT_CORS_ORIGINS));
  }

  /** The feed's CORS (called for every request, after the lobby's open default): only the allowed origins */
  cors(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
    if (!url.startsWith('/activity/')) return;
    const origin = String(req.headers.origin ?? '');
    res.setHeader('Vary', 'Origin');
    if (origin && this.origins.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    else res.removeHeader('Access-Control-Allow-Origin');
  }

  /** Handles /activity/read and /admin/activity/ingest (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST' || (url !== '/activity/read' && url !== '/admin/activity/ingest')) return false;
    const ingest = url === '/admin/activity/ingest';
    if (ingest) {
      const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return true; }
    } else if (!this.reads.hit(this.ipOf(req))) {
      this.sendJson(res, 429, { success: false, feed: true, error: 'Too many requests. Wait a minute and try again.' });
      return true;
    }
    if (!this.store) { this.sendJson(res, 503, { success: false, feed: true, error: 'The activity feed is unavailable right now' }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, (err as { status?: number })?.status === 413 ? 413 : 400, { success: false, error: 'Invalid request' }); return true; }
    if (ingest) await this.ingest(res, this.store, body);
    else await this.read(res, this.store, body);
    return true;
  }

  private async ingest(res: http.ServerResponse, store: ActivityStore, body: any): Promise<void> {
    const server = oneLine(body.server, 64);
    if (!server || server.toLowerCase() === LOBBY_NAME.toLowerCase()) { this.sendJson(res, 400, { success: false, error: 'Which server?' }); return; }
    if (!Array.isArray(body.events)) { this.sendJson(res, 400, { success: false, error: 'No events' }); return; }
    if (body.events.length > INGEST_MAX) { this.sendJson(res, 413, { success: false, error: `At most ${INGEST_MAX} events a call` }); return; }
    if (!this.calls.hit(`server:${server.toLowerCase()}`)) { this.sendJson(res, 429, { success: false, error: 'Too many calls: send in bigger batches' }); return; }
    const now = this.now();
    const events = body.events.map((e: unknown) => cleanEvent(e, server, now)).filter((e: NewActivity | null): e is NewActivity => !!e);
    const stored = events.length ? (await store.add(events)).length : 0;
    this.sendJson(res, 200, { success: true, stored });
  }

  private async read(res: http.ServerResponse, store: ActivityStore, body: any): Promise<void> {
    const token = typeof body.token === 'string' ? body.token : '';
    const user = token ? await this.users.validateSession(token) : null;
    if (!user) { this.sendJson(res, 401, { success: false, feed: true, error: 'Invalid or expired session' }); return; }
    if (!isAdminRank(user) || banMessage(user)) { this.sendJson(res, 403, { success: false, feed: true, error: 'Only an admin can do that' }); return; }
    const id = (v: unknown) => { const n = v === undefined || v === null || v === '' ? NaN : Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : undefined; };
    const limit = Math.min(READ_MAX, Math.max(1, Math.floor(Number(body.limit) || 100)));
    const events = await store.list({
      after: id(body.after), before: id(body.before), limit,
      server: oneLine(body.server, 64) || undefined,
      type: TYPE.test(String(body.type ?? '')) ? String(body.type) : undefined,
      player: oneLine(body.player, 40) || undefined,
      search: oneLine(body.search, 100) || undefined,
    });
    const { servers, types } = await store.facets();
    this.sendJson(res, 200, { success: true, feed: true, events, servers, types, live: this.live() });
  }

  /** The lobby's own events (sign-ins and the like): never throws, never makes the caller wait */
  record(type: string, player: string, detail: string, other = ''): void {
    if (!this.store || !TYPE.test(type)) return;
    const e = { at: this.now(), server: LOBBY_NAME, type, player: oneLine(player, 40), other: oneLine(other, 40), detail: oneLine(detail, 200) };
    void this.store.add([e]).catch((err) => console.error('[Activity] record failed:', (err as Error).message));
  }

  async close(): Promise<void> {
    await this.store?.close();
  }
}
