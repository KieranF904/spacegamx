/**
 * The website halves of the game features: Database, status, ship gallery, "What's new" feed. Over real HTTP (port 0)
 * with a fake lobby, an injected status, and the real catalog snapshot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from './app.js';
import { CatalogBook } from './catalog/book.js';
import type { CatalogFile } from './catalog/types.js';
import { changelogItems } from './changelog.js';
import { loadConfig } from './config.js';
import type { Lobby } from './lobby.js';
import type { PilotSource } from './pilots.js';
import { RateLimiter } from './security.js';
import { checkShip } from './ships.js';
import { parseStatus, type ServerStatus } from './status.js';
import { JsonSiteStore } from './store/JsonSiteStore.js';
import type { Post } from './store/types.js';
import { Uploads } from './uploads.js';

const KEY = 'k'.repeat(40);
const snapshot = join(__dirname, '../catalog/catalog.json');
const cat = JSON.parse(readFileSync(snapshot, 'utf8')) as CatalogFile;

const lobby = {
  async validate() { return null; }, async findUser(n: string) { return { id: 7, username: n, isAdmin: false, createdAt: '', ban: null }; },
} as unknown as Lobby;
const pilots: PilotSource = {
  async card() { return null; }, async rankings() { return null; }, async live() { return { players: 2, ships: 3, at: Date.now(), fresh: true }; },
};

let status: ServerStatus | null = null;
let server: http.Server;
let base = '';
let dir = '';
let store: JsonSiteStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-feat-'));
  store = new JsonSiteStore(join(dir, 'site.json'));
  const cfg = loadConfig({ SITE_SECRET: 'test-secret', SITE_DATA_DIR: dir, GAME_MODE: 'link', GAME_URL: 'http://game.example', SITE_GAME_KEY: KEY } as NodeJS.ProcessEnv);
  const app = createApp({
    cfg, store, lobby, pilots, uploads: new Uploads(dir), limiter: new RateLimiter(),
    catalog: new CatalogBook(snapshot, null), status: { get: async () => status },
  });
  server = http.createServer((q, s) => void app.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cfg.origin = base;
});
afterAll(async () => { server.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); });

const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { headers, redirect: 'manual' });
  return { status: r.status, text: await r.text(), headers: r.headers };
};
const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
};
const game = { authorization: `Bearer ${KEY}` };

describe('Database', () => {
  it('every list and every entry renders, and an unknown one is a 404', async () => {
    for (const k of ['parts', 'items', 'ships', 'bosses', 'stations']) expect((await get(`/database/${k}`)).status, k).toBe(200);
    expect((await get('/database')).status).toBe(200);
    const one = { parts: cat.parts[0], items: cat.items[0], ships: cat.ships[0], bosses: cat.bosses[0], stations: cat.stations[0] };
    for (const [k, e] of Object.entries(one)) expect((await get(`/database/${k}/${e.id}`)).status, k).toBe(200);
    expect((await get('/database/parts/nope')).status).toBe(404);
    expect((await get('/database/nothing')).status).toBe(404);
    expect((await get('/database/items/%00')).status).toBe(404);
  });

  it('every entry page renders (all of them) with none of the game\'s prose', async () => {
    const prose: string[] = [];
    const data = join(__dirname, '../../data');
    const read = (f: string) => { try { return JSON.parse(readFileSync(join(data, f), 'utf8')); } catch { return null; } };
    for (const i of read('items.json')?.items ?? []) if (i.description) prose.push(i.description);
    for (const s of read('stations.json')?.stations ?? []) { if (s.description) prose.push(s.description); if (s.market?.note) prose.push(s.market.note); }
    for (const s of read('systems.json')?.systems ?? []) if (s.description) prose.push(s.description);
    for (const b of Object.values<any>(read('bosses.json')?.bosses ?? {})) { if (b.intro) prose.push(b.intro); if (b.title) prose.push(b.title); }
    const kinds = { parts: cat.parts, items: cat.items, ships: cat.ships, bosses: cat.bosses, stations: cat.stations } as const;
    for (const [kind, list] of Object.entries(kinds)) {
      for (const e of list) {
        const page = await get(`/database/${kind}/${encodeURIComponent(e.id)}`);
        expect(page.status, `${kind}/${e.id}`).toBe(200);
        for (const p of prose) if (page.text.includes(p)) throw new Error(`${kind}/${e.id} shows game text: ${p.slice(0, 60)}`);
      }
    }
  });

  it('parts read like the game\'s component guide: category tabs, rows by level with the game\'s pictures, each linkable', async () => {
    const r = await get('/database/parts?category=weapons');
    expect(r.text).toContain('class="cg-cats"');
    expect(r.text).toMatch(/<details class="cg-row[^"]*" id="cannon_pip">/);
    expect(r.text).toContain('src="/static/img/parts/cannon_pip.webp"');
    expect(r.text).toContain('href="/database/parts/cannon_pip"');
    expect(r.text).not.toContain('id="engine_ion_drive"');
    const levels = [...r.text.matchAll(/<small>LV<\/small><b>(\d+)<\/b>/g)].map((m) => Number(m[1]));
    expect(levels.length).toBeGreaterThan(5);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
    const s = await get('/database/parts?category=structure');
    expect(s.text).toContain('id="structure-alloy"');
    expect(s.text).toContain('Starter: every pilot can build it');
    const img = await fetch(base + '/static/img/parts/cannon_pip.webp');
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
  });

  it('searches and filters', async () => {
    const r = await get('/database/parts?q=pip&category=weapons');
    expect(r.text).toContain('Pip');
    expect(r.text).not.toContain('Ion Drive');
    expect((await get('/database?q=steel')).text).toContain('Steel Plate');
    expect((await get('/database/items?q=zzzzzz')).text).toContain('No item matches.');
    expect((await get('/database/items?q=%3Cscript%3E')).text).not.toContain('<script>alert');
  });

  it('the catalog API gives the contract shape, public and cached', async () => {
    const r = await get('/api/v1/catalog');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const j = JSON.parse(r.text);
    expect(j.version).toBe(1);
    expect(j.parts.length).toBe(cat.parts.length);
    expect(j.part).toBeUndefined(); // (no lookup maps)
    const only = JSON.parse((await get('/api/v1/catalog?kind=bosses')).text);
    expect(Object.keys(only)).toEqual(['version', 'builtAt', 'source', 'bosses']);
  });

  it('says so when there is no catalog', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'site-none-'));
    const cfg = loadConfig({ SITE_SECRET: 'x', SITE_DATA_DIR: dir2, GAME_MODE: 'link' } as NodeJS.ProcessEnv);
    const st = new JsonSiteStore(join(dir2, 'site.json'));
    const app = createApp({ cfg, store: st, lobby, pilots, uploads: new Uploads(dir2), catalog: new CatalogBook(join(dir2, 'missing.json'), null), status: { get: async () => null } });
    const srv = http.createServer((q, s) => void app.handle(q, s));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const b = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const r = await fetch(`${b}/database/parts`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('The database has not been built.');
    expect((await fetch(`${b}/api/v1/catalog`)).status).toBe(503);
    srv.close(); await st.close(); rmSync(dir2, { recursive: true, force: true });
  });
});

describe('server status', () => {
  const NOT = 'Not reported by the server yet.';

  it('parses only what is well formed', () => {
    const now = 1_000_000;
    expect(parseStatus(null)).toBeNull();
    const s = parseStatus({ t: now - 1000, players: 3, ships: 9, version: '1.2', protocol: 26, tick: { ms50: 4.2, ms99: 11 }, systems: [{ id: 'sol', players: 2 }, { id: '<b>', players: 1 }, { id: 'x' }], bosses: [{ id: 'b1', system: 'sol', state: 'down', respawnAt: now + 5000 }, { id: 'b2', system: 'sol', state: 'weird' }] }, now)!;
    expect(s).toMatchObject({ online: true, players: 3, ships: 9, version: '1.2', protocol: 26, tick: { ms50: 4.2, ms99: 11 } });
    expect(s.systems).toEqual([{ id: 'sol', players: 2 }]);
    expect(s.bosses).toEqual([{ id: 'b1', system: 'sol', state: 'down', respawnAt: now + 5000 }]);
    const old = parseStatus({ t: now - 60_000, players: 3, ships: 1 }, now)!;
    expect(old).toMatchObject({ online: false, players: 0 });
    const bare = parseStatus({ t: now, players: 1, ships: 2 }, now)!;
    expect(bare.version).toBeUndefined();
    expect(bare.systems).toBeUndefined();
  });

  it('with only players and ships, each other section says it is not reported', async () => {
    status = parseStatus({ t: Date.now(), players: 2, ships: 5 });
    const r = await get('/status');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Online');
    expect(r.text.split(NOT).length - 1).toBe(4); // version, tick, systems, bosses
    const api = JSON.parse((await get('/api/v1/status')).text);
    expect(api).toMatchObject({ online: true, players: 2, ships: 5 });
    expect(api.version).toBeUndefined();
  });

  it('shows what the game reports', async () => {
    status = parseStatus({
      t: Date.now(), players: 2, ships: 5, version: '0.9.1', protocol: 26, startedAt: Date.now() - 3 * 3600_000, tick: { ms50: 3.1, ms99: 9.8 },
      systems: [{ id: 'sol', players: 2 }], bosses: [{ id: 'boss_scrap_mother', system: 'sol_scrap_nest', state: 'down', respawnAt: Date.now() + 120_000 }],
    });
    const r = await get('/status');
    expect(r.text).not.toContain(NOT);
    expect(r.text).toContain('0.9.1');
    expect(r.text).toContain('Sol System');
    expect(r.text).toContain('Scrap Mother');
    expect(r.text).toContain('3.1 ms');
  });

  it('offline: says so, and has no sections', async () => {
    status = parseStatus({ t: Date.now() - 120_000, players: 4, ships: 8 });
    const r = await get('/status');
    expect(r.text).toContain('Offline');
    expect(r.text).not.toContain('Tick time');
    expect(JSON.parse((await get('/api/v1/status')).text)).toMatchObject({ online: false, players: 0 });
    status = null;
    expect((await get('/status')).text).toContain('The server is offline.');
  });
});

describe('changelog feed', () => {
  const post = (slug: string, publishedAt: string | null, tags: string[] = []): Post => ({
    id: 1, slug, title: slug, summary: `About ${slug}`, body: 'Hello', tags, cover: '/uploads/a.png', status: publishedAt ? 'published' : 'draft', authorId: 1, authorName: 'a',
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', publishedAt,
  });
  const posts = [post('old', '2026-10-01T00:00:00Z'), post('new', '2026-11-02T00:00:00Z', ['game']), post('draft', null)];

  it('lists published posts, newest first, with absolute links', () => {
    const items = changelogItems(posts, { origin: 'https://x.test' });
    expect(items.map((i) => i.slug)).toEqual(['new', 'old']);
    expect(items[0]).toMatchObject({ url: 'https://x.test/updates/new', cover: 'https://x.test/uploads/a.png', summary: 'About new' });
  });

  it('narrows by since, tag and limit', () => {
    expect(changelogItems(posts, { origin: 'o', since: '2026-10-15T00:00:00Z' }).map((i) => i.slug)).toEqual(['new']);
    expect(changelogItems(posts, { origin: 'o', tag: 'game' }).map((i) => i.slug)).toEqual(['new']);
    expect(changelogItems(posts, { origin: 'o', limit: 1 })).toHaveLength(1);
    expect(changelogItems(posts, { origin: 'o', since: 'not a date' })).toHaveLength(2);
  });

  it('the endpoint is public and leaves drafts out', async () => {
    await store.createPost({ slug: 'feed-a', title: 'Feed A', summary: 'S', body: 'b', tags: ['game'], cover: null, status: 'published', authorId: 1, authorName: 'x' });
    await store.createPost({ slug: 'feed-b', title: 'Feed B', summary: '', body: 'b', tags: [], cover: null, status: 'draft', authorId: 1, authorName: 'x' });
    const r = await get('/api/v1/changelog');
    expect(r.status).toBe(200);
    const j = JSON.parse(r.text);
    expect(j.items.map((i: { slug: string }) => i.slug)).toEqual(['feed-a']);
    expect(j.items[0].url).toBe(`${base}/updates/feed-a`);
    expect(JSON.parse((await get('/api/v1/changelog?tag=nope')).text).items).toEqual([]);
  });
});

describe('ship gallery', () => {
  const plan = cat.ships[0].plan;
  const stats = cat.ships[0].stats;
  const body = (over: Record<string, unknown> = {}) => ({ userId: 7, userName: 'Orrin', name: 'Stubborn', plan, stats, ...over });

  it('checks what the game sends', () => {
    expect(checkShip(body(), cat.render).ok).toBe(true);
    expect(checkShip(body({ userId: 'x' }), cat.render).ok).toBe(false);
    expect(checkShip(body({ userName: '<b>' }), cat.render).ok).toBe(false);
    expect(checkShip(body({ name: '   ' }), cat.render).ok).toBe(false);
    expect(checkShip(body({ plan: [] }), cat.render).ok).toBe(false);
    expect(checkShip(body({ plan: [{ fn: 'hull', piece: 'nope', x: 0, y: 0, rot: 0 }] }), cat.render).ok).toBe(false);
    expect(checkShip(body({ plan: [{ fn: 'hull', piece: 'sq', x: 0.5, y: 0, rot: 0 }] }), cat.render).ok).toBe(false);
    expect(checkShip(body({ plan: [{ fn: 'hull', piece: 'sq', x: 0, y: 0, rot: 9 }] }), cat.render).ok).toBe(false);
    expect(checkShip(body({ stats: { ...stats, mass: -1 } }), cat.render).ok).toBe(false);
    expect(checkShip(body({ stats: { ...stats, guns: undefined } }), cat.render).ok).toBe(false);
    expect(checkShip(body({ plan: Array.from({ length: 401 }, () => ({ fn: 'hull', piece: 'sq', x: 0, y: 0, rot: 0 })) }), cat.render).ok).toBe(false);
  });

  it('only the game server, with its key, can share', async () => {
    expect((await send('POST', '/api/v1/ships', body())).status).toBe(403); // (no key and no form token: the site's usual refusal)
    expect((await send('POST', '/api/v1/ships', body(), { authorization: 'Bearer wrong' })).status).toBe(401);
    // The key is not an admin: it can't touch posts
    expect((await send('GET', '/api/v1/posts', undefined, game)).status).toBe(401);
    expect((await send('POST', '/api/v1/posts', { title: 'x', body: 'y' }, game)).status).toBe(401);
    expect((await send('GET', '/api/v1/me', undefined, game)).status).toBe(401);
  });

  it('shares, updates by name, lists, draws, and shows on the pilot page', async () => {
    const a = await send('POST', '/api/v1/ships', body(), game);
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ created: true, url: expect.stringContaining('/ships/') });
    const again = await send('POST', '/api/v1/ships', body({ name: 'stubborn', stats: { ...stats, mass: 99 } }), game);
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(a.json.id);
    const list = JSON.parse((await get('/api/v1/ships')).text);
    expect(list.ships).toHaveLength(1);
    expect(list.ships[0]).toMatchObject({ owner: 'Orrin', stats: { mass: 99 } });
    expect(list.ships[0].plan).toBeUndefined();
    const one = JSON.parse((await get(`/api/v1/ships/${a.json.id}`)).text);
    expect(one.ship.plan.length).toBe(plan.length);
    const g = await get('/ships');
    expect(g.text).toContain('Orrin');
    const sp = await get(`/ships/${a.json.id}`);
    expect(sp.status).toBe(200);
    expect(sp.text).toContain('<polygon');
    expect((await get('/pilots/Orrin')).text).toContain('Shared ships');
    expect((await get('/pilots/Orrin')).text).toContain('stubborn');
  });

  it('caps a pilot, and only the owner can withdraw a ship', async () => {
    for (let i = 0; i < 9; i++) expect((await send('POST', '/api/v1/ships', body({ name: `Ship ${i}` }), game)).status).toBe(201);
    const over = await send('POST', '/api/v1/ships', body({ name: 'One too many' }), game);
    expect(over.status).toBe(409);
    const list = JSON.parse((await get('/api/v1/ships?owner=orrin')).text);
    expect(list.ships).toHaveLength(10);
    const id = list.ships[0].id;
    expect((await send('DELETE', `/api/v1/ships/${id}?userId=8`, undefined, game)).status).toBe(403);
    expect((await send('DELETE', `/api/v1/ships/${id}`, undefined, game)).status).toBe(403);
    expect((await send('DELETE', `/api/v1/ships/${id}?userId=7`)).status).toBe(403);
    expect((await send('DELETE', `/api/v1/ships/${id}?userId=7`, undefined, game)).status).toBe(200);
    expect((await get(`/ships/${id}`)).status).toBe(404);
  });

  it('a hidden ship is out of the gallery and the API', async () => {
    const list = await store.listShips({});
    await store.setShipHidden(list[0].id, true);
    expect((await get(`/ships/${list[0].id}`)).status).toBe(404);
    expect(JSON.parse((await get('/api/v1/ships')).text).ships.some((s: { id: number }) => s.id === list[0].id)).toBe(false);
    expect((await get(`/api/v1/ships/${list[0].id}`)).status).toBe(404);
  });

  it('is off without a key, and says so', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'site-nokey-'));
    const cfg = loadConfig({ SITE_SECRET: 'x', SITE_DATA_DIR: dir2, GAME_MODE: 'link' } as NodeJS.ProcessEnv);
    const st = new JsonSiteStore(join(dir2, 'site.json'));
    const app = createApp({ cfg, store: st, lobby, pilots, uploads: new Uploads(dir2), catalog: new CatalogBook(snapshot, null), status: { get: async () => null } });
    const srv = http.createServer((q, s) => void app.handle(q, s));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const b = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const r = await fetch(`${b}/api/v1/ships`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body()) });
    expect(r.status).toBe(401); // (no key is set, so the bearer is just a bad token)
    expect(await (await fetch(`${b}/ships`)).text()).toContain('No shared ships yet.');
    srv.close(); await st.close(); rmSync(dir2, { recursive: true, force: true });
  });
});

describe('no lore on the site', () => {
  it('the home page and pilot pages carry no game story, quotes or codex counts', async () => {
    const home = (await get('/')).text;
    expect(home).not.toContain('Something huge');
    expect(home).not.toContain('class="ingame"');
    expect(home).not.toMatch(/codex/i);
    expect((await get('/pilots/Orrin')).text).not.toMatch(/codex/i);
  });

  it('the Database lists have no description column, and the nav and footer link to the features', async () => {
    const parts = (await get('/database/parts')).text;
    expect(parts).not.toMatch(/<th>Description/i);
    for (const href of ['/database', '/ships', '/status']) expect(parts).toContain(`href="${href}"`);
    expect(parts).not.toContain('href="/guides"'); // (hidden: SITE_GUIDES=1 brings them back)
  });
});
