/**
 * Accounts, kept by the lobby so one account works on every game server.
 *
 * Public (the client, through nginx at /lobby/auth/...):
 *   POST /auth/register  { username, email, password } -> { success, username, token, isAdmin }
 *   POST /auth/login     { username, password }        -> { success, username, token, isAdmin }
 *   POST /auth/validate  { token }                     -> { success, id, username, isAdmin }
 *   POST /auth/logout    { token }                     -> { success }
 *
 * Account management (the website's account page; each needs the session token,
 * and those that change the account need the password again; limited per address
 * like sign-in):
 *   POST /auth/account         { token }                          -> { success, id, username, email, isAdmin, createdAt }
 *   POST /auth/change-password { token, password, newPassword }   -> { success }   (the account's other sessions end)
 *   POST /auth/change-email    { token, password, email }         -> { success, email }
 *   POST /auth/logout-all      { token }                          -> { success, ended }  (every session, this one too)
 *   POST /auth/delete-account  { token, password }                -> { success, id }     (for good; its sessions go too)
 *
 * Deleting an account also deletes the pilot's profile: the lobby keeps the ids of lately deleted accounts
 * (DeletedAccounts) and answers each game server's heartbeat (POST /register, index.ts) with them as
 * `deletedAccounts`, and the server deletes those profiles (GameServer.forgetAccounts).
 *
 * Game servers call /auth/validate when a pilot joins with a token, and get
 * the account's id (their profiles are kept by it) and admin flag.
 *
 * Sign-in and registration are limited per address (a few a minute), so the
 * one place every password is checked can't be used to guess them. A banned
 * account can't sign in, and its sessions stop validating (the answer says why
 * and until when).
 *
 * Game servers only (the admin tools' players, ranks and bans; nginx doesn't
 * pass /admin/ through, and each call needs `Authorization: Bearer
 * <LOBBY_ADMIN_SECRET>`, the secret the game servers are given too):
 *   POST /admin/users     { search?, offset?, limit? }        -> { success, users: AdminUser[], total }
 *   POST /admin/user      { username }                        -> { success, user: AdminUser }
 *   POST /admin/set-admin { username, isAdmin }               -> { success, user }
 *   POST /admin/ban       { username, until, reason, by }     -> { success, user }   (until: epoch ms, null for good)
 *   POST /admin/unban     { username }                        -> { success, user }
 * AdminUser is { id, username, isAdmin, createdAt, ban: { until, reason, by } | null } (until null: for good);
 * never an email or credentials. Without a secret (production with none set)
 * these are off.
 */

import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createUserStore } from './index.js';
import { DeletedAccounts } from './DeletedAccounts.js';
import type { UserStore, UserSummary } from './types.js';
import { BAN_FOREVER, banMessage, validatePassword } from './utils.js';

type Json = (res: http.ServerResponse, status: number, body: unknown) => void;
type Body = (req: http.IncomingMessage) => Promise<any>;

/** Attempts allowed per address per window */
const LIMIT = 10;
const WINDOW_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
/** Accounts live beside the game's data (kept across deploys): ../../data/lobby from dist/accounts or src/accounts */
const DATA_DIR = process.env.ACCOUNTS_DIR || path.resolve(here, '../../../data/lobby');
/** Shared with the game servers for /admin/* (dev servers share a fixed one, so it works out of the box) */
const ADMIN_SECRET = process.env.LOBBY_ADMIN_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-lobby-admin-secret');
/** Account management actions (handleAccount) */
const ACCOUNT_ACTIONS = ['account', 'change-password', 'change-email', 'logout-all', 'delete-account'];
/** Most users in one page of /admin/users */
const PAGE_MAX = 100;

/** A user as the game servers' admin tools see them */
function adminUser(u: UserSummary, now = Date.now()) {
  const banned = u.banned_until !== null && u.banned_until > now;
  return {
    id: u.id, username: u.username, isAdmin: u.is_admin, createdAt: u.created_at,
    ban: banned ? { until: u.banned_until! >= BAN_FOREVER ? null : u.banned_until, reason: u.ban_reason ?? '', by: u.banned_by ?? '' } : null,
  };
}

export class AccountRoutes {
  private attempts = new Map<string, number[]>();

  private constructor(private store: UserStore, private sendJson: Json, private parseJson: Body, private ipOf: (req: http.IncomingMessage) => string, private adminSecret: string, private deleted: DeletedAccounts) {}

  /** (Tests pass their own store and secret) */
  static async create(sendJson: Json, parseJson: Body, ipOf: (req: http.IncomingMessage) => string, opts: { store?: UserStore; adminSecret?: string; deleted?: DeletedAccounts } = {}): Promise<AccountRoutes> {
    const store = opts.store ?? await createUserStore(DATA_DIR);
    if (!opts.store) setInterval(() => void store.cleanupExpiredSessions(), 60 * 60 * 1000);
    const secret = opts.adminSecret ?? ADMIN_SECRET;
    if (!secret) console.log("[Accounts] LOBBY_ADMIN_SECRET isn't set: the game servers' admin tools can't manage accounts");
    const deleted = opts.deleted ?? new DeletedAccounts(opts.store ? null : path.join(DATA_DIR, 'deleted-accounts.json'));
    return new AccountRoutes(store, sendJson, parseJson, ipOf, secret, deleted);
  }

  /** Handles /auth/* and /admin/* (true when it did) */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<boolean> {
    if (url.startsWith('/admin/') && req.method === 'POST') { await this.handleAdmin(req, res, url.slice('/admin/'.length)); return true; }
    if (!url.startsWith('/auth/') || req.method !== 'POST') return false;
    const action = url.slice('/auth/'.length);
    let body: any;
    try { body = await this.parseJson(req); } catch { this.sendJson(res, 400, { success: false, error: 'Invalid request' }); return true; }
    const str = (v: unknown) => (typeof v === 'string' ? v : '');

    if (action === 'login' || action === 'register') {
      if (!this.allow(this.ipOf(req))) {
        this.sendJson(res, 429, { success: false, error: 'Too many attempts. Wait a minute and try again.' });
        return true;
      }
      const result = action === 'login'
        ? await this.store.login(str(body.username), str(body.password))
        : await this.store.register(str(body.username), str(body.email), str(body.password));
      if (!result.success) { this.sendJson(res, action === 'login' ? 401 : 400, { success: false, error: result.error }); return true; }
      this.sendJson(res, 200, { success: true, username: result.user.username, token: result.token, isAdmin: result.user.is_admin });
      return true;
    }
    if (action === 'validate') {
      const user = str(body.token) ? await this.store.validateSession(str(body.token)) : null;
      if (!user) { this.sendJson(res, 401, { success: false, error: 'Invalid or expired session' }); return true; }
      const banned = banMessage(user);
      if (banned) { this.sendJson(res, 403, { success: false, error: banned, banned: true }); return true; }
      this.sendJson(res, 200, { success: true, id: user.id, username: user.username, isAdmin: user.is_admin });
      return true;
    }
    if (ACCOUNT_ACTIONS.includes(action)) { await this.handleAccount(req, res, action, body); return true; }
    if (action === 'logout') {
      if (str(body.token)) await this.store.logout(str(body.token));
      this.sendJson(res, 200, { success: true });
      return true;
    }
    this.sendJson(res, 404, { success: false, error: 'Not found' });
    return true;
  }

  /** The website's account management (see the top) */
  private async handleAccount(req: http.IncomingMessage, res: http.ServerResponse, action: string, body: any): Promise<void> {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const token = str(body.token);
    const user = token ? await this.store.validateSession(token) : null;
    if (!user) { this.sendJson(res, 401, { success: false, error: 'Invalid or expired session' }); return; }
    const banned = banMessage(user);
    if (banned) { this.sendJson(res, 403, { success: false, error: banned, banned: true }); return; }

    if (action === 'account') {
      this.sendJson(res, 200, { success: true, id: user.id, username: user.username, email: user.email, isAdmin: user.is_admin, createdAt: user.created_at });
      return;
    }
    if (action === 'logout-all') {
      const ended = await this.store.endSessions(user.id);
      console.log(`[Accounts] ${user.username} signed out everywhere (${ended})`);
      this.sendJson(res, 200, { success: true, ended });
      return;
    }
    // The rest change the account: the password again, limited like sign-in
    if (!this.allow(this.ipOf(req))) { this.sendJson(res, 429, { success: false, error: 'Too many attempts. Wait a minute and try again.' }); return; }
    if (!(await this.store.checkPassword(user.id, str(body.password)))) { this.sendJson(res, 401, { success: false, error: 'That password is wrong' }); return; }

    if (action === 'change-password') {
      const next = str(body.newPassword);
      const invalid = validatePassword(next);
      if (invalid) { this.sendJson(res, 400, { success: false, error: invalid }); return; }
      await this.store.setPassword(user.id, next);
      await this.store.endSessions(user.id, token);
      console.log(`[Accounts] ${user.username} changed their password`);
      this.sendJson(res, 200, { success: true });
      return;
    }
    if (action === 'change-email') {
      const error = await this.store.setEmail(user.id, str(body.email));
      if (error) { this.sendJson(res, 400, { success: false, error }); return; }
      this.sendJson(res, 200, { success: true, email: (await this.store.getUserById(user.id))?.email ?? '' });
      return;
    }
    // delete-account
    await this.store.deleteUser(user.id);
    this.deleted.add(user.id);
    console.log(`[Accounts] ${user.username} (id ${user.id}) deleted their account`);
    this.sendJson(res, 200, { success: true, id: user.id });
  }

  /** The game servers' account admin (see the top) */
  private async handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, action: string): Promise<void> {
    const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const secret = Buffer.from(this.adminSecret);
    if (!this.adminSecret || given.length !== secret.length || !crypto.timingSafeEqual(given, secret)) {
      this.sendJson(res, 403, { success: false, error: 'Forbidden' });
      return;
    }
    let body: any;
    try { body = await this.parseJson(req); } catch { this.sendJson(res, 400, { success: false, error: 'Invalid request' }); return; }
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

    if (action === 'users') {
      const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
      const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(body.limit) || 50)));
      const { users, total } = await this.store.listUsers(str(body.search), offset, limit);
      this.sendJson(res, 200, { success: true, users: users.map((u) => adminUser(u)), total });
      return;
    }
    if (!['user', 'set-admin', 'ban', 'unban'].includes(action)) { this.sendJson(res, 404, { success: false, error: 'Not found' }); return; }
    const found = str(body.username) ? await this.store.getUserByUsername(str(body.username)) : null;
    if (!found) { this.sendJson(res, 404, { success: false, error: `No account "${str(body.username)}"` }); return; }
    if (action === 'set-admin') await this.store.setAdmin(found.id, body.isAdmin === true);
    if (action === 'ban') {
      const until = body.until === null ? BAN_FOREVER : Number(body.until);
      if (!Number.isFinite(until) || until <= Date.now()) { this.sendJson(res, 400, { success: false, error: 'A ban needs an end in the future (or null for good)' }); return; }
      await this.store.setBan(found.id, Math.min(until, BAN_FOREVER), str(body.reason).slice(0, 200), str(body.by).slice(0, 40));
    }
    if (action === 'unban') await this.store.setBan(found.id, null, '', '');
    const user = (await this.store.getUserById(found.id))!;
    if (action !== 'user') console.log(`[Accounts] ${action} ${user.username}${action === 'ban' ? ` by ${str(body.by)}` : action === 'set-admin' ? `: ${user.is_admin}` : ''}`);
    this.sendJson(res, 200, { success: true, user: adminUser(user) });
  }

  /** The ids of accounts deleted lately, for the game servers to delete their profiles */
  deletedAccounts(): number[] {
    return this.deleted.recent();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private allow(ip: string): boolean {
    const now = Date.now();
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length >= LIMIT) { this.attempts.set(ip, list); return false; }
    list.push(now);
    this.attempts.set(ip, list);
    if (this.attempts.size > 10_000) this.attempts.clear();
    return true;
  }
}
