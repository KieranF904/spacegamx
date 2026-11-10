// The engine's calls and messages, on a fake model and a fake renderer (no network, no GPU): everything else is real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { blueprintToGrid, loadContext } from '../core/index';
import { ship } from '../core/testShips';
import { pruneFrame } from '../loop/staged';
import { AbortedError, type Llm, type Renderer } from '../loop/index';
import { fakeLlm, fakeModel } from '../loop/fakeLlm';
import { type Engine, type EngineMessage, createEngine } from './engine';
import { defaultPaths } from './paths';
import { buildUp } from './timelapse';

const ctx = loadContext();
const wren = ship('samples/review-wren');
const GOOD = blueprintToGrid(ctx, wren).text;
// (The Wren less its wing tips: a batch keeps only a ship that isn't a copy of the role's worked example)
const TRIM = blueprintToGrid(ctx, pruneFrame(ctx, wren).bp).text;
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
    setTimeout(() => req.onToken?.('name: X\ngrid:\n', 'content'), 30);
    return new Promise((_ok, fail) => {
      if (req.signal?.aborted) fail(new AbortedError());
      req.signal?.addEventListener('abort', () => fail(new AbortedError()));
    });
  },
});

let tmp: string, engine: Engine, llm: Llm & { requests?: unknown[] };
const renderer = fakeRenderer();
const labCalls: string[] = [];
let currentLlm: Llm;
const sent: EngineMessage[] = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shipgen-engine-'));
  const paths = { ...defaultPaths(ctx.dataDir), out: join(tmp, 'out'), dev: join(tmp, 'dev'), lab: join(tmp, 'lab') };
  mkdirSync(paths.lab, { recursive: true });
  llm = fakeLlm([GOOD], [fakeModel('fake'), fakeModel('other'), fakeModel('eyes', { vision: true }), fakeModel('big:cloud', { cloud: true }), { ...fakeModel('lm'), id: 'lmstudio/lm', provider: 'lmstudio', off: 'LM Studio, not enabled' }]);
  currentLlm = llm;
  // (The llm can be swapped per test through this proxy)
  const proxy: Llm = { list: () => currentLlm.list(), chat: (r) => currentLlm.chat(r) };
  engine = createEngine({ ctx, llm: proxy, paths, getRenderer: async () => renderer, exportLab: async (exporter: string) => { labCalls.push(exporter); return '99 ships written'; }, send: (m) => sent.push(m), watchIntervalMs: 20 });
});

afterAll(async () => {
  await engine.close();
  rmSync(tmp, { recursive: true, force: true });
});

const call = (cmd: string, args?: Record<string, any>) => engine.call(cmd, args) as Promise<any>;
const fails = (cmd: string, args?: Record<string, any>) => engine.call(cmd, args).then(() => ({ status: 200, error: '' }), (e) => ({ status: e.status ?? 500, error: e.message as string }));

/** A run's messages, from the first, until its end */
async function stream(id: string): Promise<any[]> {
  for (let i = 0; i < 500 && !sent.some((m) => m.type === 'end' && m.channel === 'run' && m.id === id); i++) await new Promise((r) => setTimeout(r, 10));
  expect(sent.some((m) => m.type === 'end' && m.id === id)).toBe(true);
  return sent.filter((m): m is Extract<EngineMessage, { type: 'event' }> => m.type === 'event' && m.channel === 'run' && m.id === id).map((m) => m.e);
}

async function waitIdle() {
  for (let i = 0; i < 200 && engine.runs.active(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe('shipgen engine', () => {
  it('gives the game-derived lists, and opens a library ship with its check', async () => {
    const info = await call('info');
    expect(info.roles.map((r: any) => r.id)).toContain('starter');
    const byCode = new Map(info.legend.map((r: any) => [r.code, r]));
    expect((byCode.get('CA') as any).cat).toBe('core');
    expect((byCode.get('PI') as any).cat).toBe('weapon');
    expect((byCode.get('ID') as any).cat).toBe('thruster');
    expect((byCode.get('BT') as any).cat).toBe('store');
    expect(info.library.find((s: any) => s.id === 'samples/review-wren')).toMatchObject({ group: 'Samples' });
    expect(info.library.some((s: any) => s.group === 'Enemy ships')).toBe(true);
    expect(info.contracts.map((c: any) => c.id)).toEqual(['grid-text', 'grid-json', 'parts']);

    const one = await call('library', { id: 'samples/review-wren', role: 'starter' });
    expect(one.check.valid).toBe(true);
    expect(one.grid).toMatch(/^name: Review: Wren/);
    expect(Object.keys(one.cells).length).toBe(wren.parts.length);
    expect((await fails('library', { id: '../../package' })).status).toBe(400);
    expect((await fails('library', { id: 'dev/nope' })).status).toBe(404);
  });

  it('lists models with cloud ones labelled and LM Studio ones off until allowed; refuses to run them', async () => {
    const m = await call('models');
    expect(m.models.find((x: any) => x.name === 'big:cloud').cloud).toBe(true);
    expect(m.models.find((x: any) => x.name === 'fake').cloud).toBe(false);
    expect(m.lmstudioChat).toBe(false);
    expect(m.models.find((x: any) => x.id === 'lmstudio/lm').off).toBe('LM Studio, not enabled');
    expect(m.models.find((x: any) => x.name === 'fake').auto.contract).toBe('grid-text');
    const bad = await fails('start', { form: { mode: 'design', model: 'lmstudio/lm', role: 'starter' } });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/not enabled/);
    expect((await call('settings', { lmstudioChat: true })).lmstudioChat).toBe(true);
    expect((await call('models')).lmstudioChat).toBe(true);
    expect((await call('settings', { lmstudioChat: false })).lmstudioChat).toBe(false);
    expect((await fails('start', { form: { mode: 'design', model: 'ollama/fake', role: 'starter', contract: 'xml' } })).status).toBe(400);
  });

  it('runs a design and sends its events, with picture files and part cells added, and keeps a record', async () => {
    const r = await call('start', { form: { mode: 'design', model: 'ollama/fake', role: 'starter', rounds: 2, temperature: 0.3 } });
    const ev = await stream(r.id);
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe('start');
    expect(types).toContain('token');
    expect(types.at(-1)).toBe('done');
    const check = ev.find((e) => e.type === 'check');
    expect(check.valid).toBe(true);
    expect(Object.keys(check.cells).length).toBe(wren.parts.length);
    const render = ev.find((e) => e.type === 'render');
    expect(render.file).toMatch(/[\\/]renders[\\/]r1\.png$/);
    expect(readFileSync(render.file).equals(PNG)).toBe(true);
    expect(ev.find((e) => e.type === 'best').file).toBe(render.file);
    // (A view opened late replays the stored events: no tokens, numbered in order)
    const rep = await call('replay', { id: r.id });
    expect(rep.status).toBe('done');
    expect(rep.events.some((e: any) => e.type === 'token')).toBe(false);
    expect(rep.events.map((e: any) => e.seq)).toEqual(rep.events.map((_: unknown, i: number) => i));
    // The gallery has it, and the run left a record
    const g = await call('gallery');
    expect(g.gallery.find((x: any) => x.run === r.id)).toMatchObject({ valid: true, file: render.file, model: 'ollama/fake', role: 'starter' });
    const out = (await call('runs')).runs.find((x: any) => x.id === r.id);
    expect(out.status).toBe('done');
    expect(readFileSync(join(out.outDir, 'events.jsonl'), 'utf8')).not.toMatch(/"type":"token"/);
    expect(existsSync(join(out.outDir, 'metrics.json'))).toBe(true);
    // ...which the watch list shows, and a watch replays to its end
    const id = (await call('watchList')).runs.find((x: any) => out.outDir.replace(/\\/g, '/').endsWith(x.id)).id;
    await call('watch', { id });
    for (let i = 0; i < 200 && !sent.some((m) => m.type === 'end' && m.channel === 'watch' && m.id === id); i++) await new Promise((res) => setTimeout(res, 10));
    const watched = sent.filter((m) => m.type === 'event' && m.channel === 'watch' && m.id === id).map((m) => (m as any).e.type);
    expect(watched[0]).toBe('start');
    expect(watched.at(-1)).toBe('done');
  });

  it('runs a staged build with a part list from the form', async () => {
    const prev = currentLlm;
    currentLlm = fakeLlm(['name: S\nparts:\nCR -1,0\nBT -1,-1\nend', 'name: S\nparts:\nPI^ -2,0\nend', 'name: S\nparts:\nBT -1,1\nIDv -1,2\nend', 'name: S\nparts:\nAA -3,0\nend'], [fakeModel('fake')]);
    try {
      const r = await call('start', { form: { mode: 'design', model: 'ollama/fake', role: 'starter', build: 'staged', contract: 'parts', rounds: 1, mirror: true, concept: false } });
      const ev = await stream(r.id);
      expect(ev[0]).toMatchObject({ type: 'start', build: 'staged', contract: 'parts', mirror: true });
      expect(ev.filter((e) => e.type === 'step' && e.status === 'accepted').map((e) => e.step)).toEqual(['power', 'weapons', 'engines', 'armour']);
      await waitIdle();
    } finally { currentLlm = prev; }
  });

  it('starts from a library ship, with the tier and size overrides in the brief', async () => {
    const r = await call('start', { form: { mode: 'design', model: 'fake', role: 'starter', rounds: 1, startId: 'samples/review-wren', note: 'make it faster', maxLevel: 3, cells: [20, 30] } });
    await stream(r.id);
    const req = (llm as any).requests.at(-1);
    expect(req.messages[1].content).toMatch(/Here is a design \(its left half and centre line\):[\s\S]*Change it: make it faster/);
    expect(req.messages[0].content).toMatch(/20.{0,6}30/);
  });

  it('refuses bad run forms', async () => {
    expect((await fails('start', { form: { mode: 'design', model: 'ollama/nope', role: 'starter' } })).status).toBe(400);
    expect((await fails('start', { form: { mode: 'design', model: 'fake', critic: 'ollama/other', role: 'starter' } })).error).toMatch(/images/);
    expect((await fails('start', { form: { mode: 'compare', models: ['ollama/fake'], role: 'starter' } })).status).toBe(400);
    expect((await fails('start', { form: { mode: 'design', model: 'fake', role: 'nope' } })).status).toBe(400);
    expect((await fails('start', { form: { mode: 'batch', model: 'ollama/fake', roles: [] } })).status).toBe(400);
  });

  it('makes ships in a batch: each ship in its own lane, batch events between, the ship in the saved list, a rating kept beside it', async () => {
    currentLlm = fakeLlm([TRIM], [fakeModel('fake')]);
    const r = await call('start', { form: { mode: 'batch', model: 'ollama/fake', roles: ['starter'], maxShips: 1, generations: 0, rounds: 2, note: 'tidy' } });
    const ev = await stream(r.id).finally(() => { currentLlm = llm; });
    const batch = ev.filter((e) => e.type === 'batch');
    expect(batch.map((e) => e.phase)).toEqual(['design', 'saved', 'stopped']);
    expect(batch[1]).toMatchObject({ attempt: 1, role: 'starter', saved: 1, attempts: 1, ship: { name: expect.any(String) } });
    expect(batch[1].file).toMatch(/[\\/]starter[\\/]001-.+[\\/]render\.png$/);
    expect(batch[2].reason).toBe('1 ships');
    expect(ev.find((e) => e.type === 'start')).toMatchObject({ mode: 'design', role: 'starter', lane: '#1 starter' });
    expect(ev.filter((e) => e.type === 'done').length).toBe(1);
    expect((await call('runs')).runs.find((x: any) => x.id === r.id)).toMatchObject({ mode: 'batch', status: 'done' });
    // The saved list has it, under the engine's own batch folder, and a rating is written beside it
    const mine = (await call('ships')).ships.find((s: any) => s.run.includes(`-${r.id}-app`));
    expect(mine).toMatchObject({ role: 'starter', model: 'ollama/fake' });
    expect(existsSync(mine.png)).toBe(true);
    expect(await call('rate', { dir: mine.dir, rating: 4 })).toEqual({ dir: mine.dir, rating: 4 });
    expect((await call('ships')).ships.find((s: any) => s.dir === mine.dir).rating).toBe(4);
    expect(await call('rate', { dir: mine.dir, rating: 0 })).toEqual({ dir: mine.dir });
    expect((await fails('rate', { dir: '../../etc', rating: 3 })).status).toBe(400);
  });

  it('Stop ends a batch', async () => {
    currentLlm = hangingLlm();
    try {
      const r = await call('start', { form: { mode: 'batch', model: 'ollama/slow', roles: ['starter'], concept: false } });
      await new Promise((ok) => setTimeout(ok, 50));
      expect((await call('stop', { id: r.id })).stopping).toBe(true);
      const ev = await stream(r.id);
      expect(ev.at(-1)).toMatchObject({ type: 'batch', phase: 'stopped', reason: 'interrupted' });
      await waitIdle();
      expect(engine.runs.all.get(r.id)!.status).toBe('stopped');
    } finally { currentLlm = llm; }
  });

  it('runs one at a time, and Stop ends a run', async () => {
    currentLlm = hangingLlm();
    try {
      const r = await call('start', { form: { mode: 'design', model: 'ollama/slow', role: 'starter', rounds: 3, concept: false } });
      expect((await fails('start', { form: { mode: 'design', model: 'ollama/slow', role: 'starter' } })).status).toBe(409);
      await new Promise((ok) => setTimeout(ok, 50));
      expect((await call('stop', { id: r.id })).stopping).toBe(true);
      const ev = await stream(r.id);
      expect(ev.at(-1)).toMatchObject({ type: 'done', cancelled: true });
      expect(ev.some((e) => e.type === 'token')).toBe(true);
      await waitIdle();
      expect(engine.runs.all.get(r.id)!.status).toBe('stopped');
    } finally { currentLlm = llm; }
  });

  it('compares two models side by side', async () => {
    const r = await call('start', { form: { mode: 'compare', models: ['ollama/fake', 'ollama/other'], role: 'starter', rounds: 1, trials: 1 } });
    const ev = await stream(r.id);
    const done = ev.at(-1);
    expect(done.metrics.kind).toBe('compare');
    expect(done.metrics.models.map((m: any) => m.model)).toEqual(['ollama/fake', 'ollama/other']);
    expect(new Set(ev.filter((e) => e.type === 'check').map((e) => e.lane))).toEqual(new Set(['ollama/fake t1', 'ollama/other t1']));
  });

  it('saves only valid designs, numbered per role', async () => {
    expect((await call('save', { bp: wren, role: 'starter' })).id).toBe('dev/gen-starter-1');
    expect((await call('save', { bp: wren, role: 'starter' })).id).toBe('dev/gen-starter-2');
    expect(readdirSync(join(tmp, 'dev')).sort()).toEqual(['gen-starter-1.json', 'gen-starter-2.json']);
    expect(JSON.parse(readFileSync(join(tmp, 'dev', 'gen-starter-1.json'), 'utf8')).parts.length).toBe(wren.parts.length);
    const noCore = { ...wren, parts: wren.parts.filter((p) => p.fn !== 'core') };
    expect((await fails('save', { bp: noCore, role: 'starter' })).status).toBe(422);
    expect((await fails('save', { bp: { nope: 1 } })).status).toBe(400);
  });

  it('opens a saved design in the Energy Lab (a page on disk)', async () => {
    const r = await call('lab', { bp: wren, saved: 'samples/review-wren' });
    expect(r.url).toMatch(/^file:\/\/\/.+\/index\.html#ship=Review%3A%20Wren$/);
    expect(labCalls.length).toBe(1);
    expect((await call('lab', { bp: wren, role: 'gunship' })).saved.id).toBe('dev/gen-gunship-1');
  });

  it('renders a still and a timelapse: core first, armour last, growing a part at a time', async () => {
    const frames = buildUp(ctx, wren);
    expect(frames[0].stage).toBe('core');
    expect(frames[0].bp.parts.map((p) => p.fn)).toEqual(['core']);
    expect(frames.at(-1)!.bp.parts.length).toBe(wren.parts.length);
    const order = ['core', 'frame', 'power', 'weapons', 'engines', 'tools', 'armour'];
    const idx = frames.map((f) => order.indexOf(f.stage));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
    expect(buildUp(ctx, ship('samples/review-monarch'), 40).length).toBeLessThanOrEqual(46);

    const before = renderer.calls;
    const r = await call('timelapse', { bp: wren });
    expect(r.frames.length).toBe(frames.length);
    expect(renderer.calls - before).toBe(frames.length);
    expect(existsSync(r.frames[0].file)).toBe(true);
    const still = await call('render', { bp: wren });
    expect(still.file).toMatch(/[\\/]stills[\\/]/);
  });
});
