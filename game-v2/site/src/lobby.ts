/**
 * The lobby (server-browser), where accounts live. The site never sees a
 * password hash: it signs people in through the lobby and keeps the lobby's
 * session token in an HttpOnly cookie, the same token the game client uses.
 *
 * Calls are server to server. Each passes the visitor's address as
 * X-Forwarded-For, so the lobby's per-address attempt limit applies to each
 * visitor and not to the site as a whole (on the VPS the lobby is only reachable
 * on localhost, and nginx sets that header itself for the public /lobby/auth/).
 *
 * The admin calls (account search, bans) use LOBBY_ADMIN_SECRET, the secret the
 * game servers already share with the lobby; it never leaves the server.
 */

export interface LobbyUser { id: number; username: string; isAdmin: boolean }
export interface LobbyAccount extends LobbyUser { email: string; createdAt: string }
export interface AdminUser { id: number; username: string; isAdmin: boolean; createdAt: string; ban: { until: number | null; reason: string; by: string } | null }

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status: number };

export interface Lobby {
  login(username: string, password: string, ip: string): Promise<Result<{ token: string; user: LobbyUser }>>;
  register(username: string, email: string, password: string, ip: string): Promise<Result<{ token: string; user: LobbyUser }>>;
  /** The account behind a session (null: expired, signed out, or banned) */
  validate(token: string): Promise<LobbyUser | null>;
  logout(token: string): Promise<void>;
  account(token: string): Promise<Result<{ account: LobbyAccount }>>;
  changePassword(token: string, password: string, newPassword: string, ip: string): Promise<Result<object>>;
  changeEmail(token: string, password: string, email: string, ip: string): Promise<Result<{ email: string }>>;
  logoutAll(token: string): Promise<Result<{ ended: number }>>;
  deleteAccount(token: string, password: string, ip: string): Promise<Result<{ id: number }>>;
  /** Admin (LOBBY_ADMIN_SECRET) */
  findUser(username: string): Promise<AdminUser | null>;
  listUsers(search: string, offset: number, limit: number): Promise<Result<{ users: AdminUser[]; total: number }>>;
  ban(username: string, until: number | null, reason: string, by: string): Promise<Result<{ user: AdminUser }>>;
  unban(username: string): Promise<Result<{ user: AdminUser }>>;
}

export class HttpLobby implements Lobby {
  constructor(private base: string, private adminSecret: string) {}

  private async call(path: string, body: object, opts: { ip?: string; admin?: boolean } = {}): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.ip) headers['X-Forwarded-For'] = opts.ip;
    if (opts.admin) headers.Authorization = `Bearer ${this.adminSecret}`;
    try {
      const r = await fetch(`${this.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      let parsed: any = {};
      try { parsed = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body: parsed };
    } catch (e) {
      console.error(`[Site] lobby ${path} failed:`, (e as Error).message);
      return { status: 503, body: { success: false, error: "The account service isn't answering. Try again in a moment." } };
    }
  }

  private fail(r: { status: number; body: any }): { ok: false; error: string; status: number } {
    return { ok: false, error: String(r.body?.error || 'Something went wrong'), status: r.status };
  }

  private async auth(action: 'login' | 'register', body: object, ip: string) {
    const r = await this.call(`/auth/${action}`, body, { ip });
    if (!r.body?.success || !r.body.token) return this.fail(r);
    const user = await this.validate(r.body.token);
    if (!user) return { ok: false as const, error: 'Signed in, but the session could not be checked', status: 500 };
    return { ok: true as const, token: String(r.body.token), user };
  }

  login(username: string, password: string, ip: string) { return this.auth('login', { username, password }, ip); }
  register(username: string, email: string, password: string, ip: string) { return this.auth('register', { username, email, password }, ip); }

  async validate(token: string): Promise<LobbyUser | null> {
    const r = await this.call('/auth/validate', { token });
    if (!r.body?.success) return null;
    return { id: Number(r.body.id), username: String(r.body.username), isAdmin: !!r.body.isAdmin };
  }

  async logout(token: string) { await this.call('/auth/logout', { token }); }

  async account(token: string) {
    const r = await this.call('/auth/account', { token });
    if (!r.body?.success) return this.fail(r);
    const b = r.body;
    return { ok: true as const, account: { id: Number(b.id), username: b.username, email: b.email, isAdmin: !!b.isAdmin, createdAt: b.createdAt } };
  }

  async changePassword(token: string, password: string, newPassword: string, ip: string) {
    const r = await this.call('/auth/change-password', { token, password, newPassword }, { ip });
    return r.body?.success ? { ok: true as const } : this.fail(r);
  }

  async changeEmail(token: string, password: string, email: string, ip: string) {
    const r = await this.call('/auth/change-email', { token, password, email }, { ip });
    return r.body?.success ? { ok: true as const, email: String(r.body.email) } : this.fail(r);
  }

  async logoutAll(token: string) {
    const r = await this.call('/auth/logout-all', { token });
    return r.body?.success ? { ok: true as const, ended: Number(r.body.ended) } : this.fail(r);
  }

  async deleteAccount(token: string, password: string, ip: string) {
    const r = await this.call('/auth/delete-account', { token, password }, { ip });
    return r.body?.success ? { ok: true as const, id: Number(r.body.id) } : this.fail(r);
  }

  async findUser(username: string): Promise<AdminUser | null> {
    if (!this.adminSecret || !username) return null;
    const r = await this.call('/admin/user', { username }, { admin: true });
    return r.body?.success ? r.body.user : null;
  }

  async listUsers(search: string, offset: number, limit: number) {
    const r = await this.call('/admin/users', { search, offset, limit }, { admin: true });
    return r.body?.success ? { ok: true as const, users: r.body.users as AdminUser[], total: Number(r.body.total) } : this.fail(r);
  }

  async ban(username: string, until: number | null, reason: string, by: string) {
    const r = await this.call('/admin/ban', { username, until, reason, by }, { admin: true });
    return r.body?.success ? { ok: true as const, user: r.body.user as AdminUser } : this.fail(r);
  }

  async unban(username: string) {
    const r = await this.call('/admin/unban', { username }, { admin: true });
    return r.body?.success ? { ok: true as const, user: r.body.user as AdminUser } : this.fail(r);
  }
}
