/**
 * The player inbox's routes (the client, through nginx at /lobby/inbox/...). Every call carries the session
 * token in the body (as /auth/*), and the token's account is the only inbox it can touch.
 *
 *   POST /inbox/list   { token }                    -> { success, messages: InboxMessage[], unread, unreadImportant }
 *   POST /inbox/read   { token, id | ids | all }    -> { success, changed, unread, unreadImportant }
 *   POST /inbox/delete { token, id | ids }          -> { success, changed, unread, unreadImportant }
 *
 * (The website's /account/inbox uses these three too, with the pilot's own session: site/src/playerLobby.ts.)
 *
 * The lobby itself sends one kind of message, systemMessage(): the thank-you for a donation (donations/routes.ts).
 *
 * Admins (and the owner) only, checked on the token's account:
 *   POST /inbox/send   { token, to | everyone: true, subject, body, important? } -> { success, sent, to }
 *   POST /inbox/sent   { token }                    -> { success, sent: SentInfo[] }
 *
 * The game servers' /mail chat command (behind LOBBY_ADMIN_SECRET like the rest of /admin/, which nginx doesn't
 * pass through):
 *   POST /admin/mail   { actor?, to | everyone: true, subject?, body, important? } -> { success, sent, to }
 * With an actor, they must be a signed-up admin who isn't banned; without one the message is from "system".
 *
 * InboxMessage: { id, from, subject, body, important, createdAt, readAt } (from: a username or 'system').
 * SentInfo: { to ('*': everyone), from, subject, body, important, createdAt, recipients, read }.
 *
 * Limits: every inbox call per address (IP_LIMIT a minute), sends per admin (SEND_LIMIT per 10 minutes, and
 * BROADCAST_LIMIT an hour to everyone); a subject up to SUBJECT_MAX characters and a body up to BODY_MAX (refused
 * past them, never cut). Text is stored plain (control characters dropped) and escaped where it's shown.
 */

import http from 'http';
import path from 'path';
import type { UserRecord, UserStore } from '../accounts/types.js';
import { banMessage, isAdminRank, safeEqual } from '../accounts/utils.js';
import { RateLimiter } from '../accounts/RateLimiter.js';
import { createMessageStore } from './index.js';
import type { MessageRecord, MessageStore } from './types.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;

export const SUBJECT_MAX = 120;
export const BODY_MAX = 4000;
/** Inbox calls per address a minute */
export const IP_LIMIT = 60;
/** Sends per admin per 10 minutes, and to everyone per hour */
export const SEND_LIMIT = 30;
export const BROADCAST_LIMIT = 5;
/** Most messages one list answer carries, sends in the sent list, and ids in one read/delete */
const LIST_MAX = 100;
const SENT_MAX = 50;
const IDS_MAX = 100;
const SLOW_DOWN = 'Too many requests. Wait a minute and try again.';
/** Recipient names "everyone" means (when no account has that name) */
const EVERYONE = new Set(['*', 'everyone', 'all']);

/** Plain text as stored: newlines kept (not in a subject), other control characters dropped, trimmed */
export function cleanText(v: unknown, oneLine: boolean): string {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2027-\u202e]/g, '');
  if (oneLine) s = s.replace(/[\n\t]+/g, ' ');
  return s.trim();
}

function bodyStatus(err: unknown): number {
  return (err as { status?: unknown })?.status === 413 ? 413 : 400;
}

/** A message as its reader gets it */
function view(m: MessageRecord) {
  return { id: m.id, from: m.from_name, subject: m.subject, body: m.body, important: m.important, createdAt: m.created_at, readAt: m.read_at };
}

/** The ids a read/delete names (a number, or a list of them), or null when none are valid */
function idsOf(body: any): number[] | null {
  const raw: unknown[] = Array.isArray(body.ids) ? body.ids.slice(0, IDS_MAX) : [body.id];
  const ids = raw.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  return ids.length ? ids : null;
}

export class InboxRoutes {
  private perIp = new RateLimiter(IP_LIMIT, 60_000);
  private sends = new RateLimiter(SEND_LIMIT, 10 * 60_000);
  private broadcasts = new RateLimiter(BROADCAST_LIMIT, 60 * 60_000);

  private constructor(readonly store: MessageStore | null, private users: UserStore, private sendJson: Json, private parseJson: Body,
    private ipOf: (req: http.IncomingMessage) => string, private adminSecret: string) {}

  /** (Tests pass their own message store) */
  static async create(users: UserStore, sendJson: Json, parseJson: Body, ipOf: (req: http.IncomingMessage) => string,
    opts: { store?: MessageStore; adminSecret: string; dataDir: string }): Promise<InboxRoutes> {
    let store: MessageStore | null = opts.store ?? null;
    // (No inbox is better than no lobby: sign-in mustn't go down because the messages table can't be made)
    if (!store) {
      try { store = await createMessageStore(users, path.join(opts.dataDir, 'messages.json')); } catch (err) { console.error('[Inbox] off:', (err as Error).message); }
    }
    return new InboxRoutes(store, users, sendJson, parseJson, ipOf, opts.adminSecret);
  }

  /** Handles /inbox/* and /admin/mail (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (req.method !== 'POST') return false;
    if (url !== '/admin/mail' && !url.startsWith('/inbox/')) return false;
    if (!this.store) { this.sendJson(res, 503, { success: false, error: 'The inbox is unavailable right now' }); return true; }
    if (url === '/admin/mail') { await this.handleServerMail(req, res, this.store); return true; }
    const store = this.store;
    const action = url.slice('/inbox/'.length);
    if (!this.perIp.hit(this.ipOf(req))) { this.sendJson(res, 429, { success: false, error: SLOW_DOWN }); return true; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, bodyStatus(err), { success: false, error: 'Invalid request' }); return true; }
    const token = typeof body.token === 'string' ? body.token : '';
    const user = token ? await this.users.validateSession(token) : null;
    if (!user) { this.sendJson(res, 401, { success: false, error: 'Invalid or expired session' }); return true; }
    const banned = banMessage(user);
    if (banned) { this.sendJson(res, 403, { success: false, error: banned, banned: true }); return true; }

    switch (action) {
      case 'list': {
        const page = await store.list(user.id, LIST_MAX);
        this.sendJson(res, 200, { success: true, messages: page.messages.map(view), unread: page.unread, unreadImportant: page.unreadImportant });
        return true;
      }
      case 'read':
      case 'delete': {
        const ids = action === 'read' && body.all === true ? 'all' : idsOf(body);
        if (!ids) { this.sendJson(res, 400, { success: false, error: 'Which message?' }); return true; }
        const changed = ids === 'all' || action === 'read' ? await store.markRead(user.id, ids) : await store.archive(user.id, ids);
        const page = await store.list(user.id, 0);
        this.sendJson(res, 200, { success: true, changed, unread: page.unread, unreadImportant: page.unreadImportant });
        return true;
      }
      case 'send':
      case 'sent':
        if (!isAdminRank(user)) { this.sendJson(res, 403, { success: false, error: 'Only an admin can do that' }); return true; }
        if (action === 'sent') {
          const sent = await store.sent(SENT_MAX);
          this.sendJson(res, 200, {
            success: true,
            sent: sent.map((s) => ({ to: s.sent_to, from: s.from_name, subject: s.subject, body: s.body, important: s.important, createdAt: s.created_at, recipients: s.recipients, read: s.read })),
          });
          return true;
        }
        await this.send(res, store, user, body);
        return true;
    }
    this.sendJson(res, 404, { success: false, error: 'Not found' });
    return true;
  }

  /** /admin/mail: a game server's /mail, behind the admin secret (see the top) */
  private async handleServerMail(req: http.IncomingMessage, res: http.ServerResponse, store: MessageStore): Promise<void> {
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.adminSecret || !safeEqual(given, this.adminSecret)) { this.sendJson(res, 403, { success: false, error: 'Forbidden' }); return; }
    let body: any;
    try { body = await this.parseJson(req); } catch (err) { this.sendJson(res, bodyStatus(err), { success: false, error: 'Invalid request' }); return; }
    let actor: UserRecord | null = null;
    if (typeof body.actor === 'string' && body.actor.trim()) {
      actor = await this.users.getUserByUsername(body.actor.trim());
      if (!actor || !isAdminRank(actor) || banMessage(actor)) { this.sendJson(res, 403, { success: false, error: 'Only an admin can do that' }); return; }
    }
    await this.send(res, store, actor, body);
  }

  /** A send from an admin (null: the game, "system") */
  private async send(res: http.ServerResponse, store: MessageStore, from: UserRecord | null, body: any): Promise<void> {
    const text = cleanText(body.body, false);
    const subject = cleanText(body.subject, true) || (from ? `A message from ${from.username}` : 'A message from the game');
    if (!text) { this.sendJson(res, 400, { success: false, error: 'The message is empty' }); return; }
    if (text.length > BODY_MAX) { this.sendJson(res, 400, { success: false, error: `The message is too long (${BODY_MAX} characters at most)` }); return; }
    if (subject.length > SUBJECT_MAX) { this.sendJson(res, 400, { success: false, error: `The subject is too long (${SUBJECT_MAX} characters at most)` }); return; }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const recipient = to && !(body.everyone === true) ? await this.users.getUserByUsername(to) : null;
    const everyone = body.everyone === true || (!recipient && EVERYONE.has(to.toLowerCase()));
    if (!everyone && !recipient) { this.sendJson(res, 404, { success: false, error: to ? `No account "${to.slice(0, 40)}"` : 'Send it to whom?' }); return; }

    const who = from ? `id:${from.id}` : 'system';
    if (this.sends.blocked(who) || (everyone && this.broadcasts.blocked(who))) { this.sendJson(res, 429, { success: false, error: 'Too many messages sent lately. Wait a while and try again.' }); return; }
    this.sends.record(who);
    if (everyone) this.broadcasts.record(who);

    const ids = everyone ? await this.allUserIds() : [recipient!.id];
    const { count } = await store.send(ids, {
      from_user_id: from?.id ?? null, from_name: from?.username ?? 'system', subject, body: text,
      // (An admin's message is a banner until read, unless they say otherwise; the game's only when asked)
      important: body.important === undefined ? !!from : body.important === true,
      sent_to: everyone ? '*' : recipient!.username,
    });
    console.log(`[Inbox] ${from?.username ?? 'system'} sent "${subject}" to ${everyone ? `everyone (${count})` : recipient!.username}`);
    this.sendJson(res, 200, { success: true, sent: count, to: everyone ? '*' : recipient!.username });
  }

  /**
   * A message from the game ("system") to one account, made by the lobby itself (the thank-you for a donation):
   * not a banner, just unread mail. False when the account is gone or the inbox is off.
   */
  async systemMessage(userId: number, subject: string, body: string): Promise<boolean> {
    if (!this.store) return false;
    const user = await this.users.getUserById(userId);
    if (!user) return false;
    const { count } = await this.store.send([user.id], { from_user_id: null, from_name: 'system', subject: cleanText(subject, true).slice(0, SUBJECT_MAX), body: cleanText(body, false).slice(0, BODY_MAX), important: false, sent_to: user.username });
    return count > 0;
  }

  /** Every account, a page at a time */
  private async allUserIds(): Promise<number[]> {
    const ids: number[] = [];
    for (let offset = 0; ; offset += 500) {
      const { users, total } = await this.users.listUsers('', offset, 500);
      ids.push(...users.map((u) => u.id));
      if (!users.length || ids.length >= total) return ids;
    }
  }

  /** An account was deleted: its mail goes too */
  forgetUser(userId: number): void {
    void this.store?.forgetUser(userId).catch((err) => console.error('[Inbox] forgetting a deleted account failed:', err));
  }

  async close(): Promise<void> {
    await this.store?.close();
  }
}
