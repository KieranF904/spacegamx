import { describe, it, expect } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { LobbyAccounts } from './LobbyAccounts.js';

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
