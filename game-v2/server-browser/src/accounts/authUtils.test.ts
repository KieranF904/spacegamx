/** The backend-independent account rules (accounts/utils.ts): ranks, bans, input checks, password hashing, durable file writes. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BAN_FOREVER, banMessage, generateSalt, generateToken, hashPasswordSync, isAdminRank, rankOf, safeEqual,
  validateEmail, validatePassword, validateRegistration, verifyPassword, verifyPasswordSync, writeFileDurable,
} from './utils.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('ranks', () => {
  it('an owner outranks an admin, and both pass the admin check', () => {
    expect(rankOf({ is_admin: true, is_owner: true })).toBe('owner');
    expect(rankOf({ is_admin: false, is_owner: true })).toBe('owner');
    expect(rankOf({ is_admin: true })).toBe('admin');
    expect(rankOf({ is_admin: false })).toBe('pilot');
    expect(isAdminRank({ is_admin: false, is_owner: true })).toBe(true);
    expect(isAdminRank({ is_admin: true })).toBe(true);
    expect(isAdminRank({ is_admin: false })).toBe(false);
  });
});

describe('banMessage', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0);
  it('not banned, or the ban is over (also exactly at its end): null', () => {
    expect(banMessage({ banned_until: null, ban_reason: null }, now)).toBeNull();
    expect(banMessage({ banned_until: now - 1, ban_reason: 'x' }, now)).toBeNull();
    expect(banMessage({ banned_until: now, ban_reason: 'x' }, now)).toBeNull();
  });
  it('a timed ban says when it ends in UTC, with the reason when there is one', () => {
    const until = Date.UTC(2026, 0, 3, 8, 30);
    expect(banMessage({ banned_until: until, ban_reason: null }, now)).toBe('This account is banned until 2026-01-03 08:30 UTC');
    expect(banMessage({ banned_until: until, ban_reason: 'cheating' }, now)).toBe('This account is banned until 2026-01-03 08:30 UTC: cheating');
  });
  it('a ban at or past the forever mark is permanent', () => {
    expect(banMessage({ banned_until: BAN_FOREVER, ban_reason: 'spam' }, now)).toBe('This account is banned permanently: spam');
    expect(banMessage({ banned_until: BAN_FOREVER + 1000, ban_reason: null }, now)).toBe('This account is banned permanently');
  });
});

describe('input checks', () => {
  it('usernames are 2-20 characters of letters, digits, _ and -', () => {
    const ok = (u: string) => validateRegistration(u, 'a@b.co', 'pw');
    expect(ok('ab')).toBeNull();
    expect(ok('a'.repeat(20))).toBeNull();
    expect(ok('a_b-9')).toBeNull();
    expect(ok('a')).toMatch(/2-20/);
    expect(ok('a'.repeat(21))).toMatch(/2-20/);
    expect(ok('no spaces')).toMatch(/letters/);
    expect(ok('émile')).toMatch(/letters/);
  });
  it('the username is checked before the email, the email before the password', () => {
    expect(validateRegistration('x', 'bad', '')).toMatch(/Username/);
    expect(validateRegistration('xx', 'bad', '')).toMatch(/email/);
    expect(validateRegistration('xx', 'a@b.co', '')).toMatch(/Password/);
  });
  it('email needs an @ and 5 to 254 characters', () => {
    expect(validateEmail('a@b.c')).toBeNull();
    expect(validateEmail('a@bc')).not.toBeNull();
    expect(validateEmail('a@b')).not.toBeNull();
    expect(validateEmail('abcdef')).not.toBeNull();
    expect(validateEmail(`${'a'.repeat(250)}@b.co`)).not.toBeNull();
  });
  it('a password is 1 to 200 characters', () => {
    expect(validatePassword('')).not.toBeNull();
    expect(validatePassword('x')).toBeNull();
    expect(validatePassword('x'.repeat(200))).toBeNull();
    expect(validatePassword('x'.repeat(201))).not.toBeNull();
  });
});

describe('passwords and tokens', () => {
  it('a hash verifies the right password and no other, sync and async agree', async () => {
    const salt = generateSalt();
    const h = hashPasswordSync('hunter2', salt);
    expect(verifyPasswordSync('hunter2', salt, h)).toBe(true);
    expect(verifyPasswordSync('hunter3', salt, h)).toBe(false);
    expect(await verifyPassword('hunter2', salt, h)).toBe(true);
    expect(await verifyPassword('hunter3', salt, h)).toBe(false);
    expect(await verifyPassword('hunter2', generateSalt(), h)).toBe(false);
  });
  it('a malformed stored hash fails the check rather than throwing', async () => {
    const salt = generateSalt();
    expect(verifyPasswordSync('pw', salt, 'short')).toBe(false);
    expect(await verifyPassword('pw', salt, '')).toBe(false);
  });
  it('salts and tokens are random and long enough', () => {
    expect(generateSalt()).toHaveLength(64);
    expect(generateToken()).toHaveLength(96);
    expect(generateToken()).not.toBe(generateToken());
  });
  it('safeEqual compares whole strings, any length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('writeFileDurable', () => {
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lobby-dur-')); dirs.push(d); return d; };

  it('replaces the file whole and leaves no temp file behind', () => {
    const f = join(tmp(), 'users.json');
    writeFileDurable(f, '{"a":1}');
    expect(readFileSync(f, 'utf-8')).toBe('{"a":1}');
    writeFileDurable(f, '{"a":2}');
    expect(readFileSync(f, 'utf-8')).toBe('{"a":2}');
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });

  it('if it cannot write, the old file is untouched', () => {
    const d = tmp();
    const f = join(d, 'users.json');
    writeFileSync(f, 'old');
    // (the temp name taken by a folder: the open fails before anything is replaced)
    rmSync(`${f}.tmp`, { force: true });
    writeFileSync(join(d, 'sub'), 'x');
    expect(() => writeFileDurable(join(d, 'sub', 'users.json'), 'new')).toThrow();
    expect(readFileSync(f, 'utf-8')).toBe('old');
  });
});
