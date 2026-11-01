// The page's server routes, on a fake model and a fake renderer (no network, no GPU): everything else is real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Server, createServer, request } from 'http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { blueprintToGrid, loadContext } from '../core/index';
import { ship } from '../core/testShips';
import { AbortedError, type Llm, type Renderer } from '../loop/index';
import { fakeLlm, fakeModel } from '../loop/fakeLlm';
import { type App, createApp } from './app';
import { defaultPaths } from './paths';
import { buildUp } from './timelapse';

const ctx = loadContext();
const wren = ship('dev/review-wren');
const GOOD = blueprintToGrid(ctx, wren).text;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

const fakeRenderer = (): Renderer & { calls: number } => {
  const r = {
    calls: 0,
    async render(_bp: unknown, outPath: string) { r.calls++; mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, PNG); return { path: outPath, ms: 1, png: PNG }; },
    async close() {},
  };
  return r;
};

/** A model that streams a little, then waits until it is stopped */
const hangingLlm = (): Llm => ({
  async list() { return [fakeModel('slow')]; },
  chat(req) {
    req.onToken?.('name: X\ngrid:\n', 'content');
    return new Promise((_ok, fail) => {
      if (req.signal?.aborted) fail(new AbortedError());
      req.signal?.addEventListener('abort', () => fail(new AbortedError()));
    });
  },
});

let tmp: string, server: Server, base: string, app: App, llm: Llm & { requests?: unknown[] };
const renderer = fakeRenderer();
const labCalls: string[] = [];
let currentLlm: Llm;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'shipgen-web-'));
  const paths = { ...defaultPaths(ctx.dataDir), out: join(tmp, 'out'), dev: join(tmp, 'dev'), lab: join(tmp, 'lab') };
  mkdirSync(paths.lab, { recursive: true });
  writeFileSync(join(paths.lab, 'index.html'), '<p>lab</p>');
  llm = fakeLlm([GOOD], [fakeModel('fake'), fakeModel('other'), fakeModel('eyes', { vision: true }), fakeModel('big:cloud', { cloud: true }), { ...fakeModel('lm'), id: 'lmstudio/lm', provider: 'lmstudio', off: 'LM Studio, not enabled' }]);
  currentLlm = llm;
  // (The llm can be swapped per test through this proxy)
  const proxy: Llm = { list: () => currentLlm.list(), chat: (r) => currentLlm.chat(r) };
  app = createApp({ ctx, llm: proxy, paths, getRenderer: async () => renderer, exportLab: async (exporter) => { labCalls.push(exporter); return '99 ships written'; } });
  server = createServer(app.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
  await new Promise((ok) => server.close(ok));
  rmSync(tmp, { recursive: true, force: true });
});

const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) as any, r }; };
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};

/** The events of a run, from its SSE stream, until the server says it ended */
async function stream(id: string): Promise<any[]> {
  const r = await fetch(`${base}/api/runs/${id}/events`);
  expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
  const text = await r.text();
  expect(text).toMatch(/event: end/);
  return text.split('\n\n').filter((b) => b.includes('data: ') && !b.includes('event: end')).map((b) => JSON.parse(b.slice(b.indexOf('data: ') + 6)));
}

async function waitIdle() {
  for (let i = 0; i < 200 && app.runs.active(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe('shipgen page server', () => {
  it('serves the page and the game-derived lists', async () => {
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/<title>Shipgen<\/title>/);
    expect((await fetch(base + '/app.js')).headers.get('content-type')).toMatch(/javascript/);

    const roles = await get('/api/roles');
    expect(roles.body.roles.map((r: any) => r.id)).toContain('starter');
    const legend = await get('/api/legend');
    const byCode = new Map(legend.body.legend.map((r: any) => [r.code, r]));
    expect((byCode.get('CA') as any).cat).toBe('core');
    expect((byCode.get('PI') as any).cat).toBe('weapon');
    expect((byCode.get('ID') as any).cat).toBe('thruster');
    expect((byCode.get('BT') as any).cat).toBe('store');
    const lib = await get('/api/library');
    expect(lib.body.ships.find((s: any) => s.id === 'dev/review-wren')).toMatchObject({ group: 'Dev ships' });
    expect(lib.body.ships.some((s: any) => s.group === 'Enemy ships')).toBe(true);

    const one = await get('/api/library/dev%2Freview-wren?role=starter');
    expect(one.body.check.valid).toBe(true);
    expect(one.body.grid).toMatch(/^name: Review: Wren/);
    expect(Object.keys(one.body.cells).length).toBe(wren.parts.length);
    expect((await get('/api/library/..%2F..%2Fpackage')).status).toBe(400);
    expect((await get('/api/library/dev%2Fnope')).status).toBe(404);
  });

  it('lists models with cloud ones labelled, and never sends a token', async () => {
    const m = await get('/api/models');
    expect(m.body.models.find((x: any) => x.name === 'big:cloud').cloud).toBe(true);
    expect(m.body.models.find((x: any) => x.name === 'fake').cloud).toBe(false);
    expect(JSON.stringify(m.body)).not.toMatch(/token|bearer/i);
  });

  it('marks LM Studio models not enabled, refuses to run them, and shows each model\'s auto reply format', async () => {
    const m = await get('/api/models');
    expect(m.body.lmstudioChat).toBe(false);
    expect(m.body.models.find((x: any) => x.id === 'lmstudio/lm').off).toBe('LM Studio, not enabled');
    expect(m.body.models.find((x: any) => x.name === 'fake').auto.contract).toBe('grid-text');
    expect(m.body.contracts.map((c: any) => c.id)).toEqual(['grid-text', 'grid-json', 'parts']);
    const bad = await post('/api/runs', { mode: 'design', model: 'lmstudio/lm', role: 'starter' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not enabled/);
    expect((await post('/api/settings', { lmstudioChat: true })).body.lmstudioChat).toBe(true);
    expect((await get('/api/models')).body.lmstudioChat).toBe(true);
    expect((await post('/api/settings', { lmstudioChat: false })).body.lmstudioChat).toBe(false);
    expect((await post('/api/runs', { mode: 'design', model: 'ollama/fake', role: 'starter', contract: 'xml' })).status).toBe(400);
  });

  it('runs a staged build with a part list from the form', async () => {
    const prev = currentLlm;
    currentLlm = fakeLlm(['name: S\nparts:\nCR -1,0\nBT -1,-1\nend', 'name: S\nparts:\nPI^ -2,0\nend', 'name: S\nparts:\nBT -1,1\nIDv -1,2\nend', 'name: S\nparts:\nAA -3,0\nend'], [fakeModel('fake')]);
    try {
      const r = await post('/api/runs', { mode: 'design', model: 'ollama/fake', role: 'starter', build: 'staged', contract: 'parts', rounds: 1, mirror: true });
      expect(r.status).toBe(200);
      const ev = await stream(r.body.id);
      expect(ev[0]).toMatchObject({ type: 'start', build: 'staged', contract: 'parts', mirror: true });
      expect(ev.filter((e) => e.type === 'step' && e.status === 'accepted').map((e) => e.step)).toEqual(['power', 'weapons', 'engines', 'armour']);
      await waitIdle();
    } finally { currentLlm = prev; }
  });

  it('answers only requests addressed to localhost, and serves files only from inside its folders', async () => {
    const status = await new Promise<number>((ok, fail) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: '/api/roles', headers: { Host: 'evil.example:80' } }, (r) => { r.resume(); ok(r.statusCode!); }).on('error', fail).end();
    });
    expect(status).toBe(403);
    const cross = await fetch(base + '/api/save', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: '{}' });
    expect(cross.status).toBe(403);
    for (const p of ['/out/..%2F..%2Fpackage.json', '/out/%2e%2e/%2e%2e/package.json', '/lab/..%2Fexport-ships.ts', '/..%2F..%2Fpackage.json']) {
      expect((await fetch(base + p)).status).toBe(404);
    }
  });

  it('runs a design and streams its events, with picture URLs and part cells added', async () => {
    const r = await post('/api/runs', { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 2, temperature: 0.3 });
    expect(r.status).toBe(200);
    const ev = await stream(r.body.id);
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('token');
    expect(types.at(-1)).toBe('done');
    const check = ev.find((e) => e.type === 'check');
    expect(check.valid).toBe(true);
    expect(Object.keys(check.cells).length).toBe(wren.parts.length);
    const render = ev.find((e) => e.type === 'render');
    expect(render.url).toMatch(/^\/out\/.+\/renders\/r1\.png$/);
    const png = await fetch(base + render.url);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    const best = ev.find((e) => e.type === 'best');
    expect(best.url).toBe(render.url);
    // (A replay from an event on gives the rest)
    const after = await fetch(`${base}/api/runs/${r.body.id}/events`, { headers: { 'Last-Event-ID': String(ev.length - 2) } });
    const rest = await after.text();
    expect(rest.match(/^id: /gm)?.length).toBe(1);
    expect(rest).toMatch(new RegExp(`^id: ${ev.length - 1}$`, 'm'));
    // The gallery has it, and the run left a record
    const g = await get('/api/gallery');
    expect(g.body.gallery.find((x: any) => x.run === r.body.id)).toMatchObject({ valid: true, url: render.url, model: 'ollama/fake', role: 'starter' });
    const runs = await get('/api/runs');
    const out = runs.body.runs.find((x: any) => x.id === r.body.id);
    expect(out.status).toBe('done');
    expect(existsSync(join(out.outDir, 'events.jsonl'))).toBe(true);
    expect(readFileSync(join(out.outDir, 'events.jsonl'), 'utf8')).not.toMatch(/"type":"token"/);
    expect(existsSync(join(out.outDir, 'metrics.json'))).toBe(true);
  });

  it('starts from a library ship, with the tier and size overrides in the brief', async () => {
    const r = await post('/api/runs', { mode: 'design', model: 'fake', role: 'starter', rounds: 1, startId: 'dev/review-wren', note: 'make it faster', maxLevel: 3, cells: [20, 30] });
    expect(r.status).toBe(200);
    await stream(r.body.id);
    const req = (llm as any).requests.at(-1);
    expect(req.messages[1].content).toMatch(/Here is a design \(its left half and centre line\):[\s\S]*Change it: make it faster/);
    expect(req.messages[0].content).toMatch(/20.{0,6}30/);
  });

  it('refuses bad run forms', async () => {
    expect((await post('/api/runs', { mode: 'design', model: 'ollama/nope', role: 'starter' })).status).toBe(400);
    expect((await post('/api/runs', { mode: 'design', model: 'fake', critic: 'ollama/other', role: 'starter' })).body.error).toMatch(/images/);
    expect((await post('/api/runs', { mode: 'compare', models: ['ollama/fake'], role: 'starter' })).status).toBe(400);
    expect((await post('/api/runs', { mode: 'design', model: 'fake', role: 'nope' })).status).toBe(400);
  });

  it('runs one at a time, and Stop ends a run', async () => {
    currentLlm = hangingLlm();
    try {
      const r = await post('/api/runs', { mode: 'design', model: 'ollama/slow', role: 'starter', rounds: 3 });
      expect(r.status).toBe(200);
      expect((await post('/api/runs', { mode: 'design', model: 'ollama/slow', role: 'starter' })).status).toBe(409);
      const events = stream(r.body.id);
      await new Promise((ok) => setTimeout(ok, 50));
      expect((await post(`/api/runs/${r.body.id}/stop`, {})).body.stopping).toBe(true);
      const ev = await events;
      expect(ev.at(-1)).toMatchObject({ type: 'done', cancelled: true });
      expect(ev.some((e) => e.type === 'token')).toBe(true);
      await waitIdle();
      expect(app.runs.all.get(r.body.id)!.status).toBe('stopped');
    } finally { currentLlm = llm; }
  });

  it('compares two models side by side', async () => {
    const r = await post('/api/runs', { mode: 'compare', models: ['ollama/fake', 'ollama/other'], role: 'starter', rounds: 1, trials: 1 });
    const ev = await stream(r.body.id);
    const done = ev.at(-1);
    expect(done.metrics.kind).toBe('compare');
    expect(done.metrics.models.map((m: any) => m.model)).toEqual(['ollama/fake', 'ollama/other']);
    expect(new Set(ev.filter((e) => e.type === 'check').map((e) => e.lane))).toEqual(new Set(['ollama/fake t1', 'ollama/other t1']));
  });

  it('saves only valid designs, numbered per role', async () => {
    const a = await post('/api/save', { bp: wren, role: 'starter' });
    expect(a.body.id).toBe('dev/gen-starter-1');
    const b = await post('/api/save', { bp: wren, role: 'starter' });
    expect(b.body.id).toBe('dev/gen-starter-2');
    expect(readdirSync(join(tmp, 'dev')).sort()).toEqual(['gen-starter-1.json', 'gen-starter-2.json']);
    expect(JSON.parse(readFileSync(join(tmp, 'dev', 'gen-starter-1.json'), 'utf8')).parts.length).toBe(wren.parts.length);
    const noCore = { ...wren, parts: wren.parts.filter((p) => p.fn !== 'core') };
    const bad = await post('/api/save', { bp: noCore, role: 'starter' });
    expect(bad.status).toBe(422);
    expect((await post('/api/save', { bp: { nope: 1 } })).status).toBe(400);
  });

  it('opens a saved design in the Energy Lab', async () => {
    const r = await post('/api/lab', { bp: wren, saved: 'dev/review-wren' });
    expect(r.body.url).toBe('/lab/index.html#ship=Review%3A%20Wren');
    expect(labCalls.length).toBe(1);
    expect((await fetch(base + '/lab/index.html')).status).toBe(200);
    const fresh = await post('/api/lab', { bp: wren, role: 'gunship' });
    expect(fresh.body.saved.id).toBe('dev/gen-gunship-1');
  });

  it('renders a timelapse: core first, armour last, growing a part at a time', async () => {
    const frames = buildUp(ctx, wren);
    expect(frames[0].stage).toBe('core');
    expect(frames[0].bp.parts.map((p) => p.fn)).toEqual(['core']);
    expect(frames.at(-1)!.bp.parts.length).toBe(wren.parts.length);
    const order = ['core', 'frame', 'power', 'weapons', 'engines', 'tools', 'armour'];
    const idx = frames.map((f) => order.indexOf(f.stage));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
    expect(buildUp(ctx, ship('dev/review-monarch'), 40).length).toBeLessThanOrEqual(46);

    const before = renderer.calls;
    const r = await post('/api/timelapse', { bp: wren });
    expect(r.body.frames.length).toBe(frames.length);
    expect(renderer.calls - before).toBe(frames.length);
    expect((await fetch(base + r.body.frames[0].url)).status).toBe(200);
    const still = await post('/api/render', { bp: wren });
    expect(still.body.url).toMatch(/^\/out\/stills\//);
  });
});
