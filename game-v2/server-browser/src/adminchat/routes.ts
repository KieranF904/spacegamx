/**
 * @contract lobby.adminchat.routes
 * owns:       chat between admins on the website and pilots in the game: who is on each game server (told by the
 *             servers), the messages waiting for each server, the admin message log, and leaving a message in an
 *             offline pilot's inbox instead
 * needs:      UserStore (is the sender an admin; the inbox's account), AdminChatStore, accounts/RateLimiter + utils; the
 *             inbox through the lobby's entry (opts.toInbox)
 * invariants: every route needs LOBBY_ADMIN_SECRET, and a send also names a real admin who isn't banned — server-browser/src/adminchat/adminchat.test.ts
 *             a message goes only to the server it was sent to, and a private one only when that pilot is on there — server-browser/src/adminchat/adminchat.test.ts
 *             a message is handed to its server until the server says it has it, then never again — server-browser/src/adminchat/adminchat.test.ts
 *             a pilot's private reply is kept in the admin log only: nothing reaches the activity feed — server-browser/src/adminchat/adminchat.test.ts
 *             sends are limited per admin and cut to TEXT_MAX; every one is logged with who, to whom, where and when — server-browser/src/adminchat/adminchat.test.ts
 * extend:     a new route is one case in handle()
 *
 * All behind `Authorization: Bearer <LOBBY_ADMIN_SECRET>` (nginx doesn't pass /admin/ through; a browser never has it).
 *
 * From a game server (server/src/adminChatLink.ts), every couple of seconds while pilots are on:
 *   POST /admin/chat/poll { server, online: [{ name, guest, since }], replies: [{ from, guest, to, text, at }], failed: [id], ack }
 *        -> { success, epoch, messages: [{ id, kind: 'all' | 'pm', admin, to?, text }] }
 *        `ack`: the newest message id the server has handled. `failed`: private ones whose pilot had gone.
 *
 * From the website's admin panel (site/src/routes/adminChat.ts), naming the signed-in admin as `actor`:
 *   POST /admin/chat/state { actor, server?, with? } -> { success, servers: [{ name, fresh, online }], messages: [...] }
 *        The log, oldest first: everything, one server's, or one pilot's conversation (`with`).
 *   POST /admin/chat/send  { actor, server, to?, text } -> { success, id } | { success: false, offline: true, error }
 *        `to` left out: everyone on that server. With `to`: a private message, only if that pilot is on there now.
 *   POST /admin/chat/inbox { actor, to, text } -> { success }   left in that account's in-game inbox (for a pilot who is offline)
 */

import http from 'http';
import path from 'path';
import type { UserStore } from '../accounts/types.js';
import { banMessage, isAdminRank, safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { createAdminChatStore } from './index.js';
import type { AdminChatStore, AdminMessageRecord } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;

/** Most characters of one message, either way */
export const TEXT_MAX = 300;
/** Messages an admin may send a minute */
export const SENDS_PER_MIN = 30;
/** Polls a game server may make a minute (it asks every 2 s) */
export const POLLS_PER_MIN = 120;
/** A server that hasn't asked for this long isn't connected: its roster is stale and nothing can be sent to it */
export const FRESH_MS = 15_000;
/** A message its server never came for is given up on after this long */
export const GIVE_UP_MS = 60_000;
/** Most pilots of a roster, and replies of one poll, taken */
const ROSTER_MAX = 500;
const REPLIES_MAX = 100;
const LOG_MAX = 200;
const NAME = /^[A-Za-z0-9_-]{2,20}$/;

export interface OnlinePilot { name: string; guest: boolean; since: number }
interface ServerState { online: OnlinePilot[]; at: number; outbox: { id: number; kind: 'all' | 'pm'; admin: string; to?: string; text: string; at: number }[] }

/** One line of plain text: control characters dropped, trimmed, cut to `max` */
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f‧-‮]+/g, ' ').trim().slice(0, max);
}

function bodyStatus(err: unknown): number {
  return (err as { status?: unknown })?.status === 413 ? 413 : 400;
}

const view = (m: AdminMessageRecord) => ({ id: m.id, at: m.at, server: m.server, direction: m.direction, admin: m.admin, pilot: m.pilot, text: m.body, status: m.status });

export class AdminChatRoutes {
  private servers = new Map<string, ServerState>();
  private sends: RateLimiter;
  private polls: RateLimiter;
  /** When this lobby started: a game server that sees it change starts counting message ids afresh (they may have, too) */
  private epoch: number;

  private constructor(readonly store: AdminChatStore | null, private users: UserStore, private sendJson: Json, private parseJson: Body,
    private adminSecret: string, private now: () => number, private toInbox: ((userId: number, subject: string, body: string) => Promise<boolean>) | null) {
    this.sends = new RateLimiter(SENDS_PER_MIN, 60_000, 1000, now);
    this.polls = new RateLimiter(POLLS_PER_MIN, 60_000, 1000, now);
    this.epoch = now();
  }

  /** (Tests pass their own store and clock.) `toInbox`: the inbox's own way to leave a message from the game */
  static async create(users: UserStore, sendJson: Json, parseJson: Body,
    opts: { store?: AdminChatStore; adminSecret: string; dataDir: string; now?: () => number; toInbox?: (userId: number, subject: string, body: string) => Promise<boolean> }): Promise<AdminChatRoutes> {
    let store: AdminChatStore | null = opts.store ?? null;
    // (No admin chat is better than no lobby)
    if (!store) {
      try { store = await createAdminChatStore(users, path.join(opts.dataDir, 'admin-messages.json')); } catch (err) { console.error('[AdminChat] off:', (err as Error).message); }
    }
    return new AdminChatRoutes(store, users, sendJson, parseJson, opts.adminSecret, opts.now ?? Date.now, opts.toInbox ?? null);
  }

  /** Handles /admin/chat/* (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST' || !url.startsWith('/admin/chat/')) return false;
    const action = url.slice('/admin/chat/'.length);
    if (!['poll', 'state', 'send', 'inbox'].includes(action)) return false;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return true; }
    if (!this.store) { this.sendJson(res, 503, { success: false, error: 'Admin chat is unavailable right now' }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, bodyStatus(err), { success: false, error: 'Invalid request' }); return true; }
    try {
      if (action === 'poll') await this.poll(res, this.store, body);
      else {
        // (The website has checked its visitor's session; the lobby checks the name it gives is an admin's, as for bans)
        const actor = typeof body?.actor === 'string' ? await this.users.getUserByUsername(body.actor.trim()) : null;
        if (!actor || !isAdminRank(actor) || banMessage(actor)) { this.sendJson(res, 403, { success: false, error: 'Only an admin can do that' }); return true; }
        if (action === 'state') await this.state(res, this.store, body);
        else if (action === 'send') await this.send(res, this.store, actor.username, body);
        else await this.inbox(res, this.store, actor.username, body);
      }
    } catch (err) {
      console.error(`[AdminChat] ${action} failed:`, err);
      this.sendJson(res, 500, { success: false, error: 'Something went wrong. Try again in a moment.' });
    }
    return true;
  }

  private fresh(s: ServerState | undefined): s is ServerState {
    return !!s && this.now() - s.at < FRESH_MS;
  }

  /** A game server asking: who it has on, what pilots replied, what it couldn't deliver; back go the messages for it */
  private async poll(res: http.ServerResponse, store: AdminChatStore, body: any): Promise<void> {
    const name = cleanLine(body?.server, 64);
    if (!name) { this.sendJson(res, 400, { success: false, error: 'Which server?' }); return; }
    if (!this.polls.hit(name)) { this.sendJson(res, 429, { success: false, error: 'Too many requests' }); return; }
    const now = this.now();
    let s = this.servers.get(name);
    if (!s) this.servers.set(name, s = { online: [], at: now, outbox: [] });
    s.at = now;
    s.online = (Array.isArray(body.online) ? body.online.slice(0, ROSTER_MAX) : [])
      .map((p: any) => ({ name: cleanLine(p?.name, 40), guest: p?.guest === true, since: Number.isFinite(p?.since) ? Number(p.since) : now }))
      .filter((p: OnlinePilot) => p.name);

    // What the server has handled is done with; what it couldn't deliver is marked so
    const ack = Number.isSafeInteger(body.ack) ? body.ack as number : 0;
    const failed = new Set<number>((Array.isArray(body.failed) ? body.failed : []).filter((n: unknown) => Number.isSafeInteger(n)));
    const done = s.outbox.filter((m) => m.id <= ack);
    s.outbox = s.outbox.filter((m) => m.id > ack);
    const mine = new Set(done.map((m) => m.id));
    await store.setStatus(done.filter((m) => !failed.has(m.id)).map((m) => m.id), 'sent');
    // (Only its own messages: a server can't mark another's)
    await store.setStatus([...failed].filter((id) => mine.has(id)), 'failed');

    // Pilots' private replies: the admin log only
    for (const r of (Array.isArray(body.replies) ? body.replies.slice(0, REPLIES_MAX) : [])) {
      const from = cleanLine(r?.from, 40), to = cleanLine(r?.to, 20), text = cleanLine(r?.text, TEXT_MAX);
      if (!from || !NAME.test(to) || !text) continue;
      await store.add({ at: now, server: name, direction: 'in', admin: to, pilot: from, body: text, status: 'received' });
    }
    this.sendJson(res, 200, { success: true, epoch: this.epoch, messages: s.outbox.map(({ at: _at, ...m }) => m) });
  }

  /** Messages no server came for: given up on (their server stopped asking) */
  private async expire(store: AdminChatStore): Promise<void> {
    const now = this.now();
    for (const s of this.servers.values()) {
      const old = s.outbox.filter((m) => now - m.at >= GIVE_UP_MS);
      if (!old.length) continue;
      s.outbox = s.outbox.filter((m) => now - m.at < GIVE_UP_MS);
      await store.setStatus(old.map((m) => m.id), 'failed');
    }
  }

  private async state(res: http.ServerResponse, store: AdminChatStore, body: any): Promise<void> {
    await this.expire(store);
    const server = cleanLine(body?.server, 64) || undefined;
    const pilot = cleanLine(body?.with, 40) || undefined;
    const messages = await store.list({ server, pilot, limit: LOG_MAX });
    const servers = [...this.servers].map(([name, s]) => ({ name, fresh: this.fresh(s), online: this.fresh(s) ? s.online : [] }))
      .sort((a, b) => Number(b.fresh) - Number(a.fresh) || a.name.localeCompare(b.name));
    this.sendJson(res, 200, { success: true, servers, messages: messages.map(view) });
  }

  private async send(res: http.ServerResponse, store: AdminChatStore, admin: string, body: any): Promise<void> {
    const text = cleanLine(body?.text, TEXT_MAX + 1);
    if (!text) { this.sendJson(res, 400, { success: false, error: 'The message is empty' }); return; }
    if (text.length > TEXT_MAX) { this.sendJson(res, 400, { success: false, error: `The message is too long (${TEXT_MAX} characters at most)` }); return; }
    const name = cleanLine(body?.server, 64);
    const s = this.servers.get(name);
    if (!this.fresh(s)) { this.sendJson(res, 409, { success: false, error: name ? `${name} isn't connected right now` : 'Which server?' }); return; }
    const to = cleanLine(body?.to, 40);
    const target = to ? s.online.find((p) => p.name.toLowerCase() === to.toLowerCase()) : undefined;
    if (to && !target) { this.sendJson(res, 409, { success: false, offline: true, error: `${to} is not online on ${name}` }); return; }
    if (!to && !s.online.length) { this.sendJson(res, 409, { success: false, error: `Nobody is on ${name} right now` }); return; }
    if (!this.sends.hit(admin.toLowerCase())) { this.sendJson(res, 429, { success: false, error: 'Too many messages sent lately. Wait a minute and try again.' }); return; }
    const row = await store.add({ at: this.now(), server: name, direction: 'out', admin, pilot: target?.name ?? '', body: text, status: 'queued' });
    s.outbox.push({ id: row.id, kind: target ? 'pm' : 'all', admin, ...(target ? { to: target.name } : {}), text, at: row.at });
    console.log(`[AdminChat] ${admin} -> ${target ? target.name : 'everyone'} on ${name}`);
    this.sendJson(res, 200, { success: true, id: row.id });
  }

  private async inbox(res: http.ServerResponse, store: AdminChatStore, admin: string, body: any): Promise<void> {
    const text = cleanLine(body?.text, TEXT_MAX + 1);
    const to = cleanLine(body?.to, 40);
    if (!text || text.length > TEXT_MAX) { this.sendJson(res, 400, { success: false, error: text ? `The message is too long (${TEXT_MAX} characters at most)` : 'The message is empty' }); return; }
    const user = to ? await this.users.getUserByUsername(to) : null;
    // (A guest has no account, so no inbox)
    if (!user) { this.sendJson(res, 404, { success: false, error: to ? `No account "${to}" (a guest has no inbox)` : 'Send it to whom?' }); return; }
    if (!this.toInbox) { this.sendJson(res, 503, { success: false, error: 'The inbox is unavailable right now' }); return; }
    if (!this.sends.hit(admin.toLowerCase())) { this.sendJson(res, 429, { success: false, error: 'Too many messages sent lately. Wait a minute and try again.' }); return; }
    const ok = await this.toInbox(user.id, `A message from ${admin} (admin)`, text);
    if (!ok) { this.sendJson(res, 503, { success: false, error: 'The inbox is unavailable right now' }); return; }
    await store.add({ at: this.now(), server: '', direction: 'out', admin, pilot: user.username, body: text, status: 'inbox' });
    console.log(`[AdminChat] ${admin} -> ${user.username}'s inbox`);
    this.sendJson(res, 200, { success: true });
  }

  async close(): Promise<void> {
    await this.store?.close();
  }
}
