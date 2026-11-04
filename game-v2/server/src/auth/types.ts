/**
 * Accounts as the game server sees them. They're kept by the lobby
 * (server-browser/src/accounts), so one account works on every game server;
 * the game server only asks it (LobbyAccounts).
 */

/** Public user record (never includes password_hash/salt) */
export interface UserRecord {
  id: number;
  username: string;
  email: string;
  is_admin: boolean;
  /** The owner rank, above admin (an owner is an admin too: is_admin is true for one). Missing: not the owner */
  is_owner?: boolean;
  created_at: string;
}

/** Result for register/login operations */
export type AuthResult =
  | { success: true; user: UserRecord; token: string }
  | { success: false; error: string };

/** What the game server needs of the accounts */
export interface UserStore {
  /** Create a new account and start a session (`ip`: the player's address, for the attempt limits) */
  register(username: string, email: string, password: string, ip?: string): Promise<AuthResult>;

  /** Verify credentials and start a session (`ip`: the player's address, for the attempt limits) */
  login(username: string, password: string, ip?: string): Promise<AuthResult>;

  /** Resolve a session token to a user, or null if invalid/expired */
  validateSession(token: string): Promise<UserRecord | null>;

  /** validateSession, with why when it's refused (a ban says why and until when) */
  checkSession?(token: string): Promise<{ user: UserRecord; error?: undefined } | { user: null; error: string }>;

  /** Managing accounts (null or missing: not here, e.g. no shared secret with the lobby) */
  admin?: AccountAdmin | null;

  /** Invalidate a session token */
  logout(token: string): Promise<void>;

  /** Remove expired sessions (the lobby does its own: a no-op here) */
  cleanupExpiredSessions(): Promise<void>;

  close(): Promise<void>;
}

/** An account as the admin tools see it (never an email or credentials) */
export interface AccountInfo {
  id: number;
  username: string;
  /** Admin or owner */
  isAdmin: boolean;
  /** The owner (above admin; set only on the lobby's side). Missing (an older lobby): not */
  isOwner?: boolean;
  createdAt: string;
  /** Banned (null: not, or the ban's over): until when (null: for good), why, by whom */
  ban: { until: number | null; reason: string; by: string } | null;
}

/**
 * Managing accounts (the admin tools' players, ranks and bans), by username.
 * Each throws an Error saying what went wrong (the lobby's answer, or that it
 * can't be reached). `actor`: the signed-in admin it's done for (the lobby
 * applies the ranks' rules to them too: server-browser routes.ts rankRefusal).
 */
export interface AccountAdmin {
  /** Accounts whose username starts with `search` ('' for all), a page at a time */
  list(search: string, offset: number, limit: number): Promise<{ users: AccountInfo[]; total: number }>;
  /** One account (null: no such account) */
  get(username: string): Promise<AccountInfo | null>;
  setAdmin(username: string, on: boolean, actor?: string): Promise<AccountInfo>;
  /** Ban until `until` (epoch ms; null: for good) */
  ban(username: string, until: number | null, reason: string, by: string, actor?: string): Promise<AccountInfo>;
  unban(username: string, actor?: string): Promise<AccountInfo>;
}
