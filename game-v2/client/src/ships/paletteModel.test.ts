/**
 * The hangar palette's rows (the guide's categories, structure by function) and the part a row puts in hand, and the
 * build facts its opened row shows (read from the data and rules).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import { COMP_TABS, guideRows } from '../ui/componentGuide';
import { PLATES } from '../ui/componentData';
import { paletteRows, rowInHand, rowPart, spareRows, tabOfFn } from './paletteModel';
import { buildFacts, portsText } from './buildFacts';

const { catalog, tuning } = createShipBridge(loadShipConfigFromDisk(join(__dirname, '../../../data')));
const guide = guideRows(catalog, PLATES);
const rows = paletteRows(catalog, guide);
const row = (id: string) => rows.find((r) => r.id === id)!;
const sel = (fn: string, piece = 'sq', material = 'alloy') => ({ fn, piece, material });

describe('palette rows', () => {
  it('every model in the guide is a row, under the guide\'s tab; structure is one row per function', () => {
    for (const g of guide.filter((x) => x.kind === 'model')) expect(row(g.id)?.tab, g.id).toBe(g.tab);
    expect(rows.filter((r) => r.kind === 'structure').map((r) => r.fn)).toEqual(['hull', 'armor', 'cargo']);
    expect(row('core').tab).toBe('structure');
    expect(rows.some((r) => r.id.startsWith('structure:'))).toBe(false);
    for (const t of COMP_TABS) expect(rows.some((r) => r.tab === t.id), t.id).toBe(true);
  });

  it('knows each row\'s shapes: hull every piece, a single-size model one', () => {
    expect(row('fn:hull').shapes.length).toBe(catalog.pieceIds.length);
    expect(row('fn:cargo').shapes.length).toBeGreaterThan(1);
    expect(row('cannon_pip').shapes).toEqual(['sq']);
  });

  it('a function\'s tab', () => {
    expect(tabOfFn(rows, 'hull')).toBe('structure');
    expect(tabOfFn(rows, 'cannon_pip')).toBe('weapons');
    expect(tabOfFn(rows, 'engine_ion_drive')).toBe('engines');
    expect(tabOfFn(rows, 'nope')).toBeNull();
  });
});

describe('the part a row puts in hand', () => {
  it('a new component comes in its default shape; the one in hand keeps its shape; a remembered one wins', () => {
    expect(rowPart(row('fn:armor'), sel('cannon_pip'))).toEqual({ fn: 'armor', piece: 'sq', material: 'alloy' });
    expect(rowPart(row('fn:armor'), sel('armor', 'slope2'))).toEqual({ fn: 'armor', piece: 'slope2', material: 'alloy' });
    expect(rowPart(row('fn:armor'), sel('hull', 'tri'), 'rect2').piece).toBe('rect2');
  });

  it('structure is built in the material picked; a model in its own', () => {
    expect(rowPart(row('fn:hull'), sel('hull', 'sq', 'steel')).material).toBe('steel');
    const pip = catalog.functions.get('cannon_pip')!;
    expect(rowPart(row('cannon_pip'), sel('hull', 'sq', 'steel')).material).toBe(pip.material ?? 'alloy');
  });

  it('finds the row in hand', () => {
    expect(rowInHand(rows, sel('armor', 'rect2'))?.id).toBe('fn:armor');
    expect(rowInHand(rows, sel('cannon_pip'))?.id).toBe('cannon_pip');
  });

  it('spare parts no row covers get a row each, in their category; covered ones none', () => {
    const parts: Record<string, { fn: string; material: string; piece: string }> = {
      a: { fn: 'laser', material: 'alloy', piece: 'sq' }, b: { fn: 'hull', material: 'alloy', piece: 'sq' },
    };
    const spares = spareRows(catalog, ['a', 'b'], rows, (id) => parts[id] ?? null, (id) => `Part ${id}`);
    expect(spares.map((r) => [r.id, r.tab, r.shapes])).toEqual([['spare:a', 'weapons', ['sq']]]);
  });
});

describe('build facts', () => {
  const facts = (fn: string, piece: string, material = 'alloy') => buildFacts(catalog, tuning, catalog.functions.get(fn)!, piece, material);
  const value = (fs: ReturnType<typeof facts>, label: string) => fs.find((f) => f.label === label)?.value;

  it('a weapon: footprint, toughness, damage, power, ports, its mounting rules and facing', () => {
    const f = facts('cannon_pip', 'sq');
    expect(f[0]).toMatchObject({ group: 'Shape', label: 'Square' });
    expect(value(f, 'Damage')).toMatch(/\/s/);
    expect(value(f, 'Reach')).toBeTruthy();
    expect(value(f, 'Mount')).toMatch(/Fixed/);
    expect(value(f, 'Facing')).toMatch(/free straight edge/);
    expect(value(f, 'Ports')).toBe(portsText(catalog.functions.get('cannon_pip')!).join(' · '));
    expect(value(f, 'Ports')).toMatch(/^in at the back \d+\/s$/);
  });

  it('an engine: thrust, its exhaust rule; a reactor: what it generates', () => {
    const e = facts('engine_ion_drive', 'sq');
    expect(value(e, 'Thrust')).toBeTruthy();
    expect(value(e, 'Exhaust')).toMatch(/clear line out behind/);
    const r = facts('power_cell_reactor', 'sq');
    expect(value(r, 'Generates')).toMatch(/^\+\d+\/s$/);
    expect(value(r, 'Ports')).toMatch(/^out at the front/);
  });

  it('structure follows the shape and material: a bigger piece is tougher; the core has its limit', () => {
    const hp = (piece: string, m = 'alloy') => Number(value(facts('hull', piece, m), 'Hull · armour')!.split(' ')[0].replace(/,/g, ''));
    expect(hp('rect2')).toBeGreaterThan(hp('sq'));
    expect(value(facts('hull', 'rect2'), 'Rect2') ?? value(facts('hull', 'rect2'), 'Panel')).toBe('Medium · 2×1 · 2 cells');
    expect(value(facts('core', 'sq'), 'Per ship')).toMatch(/exactly one/);
    expect(facts('hull', 'sq').some((f) => f.group === 'Limits')).toBe(false);
  });
});
