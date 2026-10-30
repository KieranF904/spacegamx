/**
 * PostgresUserStore - PostgreSQL-backed user account system (production)
 *
 * Implements the same UserStore interface as JsonUserStore, using the
 * schema defined in ../../schema.sql:
 *
 *   users:    (id, username, email, password_hash, salt, is_admin, created_at,
 *              banned_until, ban_reason, banned_by)
 *   sessions: (token, user_id, expires_at)
 *
 * Uses node-postgres (pg) via a small connection pool. Enable by setting
 * DATABASE_URL and USER_STORE_BACKEND=postgres in createUserStore().
 * NOTE: 'pg' is intentionally NOT in package.json dependencies yet. On the VPS, in server-browser/ (the lobby)
 * and in server/ (the game server keeps profiles in the same database), run `npm install pg`, then:
 *
 *   psql $DATABASE_URL -f server-browser/schema.sql
 *   USER_STORE_BACKEND=postgres DATABASE_URL=postgres://... npm start
 */

import {
  AuthResult,
  SessionRecord,
  UserRecord,
  UserStore,
  UserSummary,
} from './types.js';
import {
  SESSION_DURATION_MS,
  banMessage,
  generateSalt,
  generateToken,
  hashPassword,
  validateEmail,
  validateRegistration,
  verifyPassword,
} from './utils.js';

/**
 * Minimal structural types for node-postgres.
 * The real 'pg' package is only needed when this backend is enabled:
 *   npm install pg @types/pg
 */
interface PgQueryResult {
  rows: any[];
}
interface PgClient {
  query(sql: string, params?: any[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  query(sql: string, params?: any[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

/** Row shape returned by user queries (includes credentials) */
interface UserRow {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  salt: string;
  is_admin: boolean;
  created_at: Date | string;
  banned_until: string | number | null;
  ban_reason: string | null;
  banned_by: string | null;
}

/** The public columns (no credentials) */
const PUBLIC = 'id, username, email, is_admin, created_at, banned_until, ban_reason, banned_by';

export class PostgresUserStore implements UserStore {
  private pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
    console.log('[UserStore] PostgreSQL pool created');
  }

  /**
   * Create a store backed by a node-postgres pool.
   * Requires 'pg' to be installed: npm install pg
   */
  static async create(connectionString: string): Promise<PostgresUserStore> {
    // Non-literal specifier so TypeScript doesn't require 'pg' at compile time
    const moduleName = 'pg';
    const pg: any = await import(moduleName);
    return new PostgresUserStore(new pg.Pool({ connectionString }) as unknown as PgPool);
  }

  // ============================================
  // USER MANAGEMENT
  // ============================================

  async register(username: string, email: string, password: string): Promise<AuthResult> {
    username = username.trim();
    email = email.trim().toLowerCase();

    const validationError = validateRegistration(username, email, password);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const client = await this.pool.connect();
    try {
      // Check for existing user (case-insensitive)
      const existing = await client.query(
        'SELECT username FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)',
        [username, email]
      );
      if (existing.rows.length > 0) {
        const byUsername = existing.rows.some((r: any) => r.username.toLowerCase() === username.toLowerCase());
        return { success: false, error: byUsername ? 'Username already taken' : 'Email already registered' };
      }

      const salt = generateSalt();
      const passwordHash = hashPassword(password, salt);

      const result = await client.query(
        `INSERT INTO users (username, email, password_hash, salt, is_admin)
         VALUES ($1, $2, $3, $4, false)
         RETURNING ${PUBLIC}`,
        [username, email, passwordHash, salt]
      );
      const row = result.rows[0];
      const token = await this.createSession(row.id);
      return { success: true, user: this.toPublicRecord(row), token };
    } finally {
      client.release();
    }
  }

  async login(username: string, password: string): Promise<AuthResult> {
    username = username.trim();

    const result = await this.pool.query(
      `SELECT ${PUBLIC}, password_hash, salt FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)`,
      [username]
    );
    const row = result.rows[0] as UserRow | undefined;
    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      return { success: false, error: 'Invalid username or password' };
    }
    // (Only told once the password is right, so it doesn't say which names are banned)
    const banned = banMessage(this.toPublicRecord(row));
    if (banned) return { success: false, error: banned };

    const token = await this.createSession(row.id);
    return { success: true, user: this.toPublicRecord(row), token };
  }

  async validateSession(token: string): Promise<UserRecord | null> {
    const result = await this.pool.query(
      `SELECT u.id, u.username, u.email, u.is_admin, u.created_at, u.banned_until, u.ban_reason, u.banned_by
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = $1 AND s.expires_at > $2`,
      [token, Date.now()]
    );
    if (result.rows.length === 0) {
      // Opportunistic cleanup of the expired session, if any
      await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      return null;
    }
    return this.toPublicRecord(result.rows[0]);
  }

  private async createSession(userId: number): Promise<string> {
    const token = generateToken();
    await this.pool.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, userId, Date.now() + SESSION_DURATION_MS]
    );
    return token;
  }

  async logout(token: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const result = await this.pool.query(
      `SELECT ${PUBLIC} FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.toPublicRecord(result.rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const result = await this.pool.query(
      `SELECT ${PUBLIC} FROM users WHERE lower(username) = lower($1)`,
      [username]
    );
    return result.rows[0] ? this.toPublicRecord(result.rows[0]) : null;
  }

  async setAdmin(userId: number, isAdmin: boolean): Promise<void> {
    await this.pool.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, userId]);
  }

  async setBan(userId: number, until: number | null, reason: string, by: string): Promise<void> {
    await this.pool.query(
      'UPDATE users SET banned_until = $1, ban_reason = $2, banned_by = $3 WHERE id = $4',
      until === null ? [null, null, null, userId] : [until, reason, by, userId]
    );
  }

  async listUsers(search: string, offset: number, limit: number): Promise<{ users: UserSummary[]; total: number }> {
    // A prefix match: escape LIKE's wildcards (usernames may have _ in them)
    const pattern = search.trim().replace(/[\\%_]/g, '\\$&') + '%';
    const total = await this.pool.query('SELECT COUNT(*)::int AS count FROM users WHERE username ILIKE $1', [pattern]);
    const result = await this.pool.query(
      `SELECT ${PUBLIC} FROM users WHERE username ILIKE $1 ORDER BY id LIMIT $2 OFFSET $3`,
      [pattern, limit, offset]
    );
    const users = result.rows.map((r) => {
      const { email: _, ...rest } = this.toPublicRecord(r);
      return rest;
    });
    return { users, total: total.rows[0].count };
  }

  async getUserCount(): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*)::int AS count FROM users');
    return result.rows[0].count;
  }

  async checkPassword(userId: number, password: string): Promise<boolean> {
    const result = await this.pool.query('SELECT password_hash, salt FROM users WHERE id = $1', [userId]);
    const row = result.rows[0];
    return !!row && verifyPassword(password, row.salt, row.password_hash);
  }

  async setPassword(userId: number, password: string): Promise<void> {
    const salt = generateSalt();
    await this.pool.query('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3', [hashPassword(password, salt), salt, userId]);
  }

  async setEmail(userId: number, email: string): Promise<string | null> {
    email = email.trim().toLowerCase();
    const invalid = validateEmail(email);
    if (invalid) return invalid;
    const taken = await this.pool.query('SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [email, userId]);
    if (taken.rows.length) return 'Email already registered';
    const result = await this.pool.query('UPDATE users SET email = $1 WHERE id = $2 RETURNING id', [email, userId]);
    return result.rows.length ? null : 'No such account';
  }

  async endSessions(userId: number, keep?: string): Promise<number> {
    const result = keep === undefined
      ? await this.pool.query('DELETE FROM sessions WHERE user_id = $1 RETURNING token', [userId])
      : await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2 RETURNING token', [userId, keep]);
    return result.rows.length;
  }

  async deleteUser(userId: number): Promise<void> {
    // (sessions and profiles go with it: ON DELETE CASCADE)
    await this.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  async cleanupExpiredSessions(): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private toPublicRecord(row: any): UserRecord {
    return {
      // (BIGINT comes back as a string; ids are numbers everywhere else)
      id: Number(row.id),
      username: row.username,
      email: row.email,
      is_admin: !!row.is_admin,
      created_at: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at || ''),
      banned_until: row.banned_until == null ? null : Number(row.banned_until),
      ban_reason: row.ban_reason ?? null,
      banned_by: row.banned_by ?? null,
    };
  }
}