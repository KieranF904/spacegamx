// Mirror mode, the part-list contract, the staged build, per-model contracts and the critic's default weight, on a
// scripted model.
import { describe, it, expect } from 'vitest';
import { asymmetricCells, blueprintToGrid, blueprintToParts, check, findRole, halfOf, roleCheckOptions } from '../core/index';
import { loadContext } from '../core/context';
import { ship } from '../core/testShips';
import type { ShipgenEvent } from './events';
import { fakeLlm, fakeModel } from './fakeLlm';
import { type RunOptions, run } from './run';
import { STEPS, skeleton, suggestCells } from './staged';
import { autoContract } from './modelPrefs';
import { parseContract } from './contracts';
import { NO_MIRROR_SYMMETRY_WEIGHT } from './design';
import type { Renderer } from './render';

const ctx = loadContext();
const wren = ship('samples/review-wren');
const STARTER = { ...findRole(ctx, 'starter')!, example: undefined };
const fb = (ev: ShipgenEvent[]) => ev.filter((e) => e.type === 'feedback').map((e) => (e.type === 'feedback' ? e.text : ''));

const go = async (o: Partial<RunOptions> & { mode?: 'design' }, script: Parameters<typeof fakeLlm>[0], models = [fakeModel('fake')], extra: object = {}) => {
  const llm = fakeLlm(script, models);
  const ev: ShipgenEvent[] = [];
  const r = await run({ ctx, llm, models: llm.models, ...extra }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3, ...o } as RunOptions, (e) => ev.push(e));
  if (r.mode !== 'design') throw new Error('mode');
  return { ev, out: r.outcome, llm };
};

describe('shipgen mirror mode and part lists in the loop', () => {
  it('mirrors a half drawn as a grid (the default), and tells the model it is in mirror mode', async () => {
    const half = blueprintToGrid(ctx, halfOf(ctx, wren)).text;
    const { out, llm, ev } = await go({}, [half]);
    expect(llm.requests[0].messages[0].content).toMatch(/## Mirror mode/);
    expect(llm.requests[0].messages[1].content).toMatch(/LEFT half/);
    expect(out.best!.valid).toBe(true);
    expect(out.best!.bp!.parts.length).toBe(wren.parts.length);
    expect(asymmetricCells(ctx, out.best!.bp!)).toEqual([]);
    const g = ev.find((e) => e.type === 'grid' && !e.partial) as Extract<ShipgenEvent, { type: 'grid' }>;
    expect(g.drawn).toBe(half.trim().replace(/\r/g, '').replace(/^name: .*$/m, (m) => m));
    expect(g.bp!.parts.length).toBe(wren.parts.length);
  });

  it('reads a part list (the parts contract), mirrors it and shows the ship back as a grid', async () => {
    const half = blueprintToParts(ctx, halfOf(ctx, wren)).text;
    const lop = half.replace(/^HAt4 -4,2\r?\n/m, '');
    expect(lop).not.toBe(half);
    const { out, llm, ev } = await go({ contract: 'parts', target: 101 }, [lop, half]);
    expect(llm.requests[0].messages[0].content).toMatch(/## Part list format/);
    expect(llm.requests[0].messages[1].content).toMatch(/parts:, one part per line/);
    expect(out.attempts.length).toBeGreaterThanOrEqual(1);
    expect(out.attempts[0].valid).toBe(true);
    expect(fb(ev)[0]).toMatch(/Your ship as built \(whole[\s\S]*grid:/);
    expect(asymmetricCells(ctx, out.best!.bp!)).toEqual([]);
  });

  it('names overlapping parts in a part list exactly', async () => {
    const { ev, out } = await go({ contract: 'parts', rounds: 2 }, ['name: X\nparts:\nCA 0,0\nCR -1,0\nBT -1,0\nend', 'name: X\nparts:\nCA 0,0\nend']);
    expect(out.unreadable).toBeGreaterThanOrEqual(1);
    expect(fb(ev)[0]).toMatch(/"BT -1,0" overlaps "CR -1,0": both cover col -1 row 0/);
  });

  it('with mirror off: names the cells without a twin, and scores an asymmetric ship much lower', async () => {
    const tip = wren.parts.reduce((a, p) => (p.x > a.x ? p : a));
    const lop = { ...wren, parts: wren.parts.filter((p) => p !== tip) };
    const { ev, out, llm } = await go({ mirror: false, rounds: 2, target: 101 }, [blueprintToGrid(ctx, lop).text, blueprintToGrid(ctx, wren).text]);
    expect(llm.requests[0].messages[0].content).not.toMatch(/## Mirror mode/);
    expect(fb(ev)[0]).toMatch(/Not symmetric[\s\S]*row 2: col -4 is HA/);
    const [a, b] = out.attempts;
    expect(a.valid && b.valid).toBe(true);
    expect(b.score - a.score).toBeGreaterThanOrEqual(4);
    expect(fb(ev)[0]).toMatch(/costs 4 points a cell/);
    const plain = check(ctx, lop).score - check(ctx, wren).score;
    const heavy = check(ctx, lop, { weights: { symmetry: NO_MIRROR_SYMMETRY_WEIGHT } }).score - check(ctx, wren, { weights: { symmetry: NO_MIRROR_SYMMETRY_WEIGHT } }).score;
    expect(heavy).toBeLessThan(plain);
  });

  it('refuses a model that is listed but not enabled (LM Studio while its chat is off) before asking anything', async () => {
    const llm = fakeLlm(['x'], [fakeModel('fake'), { ...fakeModel('m'), id: 'lmstudio/m', provider: 'lmstudio', off: 'LM Studio, not enabled' }]);
    await expect(run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'lmstudio/m', brief: { role: STARTER } }, () => {})).rejects.toThrow(/not enabled/);
    expect(llm.requests.length).toBe(0);
  });

  it('keeps the critic out of the score by default (weight 0), recording its verdict', async () => {
    const renderer: Renderer = { async render(_bp, path) { return { path, ms: 1, png: Buffer.from('p') }; }, async close() {} };
    const half = blueprintToGrid(ctx, halfOf(ctx, wren)).text;
    const llm = fakeLlm((req) => (req.messages[0].images ? '{"looks": 2, "reason": "ugly"}' : half), [fakeModel('fake'), fakeModel('eye', { vision: true })]);
    const ev: ShipgenEvent[] = [];
    const r = await run({ ctx, llm, models: llm.models, renderer }, { mode: 'design', model: 'fake', critic: 'eye', brief: { role: STARTER }, rounds: 1, outDir: 'mem' }, (e) => ev.push(e));
    if (r.mode !== 'design') throw new Error();
    expect(r.outcome.best!.looks).toBe(2);
    // (Scored as the loop scores: the role's targets, and no symmetry term in mirror mode)
    expect(r.outcome.best!.score).toBe(check(ctx, r.outcome.best!.bp!, roleCheckOptions(STARTER, true) as never).score);
  });
});

describe('shipgen staged build', () => {
  it('starts from a valid, symmetric skeleton sized to the brief', () => {
    for (const id of ['starter', 'gunship', 'capital']) {
      const role = findRole(ctx, id)!;
      const s = skeleton(ctx, role);
      const r = check(ctx, s);
      expect(r.valid, id).toBe(true);
      expect(asymmetricCells(ctx, s), id).toEqual([]);
      expect(r.stats.height, id).toBeLessThanOrEqual(role.size.maxHeight ?? 99);
    }
    const s = skeleton(ctx, STARTER);
    expect(suggestCells(ctx, s, ['core'], { mirror: true })).toEqual(['0,-1 (frame hull)', '-1,0', '0,1 (frame hull)']);
  });

  it('builds power, then weapons, then engines, then armour, retrying a step that breaks the ship', async () => {
    const replies = [
      'name: S\nparts:\nCR -1,0\nBT -1,-1\nend',
      'name: S\nparts:\nPI^ -1,0\nend', // (on the reactor placed before: refused, tried again)
      'name: S\nparts:\nPI^ -2,0\nend',
      'name: S\nparts:\nBT -1,1\nIDv -1,2\nend', // (the battery goes on a frame hull cell)
      'name: S\nparts:\nAA -3,0\nend',
    ];
    const { ev, out, llm } = await go({ build: 'staged', contract: 'parts', rounds: 3 }, replies);
    const steps = ev.filter((e) => e.type === 'step') as Extract<ShipgenEvent, { type: 'step' }>[];
    expect(steps.map((s) => `${s.step}:${s.status}`)).toEqual(['power:start', 'power:accepted', 'weapons:start', 'weapons:accepted', 'engines:start', 'engines:accepted', 'fittings:skipped', 'armour:start', 'armour:accepted', 'shape:start', 'shape:failed']);
    expect(llm.requests.length).toBe(8);
    expect(fb(ev)[0]).toMatch(/overlaps "CR -1,0"/);
    // Each step's ask shows the ship so far and names the step
    expect(llm.requests[0].messages[1].content).toMatch(/Step 1 of 6: Add the POWER/);
    expect(llm.requests[2].messages[1].content).toMatch(/Step 2 of 6: Add the WEAPONS[\s\S]*Free cells/);
    expect(llm.requests[0].messages[0].content).toMatch(/You build it in steps/);
    const best = out.best!;
    expect(best.valid).toBe(true);
    expect(best.brief!.unmet).toEqual([]);
    expect(out.firstPassRound).toBe(5);
    expect(asymmetricCells(ctx, best.bp!)).toEqual([]);
    expect(best.bp!.parts.filter((p) => p.facing === 'S').length).toBe(2);
    expect(best.bp!.parts.filter((p) => p.facing === 'N').length).toBe(2);
    expect(STEPS.map((s) => s.id)).toEqual(['power', 'weapons', 'engines', 'fittings', 'armour', 'shape']);
  });

  it('moves on when a step runs out of tries, keeping the ship as it was', async () => {
    const { ev, out } = await go({ build: 'staged', contract: 'parts', rounds: 2 }, (_req, n) => (n < 2 ? 'name: S\nparts:\nCR -1,0\nBT -1,-1\nend' : 'nothing useful'));
    const steps = ev.filter((e) => e.type === 'step') as Extract<ShipgenEvent, { type: 'step' }>[];
    expect(steps.find((s) => s.step === 'weapons' && s.status === 'failed')).toBeTruthy();
    expect(out.best!.valid).toBe(true);
    expect(out.firstPassRound).toBeNull();
  });

  it('builds with the grid contract too: the model redraws its half each step', async () => {
    const half = (bp: Parameters<typeof halfOf>[1]) => blueprintToGrid(ctx, halfOf(ctx, bp)).text;
    const sk = skeleton(ctx, STARTER);
    const withPower = { ...sk, parts: [...sk.parts, { uid: 99, piece: 'sq', fn: 'power_cell_reactor', material: 'alloy', x: -1, y: 0, rot: 0 as const, flip: false }, { uid: 98, piece: 'sq', fn: 'power_battery', material: 'alloy', x: -1, y: -1, rot: 0 as const, flip: false }] };
    const { ev } = await go({ build: 'staged', contract: 'grid-text', rounds: 1 }, [half(withPower)]);
    const steps = ev.filter((e) => e.type === 'step') as Extract<ShipgenEvent, { type: 'step' }>[];
    expect(steps[1]).toMatchObject({ step: 'power', status: 'accepted' });
  });
});

describe('shipgen reply contracts per model', () => {
  it('reads contract names, old and new', () => {
    expect(parseContract('text')).toBe('grid-text');
    expect(parseContract('json')).toBe('grid-json');
    expect(parseContract('parts')).toBe('parts');
    expect(parseContract('auto')).toBe('auto');
    expect(parseContract('xml')).toBeUndefined();
  });

  it('picks the measured contract for known models, and a default by schema support for others', async () => {
    expect(autoContract('ollama/qwen2.5-coder:14b').why).toMatch(/trial/);
    expect(autoContract('ollama/gemma4:12b').why).toMatch(/trial/);
    expect(autoContract('ollama/unknown:1b', fakeModel('unknown:1b', { structured: true })).contract).toBe('grid-json');
    expect(autoContract('ollama/unknown:1b', fakeModel('unknown:1b')).contract).toBe('grid-text');
    const { ev } = await go({ model: 'qwen2.5-coder:14b', rounds: 1 }, ['x'], [fakeModel('qwen2.5-coder:14b', { structured: true })]);
    expect((ev[0] as Extract<ShipgenEvent, { type: 'start' }>).contract).toBe(autoContract('qwen2.5-coder:14b').contract);
  });
});
