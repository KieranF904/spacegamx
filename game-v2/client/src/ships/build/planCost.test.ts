import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Economy, partItemId, attachWork, fabWork, fieldBuildInputs, jobTicks, tierRule } from '@space-game/common';
import type { PlacedPart } from '@space-game/common';
import { testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { durationText, planCost, stallNotes, stationCost } from './planCost';
import { bindResourceLinks, fieldReadoutHtml, resLink, stationReadoutHtml } from './planCostView';

const dataFile = (f: string) => JSON.parse(readFileSync(join(SHIP_DATA_DIR, '..', f), 'utf-8'));
const catalog = testCatalog();
const econ = new Economy(dataFile('items.json'), dataFile('recipes.json'), catalog, {});
const hull = (uid: number): PlacedPart => ({ uid, piece: 'sq', fn: 'hull', material: 'alloy', x: uid, y: 0, rot: 0, flip: false });
const none = () => 0;

describe('planCost: the field plan', () => {
  it('sums the recipe inputs of every missing part', () => {
    const one = fieldBuildInputs(econ, hull(1));
    const r = planCost(econ, [hull(1), hull(2), hull(3)], { tier: 0, have: none });
    for (const [id, n] of Object.entries(one)) expect(r.lines.find((l) => l.id === id)?.need).toBe(n * 3);
    expect(r.parts).toBe(3);
  });

  it('short is need less the hold, and nothing once the hold has it', () => {
    const id = Object.keys(fieldBuildInputs(econ, hull(1)))[0];
    const need = fieldBuildInputs(econ, hull(1))[id] * 2;
    const r = planCost(econ, [hull(1), hull(2)], { tier: 0, have: (x) => (x === id ? need - 1 : 99) });
    expect(r.short[id]).toBe(1);
    expect(planCost(econ, [hull(1), hull(2)], { tier: 0, have: () => 99 }).short).toEqual({});
  });

  it('time is the real work over the tier speed', () => {
    const r = planCost(econ, [hull(1)], { tier: 0, have: none });
    const speed = tierRule('fabricator', 0).speed;
    const ticks = jobTicks(fabWork(econ, hull(1)), speed) + jobTicks(attachWork(catalog, hull(1)), speed);
    expect(r.seconds).toBeCloseTo(ticks / 60);
    const fast = planCost(econ, [hull(1)], { tier: 1, have: none });
    expect(fast.seconds).toBeLessThan(r.seconds);
  });

  it('a finished module in the hold costs only attaching', () => {
    const gun: PlacedPart = { uid: 5, piece: 'sq', fn: 'cannon_pip', material: 'alloy', x: 0, y: 0, rot: 0, flip: false };
    const bare = planCost(econ, [gun], { tier: 0, have: none });
    const held = planCost(econ, [gun], { tier: 0, have: (id) => (id === partItemId(gun) ? 1 : 0) });
    expect(held.fromHold).toBe(1);
    expect(held.lines).toEqual([]);
    expect(held.seconds).toBeLessThan(bare.seconds);
  });

  it('parts this tier cannot make add no time and are counted', () => {
    const steel: PlacedPart = { ...hull(9), material: 'steel' };
    const r = planCost(econ, [steel], { tier: 0, have: none });
    expect(r.unmakeable).toBe(1);
    expect(r.seconds).toBe(0);
  });

  it('names the stalls', () => {
    const base = { kind: 'fabricator', tier: 1, uid: 3, on: true, drawing: false } as const;
    expect(stallNotes({ ...base, on: false }, true)).toEqual(['fabricator is off']);
    expect(stallNotes({ ...base, blocked: 'cargo' }, true)).toEqual(['cargo is full']);
    expect(stallNotes({ ...base, on: true }, false)).toEqual([]);
  });

  it('writes the time in minutes', () => {
    expect(durationText(10)).toBe('under a minute');
    expect(durationText(240)).toBe('about 4 min');
    expect(durationText(4800)).toBe('about 1 h 20 min');
  });
});

describe('planCostView', () => {
  it('shorts are links carrying the item id, and names are escaped', () => {
    expect(resLink('alloy_plate', 'a<b')).toContain('data-res="alloy_plate"');
    expect(resLink('alloy_plate', 'a<b')).not.toContain('a<b');
    const r = planCost(econ, [hull(1), hull(2)], { tier: 0, have: none });
    const html = fieldReadoutHtml(r, (id) => econ.items.name(id));
    expect(html).toContain('Needs:');
    expect(html).toContain('data-res="');
    expect(html).toMatch(/to build/);
    expect(fieldReadoutHtml({ ...r, parts: 0 }, (id) => id)).toBe('');
  });

  it('a click on a link opens its entry', () => {
    const calls: string[] = [];
    const listeners: Record<string, (e: unknown) => void> = {};
    const root = { dataset: {} as Record<string, string>, addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; }, contains: () => true } as unknown as HTMLElement;
    bindResourceLinks(root, (id) => { calls.push(id); return true; });
    bindResourceLinks(root, () => false);
    const a = { dataset: { res: 'alloy_plate' } };
    listeners.click({ target: { closest: () => a }, preventDefault() {}, stopPropagation() {} });
    expect(calls).toEqual(['alloy_plate']);
  });
});

describe('stationCost', () => {
  it('counts a module recipe time and the refining of what storage lacks', () => {
    const id = Object.keys(dataFile('items.json').items ?? {}).find((k) => (econ.recipes.recipeFor(k)?.time ?? 0) > 0) ?? 'cannon_pip';
    const r = stationCost(econ, { [id]: 2 }, none, {}, () => true);
    expect(r.lines).toEqual([{ id, need: 2, have: 0 }]);
    expect(r.seconds).toBeGreaterThanOrEqual((econ.recipes.recipeFor(id)?.time ?? 0) * 2);
    const done = stationCost(econ, { [id]: 2 }, () => 5, {}, () => true);
    expect(done.seconds).toBe(0);
    expect(stationCost(econ, { [id]: 2 }, none, {}, () => false).blocked).toBe(1);
    expect(stationReadoutHtml(done, (x) => x)).toBe('');
  });
});
