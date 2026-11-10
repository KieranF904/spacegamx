import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import type http from 'http';
import { JsonUserStore } from './JsonUserStore.js';
import { AccountRoutes } from './routes.js';
import { DeletedAccounts } from './DeletedAccounts.js';
import { RateLimiter } from './RateLimiter.js';
import { BodyError, clientIp, readJson } from './request.js';
import { safeEqual } from './utils.js';
import { MAX_SERVERS, listing, parseHeartbeat } from '../servers.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'lobby-hard-'));
  dirs.push(dir);
  return dir;
}

/** The routes, with the caller's address settable per call */
async function routes(s: JsonUserStore, secret = 'sssh') {
  let body: object = {};
  let ip = '10.0.0.1';
  let out: { status: number; body: any } = { status: 0, body: null };
  const r = await AccountRoutes.create((_, status, b) => { out = { status, body: b }; }, async () => body, () => ip, { store: s, adminSecret: secret });
  return async (url: string, b: object, from = '10.0.0.1', auth?: string) => {
    body = b;
    ip = from;
    const req = { method: 'POST', headers: auth !== undefined ? { authorization: `Bearer ${auth}` } : {} } as unknown as http.IncomingMessage;
    await r.handle(req, {} as http.ServerResponse, url);
    return out;
  };
}

/** A request whose body arrives in these chunks */
function request(chunks: (string | Buffer)[], headers: Record<string, string> = {}): http.IncomingMessage {
  const req = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
  (req as any).headers = headers;
  setImmediate(() => { for (const c of chunks) req.write(c); req.end(); });
  return req;
}

describe('sign-in limits', () => {
  it('after 10 wrong passwords for a name from one address, that address is locked out of it (the right password too); the pilot elsewhere is not', async () => {
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    await s.register('victim', 'victim@example.com', 'right-pass1');
    // (Before the routes: their limits keep the clock they were made with)
    vi.useFakeTimers({ toFake: ['Date'] });
    const call = await routes(s);
    try {
      for (let i = 0; i < 10; i++) expect((await call('/auth/login', { username: 'victim', password: `guess${i}` }, '10.1.0.1')).status).toBe(401);
      // (A minute on, so it's the wrong passwords that hold it, not the address's 10 attempts a minute)
      vi.setSystemTime(Date.now() + 61_000);
      const locked = await call('/auth/login', { username: 'VICTIM', password: 'right-pass1' }, '10.1.0.1');
      expect(locked.status).toBe(429);
      expect(locked.body).toEqual({ success: false, error: expect.stringMatching(/Too many wrong passwords for this account\. Try again in 14 minutes/) });
      // The pilot, from their own address, gets in
      expect((await call('/auth/login', { username: 'victim', password: 'right-pass1' }, '10.2.0.1')).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('locks a name from every address after 100 wrong passwords from anywhere (guessing shared out); other names are fine', async () => {
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    await s.register('victim', 'victim@example.com', 'right-pass1');
    await s.register('bystander', 'by@example.com', 'pw-12345');
    const call = await routes(s);
    for (let i = 0; i < 100; i++) expect((await call('/auth/login', { username: 'victim', password: `guess${i}` }, `10.1.${i >> 3}.${i & 7}`)).status).toBe(401);
    const locked = await call('/auth/login', { username: 'VICTIM', password: 'right-pass1' }, '10.9.0.1');
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual({ success: false, error: expect.stringMatching(/Too many wrong passwords for this account\. Try again in 15 minutes/) });
    expect((await call('/auth/login', { username: 'bystander', password: 'pw-12345' }, '10.9.0.2')).status).toBe(200);
  });

  it('a right password clears that address\'s wrong ones', async () => {
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    await s.register('forgetful', 'f@example.com', 'right-pass1');
    // (Before the routes: their limits keep the clock they were made with)
    vi.useFakeTimers({ toFake: ['Date'] });
    const call = await routes(s);
    try {
      for (let i = 0; i < 9; i++) await call('/auth/login', { username: 'forgetful', password: 'x' }, '10.5.0.1');
      expect((await call('/auth/login', { username: 'forgetful', password: 'right-pass1' }, '10.5.0.1')).status).toBe(200);
      vi.setSystemTime(Date.now() + 61_000);
      for (let i = 0; i < 9; i++) expect((await call('/auth/login', { username: 'forgetful', password: 'x' }, '10.5.0.1')).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still limits each address to 10 attempts a minute', async () => {
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    const call = await routes(s);
    for (let i = 0; i < 10; i++) expect((await call('/auth/login', { username: `nobody${i}`, password: 'x' }, '10.9.9.9')).status).toBe(401);
    const r = await call('/auth/login', { username: 'other', password: 'x' }, '10.9.9.9');
    expect(r).toEqual({ status: 429, body: { success: false, error: 'Too many attempts. Wait a minute and try again.' } });
  });

  it('limits wrong passwords on account changes per account, from any address', async () => {
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    const reg = await s.register('owner', 'owner@example.com', 'right-pass1');
    if (!reg.success) throw new Error(reg.error);
    const call = await routes(s);
    for (let i = 0; i < 10; i++) expect((await call('/auth/delete-account', { token: reg.token, password: 'x' }, `10.7.0.${i}`)).status).toBe(401);
    expect((await call('/auth/delete-account', { token: reg.token, password: 'right-pass1' }, '10.8.0.1')).status).toBe(429);
    expect(await s.getUserById(reg.user.id)).not.toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows `limit` per window, then again once the window passes', () => {
    let t = 0;
    const l = new RateLimiter(3, 1000, 100, () => t);
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, true, false]);
    expect(l.retryAfter('a')).toBe(1);
    t = 1000;
    expect(l.hit('a')).toBe(true);
  });

  it('stays bounded under a flood of new keys, dropping the oldest, without wiping a busy key', () => {
    let t = 0;
    const l = new RateLimiter(2, 60_000, 100, () => t);
    l.hit('target'); l.hit('target');
    for (let i = 0; i < 50; i++) { t++; l.hit(`spray${i}`); }
    l.record('target'); // (touched lately: among the newest)
    for (let i = 50; i < 5000; i++) { t++; l.hit(`spray${i}`); if (i % 50 === 0) l.record('target'); }
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.blocked('target')).toBe(true);
  });

  it('drops keys whose window passed', () => {
    let t = 0;
    const l = new RateLimiter(1, 1000, 10, () => t);
    for (let i = 0; i < 10; i++) l.hit(`old${i}`);
    t = 5000;
    l.hit('new1');
    expect(l.size).toBe(1);
  });
});

describe('request bodies and addresses', () => {
  it('reads a JSON object, split anywhere (even inside a character)', async () => {
    const bytes = Buffer.from(JSON.stringify({ username: 'Zoë' }));
    const at = bytes.indexOf(0xc3) + 1;
    expect(await readJson(request([bytes.subarray(0, at), bytes.subarray(at)]))).toEqual({ username: 'Zoë' });
    expect(await readJson(request([]))).toEqual({});
  });

  it('refuses a body past the limit (413) without keeping it, and bad or non-object JSON (400)', async () => {
    const big = 'x'.repeat(16 * 1024);
    await expect(readJson(request([big, big, big, big, big]), 64 * 1024)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(request(['{}'], { 'content-length': String(10 * 1024 * 1024) }))).rejects.toBeInstanceOf(BodyError);
    await expect(readJson(request(['{"a":']))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request(['null']))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request(['[1]']))).rejects.toMatchObject({ status: 400 });
  });

  it('the accounts answer a body too large with 413', async () => {
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    let out = { status: 0, body: null as any };
    const r = await AccountRoutes.create((_, status, b) => { out = { status, body: b }; }, async () => { throw new BodyError('Request body too large', 413); }, () => '10.0.0.1', { store: s, adminSecret: 'sssh' });
    await r.handle({ method: 'POST', headers: {} } as unknown as http.IncomingMessage, {} as http.ServerResponse, '/auth/login');
    expect(out).toEqual({ status: 413, body: { success: false, error: 'Invalid request' } });
  });

  it('believes X-Forwarded-For only from this machine (nginx, the website)', () => {
    const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as http.IncomingMessage;
    expect(clientIp(req('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9');
    expect(clientIp(req('127.0.0.1', '198.51.100.7'))).toBe('198.51.100.7');
    expect(clientIp(req('::ffff:127.0.0.1', 'spoofed, 198.51.100.8'))).toBe('198.51.100.8');
    expect(clientIp(req('::1'))).toBe('::1');
  });
});

describe('admin secret', () => {
  it('compares in constant time, any length, and is off when unset', async () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    const s = new JsonUserStore(join(tmp(), 'users.json'));
    const call = await routes(s);
    expect((await call('/admin/users', {}, '127.0.0.1', 'sssh-and-more')).status).toBe(403);
    expect((await call('/admin/users', {}, '127.0.0.1', '')).status).toBe(403);
    const off = await routes(s, '');
    expect((await off('/admin/users', {}, '127.0.0.1', '')).status).toBe(403);
    expect((await off('/admin/ban', { username: 'admin', until: null }, '127.0.0.1', 'Bearer ')).status).toBe(403);
  });
});

describe('accounts file safety', () => {
  it('refuses to start over a damaged users.json, leaving it (and the backup) as they were', async () => {
    const dir = tmp();
    const file = join(dir, 'users.json');
    const s = new JsonUserStore(file);
    await s.register('keeper', 'keeper@example.com', 'pw-12345');
    await s.close();
    new JsonUserStore(file); // (a good start: backs it up)
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf-8')).users.map((u: any) => u.username)).toContain('keeper');
    writeFileSync(file, '{"version":1,"users":[{"id":1,'); // cut short
    expect(() => new JsonUserStore(file)).toThrow(/Refusing to start.*users\.json\.bak/);
    expect(readFileSync(file, 'utf-8')).toBe('{"version":1,"users":[{"id":1,');
    writeFileSync(file, '');
    expect(() => new JsonUserStore(file)).toThrow(/Refusing to start/);
    expect(readFileSync(file, 'utf-8')).toBe('');
    // Restoring the backup brings everyone back
    writeFileSync(file, readFileSync(`${file}.bak`));
    expect((await new JsonUserStore(file).login('keeper', 'pw-12345')).success).toBe(true);
  });

  it('many changes at once all reach the file, which is always whole, with no temp file left', async () => {
    const dir = tmp();
    const file = join(dir, 'users.json');
    const s = new JsonUserStore(file);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.register(`pilot${i}`, `p${i}@example.com`, 'pw-12345')));
    await s.close();
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw.users.filter((u: any) => u.username.startsWith('pilot'))).toHaveLength(20);
    expect(raw.sessions).toHaveLength(20);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a deleted account is on disk by the time deleteUser returns', async () => {
    const file = join(tmp(), 'users.json');
    const s = new JsonUserStore(file);
    const reg = await s.register('gone', 'gone@example.com', 'pw-12345');
    if (!reg.success) throw new Error(reg.error);
    await s.deleteUser(reg.user.id);
    expect(readFileSync(file, 'utf-8')).not.toMatch(/gone@example/);
  });

  it('a damaged deleted-accounts list is kept aside, not silently dropped', () => {
    const dir = tmp();
    const file = join(dir, 'deleted-accounts.json');
    writeFileSync(file, '[{"id":4,"at":');
    const list = new DeletedAccounts(file, () => 1_000);
    expect(list.recent()).toEqual([]);
    expect(readFileSync(join(dir, 'deleted-accounts.json.corrupt-1000'), 'utf-8')).toBe('[{"id":4,"at":');
    list.add(7);
    expect(new DeletedAccounts(file, () => 1_000).recent()).toEqual([7]);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('game server heartbeat', () => {
  it('takes a normal heartbeat as it was', () => {
    expect(parseHeartbeat({ host: 'space.example.com', port: 443, name: 'Main', region: 'eu', maxPlayers: 32, players: 3, secure: true, version: '2.0.0', adminPort: 3101 }, '127.0.0.1'))
      .toEqual({ host: 'space.example.com', port: 443, name: 'Main', region: 'eu', maxPlayers: 32, players: 3, secure: true, version: '2.0.0', adminPort: 3101 });
    expect(parseHeartbeat({}, '::ffff:127.0.0.1')).toMatchObject({ host: '::ffff:127.0.0.1', port: 3000, name: 'Game Server', maxPlayers: 32, players: 0, adminPort: undefined });
  });

  it('lists no admin port in production (the dev lobby keeps it for the sandbox)', () => {
    const s = { host: 'space.example.com', port: 443, name: 'Main', region: 'eu', maxPlayers: 32, players: 3, secure: true, version: '2.0.0', lastSeen: 1, adminPort: 3105 };
    const prod = listing(s, true);
    expect('adminPort' in prod).toBe(false);
    expect('lastSeen' in prod).toBe(false);
    expect(prod).toEqual({ host: 'space.example.com', port: 443, name: 'Main', region: 'eu', maxPlayers: 32, players: 3, secure: true, version: '2.0.0' });
    expect(listing(s, false).adminPort).toBe(3105);
  });

  it('refuses hosts that could break the page, and bad ports; bounds the rest', () => {
    expect(parseHeartbeat({ host: "x');alert(1);//" }, '127.0.0.1')).toEqual({ error: 'Invalid host' });
    expect(parseHeartbeat({ host: 'ok', port: 70000 }, '127.0.0.1')).toEqual({ error: 'Invalid port' });
    expect(parseHeartbeat({ host: 'ok', adminPort: 'abc' }, '127.0.0.1')).toEqual({ error: 'Invalid adminPort' });
    const big = parseHeartbeat({ host: 'ok', name: 'n'.repeat(10_000), players: 1e12, maxPlayers: -5 }, '127.0.0.1');
    expect(big).toMatchObject({ players: 100_000, maxPlayers: 0 });
    expect(('name' in big) && big.name.length).toBe(64);
    expect(MAX_SERVERS).toBeGreaterThan(0);
  });
});
