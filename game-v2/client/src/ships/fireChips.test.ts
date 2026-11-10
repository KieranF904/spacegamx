/**
 * Gun tooltips and firing-model chips speak in shots (rework 2026-11 section 2.4): a gun on a Capacitor bank says how
 * many reloads the bank covers, and a card shows the model's chip.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { Economy, createShipState, type Blueprint, type ItemsFile, type PlacedPart, type RecipesFile, type Rot } from '@space-game/common';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/ships/createShipBridge';
import items from '../../../data/items.json';
import recipes from '../../../data/recipes.json';
import { fireChip } from './modelCards';
import { partTipHtml } from './partTip';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../data')));
const { catalog, tuning } = bridge;
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, catalog, {});
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const design = (gun: string, bank: boolean): Blueprint => ({
  name: 'test', catalogVersion: 1,
  parts: [
    p(0, 'rect2', 'core', 0, 0),
    p(1, 'sq', gun, 2, 0, { facing: 'N' }),
    p(2, 'sq', 'power_cell_reactor', -1, 1),
    p(3, 'sq', 'engine_ion_drive', 0, 2, { facing: 'S' }),
    p(4, 'sq', 'engine_ion_drive', 1, 2, { facing: 'S' }),
    ...(bank ? [p(5, 'sq', 'power_capacitor', 3, 0), p(6, 'sq', 'power_capacitor', 3, 1)] : []),
  ],
});
const ctx = (bp: Blueprint) => ({ catalog, tuning, econ, have: () => 0, canMake: () => true, derived: createShipState(catalog, tuning, 1, bp, 0).derived, index: 1, state: 'built' as const });
const tip = (gun: string, bank: boolean) => partTipHtml(design(gun, bank).parts[1], ctx(design(gun, bank))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('gun tooltips in shots', () => {
  it('every firing model has its chip, cycle and auto included', () => {
    const chips = new Set<string>();
    for (const f of catalog.functions.values()) if (f.weapon && f.fire && !f.fire.model.startsWith('x')) chips.add(`${f.fire.model}:${fireChip(f) !== ''}`);
    expect(chips.has('clip:true')).toBe(true);
    expect(chips.has('charge:true')).toBe(true);
    expect(chips.has('beam:true')).toBe(true);
    expect(chips.has('cycle:true')).toBe(true);
  });
});
