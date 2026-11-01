// The staged build's acceptance rule (a step must add a part of its kind), the engines step's help, and the skeleton's size.
import { describe, it, expect } from 'vitest';
import { asymmetricCells, check, findRole } from '../core/index';
import { loadContext } from '../core/context';
import { ship } from '../core/testShips';
import type { ShipgenEvent } from './events';
import { fakeLlm, fakeModel } from './fakeLlm';
import { type RunOptions, run } from './run';
import { engineHelp, skeleton } from './staged';

const ctx = loadContext();
const wren = ship('dev/review-wren');
const STARTER = { ...findRole(ctx, 'starter')!, example: undefined };
const fb = (ev: ShipgenEvent[]) => ev.filter((e) => e.type === 'feedback').map((e) => (e.type === 'feedback' ? e.text : ''));

const go = async (o: Partial<RunOptions>, script: Parameters<typeof fakeLlm>[0]) => {
  const llm = fakeLlm(script, [fakeModel('fake')]);
  const ev: ShipgenEvent[] = [];
  const r = await run({ ctx, llm, models: llm.models }, { mode: 'design', model: 'fake', brief: { role: STARTER }, rounds: 3, ...o } as RunOptions, (e) => ev.push(e));
  if (r.mode !== 'design') throw new Error('mode');
  return { ev, out: r.outcome, llm };
};

const REPLIES = [
  'name: S\nparts:\nCR -1,0\nBT -1,-1\nend',
  'name: S\nparts:\nPI^ -1,0\nend',
  'name: S\nparts:\nPI^ -2,0\nend',
  'name: S\nparts:\nBT -1,1\nIDv -1,2\nend',
];

describe('shipgen staged build: accepting a step, engines, skeleton size', () => {
  it('does not accept a step that added nothing of the kind it asked for', async () => {
    // (A valid ship, but the armour step added a store: no armour and no hull)
    const { ev, out } = await go({ build: 'staged', contract: 'parts', rounds: 3 }, [...REPLIES, 'name: S\nparts:\nBT -2,-1\nend']);
    const steps = ev.filter((e) => e.type === 'step') as Extract<ShipgenEvent, { type: 'step' }>[];
    expect(steps.find((x) => x.step === 'armour' && x.status === 'accepted')).toBeUndefined();
    expect(steps.find((x) => x.step === 'armour' && x.status === 'failed')).toBeTruthy();
    expect(fb(ev).some((t) => /you added no armour part/.test(t))).toBe(true);
    expect(out.steps!.accepted).not.toContain('armour');
  });

  it('names the engine count, the legal cells aft, and what to do when there is no room', () => {
    const sc = { ctx, role: STARTER, mirror: true };
    // (Frame hull gives way, so the skeleton has legal cells; a frame of armour boxes the core in)
    expect(engineHelp(sc, skeleton(ctx, STARTER)).join('\n')).toMatch(/Legal engine cells[^\n]*frame hull/);
    const boxed = skeleton(ctx, STARTER);
    const noRoom = engineHelp(sc, { ...boxed, parts: boxed.parts.map((p) => (p.fn === 'hull' ? { ...p, fn: 'armor' } : p)) }).join('\n');
    expect(noRoom).toMatch(/Engines now: 0 facing v; the ship needs at least 2/);
    expect(noRoom).toMatch(/counts twice/);
    expect(noRoom).toMatch(/Extend the ship aft/);
    // A ship with power and free cells behind it lists them
    const noEngines = { ...wren, parts: wren.parts.filter((p) => p.facing !== 'S') };
    const help = engineHelp(sc, noEngines).join('\n');
    expect(help).toMatch(/flame leaves its bottom edge/);
    expect(help).toMatch(/Legal engine cells[^\n]*-?\d+,-?\d+/);
  });

  it('puts the engine lines in the engines step ask and its retry', async () => {
    const { llm } = await go({ build: 'staged', contract: 'parts', rounds: 2 }, [...REPLIES.slice(0, 3), 'nothing', 'nothing']);
    const asks = llm.requests.filter((r) => /Step 3 of 5/.test(r.messages[1].content));
    expect(asks.length).toBe(2);
    expect(asks[0].messages[1].content).toMatch(/Engines now: \d+ facing v/);
    expect(asks[1].messages.at(-1)!.content).toMatch(/Engines now/);
  });

  it('sizes the skeleton to the brief minimum (or the concept target), still valid, symmetric and inside the box', () => {
    for (const id of ['starter', 'gunship', 'hauler']) {
      const role = findRole(ctx, id)!;
      const s = skeleton(ctx, role);
      const r = check(ctx, s);
      expect(r.valid, id).toBe(true);
      expect(asymmetricCells(ctx, s), id).toEqual([]);
      expect(r.stats.cells, id).toBeGreaterThanOrEqual(role.size.cells[0]);
      expect(r.stats.height, id).toBeLessThanOrEqual(role.size.maxHeight!);
      expect(r.stats.width, id).toBeLessThanOrEqual(role.size.maxWidth!);
    }
    const g = findRole(ctx, 'gunship')!;
    expect(check(ctx, skeleton(ctx, g, 'x', 60)).stats.cells).toBeGreaterThanOrEqual(58);
    expect(check(ctx, skeleton(ctx, g, 'x', 500)).stats.cells).toBeLessThanOrEqual(g.size.cells[1]);
  });
});
