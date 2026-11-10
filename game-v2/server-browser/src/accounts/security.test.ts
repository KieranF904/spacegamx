import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type http from 'http';
import { JsonUserStore } from './JsonUserStore.js';
import { AccountRoutes } from './routes.js';
import { hashPasswordSync, hashToken } from './utils.js';

// SEC-11 (password length) and SEC-12 (session tokens kept hashed), docs/audits/full-audit-2026-11-10.md

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function file() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-sec-'));
  dirs.push(dir);
  return join(dir, 'users.json');
}

async function routes(s: JsonUserStore) {
  let body: object = {};
  let out: { status: number; body: any } = { status: 0, body: null };
  const r = await AccountRoutes.create((_, status, b) => { out = { status, body: b }; }, async () => body, () => '127.0.0.1', { store: s, adminSecret: 'sssh' });
  return async (url: string, b: object) => {
    body = b;
    await r.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, url);
    return out;
  };
}

describe('password length', () => {
  it('refuses short passwords on register and on change, with a clear message', async () => {
    const s = new JsonUserStore(file());
    const call = await routes(s);
    const short = await call('/auth/register', { username: 'tiny', email: 'tiny@example.com', password: 'abc' });
    expect(short.status).toBe(400);
    expect(short.body.error).toBe('Password must be at least 8 characters.');
    const ok = await call('/auth/register', { username: 'tiny', email: 'tiny@example.com', password: 'abcdefgh' });
    expect(ok.status).toBe(200);
    const change = await call('/auth/change-password', { token: ok.body.token, password: 'abcdefgh', newPassword: 'abcdefg' });
    expect(change.status).toBe(400);
    expect(change.body.error).toBe('Password must be at least 8 characters.');
    expect((await call('/auth/change-password', { token: ok.body.token, password: 'abcdefgh', newPassword: 'abcdefgh1' })).status).toBe(200);
  });

  it('an account made with a short password can still sign in', async () => {
    const f = file();
    const s = new JsonUserStore(f);
    await s.register('oldtimer', 'old@example.com', 'long-enough');
    await s.close();
    const raw = JSON.parse(readFileSync(f, 'utf-8'));
    const u = raw.users.find((x: any) => x.username === 'oldtimer');
    u.password_hash = hashPasswordSync('pw', u.salt);
    writeFileSync(f, JSON.stringify(raw));
    expect((await new JsonUserStore(f).login('oldtimer', 'pw')).success).toBe(true);
  });
});

describe('session tokens', () => {
  it('are stored only as a hash, and still validate and end by the raw token', async () => {
    const f = file();
    const s = new JsonUserStore(f);
    const reg = await s.register('hashy', 'hashy@example.com', 'long-enough');
    if (!reg.success) throw new Error(reg.error);
    const other = await s.login('hashy', 'long-enough');
    if (!other.success) throw new Error(other.error);
    expect((await s.validateSession(reg.token))?.username).toBe('hashy');
    expect(await s.validateSession(hashToken(reg.token))).toBeNull();
    expect(await s.endSessions(reg.user.id, reg.token)).toBe(1);
    expect(await s.validateSession(other.token)).toBeNull();
    await s.close();
    const text = readFileSync(f, 'utf-8');
    expect(text).not.toContain(reg.token);
    expect(JSON.parse(text).sessions[0].token).toBe(hashToken(reg.token));
    const again = new JsonUserStore(f);
    await again.logout(reg.token);
    expect(await again.validateSession(reg.token)).toBeNull();
    await again.close();
  });

  it('kept in plain from before are hashed at start, and keep working (restarting again changes nothing)', async () => {
    const f = file();
    const s = new JsonUserStore(f);
    const reg = await s.register('veteran', 'vet@example.com', 'long-enough');
    if (!reg.success) throw new Error(reg.error);
    await s.close();
    const raw = JSON.parse(readFileSync(f, 'utf-8'));
    raw.sessions[0].token = reg.token; // as an old file kept it
    writeFileSync(f, JSON.stringify(raw));
    const again = new JsonUserStore(f);
    expect((await again.validateSession(reg.token))?.username).toBe('veteran');
    await again.close();
    expect(readFileSync(f, 'utf-8')).not.toContain(reg.token);
    const third = new JsonUserStore(f);
    expect((await third.validateSession(reg.token))?.username).toBe('veteran');
    await third.close();
    expect(JSON.parse(readFileSync(f, 'utf-8')).sessions[0].token).toBe(hashToken(reg.token));
  });
});
