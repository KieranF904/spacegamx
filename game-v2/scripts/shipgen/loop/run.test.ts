import { describe, it, expect } from 'vitest';
import { loadContext, blueprintToGrid } from '../core/index';
import { ship } from '../core/testShips';
import type { ShipgenEvent } from './events';
import { fakeLlm, fakeModel } from './fakeLlm';
import { type RunOptions, run, runEvents } from './run';
import { designLoop } from './design';
import { mutationsFor, pickMutation, rngOf } from './mutations';
import { briefLegend, briefCheck, check, findRole } from '../core/index';
import type { Renderer } from './render';

const ctx = loadContext();
const wren = ship('samples/review-wren');
const GOOD = blueprintToGrid(ctx, wren).text;
// (The Wren is the starter role's worked example, so a copy of it is flagged: these tests use the role without one)
const STARTER = { ...findRole(ctx, 'starter')!, example: undefined };
// (No core: reads fine, but the game refuses it)
const NO_CORE = GOOD.replace(/CA\s+ca/, '..   ..');
const GARBAGE = 'I would love to help! A ship needs engines.';
const EMPTY = ['name: E', 'grid:', '0 .. ..', '1 .. ..', 'end'].join('\n');
const BAD_GRID ='name: X\ngrid:\n0 ZZ zz\n1 HA ha\nend';

const collect = async (o: RunOptions, llm = fakeLlm([GOOD]), extra: object = {}) => {
  const ev: ShipgenEvent[] = [];
  const r = await run({ ctx, llm, models: llm.models, ...extra }, o, (e) => ev.push(e));
  return { ev, r, llm };
};
const types = (ev: ShipgenEvent[]) => ev.filter((e) => e.type !== 'token').map((e) => e.type);

describe('shipgen design loop', () => {
  it('feeds back until valid, keeping the best', async () => {
    const llm = fakeLlm([GARBAGE, BAD_GRID, NO_CORE, GOOD]);
    const { ev, r } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 6 }, llm);
    expect(r.mode).toBe('design');
    if (r.mode !== 'design') return;
    const o = r.outcome;
    expect(o.attempts.length).toBe(4); // (Wren scores 95 on the starter brief: past the target, so it stops)
    expect(o.firstValidRound).toBe(4);
    expect(o.unreadable).toBe(2);
    expect(o.best!.round).toBe(4);
    expect(o.best!.valid).toBe(true);
    // Each round's feedback says what went wrong
    const fb = ev.filter((e): e is Extract<ShipgenEvent, { type: 'feedback' }> => e.type === 'feedback');
    expect(fb[0].text).toMatch(/couldn't find a design/);
    expect(fb[1].text).toMatch(/couldn't read your grid[\s\S]*ZZ/);
    expect(fb[2].text).toMatch(/NOT valid/);
    // ...and goes to the model next round, with the system prompt and the first ask kept
    expect(llm.requests[3].messages[0].role).toBe('system');
    expect(llm.requests[3].messages[1].content).toMatch(/Design the ship now/);
    expect(llm.requests[3].messages.at(-1)!.content).toBe(fb[2].text);
    expect(llm.requests[3].messages.length).toBe(2 + 4); // (2 past exchanges kept)
    // Event order
    expect(types(ev).slice(0, 6)).toEqual(['start', 'brief', 'prompt', 'reply', 'grid', 'feedback']);
    expect(types(ev).at(-1)).toBe('done');
    const best = ev.filter((e) => e.type === 'best');
    expect(best.map((e) => e.round)).toEqual([3, 4]);
    const done = ev.at(-1) as Extract<ShipgenEvent, { type: 'done' }>;
    expect(done.metrics).toMatchObject({ kind: 'design', rounds: 4, firstValidRound: 4, valid: true, unreadable: 2 });
    expect(ev.every((e) => typeof e.t === 'number')).toBe(true);
  });

  it('calls an empty grid unreadable', async () => {
    const { ev, r } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 2 }, fakeLlm([EMPTY, GOOD]));
    expect(r.mode === 'design' && r.outcome.unreadable).toBe(1);
    expect((ev.find((e) => e.type === 'feedback') as { text: string }).text).toMatch(/no parts/);
    expect(ev.filter((e) => e.type === 'check').length).toBe(1);
  });

  it('streams tokens and live partial grids', async () => {
    const { ev } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 1 });
    const toks = ev.filter((e) => e.type === 'token');
    expect(toks.map((e) => (e as { text: string }).text).join('')).toBe(GOOD);
    const partial = ev.filter((e) => e.type === 'grid' && e.partial) as Extract<ShipgenEvent, { type: 'grid' }>[];
    expect(partial.length).toBeGreaterThan(2);
    expect(partial.at(-1)!.parts).toBe(wren.parts.length);
    const fin = ev.find((e) => e.type === 'grid' && !e.partial) as Extract<ShipgenEvent, { type: 'grid' }>;
    expect(fin.bp!.parts.length).toBe(wren.parts.length);
  });

  it('asks for JSON (with the schema) from a model that takes one, and reads it', async () => {
    const rows = GOOD.split('\n').filter((l) => !/^(name|grid|end)\b/.test(l.trim()));
    const llm = fakeLlm([JSON.stringify({ name: 'Jay', grid: rows })], [fakeModel('fake', { structured: true })]);
    const { ev, r } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 1 }, llm);
    expect((ev[0] as Extract<ShipgenEvent, { type: 'start' }>).contract).toBe('grid-json');
    expect(llm.requests[0].schema).toBeTruthy();
    expect(llm.requests[0].messages[1].content).toMatch(/Reply as JSON/);
    expect(r.mode === 'design' && r.outcome.best?.valid).toBe(true);
    expect(ev.filter((e) => e.type === 'grid' && e.partial).length).toBeGreaterThan(2);
  });

  it('stops at the first valid design that meets the brief when asked, and keeps going otherwise up to the rounds', async () => {
    const a = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3, stopWhenValid: true, target: 101 });
    expect(a.r.mode === 'design' && a.r.outcome.attempts.length).toBe(1);
    // (Wren as a gunship is valid but off brief: compare keeps asking)
    const g = await collect({ mode: 'design', model: 'fake', brief: { role: 'gunship' }, rounds: 3, stopWhenValid: true });
    expect(g.r.mode === 'design' && [g.r.outcome.attempts.length, g.r.outcome.firstValidRound, g.r.outcome.firstPassRound]).toEqual([3, 1, null]);
    // (Wren as a gunship: valid but missing the brief's parts, so not good enough to stop)
    const b = await collect({ mode: 'design', model: 'fake', brief: { role: 'gunship' }, rounds: 3 });
    expect(b.r.mode === 'design' && b.r.outcome.attempts.length).toBe(3);
    expect(b.r.mode === 'design' && b.r.outcome.best!.brief!.unmet.length).toBeGreaterThan(0);
    expect(b.r.mode === 'design' && b.r.outcome.best!.score).toBeLessThan(check(ctx, wren).score);
  });

  it('survives a model error, and gives up after two in a row', async () => {
    const one = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3 }, fakeLlm([new Error('boom'), GOOD]));
    expect(one.r.mode === 'design' && one.r.outcome.best?.valid).toBe(true);
    expect(one.ev.some((e) => e.type === 'error' && !e.fatal)).toBe(true);
    const two = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 5 }, fakeLlm([new Error('a'), new Error('b'), GOOD]));
    expect(two.ev.some((e) => e.type === 'error' && e.fatal)).toBe(true);
    expect(two.llm.requests.length).toBe(2);
  });

  it('cancels mid-reply', async () => {
    const ac = new AbortController();
    const llm = fakeLlm([NO_CORE, GOOD]);
    const ev: ShipgenEvent[] = [];
    let n = 0;
    const r = await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 5, signal: ac.signal }, (e) => {
      ev.push(e);
      if (e.type === 'token' && e.round === 2 && ++n === 3) ac.abort();
    });
    expect(r.mode === 'design' && r.outcome.cancelled).toBe(true);
    expect(r.mode === 'design' && r.outcome.attempts.length).toBe(1);
    expect((ev.at(-1) as Extract<ShipgenEvent, { type: 'done' }>).cancelled).toBe(true);
    expect(llm.requests.length).toBe(2);
  });

  it('renders, asks the critic about valid designs, and blends looks into the score', async () => {
    const renders: string[] = [];
    const renderer: Renderer = { async render(_bp, path) { renders.push(path); return { path, ms: 20, png: Buffer.from('png') }; }, async close() {} };
    const llm = fakeLlm((req) => (req.messages[0].images ? '{"looks": 4, "reason": "boxy"}' : req.messages.length > 2 ? GOOD : NO_CORE), [fakeModel('fake'), fakeModel('eye', { vision: true })]);
    const { ev, r } = await collect({ mode: 'design', model: 'fake', critic: 'eye', criticWeight: 0.1, brief: { role: STARTER }, rounds: 2, outDir: 'mem' }, llm, { renderer });
    expect(renders.length).toBe(2); // (fast renders: every readable design)
    const crit = ev.filter((e) => e.type === 'critic');
    expect(crit.length).toBe(1); // (the valid one only)
    expect(crit[0]).toMatchObject({ looks: 4, reason: 'boxy' });
    const best = r.mode === 'design' ? r.outcome.best! : null;
    const base = check(ctx, best!.bp!).score;
    expect(best!.score).toBeCloseTo(base * 0.9 + 40 * 0.1, 0);
    expect(best!.renderPath).toMatch(/r2\.png$/);
  });

  it('renders only valid designs once renders are slow', async () => {
    const renders: string[] = [];
    const renderer: Renderer = { async render(_bp, path) { renders.push(path); return { path, ms: 5000, png: Buffer.from('') }; }, async close() {} };
    await collect({ mode: 'design', model: 'fake', brief: { role: 'gunship' }, rounds: 3 }, fakeLlm([NO_CORE, NO_CORE, GOOD]), { renderer });
    expect(renders.length).toBe(0); // (no outDir: nothing rendered)
    await collect({ mode: 'design', model: 'fake', brief: { role: 'gunship' }, rounds: 3, outDir: 'mem' }, fakeLlm([NO_CORE, NO_CORE, GOOD]), { renderer });
    expect(renders.map((p) => p.replace(/\\/g, '/'))).toEqual(['mem/renders/r1.png', 'mem/renders/r3.png']);
  });

  it('flags a copy of the worked example', () => {
    expect(briefCheck(ctx, wren, findRole(ctx, 'starter')!).unmet.join(' ')).toMatch(/worked example/);
    expect(briefCheck(ctx, wren, STARTER).unmet).toEqual([]);
  });

  it('says so when a model sends the same grid again', async () => {
    const { ev } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3 }, fakeLlm([NO_CORE, NO_CORE, NO_CORE]));
    const fb = ev.filter((e) => e.type === 'feedback').map((e) => (e.type === 'feedback' ? e.text : ''));
    expect(fb[0]).not.toMatch(/same grid/);
    expect(fb[1]).toMatch(/same design/);
  });

  it('stops a row that runs on far past the brief\'s width', async () => {
    const wide = ['name: Wide', 'grid:', '0 1 2', `0 ${Array(2000).fill('..').join(' ')}`, 'end'].join('\n');
    const { ev } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 2 }, fakeLlm([wide, GOOD]));
    const reply = ev.find((e) => e.type === 'reply')!;
    expect(reply.type === 'reply' && reply.text.length).toBeLessThan(wide.length / 4);
    const fb = ev.find((e) => e.type === 'feedback')!;
    expect(fb.type === 'feedback' && fb.text).toMatch(/row ran on/);
  });

  it('stops a model that writes row after row, and tells it why', async () => {
    const loop = ['name: Loop', 'grid:', '0 HA HA', ...Array.from({ length: 200 }, (_, i) => `${i + 1} HA HA`), 'end'].join('\n');
    const llm = fakeLlm([loop, GOOD]);
    const { ev, r } = await collect({ mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 2 }, llm);
    if (r.mode !== 'design') throw new Error('mode');
    const reply = ev.find((e) => e.type === 'reply')!;
    expect(reply.type === 'reply' && reply.text.length).toBeLessThan(loop.length / 2);
    const fb = ev.find((e) => e.type === 'feedback')!;
    expect(fb.type === 'feedback' && fb.text).toMatch(/kept writing rows/);
    expect(r.outcome.firstValidRound).toBe(2);
  });
});

describe('shipgen evolve and compare', () => {
  it('evolves a seed blueprint: mutations from its check, generations kept by score', async () => {
    const llm = fakeLlm([GOOD]);
    const { ev, r } = await collect({ mode: 'evolve', model: 'fake', brief: { role: 'gunship' }, seed: wren, population: 3, keep: 2, generations: 2, childRounds: 1 }, llm);
    if (r.mode !== 'evolve') throw new Error();
    expect(ev.filter((e) => e.type === 'mutation').length).toBe(6);
    const gens = ev.filter((e) => e.type === 'generation') as Extract<ShipgenEvent, { type: 'generation' }>[];
    expect(gens.map((g) => g.gen)).toEqual([0, 1, 2]);
    expect(gens[0].population.map((p) => p.id)).toEqual(['seed']);
    expect(gens[2].population.length).toBe(2);
    expect(r.outcome.metrics).toMatchObject({ kind: 'evolve', generations: 2, children: 6, validChildren: 6 });
    // The child's first ask carries the parent's grid and the change
    const ask = llm.requests[0].messages[1].content;
    expect(ask).toMatch(/Here is a design \(its left half and centre line\):[\s\S]*grid:[\s\S]*Its check:[\s\S]*Change it: /);
    expect(ev.filter((e) => e.type === 'prompt').every((e) => typeof e.lane === 'string' && /^g\d#\d$/.test(e.lane))).toBe(true);
  });

  it('evolves from a role (fresh seeds)', async () => {
    const { r } = await collect({ mode: 'evolve', model: 'fake', brief: { role: STARTER }, population: 2, keep: 2, generations: 1, seedRounds: 1, childRounds: 1 }, fakeLlm([NO_CORE, GOOD]));
    if (r.mode !== 'evolve') throw new Error();
    expect(r.outcome.best!.a.valid).toBe(true);
    expect(r.outcome.metrics.bestByGen.length).toBe(2);
  });

  it('picks mutations from what the check lacks (a Diode only when the legend has one)', () => {
    const res = check(ctx, wren);
    const withDiode = mutationsFor(res, { unmet: ['needs 4 weapons (has 2)'], missing: [] }, briefLegend(ctx, { role: 'gunship' }));
    expect(withDiode.some((m) => /Diode/.test(m.instruction))).toBe(true);
    expect(withDiode[0].instruction).toMatch(/meet the brief/);
    const noDiode = mutationsFor(res, undefined, briefLegend(ctx, { band: { maxLevel: 0 } }));
    expect(noDiode.some((m) => /Diode/.test(m.instruction))).toBe(false);
    const rng = rngOf(7);
    const picks = new Set(Array.from({ length: 200 }, () => pickMutation(withDiode, rng).why));
    expect(picks.has('brief unmet')).toBe(true);
  });

  it('compares models: pass rate, rounds per valid ship, valid per minute, mean score', async () => {
    let clock = 0;
    const llm = fakeLlm((req) => (req.model === 'good' ? GOOD : req.messages.length > 2 ? GOOD : NO_CORE), [fakeModel('good'), fakeModel('slow')]);
    const ev: ShipgenEvent[] = [];
    const r = await run({ ctx, llm, models: llm.models, now: () => (clock += 1000) }, { mode: 'compare', models: ['good', 'slow'], brief: { role: STARTER }, trials: 2, rounds: 3 }, (e) => ev.push(e));
    if (r.mode !== 'compare') throw new Error();
    const [g, s] = r.outcome.metrics.models;
    expect(g).toMatchObject({ model: 'good', trials: 2, passes: 2, passRate: 1, roundsPerValid: 1 });
    expect(s).toMatchObject({ model: 'slow', trials: 2, passes: 2, passRate: 1, roundsPerValid: 2 });
    expect(g.validPerMinute).toBeGreaterThan(s.validPerMinute);
    expect(g.meanScore).toBeGreaterThan(80);
    expect(new Set(ev.filter((e) => e.type === 'prompt').map((e) => e.lane))).toEqual(new Set(['good t1', 'good t2', 'slow t1', 'slow t2']));
  });

  it('runs as an async generator of the same events', async () => {
    const llm = fakeLlm([NO_CORE, GOOD]);
    const gen = runEvents({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3 });
    const seen: string[] = [];
    let step = await gen.next();
    while (!step.done) { seen.push(step.value.type); step = await gen.next(); }
    expect(seen[0]).toBe('start');
    expect(seen.at(-1)).toBe('done');
    expect(seen.filter((t) => t === 'check').length).toBe(2);
    expect(step.value.mode === 'design' && step.value.outcome.best?.valid).toBe(true);
  });

  it('a single designLoop can start from a design and a change', async () => {
    const llm = fakeLlm([GOOD]);
    const ev: ShipgenEvent[] = [];
    const r = await designLoop({ ctx, llm, models: llm.models }, { model: 'fake', brief: { role: STARTER }, rounds: 1, start: { text: GOOD, instruction: 'make it faster' } }, (e) => ev.push(e as ShipgenEvent));
    expect(llm.requests[0].messages[1].content).toMatch(/Change it: make it faster/);
    expect(r.best?.valid).toBe(true);
  });
});
