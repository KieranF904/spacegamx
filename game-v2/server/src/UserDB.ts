/**
 * UserDB - SQLite-backed user account system
 * 
 * Stores: username, email, password (hashed), is_admin flag
 * Sessions: token-based, 7 day expiry
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface UserRecord {
  id: number;
  username: string;
  email: string;
  is_admin: boolean;
  created_at: string;
}

export interface SessionRecord {
  token: string;
  user_id: number;
  expires_at: number;
}

export class UserDB {
  private db: Database.Database;

  constructor(dbPath: string = 'users.db') {
    const fullPath = path.resolve(dbPath);
    this.db = new Database(fullPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
    this.seedAdmin();
    console.log(`[UserDB] Database opened at ${fullPath}`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);
  }

  // ============================================
  // SEED ADMIN ACCOUNT
  // ============================================

  private seedAdmin(): void {
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get('admin') as any;
    if (existing) {
      // Ensure is_admin flag is set
      this.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
      return;
    }

    const salt = this.generateSalt();
    const passwordHash = this.hashPassword('admin', salt);
    const result = this.db.prepare(
      'INSERT INTO users (username, email, password_hash, salt, is_admin) VALUES (?, ?, ?, ?, 1)'
    ).run('admin', 'admin@localhost', passwordHash, salt);

    console.log(`[UserDB] Seeded admin account (id=${result.lastInsertRowid})`);
  }

  // ============================================
  // PASSWORD HASHING
  // ============================================

  private hashPassword(password: string, salt: string): string {
    return crypto
      .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
      .toString('hex');
  }

  private generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private generateToken(): string {
    return crypto.randomBytes(48).toString('hex');
  }

  // ============================================
  // USER MANAGEMENT
  // ============================================

  register(username: string, email: string, password: string): { success: true; user: UserRecord; token: string } | { success: false; error: string } {
    // Validate input
    username = username.trim();
    email = email.trim().toLowerCase();

    if (username.length < 2 || username.length > 20) {
      return { success: false, error: 'Username must be 2-20 characters' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return { success: false, error: 'Username can only contain letters, numbers, _ and -' };
    }
    if (!email.includes('@') || email.length < 5) {
      return { success: false, error: 'Invalid email address' };
    }
    if (password.length < 1) {
      return { success: false, error: 'Password cannot be empty' };
    }

    // Check for existing user
    const existing = this.db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email) as any;
    if (existing) {
      // Check which one matches
      const byUsername = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (byUsername) {
        return { success: false, error: 'Username already taken' };
      }
      return { success: false, error: 'Email already registered' };
    }

    // Hash password
    const salt = this.generateSalt();
    const passwordHash = this.hashPassword(password, salt);

    // Insert user
    const result = this.db.prepare(
      'INSERT INTO users (username, email, password_hash, salt) VALUES (?, ?, ?, ?)'
    ).run(username, email, passwordHash, salt);

    const userId = result.lastInsertRowid as number;

    // Create session
    const token = this.createSession(userId);

    const user = this.getUserById(userId)!;
    return { success: true, user, token };
  }

  login(username: string, password: string): { success: true; user: UserRecord; token: string } | { success: false; error: string } {
    username = username.trim();

    // Find user by username or email
    const row = this.db.prepare(
      'SELECT id, username, email, password_hash, salt, is_admin FROM users WHERE username = ? OR email = ?'
    ).get(username, username) as any;

    if (!row) {
      return { success: false, error: 'Invalid username or password' };
    }

    // Verify password
    const hash = this.hashPassword(password, row.salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(row.password_hash))) {
      return { success: false, error: 'Invalid username or password' };
    }

    // Create session
    const token = this.createSession(row.id);

    return {
      success: true,
      user: {
        id: row.id,
        username: row.username,
        email: row.email,
        is_admin: !!row.is_admin,
        created_at: row.created_at || '',
      },
      token,
    };
  }

  validateSession(token: string): UserRecord | null {
    const session = this.db.prepare(
      'SELECT user_id, expires_at FROM sessions WHERE token = ?'
    ).get(token) as any;

    if (!session || session.expires_at < Date.now()) {
      if (session) {
        this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
      return null;
    }

    return this.getUserById(session.user_id);
  }

  private createSession(userId: number): string {
    const token = this.generateToken();
    this.db.prepare(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(token, userId, Date.now() + SESSION_DURATION_MS);
    return token;
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  getUserById(id: number): UserRecord | null {
    const row = this.db.prepare(
      'SELECT id, username, email, is_admin, created_at FROM users WHERE id = ?'
    ).get(id) as any;

    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      email: row.email,
      is_admin: !!row.is_admin,
      created_at: row.created_at,
    };
  }

  setAdmin(userId: number, isAdmin: boolean): void {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
  }

  getUserCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM users').get() as any;
    return row.count;
  }

  cleanupExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  close(): void {
    this.db.close();
  }
}
