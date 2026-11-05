/**
 * Auth type definitions
 *
 * These mirror the PostgreSQL schema in ../../schema.sql exactly:
 *
 *   users:    (id, username, email, password_hash, salt, is_admin, is_owner, created_at,
 *              banned_until, ban_reason, banned_by)
 *   sessions: (token, user_id, expires_at)
 *
 * The JSON store (JsonUserStore) persists the same fields with the same
 * semantics, so switching backends is a 1:1 data copy.
 */

/** Public user record (never includes password_hash/salt) */
export interface UserRecord {
  id: number;
  username: string;
  email: string;
  is_admin: boolean;
  /** The owner rank (above admin: an owner is an admin everywhere). Set only server-side: set-owner, OWNER_USERNAMES */
  is_owner: boolean;
  created_at: string;
  /** Banned until this time (epoch ms; BAN_FOREVER for good). null, or past: not banned */
  banned_until: number | null;
  ban_reason: string | null;
  /** The admin who banned them */
  banned_by: string | null;
}

/** A user as admins see them (no email, no credentials) */
export type UserSummary = Omit<UserRecord, 'email'>;

/** Session row */
export interface SessionRecord {
  token: string;
  user_id: number;
  expires_at: number;
}

/** Result for register/login operations */
export type AuthResult =
  | { success: true; user: UserRecord; token: string }
  | { success: false; error: string };

/**
 * UserStore - backend-agnostic account/session storage.
 *
 * Implementations:
 *   - JsonUserStore      (local dev, JSON file)
 *   - PostgresUserStore  (production, PostgreSQL)
 *
 * All methods are async because the PostgreSQL backend is async.
 */
export interface UserStore {
  /** Create a new account and start a session */
  register(username: string, email: string, password: string): Promise<AuthResult>;

  /** Verify credentials and start a session */
  login(username: string, password: string): Promise<AuthResult>;

  /** Resolve a session token to a user, or null if invalid/expired */
  validateSession(token: string): Promise<UserRecord | null>;

  /** Invalidate a session token */
  logout(token: string): Promise<void>;

  getUserById(id: number): Promise<UserRecord | null>;

  /** Case-insensitive lookup by username */
  getUserByUsername(username: string): Promise<UserRecord | null>;

  setAdmin(userId: number, isAdmin: boolean): Promise<void>;

  /** The owner rank (only the lobby's set-owner and OWNER_USERNAMES call this) */
  setOwner(userId: number, isOwner: boolean): Promise<void>;

  /** Ban until `until` (epoch ms; BAN_FOREVER for good), or lift the ban (null) */
  setBan(userId: number, until: number | null, reason: string, by: string): Promise<void>;

  /** Users by username prefix (case-insensitive; '' for all), oldest first, a page at a time */
  listUsers(search: string, offset: number, limit: number): Promise<{ users: UserSummary[]; total: number }>;

  getUserCount(): Promise<number>;

  /** Is this the account's password? (account changes ask for it again) */
  checkPassword(userId: number, password: string): Promise<boolean>;

  /** A new password (new salt); sessions are left alone (see endSessions) */
  setPassword(userId: number, password: string): Promise<void>;

  /** A new email: null when done, or why not (invalid, someone else's) */
  setEmail(userId: number, email: string): Promise<string | null>;

  /** End the account's sessions (all but `keep`, if given); how many ended */
  endSessions(userId: number, keep?: string): Promise<number>;

  /** Remove the account and its sessions for good */
  deleteUser(userId: number): Promise<void>;

  /** Remove expired sessions */
  cleanupExpiredSessions(): Promise<void>;

  /** Flush and release resources */
  close(): Promise<void>;
}