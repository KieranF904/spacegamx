/**
 * The game server's view of the accounts: it asks the lobby, which keeps them
 * (server-browser/src/accounts). Pilots normally sign in at the lobby before
 * picking a server and join with its token; this checks the token, and still
 * passes on sign-ins sent over the game connection (older clients).
 *
 * Given the lobby's admin secret (LOBBY_ADMIN_SECRET, the same on both), it
 * can manage accounts too (`admin`: the admin tools' players, ranks and bans).
 */

import type { AccountAdmin, AccountInfo, AuthResult, UserRecord, UserStore } from './types.js';

const UNREACHABLE = 'Accounts are unavailable right now. Try again shortly.';

/** An address worth passing on (IPv4 or IPv6, nothing else: it goes in a header) */
const ADDRESS = /^[0-9A-Fa-f:.]{2,64}$/;

export class LobbyAccounts implements UserStore {
  readonly admin: AccountAdmin | null;

  constructor(private lobbyUrl: string, adminSecret = '') {
    this.admin = adminSecret ? new LobbyAccountAdmin(lobbyUrl, adminSecret) : null;
  }

  /**
   * `ip`: the player's address. A sign-in relayed through here reaches the lobby from this machine, which it trusts to
   * say who it's for (X-Forwarded-For, as from nginx), so its attempt limits count each player, not this server as one
   */
  private async post(path: string, body: unknown, ip?: string): Promise<any> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ip && ADDRESS.test(ip)) headers['X-Forwarded-For'] = ip;
      const r = await fetch(`${this.lobbyUrl}/auth/${path}`, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      return await r.json();
    } catch (err) {
      console.error(`[Accounts] lobby unreachable (${path}):`, String(err));
      return { success: false, error: UNREACHABLE };
    }
  }

  private async signIn(path: 'login' | 'register', body: unknown, ip?: string): Promise<AuthResult> {
    const r = await this.post(path, body, ip);
    if (!r?.success) return { success: false, error: r?.error ?? 'Sign-in failed' };
    // The lobby's answer doesn't carry the id: ask for it with the new token
    const user = await this.validateSession(r.token);
    if (!user) return { success: false, error: 'Sign-in failed' };
    return { success: true, user, token: r.token };
  }

  login(username: string, password: string, ip?: string): Promise<AuthResult> {
    return this.signIn('login', { username, password }, ip);
  }

  register(username: string, email: string, password: string, ip?: string): Promise<AuthResult> {
    return this.signIn('register', { username, email, password }, ip);
  }

  async validateSession(token: string): Promise<UserRecord | null> {
    return (await this.checkSession(token)).user;
  }

  async checkSession(token: string): Promise<{ user: UserRecord } | { user: null; error: string }> {
    const r = await this.post('validate', { token });
    // (Only a ban's refusal is worth passing on: anything else is "sign in again")
    if (!r?.success) return { user: null, error: r?.banned ? String(r.error) : '' };
    return { user: { id: r.id, username: r.username, email: '', is_admin: !!r.isAdmin, created_at: '' } };
  }

  async logout(token: string): Promise<void> {
    await this.post('logout', { token });
  }

  async cleanupExpiredSessions(): Promise<void> {}
  async close(): Promise<void> {}
}

/** The lobby's /admin/* (server-browser/src/accounts/routes.ts) */
class LobbyAccountAdmin implements AccountAdmin {
  constructor(private lobbyUrl: string, private secret: string) {}

  private async post(path: string, body: unknown, missingOk = false): Promise<any> {
    let r: Response;
    try {
      r = await fetch(`${this.lobbyUrl}/admin/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secret}` }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error(`[Accounts] lobby unreachable (admin/${path}):`, String(err));
      throw new Error(UNREACHABLE);
    }
    if (r.status === 404 && missingOk) return null;
    const data: any = await r.json().catch(() => null);
    if (r.status === 403) throw new Error("The lobby refused (LOBBY_ADMIN_SECRET isn't the same on the lobby and this server)");
    if (!data?.success) throw new Error(data?.error ?? `The lobby answered ${r.status}`);
    return data;
  }

  async list(search: string, offset: number, limit: number): Promise<{ users: AccountInfo[]; total: number }> {
    const r = await this.post('users', { search, offset, limit });
    return { users: r.users, total: r.total };
  }

  async get(username: string): Promise<AccountInfo | null> {
    return (await this.post('user', { username }, true))?.user ?? null;
  }

  async setAdmin(username: string, on: boolean): Promise<AccountInfo> {
    return (await this.post('set-admin', { username, isAdmin: on })).user;
  }

  async ban(username: string, until: number | null, reason: string, by: string): Promise<AccountInfo> {
    return (await this.post('ban', { username, until, reason, by })).user;
  }

  async unban(username: string): Promise<AccountInfo> {
    return (await this.post('unban', { username })).user;
  }
}
