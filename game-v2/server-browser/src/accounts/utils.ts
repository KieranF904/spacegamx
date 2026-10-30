/**
 * Shared auth utilities
 *
 * Backend-independent logic used by every UserStore implementation so
 * validation and hashing behave identically regardless of storage.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/** Session lifetime: 7 days */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** A ban that never ends (the year 9999): banned_until at or past this is for good */
export const BAN_FOREVER = 253_402_300_799_000;

/** Why this account can't sign in (null: it's not banned, or the ban is over) */
export function banMessage(user: { banned_until: number | null; ban_reason: string | null }, now = Date.now()): string | null {
  if (user.banned_until === null || user.banned_until <= now) return null;
  const why = user.ban_reason ? `: ${user.ban_reason}` : '';
  if (user.banned_until >= BAN_FOREVER) return `This account is banned permanently${why}`;
  return `This account is banned until ${new Date(user.banned_until).toISOString().slice(0, 16).replace('T', ' ')} UTC${why}`;
}

/**
 * PBKDF2-SHA512 password hashing.
 * Same parameters as the original SQLite UserDB, so existing hashes
 * remain valid if you migrate old data.
 * Asynchronous (on libuv's thread pool): each hash is ~50-100 ms of CPU, and a flood of sign-ins mustn't stall
 * everything else the lobby does. The Sync forms are for start-up only (seeding the admin account).
 */
export function hashPassword(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

export function hashPasswordSync(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

export function generateSalt(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

/** Constant-time password verification (safe against malformed stored hashes) */
export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  try {
    return sameHash(await hashPassword(password, salt), expectedHash);
  } catch {
    return false;
  }
}

export function verifyPasswordSync(password: string, salt: string, expectedHash: string): boolean {
  try {
    return sameHash(hashPasswordSync(password, salt), expectedHash);
  } catch {
    return false;
  }
}

function sameHash(hash: string, expected: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

/**
 * Validate registration input.
 * Returns an error string, or null when valid.
 */
export function validateRegistration(username: string, email: string, password: string): string | null {
  if (username.length < 2 || username.length > 20) {
    return 'Username must be 2-20 characters';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return 'Username can only contain letters, numbers, _ and -';
  }
  return validateEmail(email) ?? validatePassword(password);
}

/** An email address an account can have (an error, or null) */
export function validateEmail(email: string): string | null {
  if (!email.includes('@') || email.length < 5 || email.length > 254) {
    return 'Invalid email address';
  }
  return null;
}

/** A password an account can have (an error, or null) */
export function validatePassword(password: string): string | null {
  if (password.length < 1) {
    return 'Password cannot be empty';
  }
  if (password.length > 200) {
    return 'Password is too long (200 characters at most)';
  }
  return null;
}

/** Constant-time string equality (hashed first, so not even the length leaks) */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/**
 * Replace a file so a crash or a full disk never leaves it half-written: a temp file, flushed to disk
 * (fsync), renamed over it, and the folder flushed so the rename sticks. Throws if it couldn't; the old
 * file is untouched then.
 */
export function writeFileDurable(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } catch { /* (Windows can't fsync a folder) */ }
}
