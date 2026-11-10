// Fixes from the 2026-11-01 audit, on the engine: one run at a time even when started at once, timelapse and renders
// beside a run, what is kept of finished runs, the watch of a run that stopped (or finished before anyone looked), secrets.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { blueprintToGrid, loadContext } from '../core/index';
import { ship } from '../core/testShips';
import type { Llm, Renderer } from '../loop/index';
import { fakeLlm, fakeModel } from '../loop/fakeLlm';
import { type Engine, type EngineMessage, createEngine } from './engine';
import { defaultPaths } from './paths';
import { Runs } from './runs';
import { listWatchRuns, watchRun } from './watch';

const ctx = loadContext();
const wren = ship('samples/review-wren');
const GOOD = blueprintToGrid(ctx, wren).text;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let tmp: string, engine: Engine;
const renderer: Renderer = {
  async render(_bp, outPath) { mkdirSync(dirname(outPath), { recursive: true }); writeFileSync(outPath, PNG); return { path: outPath, ms: 1, png: PNG }; },
  async close() {},
};
const status = (p: Promise<unknown>) => p.then(() => 200, (e) => e.status ?? 500);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shipgen-audit-'));
  const paths = { ...defaultPaths(ctx.dataDir), out: join(tmp, 'out'), dev: join(tmp, 'dev'), lab: join(tmp, 'lab') };
  // (A slow listing: the window in which a second start used to slip past the one-run check)
  const inner = fakeLlm([GOOD], [fakeModel('fake')]);
  const llm: Llm = { list: async () => { await new Promise((r) => setTimeout(r, 120)); return inner.list(); }, chat: (r) => inner.chat(r) };
  engine = createEngine({ ctx, llm, paths, getRenderer: async () => renderer, send: () => {} });
});

afterAll(async () => {
  await engine.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function idle() { for (let i = 0; i < 300 && engine.runs.active(); i++) await new Promise((r) => setTimeout(r, 10)); }

describe('one run at a time', () => {
  it('two starts at once: one starts, the other is refused, and the output folders differ', async () => {
    const form = { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 1 };
    const [a, b] = await Promise.allSettled([engine.call('start', { form }), engine.call('start', { form })]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(((a.status === 'rejected' ? a : b) as PromiseRejectedResult).reason.status).toBe(409);
    await idle();
    const c = await engine.call('start', { form }) as { outDir: string };
    const ok = ((a.status === 'fulfilled' ? a : b) as PromiseFulfilledResult<{ outDir: string }>).value;
    expect(c.outDir).not.toBe(ok.outDir);
    await idle();
  });
  it('a timelapse or a still is refused while a run is going', async () => {
    await engine.call('start', { form: { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 1 } });
    expect(await status(engine.call('timelapse', { bp: wren }))).toBe(409);
    expect(await status(engine.call('render', { bp: wren }))).toBe(409);
    await idle();
    expect(await status(engine.call('render', { bp: wren }))).toBe(200);
  });
  it('refuses a command it does not know', async () => {
    expect(await status(engine.call('nope'))).toBe(404);
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
  it('does not store token events, numbers the ones it stores, and keeps only the latest progress', async () => {
    const runs = new Runs(ctx, tmp, async (_d, _o, emit) => {
      emit({ type: 'prompt', round: 1, user: 'u', messages: 1, chars: 1, t: 0 });
      emit({ type: 'token', round: 1, kind: 'content', text: 'a', t: 0 });
      emit({ type: 'progress', round: 1, thinking: 10, content: 0, t: 0 });
      emit({ type: 'progress', round: 1, thinking: 20, content: 0, t: 0 });
      emit({ type: 'grid', round: 1, partial: true, text: 'name: x', parts: 0, errors: [], warnings: [], t: 0 });
      emit({ type: 'reply', round: 1, text: 'x', ms: 1, structured: false, t: 0 });
      return { mode: 'design', outcome: {} as never };
    });
    const r = runs.start({ ctx, llm: fakeLlm(['x']) }, { mode: 'design', model: 'm', brief: {} } as never, { id: 'q', ac: new AbortController(), outDir: tmp });
    await r.done;
    expect(r.events.map((e) => e.type)).toEqual(['prompt', 'progress', 'grid', 'reply']);
    expect(r.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect((r.events[1] as { thinking: number }).thinking).toBe(20);
    // (The streaming preview is emptied once the reply is in)
    expect((r.events[2] as { text: string | null }).text).toBeNull();
  });
});

describe('watching a run', () => {
  const follow = (runs: Runs, out: string, id: string, staleMs: number) => new Promise<unknown[]>((ok) => {
    const got: unknown[] = [];
    watchRun(runs, out, id, (e) => got.push(e), () => ok(got), 20, staleMs);
  });
  it('lists one that never finished as stale, and ends its watch with a note', async () => {
    const out = join(tmp, 'watch');
    mkdirSync(join(out, 'dead'), { recursive: true });
    const f = join(out, 'dead', 'events.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'start', mode: 'design', model: 'm', t: 0 }) + '\n');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(f, old, old);
    expect(listWatchRuns(out)[0]).toMatchObject({ id: 'dead', finished: false, stale: true });
    const got = await follow(new Runs(ctx, out, async () => ({ mode: 'design', outcome: {} as never })), out, 'dead', 60);
    expect(JSON.stringify(got)).toMatch(/never finished/);
  });
  it('ends at once for a run that finished before anyone watched', async () => {
    const out = join(tmp, 'watch');
    mkdirSync(join(out, 'over'), { recursive: true });
    writeFileSync(join(out, 'over', 'events.jsonl'), [{ type: 'start', mode: 'design', model: 'm', t: 0 }, { type: 'done', cancelled: false, metrics: {}, t: 1 }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const t0 = Date.now();
    const got = await follow(new Runs(ctx, out, async () => ({ mode: 'design', outcome: {} as never })), out, 'over', 600000);
    expect(got.map((e) => (e as { type: string }).type)).toEqual(['start', 'done']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('refuses an id outside the output folder', () => {
    expect(() => watchRun(new Runs(ctx, tmp, async () => ({ mode: 'design', outcome: {} as never })), tmp, '../../etc', () => {}, () => {})).toThrow(/no run/);
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
    const sent: EngineMessage[] = [];
    const e = createEngine({ ctx, llm, paths: { ...defaultPaths(ctx.dataDir), out: join(tmp, 'out2') }, getRenderer: async () => renderer, send: (m) => sent.push(m) });
    try {
      const t = JSON.stringify(await e.call('models', { fresh: true }));
      expect(t).toContain('claude-haiku-5-5');
      expect(t).not.toMatch(/SECRET|token|bearer/i);
    } finally { await e.close(); }
  });
});
