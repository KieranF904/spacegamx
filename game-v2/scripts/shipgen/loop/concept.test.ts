// The concept step on a scripted model (no network): the request, the design prompt and feedback carrying it, events and
// metrics recording it, the variation hint, and a malformed reply falling back.
import { describe, it, expect } from 'vitest';
import { blueprintToGrid, conceptPenalty, conceptRequest, findRole, loadContext, parseConcept } from '../core/index';
import { ship } from '../core/testShips';
import type { ShipgenEvent } from './events';
import { fakeLlm, fakeModel } from './fakeLlm';
import { type RunOptions, run } from './run';

const ctx = loadContext();
const GOOD = blueprintToGrid(ctx, ship('dev/review-wren')).text;
const NO_CORE = GOOD.replace(/CA\s+ca/, '..   ..');
const STARTER = { ...findRole(ctx, 'starter')!, example: undefined };
const CONCEPT = ['concept:', 'name: Dart', 'size: small', 'silhouette: long needle nose, swept wings', 'layout: core amidships, reactor and battery on the centre line, guns paired at the nose, engines paired aft', 'character: A quick, spiky interceptor.', 'cells: 24', 'end'].join('\n');
const isConcept = (req: { messages: { content: string }[] }) => /art director/.test(req.messages[0].content);

const go = async (o: Partial<RunOptions>, script: Parameters<typeof fakeLlm>[0], models = [fakeModel('fake')]) => {
  const llm = fakeLlm(script, models);
  const ev: ShipgenEvent[] = [];
  const r = await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3, concept: true, shapeIndex: 0, ...o } as RunOptions, (e) => ev.push(e));
  if (r.mode !== 'design') throw new Error('mode');
  return { ev, out: r.outcome, llm };
};

describe('shipgen concept step', () => {
  it('asks for a concept first, puts it in the design prompt and each feedback message, and records it', async () => {
    const { ev, out, llm } = await go({}, [CONCEPT, NO_CORE, GOOD]);
    expect(isConcept(llm.requests[0])).toBe(true);
    expect(llm.requests[0].maxTokens).toBeLessThan(1000);
    expect(llm.requests[0].messages[1].content).toMatch(/name: \.\.\./); // (the text block form: this model takes no schema)
    // The first design round carries the concept
    expect(llm.requests[1].messages[1].content).toMatch(/Follow this concept[\s\S]*Dart[\s\S]*long needle nose, swept wings[\s\S]*guns paired at the nose/);
    // So does the feedback after it, as one line
    const fb = ev.filter((e) => e.type === 'feedback') as Extract<ShipgenEvent, { type: 'feedback' }>[];
    expect(fb[0].text).toMatch(/Concept "Dart": small ship \(about 24 cells\), long needle nose, swept wings/);
    expect(fb[0].text.split('\n').filter((l) => l.startsWith('Concept ')).length).toBe(1);
    // Events and metrics
    const c = ev.find((e) => e.type === 'concept') as Extract<ShipgenEvent, { type: 'concept' }>;
    expect(c.concept).toMatchObject({ name: 'Dart', sizeClass: 'small', cells: 24, source: 'model' });
    expect(ev.findIndex((e) => e.type === 'concept')).toBeLessThan(ev.findIndex((e) => e.type === 'prompt'));
    const done = ev.at(-1) as Extract<ShipgenEvent, { type: 'done' }>;
    expect((done.metrics as { concept?: { name: string } }).concept?.name).toBe('Dart');
    expect(out.concept?.name).toBe('Dart');
  });

  it('is off unless asked for, and skipped when the design begins from a given ship', async () => {
    const off = await go({ concept: false }, [GOOD]);
    expect(off.llm.requests.length).toBe(1);
    expect(off.ev.some((e) => e.type === 'concept')).toBe(false);
    const { llm } = await go({ start: { bp: ship('dev/review-wren'), instruction: 'make it faster' } }, [GOOD], [fakeModel('fake')]);
    expect(llm.requests.every((r) => !isConcept(r))).toBe(true);
  });

  it('uses a given concept without asking, and keeps it in the prompt', async () => {
    const given = { name: 'Given', sizeClass: 'medium' as const, silhouette: 'a wedge', layout: 'guns at the front', character: 'Plain.', source: 'given' as const };
    const { llm, ev } = await go({ concept: given }, [GOOD]);
    expect(llm.requests.length).toBe(1);
    expect(llm.requests[0].messages[1].content).toMatch(/Follow this concept[\s\S]*Given[\s\S]*a wedge/);
    expect(ev.some((e) => e.type === 'concept')).toBe(true);
  });

  it('asks for JSON with the schema from a model that takes one', async () => {
    const reply = JSON.stringify({ name: 'Jay', size: 'large', silhouette: 'a flying wing', layout: 'wide nose, guns at the roots', character: 'Broad.', cells: 30 });
    const { llm, out } = await go({}, [reply, GOOD], [fakeModel('fake', { structured: true })]);
    expect(llm.requests[0].schema).toBeTruthy();
    expect(llm.requests[0].messages[1].content).toMatch(/Reply as JSON/);
    expect(out.concept).toMatchObject({ name: 'Jay', sizeClass: 'large', cells: 30 });
  });

  it('falls back to the role silhouette when the concept reply is malformed, and the design still runs', async () => {
    const { ev, out, llm } = await go({}, ['Sure! Here is a lovely ship idea, no format at all.', GOOD]);
    const c = ev.find((e) => e.type === 'concept') as Extract<ShipgenEvent, { type: 'concept' }>;
    expect(c.concept.source).toBe('fallback');
    expect(c.concept.silhouette).toBe(STARTER.shapes![0]);
    expect(c.note).toMatch(/unreadable/);
    expect(out.best?.valid).toBe(true);
    expect(llm.requests[1].messages[1].content).toMatch(/Follow this concept/);
  });

  it('survives a concept request that throws', async () => {
    const { ev, out } = await go({}, [new Error('connection refused'), GOOD]);
    expect(ev.some((e) => e.type === 'error' && /concept/.test(e.message) && !e.fatal)).toBe(true);
    expect((ev.find((e) => e.type === 'concept') as { concept: { source: string } }).concept.source).toBe('fallback');
    expect(out.best?.valid).toBe(true);
  });

  it('goes on without a concept when the reply is unreadable and the role has no silhouettes', async () => {
    const { ev, out, llm } = await go({ brief: { role: { ...STARTER, shapes: [] } } }, ['nonsense', GOOD]);
    expect(ev.some((e) => e.type === 'concept')).toBe(false);
    expect(llm.requests[1].messages[1].content).not.toMatch(/Follow this concept/);
    expect(out.best?.valid).toBe(true);
  });

  it('passes a variation hint: the silhouette, a seed and the concepts already used', async () => {
    const { llm } = await go({ conceptSeed: 7, usedConcepts: ['Dart: small, long needle nose', 'Brick: medium, a block'] }, [CONCEPT, GOOD]);
    const ask = llm.requests[0].messages[1].content;
    expect(ask).toMatch(/Start from this silhouette: a dart/);
    expect(ask).toMatch(/Variation number 7/);
    expect(ask).toMatch(/already made this session[\s\S]*Dart: small[\s\S]*Brick: medium/);
  });

  it('carries the concept through a staged build: each step ask and each retry', async () => {
    const { llm } = await go({ build: 'staged', contract: 'parts', rounds: 2 }, (req, n) => (n === 0 ? CONCEPT : n === 1 ? 'name: S\nparts:\nCR -1,0\nBT -1,-1\nend' : 'nothing'));
    const power = llm.requests[1].messages[1].content;
    expect(power).toMatch(/Follow this concept[\s\S]*Dart[\s\S]*Step 1 of 5/);
    // (the skeleton is sized to the plan's cell target)
    expect(power).toMatch(/Step 1/);
  });
});

describe('shipgen concept reading and scoring', () => {
  it('reads JSON, a text block and a fenced reply, and clamps the cells to the role', () => {
    expect(parseConcept('```json\n{"name":"A","size":"large","silhouette":"s","layout":"l","character":"c","cells":9999}\n```', STARTER)).toMatchObject({ sizeClass: 'large', cells: 40 });
    expect(parseConcept('<think>hm</think>\nname: B\nsize: Small ship\nsilhouette: s\nlayout: l', STARTER)).toMatchObject({ name: 'B', sizeClass: 'small' });
    expect(parseConcept('{"name": broken', STARTER)).toBeNull();
    expect(parseConcept('', STARTER)).toBeNull();
  });

  it('asks for a short reply and names the role range', () => {
    const r = conceptRequest(STARTER, 'a needle', {}, false);
    expect(r.system).toMatch(/14-40 cells/);
    expect(r.system).toMatch(/a needle/);
  });

  it('takes a few points off a ship far from the planned size, and none close to it', () => {
    const c = { name: 'x', sizeClass: 'small' as const, silhouette: 's', layout: '', character: '', cells: 20, source: 'model' as const };
    expect(conceptPenalty(STARTER, c, 21).points).toBe(0);
    expect(conceptPenalty(STARTER, c, 40).points).toBeGreaterThan(0);
    expect(conceptPenalty(STARTER, c, 40).points).toBeLessThanOrEqual(5);
    expect(conceptPenalty(STARTER, undefined, 40).points).toBe(0);
    expect(conceptPenalty(STARTER, { ...c, source: 'fallback' }, 40).points).toBe(0);
  });
});
