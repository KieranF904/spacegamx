import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { LobbyAccounts } from './LobbyAccounts.js';
import { adminPassword } from '../AdminServer.js';

/** A lobby that refuses every sign-in, keeping each request's path and X-Forwarded-For */
async function lobby(): Promise<{ url: string; seen: { path: string; xff?: string }[]; close: () => Promise<void> }> {
  const seen: { path: string; xff?: string }[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ path: req.url ?? '', xff: req.headers['x-forwarded-for'] as string | undefined });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid username or password' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise((r) => server.close(() => r())) };
}

describe('sign-ins relayed to the lobby', () => {
  it("pass on the player's address (so the lobby's limits count each player), and nothing that isn't an address", async () => {
    const l = await lobby();
    try {
      const accounts = new LobbyAccounts(l.url);
      expect(await accounts.login('pilot', 'wrong', '203.0.113.7')).toEqual({ success: false, error: 'Invalid username or password' });
      await accounts.register('pilot', 'p@example.com', 'pw', '2001:db8::1');
      await accounts.login('pilot', 'wrong');
      await accounts.login('pilot', 'wrong', '1.2.3.4\r\nX-Evil: 1');
      expect(l.seen).toEqual([
        { path: '/auth/login', xff: '203.0.113.7' },
        { path: '/auth/register', xff: '2001:db8::1' },
        { path: '/auth/login', xff: undefined },
        { path: '/auth/login', xff: undefined },
      ]);
    } finally {
      await l.close();
    }
  });
});

describe('the admin server password', () => {
  it('comes from the environment; development falls back to "admin", production to none (the admin server stays off)', () => {
    expect(adminPassword({ ADMIN_SERVER_PASSWORD: 'a', ADMIN_PASSWORD: 'b', LOBBY_ADMIN_SECRET: 'c', NODE_ENV: 'production' })).toBe('a');
    expect(adminPassword({ ADMIN_PASSWORD: 'b', LOBBY_ADMIN_SECRET: 'c', NODE_ENV: 'production' })).toBe('b');
    expect(adminPassword({ LOBBY_ADMIN_SECRET: 'c', NODE_ENV: 'production' })).toBe('c');
    expect(adminPassword({ NODE_ENV: 'production' })).toBe('');
    expect(adminPassword({})).toBe('admin');
  });
});

describe('the owner rank, from the lobby', () => {
  it('an owner signs in as an admin and the owner; admin changes name the acting admin', async () => {
    const bodies: { path: string; body: any }[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        bodies.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === '/auth/validate'
          ? { success: true, id: 4, username: 'kier', isAdmin: false, isOwner: true }
          : { success: true, user: { id: 5, username: body.username, isAdmin: true, isOwner: false, createdAt: '', ban: null } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const accounts = new LobbyAccounts(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'sssh');
      // (An owner is an admin, even if the lobby's isAdmin said otherwise)
      expect(await accounts.validateSession('tok')).toMatchObject({ id: 4, is_admin: true, is_owner: true });
      await accounts.admin!.setAdmin('pilot', true, 'kier');
      await accounts.admin!.ban('pilot', null, 'x', 'kier', 'kier');
      await accounts.admin!.unban('pilot', 'kier');
      expect(bodies.slice(1).map((b) => [b.path, b.body.actor])).toEqual([['/admin/set-admin', 'kier'], ['/admin/ban', 'kier'], ['/admin/unban', 'kier']]);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
