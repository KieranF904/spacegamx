/**
 * JsonUserStore - JSON-file-backed user account system (local dev)
 *
 * Persists the exact same schema as the PostgreSQL backend:
 *
 *   users:    (id, username, email, password_hash, salt, is_admin, is_owner, created_at,
 *              banned_until, ban_reason, banned_by)
 *   sessions: (token, user_id, expires_at)
 *
 * Data lives in a single JSON file on disk. Writes are atomic and durable
 * (temp file, fsync, rename) so a crash mid-write can't corrupt the store.
 * A file that can't be read at startup is never replaced: the store refuses
 * to start (users.json.bak, copied at each good start, is there to restore).
 *
 * When you're ready for PostgreSQL, switch to PostgresUserStore in
 * createUserStore() - the data files are 1:1 compatible.
 */

import fs from 'fs';
import { devAuthOn } from './devAuth.js';
import path from 'path';
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
  hashPasswordSync,
  validateEmail,
  validateRegistration,
  verifyPassword,
  verifyPasswordSync,
  writeFileDurable,
} from './utils.js';

/** Full user row as stored on disk (includes credentials) */
interface StoredUser {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  salt: string;
  is_admin: boolean;
  /** The owner rank (see UserRecord); missing in records from before it: false */
  is_owner?: boolean;
  created_at: string;
  /** Ban (see UserRecord); missing in records from before bans */
  banned_until?: number | null;
  ban_reason?: string | null;
  banned_by?: string | null;
}

/** On-disk file format */
interface StoreFile {
  version: 1;
  /** The next account id, kept so a deleted account's id is never given out again */
  nextUserId?: number;
  users: StoredUser[];
  sessions: SessionRecord[];
}

export class JsonUserStore implements UserStore {
  private filePath: string;
  private users: StoredUser[] = [];
  private sessions: SessionRecord[] = [];
  private nextUserId = 1;
  private writeQueue: Promise<void> = Promise.resolve();
  /** A write is queued (it takes the state as it is when it runs) */
  private dirty = false;
  private closed = false;

  constructor(filePath: string = 'users.json') {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.load();
    this.seedAdmin();
    console.log(`[UserStore] JSON store at ${this.filePath} (${this.users.length} users)`);
  }

  // ============================================
  // PERSISTENCE
  // ============================================

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.users = [];
      this.sessions = [];
      this.nextUserId = 1;
      this.save();
      return;
    }

    let raw: StoreFile;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      if (!raw || typeof raw !== 'object' || (raw.users !== undefined && typeof raw.users !== 'object')) throw new Error('not an accounts file');
    } catch (err) {
      // Never start fresh over it: the next save would replace every account with an empty list
      const backup = `${this.filePath}.bak`;
      throw new Error(`[UserStore] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the accounts: `
        + `fix it, or restore ${fs.existsSync(backup) ? backup : 'a backup'} over it.`);
    }
    // Normalize: tolerate a single user object instead of an array
    this.users = Array.isArray(raw.users)
      ? raw.users
      : raw.users
        ? [raw.users]
        : [];
    this.sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    this.nextUserId = Math.max(
      Number(raw.nextUserId) || 1,
      this.users.length > 0 ? Math.max(...this.users.map(u => u.id)) + 1 : 1,
    );
    // A known-good copy, for when the file is ever lost or damaged
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
    } catch (err) {
      console.error('[UserStore] Could not back up the accounts:', err);
    }
  }

  /**
   * Durable atomic write (writeFileDurable), serialized through a queue. Saves asked for while one is
   * queued share it (it writes the latest state). A failed write leaves the old file whole; the next save
   * writes everything again.
   */
  private save(): void {
    if (this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = {
        version: 1,
        nextUserId: this.nextUserId,
        users: this.users,
        sessions: this.sessions,
      };
      try {
        writeFileDurable(this.filePath, JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('[UserStore] Failed to save:', err);
      }
    });
  }

  // ============================================
  // SEED ADMIN
  // ============================================

  private seedAdmin(): void {
    const existing = this.users.find(u => u.username.toLowerCase() === 'admin');
    const production = process.env.NODE_ENV === 'production';
    if (existing) {
      if (!existing.is_admin) {
        existing.is_admin = true;
        this.save();
      }
      if (production && verifyPasswordSync('admin', existing.salt, existing.password_hash)) {
        console.warn('[UserStore] WARNING: the admin account still has the default password "admin". Change it.');
      }
      return;
    }

    // An admin already (made one by hand): nothing to seed
    if (this.users.some((u) => u.is_admin)) return;
    // An admin is only made with a password you chose (ADMIN_PASSWORD); the default one only with DEV_AUTH=1 (never in production)
    const password = process.env.ADMIN_PASSWORD || (devAuthOn() ? 'admin' : '');
    if (!password) {
      console.log('[UserStore] No admin account (set ADMIN_PASSWORD to create one; DEV_AUTH=1 seeds the dev default)');
      return;
    }
    const salt = generateSalt();
    const passwordHash = hashPasswordSync(password, salt);
    const user: StoredUser = {
      id: this.nextUserId++,
      username: 'admin',
      email: 'admin@localhost',
      password_hash: passwordHash,
      salt,
      is_admin: true,
      created_at: new Date().toISOString(),
    };
    this.users.push(user);
    this.save();
    console.log(`[UserStore] Seeded admin account (id=${user.id}${process.env.ADMIN_PASSWORD ? '' : ', password: admin (dev only)'})`);
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

    // (Hashed first: from the checks below to adding the account nothing waits, so two at once can't both take a name)
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    // Check for existing user (case-insensitive, matching SQL COLLATE NOCASE)
    const byUsername = this.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (byUsername) {
      return { success: false, error: 'Username already taken' };
    }
    const byEmail = this.users.find(u => u.email.toLowerCase() === email);
    if (byEmail) {
      return { success: false, error: 'Email already registered' };
    }

    const user: StoredUser = {
      id: this.nextUserId++,
      username,
      email,
      password_hash: passwordHash,
      salt,
      is_admin: false,
      is_owner: false,
      created_at: new Date().toISOString(),
    };
    this.users.push(user);
    this.save();

    const token = await this.createSession(user.id);
    return { success: true, user: this.toPublicRecord(user), token };
  }

  async login(username: string, password: string): Promise<AuthResult> {
    username = username.trim();

    const user = this.users.find(
      u => u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === username.toLowerCase()
    );

    // (Deleted while the hash was worked out: gone)
    if (!user || !(await verifyPassword(password, user.salt, user.password_hash)) || !this.users.includes(user)) {
      return { success: false, error: 'Invalid username or password' };
    }
    // (Only told once the password is right, so it doesn't say which names are banned)
    const banned = banMessage(this.toPublicRecord(user));
    if (banned) return { success: false, error: banned };

    const token = await this.createSession(user.id);
    return { success: true, user: this.toPublicRecord(user), token };
  }

  async validateSession(token: string): Promise<UserRecord | null> {
    const idx = this.sessions.findIndex(s => s.token === token);
    if (idx === -1) return null;

    const session = this.sessions[idx];
    if (session.expires_at < Date.now()) {
      this.sessions.splice(idx, 1);
      this.save();
      return null;
    }

    const user = this.users.find(u => u.id === session.user_id);
    return user ? this.toPublicRecord(user) : null;
  }

  private async createSession(userId: number): Promise<string> {
    const token = generateToken();
    this.sessions.push({
      token,
      user_id: userId,
      expires_at: Date.now() + SESSION_DURATION_MS,
    });
    this.save();
    return token;
  }

  async logout(token: string): Promise<void> {
    const idx = this.sessions.findIndex(s => s.token === token);
    if (idx !== -1) {
      this.sessions.splice(idx, 1);
      this.save();
    }
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const user = this.users.find(u => u.id === id);
    return user ? this.toPublicRecord(user) : null;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const user = this.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    return user ? this.toPublicRecord(user) : null;
  }

  async setAdmin(userId: number, isAdmin: boolean): Promise<void> {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      user.is_admin = isAdmin;
      this.save();
    }
  }

  async setOwner(userId: number, isOwner: boolean): Promise<void> {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      user.is_owner = isOwner;
      this.save();
    }
  }

  async setBan(userId: number, until: number | null, reason: string, by: string): Promise<void> {
    const user = this.users.find(u => u.id === userId);
    if (!user) return;
    user.banned_until = until;
    user.ban_reason = until === null ? null : reason;
    user.banned_by = until === null ? null : by;
    this.save();
  }

  async listUsers(search: string, offset: number, limit: number): Promise<{ users: UserSummary[]; total: number }> {
    const low = search.trim().toLowerCase();
    const all = this.users.filter(u => u.username.toLowerCase().startsWith(low));
    const users = all.slice(offset, offset + limit).map((u) => {
      const { email: _, ...rest } = this.toPublicRecord(u);
      return rest;
    });
    return { users, total: all.length };
  }

  async getUserCount(): Promise<number> {
    return this.users.length;
  }

  async checkPassword(userId: number, password: string): Promise<boolean> {
    const user = this.users.find(u => u.id === userId);
    return !!user && await verifyPassword(password, user.salt, user.password_hash);
  }

  async setPassword(userId: number, password: string): Promise<void> {
    const user = this.users.find(u => u.id === userId);
    if (!user) return;
    // (Both at once, after the hash: a sign-in meanwhile checks against the old pair)
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);
    user.salt = salt;
    user.password_hash = passwordHash;
    this.save();
  }

  async setEmail(userId: number, email: string): Promise<string | null> {
    email = email.trim().toLowerCase();
    const invalid = validateEmail(email);
    if (invalid) return invalid;
    const user = this.users.find(u => u.id === userId);
    if (!user) return 'No such account';
    if (this.users.some(u => u.id !== userId && u.email.toLowerCase() === email)) return 'Email already registered';
    user.email = email;
    this.save();
    return null;
  }

  async endSessions(userId: number, keep?: string): Promise<number> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.user_id !== userId || (keep !== undefined && s.token === keep));
    const ended = before - this.sessions.length;
    if (ended) this.save();
    return ended;
  }

  async deleteUser(userId: number): Promise<void> {
    const before = this.users.length;
    this.users = this.users.filter(u => u.id !== userId);
    this.sessions = this.sessions.filter(s => s.user_id !== userId);
    if (this.users.length !== before) this.save();
    // (On disk before the game servers are told to delete the pilot's profile)
    await this.writeQueue;
  }

  async cleanupExpiredSessions(): Promise<void> {
    const before = this.sessions.length;
    const now = Date.now();
    this.sessions = this.sessions.filter(s => s.expires_at >= now);
    if (this.sessions.length !== before) {
      this.save();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeQueue;
  }

  /** Strip credentials from a stored user row */
  private toPublicRecord(user: StoredUser): UserRecord {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      is_admin: user.is_admin,
      is_owner: user.is_owner === true,
      created_at: user.created_at,
      banned_until: user.banned_until ?? null,
      ban_reason: user.ban_reason ?? null,
      banned_by: user.banned_by ?? null,
    };
  }
}