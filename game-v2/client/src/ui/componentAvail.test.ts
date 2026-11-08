/**
 * What the component guide and the hangar palette share: a row's lock in short, the open/locked split and tab counts,
 * a cost against what you have, whether a part places now, and the shapes a component comes in (its default, its
 * footprint).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { Economy, type ItemsFile, type RecipesFile } from '@space-game/common';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import items from '../../../data/items.json';
import recipes from '../../../data/recipes.json';
import { COMP_TABS, guideRows, rowsOf, type Gate, type PilotView } from './componentGuide';
import { componentGates, PLATES } from './componentData';
import { affordable, availability, AVAIL_RANK, costLines, isOpen, lockLevel, lockText, splitOpen, tabCounts } from './componentAvail';
import { defaultShape, footprint, footprintText, shapesOf, sizeWordOf, turned } from './componentShapes';

const { catalog } = createShipBridge(loadShipConfigCached(join(__dirname, '../../../data')));
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, catalog, {});
const rows = guideRows(catalog, PLATES);
const pilot = (level: number, learned: string[] = []): PilotView => ({ level, learned, have: () => 0 });
const gates = (id: string, p: PilotView) => componentGates(catalog, econ, rows.find((r) => r.id === id)!, p);

describe('a row\'s lock', () => {
  it('a level gate reads "Reach level N" and gives its level; met, it reads nothing', () => {
    const g = gates('cannon_hammer', pilot(1));
    expect(isOpen(g)).toBe(false);
    expect(lockText(g)).toBe('Reach level 6');
    expect(lockLevel(g)).toBe(6);
    const met = gates('cannon_hammer', pilot(6));
    expect(isOpen(met)).toBe(true);
    expect(lockText(met)).toBe('');
    expect(lockLevel(met)).toBeNull();
  });

  it('a licence or a boss part says what it needs, with no level', () => {
    const lic: Gate[] = [{ kind: 'licence', met: false, text: 'Learned from the job “X”', done: '' }];
    expect(lockText(lic)).toBe('Needs its licence');
    expect(lockLevel(lic)).toBeNull();
    const part: Gate[] = [{ kind: 'level', met: true, text: '', done: '' }, { kind: 'part', met: false, text: "Needs Rustjaw's Fang: dropped by Rustjaw", done: '' }];
    expect(lockText(part)).toBe("Needs Rustjaw's Fang");
  });

  it('the starter pieces are open at level 1', () => {
    expect(isOpen(gates('cannon_pip', pilot(1)))).toBe(true);
    expect(isOpen(gates('structure:alloy', pilot(1)))).toBe(true);
  });
});

describe('lists and tabs', () => {
  it('splits open from locked, each keeping its order', () => {
    const { open, locked } = splitOpen([1, 2, 3, 4, 5], (n) => n % 2 === 1);
    expect(open).toEqual([1, 3, 5]);
    expect(locked).toEqual([2, 4]);
  });

  it('counts each tab: totals match its rows, and more opens with level', () => {
    const at = (lv: number) => tabCounts(rows, COMP_TABS, (r) => isOpen(gates(r.id, pilot(lv))));
    const low = at(1), high = at(40);
    for (const t of COMP_TABS) {
      expect(low.get(t.id)!.total).toBe(rowsOf(rows, t.id).length);
      expect(high.get(t.id)!.open).toBeGreaterThanOrEqual(low.get(t.id)!.open);
    }
    expect(low.get('weapons')!.open).toBeLessThan(low.get('weapons')!.total);
  });
});

describe('cost and placing', () => {
  it('a cost line is short where you have fewer than it takes; empty is affordable', () => {
    const have: Record<string, number> = { a: 3, b: 1 };
    const lines = costLines({ a: 2, b: 2 }, (id) => have[id] ?? 0);
    expect(lines).toEqual([{ id: 'a', n: 2, have: 3, short: false }, { id: 'b', n: 2, have: 1, short: true }]);
    expect(affordable(lines)).toBe(false);
    expect(affordable(costLines({ a: 3 }, (id) => have[id] ?? 0))).toBe(true);
    expect(affordable([])).toBe(true);
  });

  it('free places anything; no licence locks even one on hand; spares come before fabricating', () => {
    expect(availability({ free: true, spare: 0, canMake: false })).toBe('free');
    expect(availability({ free: false, spare: 2, canMake: false })).toBe('locked');
    expect(availability({ free: false, spare: 2, canMake: true })).toBe('have');
    expect(availability({ free: false, spare: 0, canMake: true })).toBe('make');
    expect(AVAIL_RANK.have).toBeLessThan(AVAIL_RANK.make);
    expect(AVAIL_RANK.make).toBeLessThan(AVAIL_RANK.locked);
  });
});

describe('shapes', () => {
  it('hull comes in every piece in the catalog\'s order; a model in its own', () => {
    expect(shapesOf(catalog, catalog.functions.get('hull')!)).toEqual(catalog.pieceIds);
    expect(shapesOf(catalog, catalog.functions.get('cannon_hammer')!)).toEqual(['rect2']);
    expect(shapesOf(catalog, catalog.functions.get('plating_reactive_armour')!)).toEqual(['sq', 'rect2']);
  });

  it('defaults to the shape last used, else a square, else the first', () => {
    expect(defaultShape(['sq', 'rect2', 'tri'])).toBe('sq');
    expect(defaultShape(['rect2', 'block2'])).toBe('rect2');
    expect(defaultShape(['sq', 'rect2'], 'rect2')).toBe('rect2');
    // (a remembered shape it doesn't come in is ignored)
    expect(defaultShape(['sq', 'rect2'], 'tri')).toBe('sq');
    expect(defaultShape([])).toBe('sq');
  });

  it('the guide and the palette agree on a model\'s default shape', () => {
    for (const r of rows.filter((x) => x.kind === 'model')) expect(r.piece, r.id).toBe(defaultShape(shapesOf(catalog, catalog.functions.get(r.fn)!)));
  });

  it('a footprint is its cells across and down, its area and size word', () => {
    expect(footprint(catalog, 'sq')).toMatchObject({ w: 1, h: 1, area: 1, size: 'Small', name: 'Square' });
    expect(footprint(catalog, 'rect2')).toMatchObject({ w: 2, h: 1, area: 2, size: 'Medium' });
    expect(footprint(catalog, 'block3')).toMatchObject({ w: 3, h: 3, size: 'Heavy' });
    expect(footprintText(footprint(catalog, 'rect2'))).toBe('2×1 · 2 cells');
    expect(footprintText(footprint(catalog, 'sq'))).toBe('1×1 · 1 cell');
    expect(sizeWordOf(1)).toBe('Small');
    expect(sizeWordOf(4)).toBe('Large');
  });

  it('a footprint turns with the part in hand: across and down swap on a quarter turn', () => {
    const panel = footprint(catalog, 'rect2');
    expect(turned(panel, 1)).toMatchObject({ w: 1, h: 2, area: 2 });
    expect(turned(panel, 2)).toMatchObject({ w: 2, h: 1 });
    expect(turned(panel, 3)).toMatchObject({ w: 1, h: 2 });
  });
});
