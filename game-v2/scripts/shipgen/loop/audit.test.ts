// Fixes from the 2026-11-01 audit: stop reasons and truncation, Anthropic thinking, the model-info cache, runaway tokens,
// evolve's seed score, compare's time, staged metrics and the shape step.
import { describe, expect, it } from 'vitest';
import { blueprintToGrid, check, exposedCorners, findRole, halfOf, loadContext, silhouetteScore } from '../core/index';
import { ship } from '../core/testShips';
import { createLlm } from './llm';
import { fakeLlm, fakeModel } from './fakeLlm';
import { type RunOptions, run } from './run';
import type { ShipgenEvent } from './events';
import { STEPS } from './staged';
import { critique } from './critic';

const ctx = loadContext();
const wren = ship('dev/review-wren');
const STARTER = { ...findRole(ctx, 'starter')!, example: undefined };

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const body = (chunks: string[]) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const ch of chunks) c.enqueue(e.encode(ch)); c.close(); } }));
const sse = (events: object[]) => body(events.map((e) => `data: ${JSON.stringify(e)}\n\n`));

describe('stop reasons', () => {
  const msgs = [{ role: 'user' as const, content: 'x' }];
  it('Anthropic: stop_reason from message_delta, thinking off, truncated on max_tokens', async () => {
    const bodies: any[] = [];
    const f = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return sse([{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'content_block_delta', delta: { text: 'hi' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }]);
    }) as typeof fetch;
    const llm = createLlm({ fetch: f, token: () => undefined, anthropicKey: () => 'k' });
    const r = await llm.chat({ model: 'anthropic/claude-haiku-5-5', messages: msgs, maxTokens: 100 });
    expect(r).toMatchObject({ stopReason: 'max_tokens', truncated: true, outputTokens: 9 });
    expect(bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(bodies[0].max_tokens).toBe(100);
    expect(bodies[0].temperature).toBeUndefined();
  });
  it('Anthropic: falls back to a lower effort, then to none, when the API refuses the thinking setting', async () => {
    const seen: any[] = [];
    const f = (async (_u: any, init: any) => {
      const b = JSON.parse(init.body); seen.push(b);
      if (b.thinking) return json({ error: { message: 'thinking is not supported' } }, 400);
      if (b.output_config) return json({ error: { message: 'output_config.effort is not allowed' } }, 400);
      return sse([{ type: 'content_block_delta', delta: { text: 'ok' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }]);
    }) as typeof fetch;
    const llm = createLlm({ fetch: f, token: () => undefined, anthropicKey: () => 'k' });
    const r = await llm.chat({ model: 'anthropic/claude-haiku-5-5', messages: msgs });
    expect(r).toMatchObject({ text: 'ok', truncated: false });
    expect(seen.length).toBe(3);
    // (remembered: the next request starts from the setting that worked)
    await llm.chat({ model: 'anthropic/claude-haiku-5-5', messages: msgs });
    expect(seen.length).toBe(4);
  });
  it('Anthropic: no key means no request at all, not even a listing', async () => {
    let n = 0;
    const llm = createLlm({ fetch: (async () => { n++; return json({}); }) as typeof fetch, token: () => undefined, anthropicKey: () => undefined });
    await expect(llm.chat({ model: 'anthropic/claude-haiku-5-5', messages: msgs })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(n).toBe(0);
  });
  it('Ollama: done_reason length is a truncation', async () => {
    const f = (async (u: any) => (String(u).endsWith('/api/tags') ? json({ models: [{ name: 'm', capabilities: ['completion'] }] })
      : body(['{"message":{"content":"a"},"done":false}\n', '{"message":{"content":""},"done":true,"done_reason":"length","eval_count":4}\n']))) as typeof fetch;
    const r = await createLlm({ fetch: f, anthropicKey: () => undefined, token: () => undefined }).chat({ model: 'm', messages: msgs });
    expect(r).toMatchObject({ stopReason: 'length', truncated: true });
  });
  it('LM Studio: finish_reason length is a truncation', async () => {
    const f = (async (u: any) => (String(u).endsWith('/api/tags') ? json({ models: [] }) : String(u).includes('models') ? json({ data: [{ id: 'q' }] })
      : sse([{ choices: [{ delta: { content: 'a' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }]))) as typeof fetch;
    const r = await createLlm({ fetch: f, anthropicKey: () => undefined, token: () => 't', lmStudioChat: () => true }).chat({ model: 'lmstudio/q', messages: msgs });
    expect(r).toMatchObject({ stopReason: 'length', truncated: true, outputTokens: 2 });
  });
  it('the model list is refreshed, and a failed listing is not kept', async () => {
    let tags: any[] = [], fail = true;
    const bodies: any[] = [];
    const f = (async (u: any, init: any) => {
      if (String(u).endsWith('/api/tags')) return fail ? json({}, 500) : json({ models: tags });
      bodies.push(JSON.parse(init.body));
      return body(['{"message":{"content":"a"},"done":true}\n']);
    }) as typeof fetch;
    const llm = createLlm({ fetch: f, anthropicKey: () => undefined, token: () => undefined });
    await llm.chat({ model: 'q3', messages: msgs, think: false });
    expect('think' in bodies[0]).toBe(false);
    fail = false; tags = [{ name: 'q3', capabilities: ['completion', 'thinking'] }];
    await llm.chat({ model: 'q3', messages: msgs, think: false });
    expect(bodies[1].think).toBe(false);
  });
});

describe('truncated replies in the loop', () => {
  const half = blueprintToGrid(ctx, halfOf(ctx, wren)).text;
  const go = async (script: Parameters<typeof fakeLlm>[0], o: Partial<RunOptions> = {}) => {
    const llm = fakeLlm(script, [fakeModel('fake')]);
    const ev: ShipgenEvent[] = [];
    const r = await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 2, ...o } as RunOptions, (e) => ev.push(e));
    if (r.mode !== 'design') throw new Error();
    return { ev, out: r.outcome, llm };
  };
  it('tells the model plainly, records it, and does not count it as unreadable', async () => {
    const { ev, out, llm } = await go([{ text: half.slice(0, half.indexOf('end') - 8), truncated: true }, half], { target: 101 });
    const fbs = ev.filter((e) => e.type === 'feedback') as Extract<ShipgenEvent, { type: 'feedback' }>[];
    expect(fbs[0].text).toMatch(/cut off at the 8192-token limit/);
    expect(fbs[0].text).toMatch(/not a format mistake/);
    expect(out.truncated).toBe(1);
    expect(out.unreadable).toBe(0);
    expect(ev.find((e) => e.type === 'reply')).toMatchObject({ truncated: true, stopReason: 'max_tokens' });
    const done = ev.find((e) => e.type === 'done') as Extract<ShipgenEvent, { type: 'done' }>;
    expect(done.metrics).toMatchObject({ truncated: 1, unreadable: 0 });
    expect(llm.requests[0].maxTokens).toBe(8192);
  });
  it('gives a thinking model the bigger budget', async () => {
    const llm = fakeLlm([half], [fakeModel('think', { thinking: true })]);
    await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'think', brief: { role: STARTER }, rounds: 1 } as RunOptions, () => {});
    expect(llm.requests[0].maxTokens).toBe(12288);
  });
  it("counts a stopped runaway reply's tokens as an estimate", async () => {
    const row = ' ' + Array(80).fill('HA').join(' ');
    const { ev } = await go(['name: x\ngrid:\n' + Array(60).fill(row).join('\n')], { rounds: 1 });
    const reply = ev.find((e) => e.type === 'reply') as Extract<ShipgenEvent, { type: 'reply' }>;
    expect(reply.tokensEstimated).toBe(true);
    expect(reply.outputTokens).toBeGreaterThan(0);
  });
});

describe('evolve and compare', () => {
  it('scores the seed as it scores a child: a seed that misses the brief does not keep its raw score', async () => {
    const llm = fakeLlm(['x']);
    const ev: ShipgenEvent[] = [];
    const gun = findRole(ctx, 'gunship')!;
    const r = await run({ ctx, llm, models: llm.models }, { mode: 'evolve', model: 'fake', brief: { role: gun }, seed: wren, generations: 0 } as RunOptions, (e) => ev.push(e));
    if (r.mode !== 'evolve') throw new Error();
    expect(r.outcome.survivors[0].a.score).toBeLessThan(check(ctx, wren).score);
    expect(ev.some((e) => e.type === 'error' && /doesn't fit the role/.test(e.message) && !e.fatal)).toBe(true);
  });
  it("a seed that is the role's own example is not a copy of it", async () => {
    const llm = fakeLlm(['x']);
    const starter = findRole(ctx, 'starter')!;
    const r = await run({ ctx, llm, models: llm.models }, { mode: 'evolve', model: 'fake', brief: { role: starter }, seed: wren, generations: 0 } as RunOptions, () => {});
    if (r.mode !== 'evolve') throw new Error();
    expect(r.outcome.survivors[0].a.brief!.unmet).toEqual([]);
  });
  it('compare: the time of a cancelled trial is not charged to the model', async () => {
    const half = blueprintToGrid(ctx, halfOf(ctx, wren)).text;
    const ac = new AbortController();
    let n = 0, clock = 0;
    const llm = fakeLlm(() => { n++; clock += 100; if (n === 2) { ac.abort(); clock += 60000; } return half; }, [fakeModel('a'), fakeModel('b')]);
    const r = await run({ ctx, llm, models: llm.models, now: () => clock }, { mode: 'compare', models: ['a'], trials: 3, brief: { role: STARTER }, rounds: 1, signal: ac.signal } as RunOptions, () => {});
    if (r.mode !== 'compare') throw new Error();
    const m = r.outcome.metrics.models[0];
    expect(m.trials).toBe(1);
    expect(m.ms).toBeLessThan(1000);
  });
});

describe('staged metrics and the shape step', () => {
  it('a build that got only the power step is not valid in its metrics', async () => {
    const llm = fakeLlm(['name: S\nparts:\nCR -1,0\nBT -1,-1\nend', 'name: bad\nparts:\nZZ 0,0\nend'], [fakeModel('fake')]);
    const r = await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, build: 'staged', contract: 'parts', rounds: 1 } as RunOptions, () => {});
    if (r.mode !== 'design') throw new Error();
    expect(r.outcome.steps!.accepted).toEqual(['power']);
    expect(r.outcome.firstValidRound).toBeNull();
  });
  it('accepts a shape step that shapes corners and leaves the power alone, refuses one that does not', () => {
    const shape = STEPS.find((s) => s.id === 'shape')!;
    const sc = { ctx, role: STARTER, mirror: false };
    // (The wren with its wedges squared off: a block)
    const before = { ...wren, parts: wren.parts.map((p) => (p.piece === 'tri' ? { ...p, piece: 'sq', rot: 0 as const, flip: false } : p)) };
    const r0 = check(ctx, before);
    expect(shape.lacks(sc, before, r0).length).toBeGreaterThan(0);
    const corner = exposedCorners(ctx, before).find((c) => !c.shaped && before.parts.find((p) => p.uid === c.uid)!.piece === 'sq');
    expect(corner).toBeDefined();
    const after = { ...before, parts: before.parts.map((p) => (p.uid === corner!.uid ? { ...p, piece: 'tri' } : p)) };
    const r1 = check(ctx, after);
    expect(silhouetteScore(ctx, after)!).toBeGreaterThan(silhouetteScore(ctx, before)!);
    expect(shape.lacks(sc, after, r1, { bp: before, r: r0 })).toEqual([]);
    expect(shape.lacks(sc, before, r0, { bp: before, r: r0 }).join(' ')).toMatch(/no more shaped/);
  });
});

describe('the critic', () => {
  it('says so when the verdict is empty, and gives a Claude critic room', async () => {
    const llm = fakeLlm([''], [fakeModel('eyes', { vision: true })]);
    await expect(critique(llm, 'eyes', Buffer.from('p'))).rejects.toThrow(/no verdict/);
    const a = fakeLlm(['{"looks": 6, "reason": "ok"}'], [{ ...fakeModel('claude-haiku-5-5', { vision: true }), id: 'anthropic/claude-haiku-5-5', provider: 'anthropic' }]);
    expect((await critique(a, 'anthropic/claude-haiku-5-5', Buffer.from('p'))).looks).toBe(6);
    expect(a.requests[0].maxTokens).toBeGreaterThanOrEqual(1024);
  });
});

describe('staged acceptance', () => {
  it('refuses a weapons step whose gun gets no power, and says why', async () => {
    const llm = fakeLlm(['name: S\nparts:\nCR -1,0\nBT -1,-1\nend', 'name: S\nparts:\nPI^ -2,1\nend', 'name: S\nparts:\nPI^ -2,1\nend', 'name: S\nparts:\nPI^ -2,1\nend'], [fakeModel('fake')]);
    const ev: ShipgenEvent[] = [];
    await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, build: 'staged', contract: 'parts', rounds: 2 } as RunOptions, (e) => ev.push(e));
    const fb = ev.filter((e) => e.type === 'feedback').map((e) => (e.type === 'feedback' ? e.text : ''));
    expect(fb.join('\n')).toMatch(/gets no power/);
    const steps = ev.filter((e) => e.type === 'step').map((e) => (e.type === 'step' ? `${e.step}:${e.status}` : ''));
    expect(steps).toContain('weapons:failed');
  });
});

describe('a start design with codes of its own', () => {
  it('reads a part-list reply that leaves the key out', async () => {
    const gun = wren.parts.find((p) => p.fn === 'cannon_pip')!;
    const bp = { ...wren, parts: wren.parts.map((p) => (p === gun ? { ...p, material: 'composite' } : p)) };
    const { blueprintToParts } = await import('../core/index');
    const shown = blueprintToParts(ctx, bp).text;
    expect(shown).toMatch(/key:/);
    const reply = shown.slice(0, shown.indexOf('key:'));
    const llm = fakeLlm([reply]);
    const ev: ShipgenEvent[] = [];
    await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 1, mirror: false, contract: 'parts', start: { bp, instruction: 'keep it' } } as RunOptions, (e) => ev.push(e));
    const g = ev.find((e) => e.type === 'grid' && !e.partial) as Extract<ShipgenEvent, { type: 'grid' }>;
    expect(g.errors).toEqual([]);
    expect(g.parts).toBe(bp.parts.length);
  });
});
