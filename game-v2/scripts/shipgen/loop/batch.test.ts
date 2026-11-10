// Batch (overnight) mode on a scripted model and a fake renderer: role rotation, saving only valid on-brief ships, the stop
// file and the ship limit, carrying on after errors, the gallery and summary, renderer restarts, a full disk.
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';
import { parseBlueprint } from '../../../common/src/ships/index';
import { blueprintToGrid, loadContext } from '../core/index';
import { ship } from '../core/testShips';
import { type BatchDeps, type BatchOptions, buildFor, galleryHtml, runBatch } from './batch';
import { fakeLlm } from './fakeLlm';
import type { Renderer } from './render';
import { listSavedShips } from '../engine/ships';
import { listWatchRuns } from '../engine/watch';

const real = loadContext();
const GOOD = blueprintToGrid(real, ship('samples/review-wren')).text;
const CONCEPTS = ['long needle nose', 'stubby brick', 'swept flying wing', 'arrowhead', 'twin booms'];

// A data folder whose roles have no worked example (the Wren is the starter's example, and a copy of it is flagged) and a
// role nothing can satisfy
const roles = JSON.parse(readFileSync(join(real.dataDir, 'shipgen/roles.json'), 'utf8')).roles;
const starter = roles.find((r: { id: string }) => r.id === 'starter');
const mk = (id: string, extra: object = {}) => ({ ...starter, id, name: id, example: undefined, ...extra });
const tmpDirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'shipgen-batch-')); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of readdirSync(tmpdir()).filter((x) => x.startsWith('shipgen-data-'))) rmSync(join(tmpdir(), d), { recursive: true, force: true }); });
afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ctxWith(list: object[]) {
  // (data/ and docs/areas/energy.md side by side, as the generator expects)
  const base = mkdtempSync(join(tmpdir(), 'shipgen-data-')), dataDir = join(base, 'data');
  mkdirSync(join(dataDir, 'shipgen'), { recursive: true });
  mkdirSync(join(base, 'docs/areas'), { recursive: true });
  writeFileSync(join(base, 'docs/areas/energy.md'), readFileSync(join(real.dataDir, '../docs/areas/energy.md')));
  writeFileSync(join(dataDir, 'shipgen/roles.json'), JSON.stringify({ roles: list }));
  return { ...real, dataDir };
}
const CTX = ctxWith([mk('alpha'), mk('beta'), mk('strict', { require: [{ role: 'weapon', min: 99 }] })]);

const conceptText = (k: number) => ['concept:', `name: Ship${k}`, 'size: small', `silhouette: ${CONCEPTS[k % CONCEPTS.length]}`, 'layout: core in the middle, guns paired at the nose, engines paired aft', 'character: Sharp.', 'cells: 24', 'end'].join('\n');

/** A model that writes a concept when asked for one and the Wren otherwise */
function model(extra: (n: number, concepts: number) => Error | undefined = () => undefined) {
  let concepts = 0;
  return fakeLlm((req, n) => {
    const err = extra(n, concepts);
    if (err) return err;
    if (/art director/.test(req.messages[0].content)) return conceptText(concepts++);
    return GOOD;
  });
}

const fakeRenderer = (fail?: () => Error | undefined): Renderer & { closed: boolean; renders: number } => ({
  closed: false, renders: 0,
  async render(_bp, path) {
    const e = fail?.();
    if (e) throw e;
    this.renders++;
    writeFileSync(path, 'png');
    return { path, ms: 1, png: Buffer.from('png') };
  },
  async close() { this.closed = true; },
});

const run = (o: Partial<BatchOptions>, d: Partial<BatchDeps> = {}) => {
  const out = o.outDir ?? tmp();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const llm = (d.llm as ReturnType<typeof model>) ?? model();
  return runBatch({
    ctx: CTX, llm, models: llm.models, log: (l) => { logs.push(l); if (process.env.DBG) console.log(l); }, sleep: async (ms) => { sleeps.push(ms); }, notify: async () => {},
    ...d,
  }, { model: 'fake', outDir: out, build: 'oneshot', generations: 1, population: 1, keep: 1, patience: 1, ...o })
    .then((summary) => ({ summary, out, logs, sleeps }));
};
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('shipgen batch mode', () => {
  it('rotates through the roles and saves each valid on-brief ship with its files and a gallery', async () => {
    const renderer = fakeRenderer();
    const { summary, out } = await run({ roles: ['alpha', 'beta'], maxShips: 4 }, { makeRenderer: async () => renderer });
    expect(summary).toMatchObject({ saved: 4, attempts: 4, rejected: 0, status: 'stopped', stopReason: '4 ships' });
    expect(summary.perRole).toEqual({ alpha: { attempts: 2, saved: 2 }, beta: { attempts: 2, saved: 2 } });
    expect(readdirSync(join(out, 'alpha')).map((d) => d.slice(0, 3))).toEqual(['001', '002']);
    expect(readdirSync(join(out, 'beta')).length).toBe(2);
    const dir = join(out, 'alpha', readdirSync(join(out, 'alpha'))[0]);
    // The blueprint parses with the game's parser; the render is there; concept, metrics and check summary too
    expect(parseBlueprint(readFileSync(join(dir, 'blueprint.json'), 'utf8')).parts.length).toBeGreaterThan(5);
    expect(existsSync(join(dir, 'render.png'))).toBe(true);
    expect(read(join(dir, 'concept.json'))).toMatchObject({ sizeClass: 'small', cells: 24 });
    const m = read(join(dir, 'metrics.json'));
    expect(m).toMatchObject({ role: 'alpha', build: 'oneshot' });
    expect(m.scoreBeforeRefinement).toBeTypeOf('number');
    expect(m.scoreAfterRefinement).toBeGreaterThanOrEqual(m.scoreBeforeRefinement);
    expect(m.minutes).toBeTypeOf('number');
    expect(m.generations).toBe(1);
    expect(read(join(dir, 'check.json'))).toMatchObject({ valid: true });
    // The gallery: static, relative, no outside assets
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/render\.png/);
    expect(html).toMatch(/needle nose|stubby brick|flying wing|arrowhead/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(read(join(out, 'summary.json')).saved).toBe(4);
    expect(renderer.closed).toBe(true);
  });

  it('writes each attempt live for Watch (design, then refine), its trace, a batch.log, and the ships for the Saved list', async () => {
    const root = tmp();
    const { out } = await run({ roles: ['alpha'], maxShips: 2, outDir: join(root, 'runs', 'b1') });
    expect(readdirSync(join(out, 'attempts'))).toEqual(['001-alpha', '002-alpha']);
    const a = join(out, 'attempts', '001-alpha');
    const lines = (f: string) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const design = lines(join(a, 'events.jsonl'));
    expect(design[0]).toMatchObject({ type: 'start', mode: 'design', role: 'alpha' });
    expect(design.at(-1).type).toBe('done');
    expect(design.some((e) => e.type === 'token')).toBe(false);
    expect(lines(join(a, 'refine', 'events.jsonl'))[0]).toMatchObject({ type: 'start', mode: 'evolve' });
    expect(existsSync(join(a, 'trace.jsonl'))).toBe(true);
    expect(readFileSync(join(out, 'batch.log'), 'utf8')).toMatch(/saved alpha\/001-/);
    // The page's lists: the attempts are runs to watch (finished), the saved ships one gallery
    const rel = (p: string) => relative(root, p).split(sep).join('/');
    expect(listWatchRuns(root).map((r) => r.id)).toEqual(expect.arrayContaining([rel(a), `${rel(a)}/refine`]));
    expect(listWatchRuns(root).find((r) => r.id === rel(a))?.finished).toBe(true);
    const ships = listSavedShips(root).filter((s) => s.run === rel(out));
    expect(ships.length).toBe(2);
    expect(ships[0]).toMatchObject({ role: 'alpha', model: 'fake' });
    expect(existsSync(ships[0].bp)).toBe(true);
    expect(ships[0].bp).toMatch(/blueprint\.json$/);
    // A batch resumed in the same folder numbers its attempts on
    await run({ roles: ['alpha'], maxShips: 1, outDir: out });
    expect(readdirSync(join(out, 'attempts'))).toContain('003-alpha');
  });

  it('varies the concept across ships: the next ask lists the ones already used', async () => {
    const llm = model();
    await run({ roles: ['alpha'], maxShips: 2 }, { llm });
    const asks = llm.requests.filter((r) => /art director/.test(r.messages[0].content));
    expect(asks.length).toBe(2);
    expect(asks[0].messages[1].content).not.toMatch(/already made/);
    expect(asks[1].messages[1].content).toMatch(/already made this session[\s\S]*long needle nose/);
    // ...and the design prompt carries the concept
    const design = llm.requests.find((r) => !/art director/.test(r.messages[0].content))!;
    expect(design.messages[1].content).toMatch(/Follow this concept/);
  });

  it('logs rejected attempts and saves only designs that are valid and on brief', async () => {
    const ac = new AbortController();
    const { summary, out, logs } = await run({ roles: ['strict'], signal: ac.signal }, { log: (l) => { logs0.push(l); if (/rejected/.test(l) && logs0.filter((x) => /rejected/.test(x)).length >= 2) ac.abort(); } });
    expect(summary).toMatchObject({ saved: 0, rejected: 2 });
    expect(existsSync(join(out, 'strict'))).toBe(false);
    const lines = readFileSync(join(out, 'attempts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.outcome)).toEqual(['rejected', 'rejected']);
    expect(lines[0].why.join(' ')).toMatch(/weapon/);
    expect(logs).toBeDefined();
  });

  it('stops at once when the stop file exists, and when it appears mid-run', async () => {
    const dir = tmp();
    const stop = join(dir, 'STOP');
    writeFileSync(stop, '');
    const a = await run({ roles: ['alpha'], stopFile: stop });
    expect(a.summary).toMatchObject({ attempts: 0, saved: 0, stopReason: 'stop file' });
    rmSync(stop);
    const b = await run({ roles: ['alpha'], stopFile: stop }, { log: (l) => { if (/saved/.test(l)) writeFileSync(stop, ''); } });
    expect(b.summary).toMatchObject({ saved: 1, stopReason: 'stop file' });
  });

  it('stops at --max-ships', async () => {
    const { summary } = await run({ roles: ['alpha', 'beta'], maxShips: 3 });
    expect(summary.saved).toBe(3);
    expect(summary.stopReason).toBe('3 ships');
  });

  it('carries on after a model that fails and recovers, waiting with a growing delay', async () => {
    // (the first attempt: the concept call and both design tries fail; the second goes through)
    const llm = model((n) => (n < 3 ? new Error('fetch failed') : undefined));
    const { summary, sleeps, out } = await run({ roles: ['alpha'], maxShips: 1 }, { llm });
    expect(summary).toMatchObject({ saved: 1, attempts: 2, errors: 1 });
    expect(summary.lastError).toMatch(/fetch failed/);
    expect(sleeps).toEqual([5000]);
    expect(readdirSync(join(out, 'alpha')).length).toBe(1);
    // A longer outage: the wait doubles, up to the cap
    const llm2 = model((n) => (n < 12 ? new Error('connect ECONNREFUSED') : undefined));
    const r2 = await run({ roles: ['alpha'], maxShips: 1, backoff: { baseMs: 1000, capMs: 3000 } }, { llm: llm2 });
    expect(r2.sleeps.slice(0, 4)).toEqual([1000, 2000, 3000, 3000]);
    expect(r2.summary.saved).toBe(1);
  });

  it('continues after an error thrown by the loop itself', async () => {
    let boom = true;
    const llm = model();
    const { summary } = await run({ roles: ['alpha'], maxShips: 1 }, { llm, renderer: undefined, log: () => {}, makeRenderer: async () => { if (boom) { boom = false; throw new Error('no renderer today'); } return fakeRenderer(); } });
    expect(summary.saved).toBe(1);
  });

  it('restarts a renderer that fails, and closes every renderer it started', async () => {
    const made: ReturnType<typeof fakeRenderer>[] = [];
    let first = true;
    const { summary, out } = await run({ roles: ['alpha'], maxShips: 1 }, {
      makeRenderer: async () => { const r = fakeRenderer(first ? () => { first = false; return new Error('render: no picture in 60 s'); } : undefined); made.push(r); return r; },
    });
    expect(made.length).toBe(2);
    expect(made.every((r) => r.closed)).toBe(true);
    expect(summary.saved).toBe(1);
    expect(existsSync(join(out, 'alpha', readdirSync(join(out, 'alpha'))[0], 'render.png'))).toBe(true);
  });

  it('stops cleanly when the disk is full', async () => {
    const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const renderer = fakeRenderer(() => full);
    const { summary } = await run({ roles: ['alpha', 'beta'] }, { makeRenderer: async () => renderer });
    expect(summary.stopReason).toBe('disk full');
    expect(summary.attempts).toBe(1);
    expect(renderer.closed).toBe(true);
  });

  it('refuses a model that is listed but not to be asked (LM Studio with chat off)', async () => {
    const llm = model();
    llm.models[0] = { ...llm.models[0], off: 'LM Studio, not enabled' };
    await expect(run({ roles: ['alpha'] }, { llm })).rejects.toThrow(/not enabled/);
    await expect(run({ roles: ['nope'] })).rejects.toThrow(/no role/);
  });

  it('pings progress every N minutes and once on stop', async () => {
    const pings: string[] = [];
    let t = 0;
    await run({ roles: ['alpha'], maxShips: 2, notifyEveryMins: 1 }, { notify: async (title) => { pings.push(title); }, now: () => (t += 40000) });
    expect(pings.length).toBeGreaterThanOrEqual(2);
    expect(pings.at(-1)).toMatch(/stopped/);
  });

  it('picks the build per role from the table, and --build overrides it', () => {
    expect(buildFor('starter')).toBe('oneshot');
    expect(buildFor('gunship')).toBe('staged');
    expect(buildFor('capital', 'auto')).toBe('staged');
    expect(buildFor('capital', 'oneshot')).toBe('oneshot');
    expect(buildFor('starter', 'staged')).toBe('staged');
  });

  it('writes a gallery that escapes names and works without ships', () => {
    const s = { started: '', updated: '', status: 'running' as const, model: 'm<x>', roles: [], attempts: 0, saved: 0, rejected: 0, errors: 0, perRole: {}, validRate: 0, avgMinutesPerShip: null, avgMinutesPerAttempt: null, elapsedMinutes: 0, tokensIn: 0, tokensOut: 0 };
    expect(galleryHtml([], s)).toMatch(/Nothing saved yet/);
    const html = galleryHtml([{ role: 'a', dir: 'a/001-x', name: '<b>Evil</b>', score: 90, draftScore: 80, parts: 20, cells: 30, minutes: 12, generations: 3, png: true, savedAt: 'x' }], s);
    expect(html).not.toMatch(/<b>Evil/);
    expect(html).toMatch(/draft 80, \+10/);
  });
});

const logs0: string[] = [];
