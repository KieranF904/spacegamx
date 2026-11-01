// Fixes from the 2026-11-01 audit, on the page server: one run at a time even when posted at once, the origin and
// content-type guards, what /out/ serves, timelapse and renders beside a run, the watch stream of a run that stopped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Server, createServer, request } from 'http';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { blueprintToGrid, loadContext } from '../core/index';
import { ship } from '../core/testShips';
import type { Llm, Renderer } from '../loop/index';
import { fakeLlm, fakeModel } from '../loop/fakeLlm';
import { type App, createApp } from './app';
import { defaultPaths } from './paths';
import { Runs } from './runs';
import { watchStream } from './watch';

const ctx = loadContext();
const wren = ship('dev/review-wren');
const GOOD = blueprintToGrid(ctx, wren).text;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let tmp: string, server: Server, base: string, app: App, port: number;
let renderDelay = 0;
const renderer: Renderer = {
  async render(_bp, outPath) { if (renderDelay) await new Promise((r) => setTimeout(r, renderDelay)); mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, PNG); return { path: outPath, ms: 1, png: PNG }; },
  async close() {},
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'shipgen-audit-'));
  const paths = { ...defaultPaths(ctx.dataDir), out: join(tmp, 'out'), dev: join(tmp, 'dev'), lab: join(tmp, 'lab') };
  // (A slow listing: the window in which a second POST used to slip past the one-run check)
  const inner = fakeLlm([GOOD], [fakeModel('fake')]);
  const llm: Llm = { list: async () => { await new Promise((r) => setTimeout(r, 120)); return inner.list(); }, chat: (r) => inner.chat(r) };
  app = createApp({ ctx, llm, paths, getRenderer: async () => renderer });
  server = createServer(app.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  mkdirSync(join(paths.out, 'x'), { recursive: true });
  writeFileSync(join(paths.out, 'x', 'ok.png'), PNG);
  writeFileSync(join(paths.out, 'x', 'notes.txt'), 'private');
  writeFileSync(join(paths.out, '.env'), 'SECRET=1');
  writeFileSync(join(paths.out, 'x', '.hidden.json'), '{}');
});

afterAll(async () => {
  await app.close();
  await new Promise((ok) => server.close(ok));
  rmSync(tmp, { recursive: true, force: true });
});

const post = async (p: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
async function idle() { for (let i = 0; i < 300 && app.runs.active(); i++) await new Promise((r) => setTimeout(r, 10)); }

describe('one run at a time', () => {
  it('two POSTs at once: one starts, the other is refused, and the output folders differ', async () => {
    const form = { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 1 };
    const [a, b] = await Promise.all([post('/api/runs', form), post('/api/runs', form)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    await idle();
    const c = await post('/api/runs', form);
    expect(c.status).toBe(200);
    const ok = a.status === 200 ? a : b;
    expect(c.body.outDir).not.toBe(ok.body.outDir);
    await idle();
  });
  it('a timelapse or a still is refused while a run is going', async () => {
    const r = await post('/api/runs', { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 1 });
    expect(r.status).toBe(200);
    expect((await post('/api/timelapse', { bp: wren })).status).toBe(409);
    expect((await post('/api/render', { bp: wren })).status).toBe(409);
    await idle();
    expect((await post('/api/render', { bp: wren })).status).toBe(200);
  });
  it('a timelapse stops when the page goes away', async () => {
    renderDelay = 40;
    try {
      const ac = new AbortController();
      const p = fetch(base + '/api/timelapse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bp: wren, maxFrames: 80 }), signal: ac.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 150));
      ac.abort();
      await p;
      await new Promise((r) => setTimeout(r, 200));
      // (the slot is free again: a run can start)
      expect((await post('/api/runs', { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 1 })).status).toBe(200);
      await idle();
    } finally { renderDelay = 0; }
  });
});

describe('request guards', () => {
  const raw = (headers: Record<string, string>, p = '/api/settings', body = '{}') => new Promise<number>((ok) => {
    const req = request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => { res.resume(); ok(res.statusCode ?? 0); });
    req.end(body);
  });
  it('accepts this server\'s own origin only, and JSON only', async () => {
    const json = { 'Content-Type': 'application/json' };
    expect(await raw({ ...json, Origin: `http://127.0.0.1:${port}` })).toBe(200);
    expect(await raw({ ...json })).toBe(200);
    expect(await raw({ ...json, Origin: 'http://localhost:3000' })).toBe(403);
    expect(await raw({ ...json, Origin: `http://localhost:${port}` })).toBe(403);
    expect(await raw({ 'Content-Type': 'text/plain' })).toBe(415);
    expect(await raw({})).toBe(415);
  });
  it('serves only pictures and records from /out/, never a dotfile', async () => {
    expect((await fetch(`${base}/out/x/ok.png`)).status).toBe(200);
    expect((await fetch(`${base}/out/x/notes.txt`)).status).toBe(404);
    expect((await fetch(`${base}/out/.env`)).status).toBe(404);
    expect((await fetch(`${base}/out/x/.hidden.json`)).status).toBe(404);
  });
});

describe('finished runs and events kept', () => {
  it('keeps only the last few finished runs in memory', async () => {
    const runs = new Runs(ctx, tmp, async () => ({ mode: 'design', outcome: {} as never }));
    const ac = () => new AbortController();
    for (let i = 0; i < Runs.KEEP_FINISHED + 5; i++) {
      const r = runs.start({ ctx, llm: fakeLlm(['x']) }, { mode: 'design', model: 'm', brief: {} } as never, { id: `r${i}`, ac: ac(), outDir: tmp });
      await r.done;
    }
    expect(runs.all.size).toBe(Runs.KEEP_FINISHED);
    expect(runs.all.has('r0')).toBe(false);
    expect(runs.all.has(`r${Runs.KEEP_FINISHED + 4}`)).toBe(true);
  });
  it('does not store token events, and numbers the ones it stores', async () => {
    const runs = new Runs(ctx, tmp, async (_d, _o, emit) => {
      emit({ type: 'prompt', round: 1, user: 'u', messages: 1, chars: 1, t: 0 });
      emit({ type: 'token', round: 1, kind: 'content', text: 'a', t: 0 });
      emit({ type: 'grid', round: 1, partial: true, text: 'name: x', parts: 0, errors: [], warnings: [], t: 0 });
      emit({ type: 'reply', round: 1, text: 'x', ms: 1, structured: false, t: 0 });
      return { mode: 'design', outcome: {} as never };
    });
    const live: string[] = [];
    const r = runs.start({ ctx, llm: fakeLlm(['x']) }, { mode: 'design', model: 'm', brief: {} } as never, { id: 'q', ac: new AbortController(), outDir: tmp });
    r.listeners.add((e) => { if (e) live.push(e.type); });
    await r.done;
    expect(r.events.map((e) => e.type)).toEqual(['prompt', 'grid', 'reply']);
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    // (The streaming preview is emptied once the reply is in)
    expect((r.events[1] as { text: string | null }).text).toBeNull();
  });
});

describe('watching a run that never finished', () => {
  it('lists it as stale, and ends the stream with a note', async () => {
    const out = join(tmp, 'watch');
    mkdirSync(join(out, 'dead'), { recursive: true });
    const f = join(out, 'dead', 'events.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'start', mode: 'design', model: 'm', t: 0 }) + '\n');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(f, old, old);
    const { listWatchRuns } = await import('./watch');
    expect(listWatchRuns(out)[0]).toMatchObject({ id: 'dead', finished: false, stale: true });
    const body = await new Promise<string>((ok) => {
      const s = createServer((req, res) => watchStream(req, res, new Runs(ctx, out, async () => ({ mode: 'design', outcome: {} as never })), out, new URL(req.url!, 'http://x'), 20, 60));
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        request({ host: '127.0.0.1', port: p, path: '/?run=dead' }, (res) => {
          let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { s.close(); ok(t); });
        }).end();
      });
    });
    expect(body).toMatch(/never finished/);
    expect(body).toMatch(/event: end/);
  });
});

describe('secrets', () => {
  it('the models list from the real client never carries a token or key', async () => {
    const { createLlm } = await import('../loop/index');
    const f = (async (u: any) => {
      const s = String(u);
      if (s.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'gemma', capabilities: ['completion'] }] }));
      if (s.includes('/api/v1/models')) return new Response(JSON.stringify({ models: [{ type: 'llm', key: 'qwen' }] }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const llm = createLlm({ fetch: f, token: () => 'tok-SECRET-123', anthropicKey: () => 'key-SECRET-456' });
    const paths = { ...defaultPaths(ctx.dataDir), out: join(tmp, 'out2') };
    const a = createApp({ ctx, llm, paths, getRenderer: async () => renderer });
    const s = createServer(a.handle);
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/api/models?fresh`);
      const t = await r.text();
      expect(t).toContain('claude-haiku-5-5');
      expect(t).not.toMatch(/SECRET|token|bearer/i);
    } finally { await a.close(); await new Promise((ok) => s.close(ok)); }
  });
});
