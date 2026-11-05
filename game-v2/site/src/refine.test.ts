/** The 2026-11-04 refinements: byline, 404 heading, home links, pilot page boss kills and ribbons, boards, no lore on the home page */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createApp } from './app.js';
import { CatalogBook } from './catalog/book.js';
import { loadConfig, parseAuthors } from './config.js';
import type { Lobby } from './lobby.js';
import type { PilotSource } from './pilots.js';
import { RateLimiter } from './security.js';
import { JsonSiteStore } from './store/JsonSiteStore.js';
import { Uploads } from './uploads.js';

const snapshot = join(__dirname, '../catalog/catalog.json');
const lobby = {
  async validate() { return null; }, async findUser(n: string) { return n.toLowerCase() === 'vega' ? { id: 2, username: 'Vega', isAdmin: false, createdAt: '', ban: null } : null; },
} as unknown as Lobby;
const pilots: PilotSource = {
  async card() {
    return {
      level: 12, xp: 1, credits: 5, shipName: 'Stubborn', ships: 1, stats: { kills: 3, bosses: 2, quests: 0, mined: 0, earned: 0, crafted: 0, deaths: 0 },
      systemsVisited: 2, ribbons: 2, ribbonIds: ['first_blood', 'explorer'], bossKills: { boss_scrap_mother: 2, boss_unknown_thing: 1 }, since: null, lastFlown: null,
    };
  },
  async rankings() { return { week: 1, weekly: {}, allTime: { kills: [{ userId: '2', name: 'Vega', value: 3 }], bosses: [], earned: [], quests: [], mined: [] } }; },
  async live() { return { players: 0, ships: 0, at: Date.now(), fresh: true }; },
};

let server: http.Server;
let base = '';
let dir = '';
let store: JsonSiteStore;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-refine-'));
  store = new JsonSiteStore(join(dir, 'site.json'));
  const cfg = loadConfig({ SITE_SECRET: 'test-secret', SITE_DATA_DIR: dir, GAME_MODE: 'link', GAME_URL: 'http://game.example' } as NodeJS.ProcessEnv);
  const app = createApp({ cfg, store, lobby, pilots, uploads: new Uploads(dir), limiter: new RateLimiter(), catalog: new CatalogBook(snapshot, null) });
  server = http.createServer((q, s) => void app.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cfg.origin = base;
  await store.createPost({ slug: 'first', title: 'First', summary: '', body: 'Hello.', tags: [], cover: null, status: 'published', authorId: 1, authorName: 'admin' });
});
afterAll(async () => { server.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); });

const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, text: await r.text() }; };

describe('refinements', () => {
  it('maps account names to shown names', () => {
    expect(parseAuthors('admin=Kieran, Other = Some One')).toEqual({ admin: 'Kieran', other: 'Some One' });
    expect(parseAuthors('')).toEqual({});
    expect(parseAuthors('nonsense')).toEqual({});
  });

  it('a post by admin is signed with the configured name', async () => {
    const { text } = await get('/updates/first');
    expect(text).toContain('Kieran');
    expect(text).not.toMatch(/<span class="sep">\/<\/span> admin</);
  });

  it('the 404 page has a heading and links', async () => {
    const r = await get('/nothing-here');
    expect(r.status).toBe(404);
    expect(r.text).toMatch(/<h1>Page not found<\/h1>/);
    expect(r.text).toContain('href="/guides"');
  });

  it('the home page links the guides and database and quotes no game text', async () => {
    const { text } = await get('/');
    expect(text).toContain('href="/guides/building-a-ship"');
    expect(text).toContain('href="/database/parts"');
    expect(text).not.toContain('ingame');
    expect(text).not.toContain('In the game');
    expect(text).not.toMatch(/stirs|patched together/i);
    expect(text).not.toMatch(/wire/i);
  });

  it('a pilot page lists boss kills by name and ribbons by name, and no codex count', async () => {
    const { text } = await get('/pilots/Vega');
    expect(text).toContain('Bosses beaten');
    expect(text).toContain('Scrap Mother');
    expect(text).toContain('Unknown thing');
    expect(text).toContain('First Blood');
    expect(text).not.toMatch(/codex/i);
  });

  it('the boards show the filled ones and one line for the empty ones', async () => {
    const { text } = await get('/pilots');
    expect(text).toContain('Hostiles destroyed');
    expect(text).toMatch(/No scores yet: boss kills, credits earned, jobs done, ore mined\./);
    expect((text.match(/class="board panel"/g) ?? []).length).toBe(1);
  });
});
