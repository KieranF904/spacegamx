/**
 * How a model is presented in the hangar palette and the fabricator: every family named, every model a trade-off
 * line, its size by its piece (not every model "Small"), its key numbers, and a locked model's level.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { Economy, partStats, type ItemsFile, type RecipesFile } from '@space-game/common';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import items from '../../../data/items.json';
import recipes from '../../../data/recipes.json';
import { FAMILY_LABEL, LEGENDARY, familyLabel, keyStats, modelLock, mountBadge, mountingText, sizeText, sizeWord, tradeOff } from './modelCards';
import { partTipHtml } from './partTip';

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../data')));
const { catalog, tuning } = bridge;
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, catalog, {});
const models = [...catalog.functions.values()].filter((f) => f.model && !f.exclusive);
const fn = (id: string) => catalog.functions.get(id)!;

describe('model cards', () => {
  it('every model has a named family, a trade-off and its numbers', () => {
    expect(models.length).toBeGreaterThan(50);
    for (const f of models) {
      const label = familyLabel(f);
      if (f.rarity !== 'legendary') expect(FAMILY_LABEL[f.family!], f.id).toBe(label);
      else expect(label).toBe(LEGENDARY);
      expect(tradeOff(f).length, f.id).toBeGreaterThan(3);
      expect(keyStats(catalog, tuning, f).length, f.id).toBeGreaterThan(3);
    }
  });

  it('a model is the size of its piece: a panel Medium, a block Large', () => {
    expect(sizeWord(catalog, 'sq')).toBe('Small');
    expect(sizeWord(catalog, 'rect2')).toBe('Medium');
    expect(sizeWord(catalog, 'block2')).toBe('Large');
    expect(sizeText(catalog, fn('cannon_bastion'))).toMatch(/^Large/);
    // (the tooltips' size, partStats, agrees)
    const size = (id: string) => partStats(catalog, tuning, { fn: id, material: fn(id).material!, piece: (fn(id).pieces as string[])[0] })!.size;
    expect(size('cannon_pip')).toBe('Small');
    expect(size('cannon_hammer')).toBe('Medium');
    expect(size('cannon_bastion')).toBe('Large');
    expect(size('engine_torch')).toBe('Medium');
    expect(size('power_fusion_plant')).toBe('Large');
  });

  it('says what it does: a gun its damage and reach, an engine its rated speed, a generator its power', () => {
    expect(keyStats(catalog, tuning, fn('cannon_hammer'))).toMatch(/dmg\/s · reach/);
    expect(keyStats(catalog, tuning, fn('engine_torch'))).toMatch(/thrust .* top [\d,]+ m\/s/);
    expect(keyStats(catalog, tuning, fn('power_cell_reactor'))).toMatch(/^\+\d+ power/);
    expect(keyStats(catalog, tuning, fn('power_capacitor'))).toMatch(/^holds [\d,]+$/);
  });

  it('a locked model gives its level and nothing earlier, legendaries and non-weapons included', () => {
    const all = econ.items.all();
    const rail = fn('railgun_needle');
    const lock = modelLock(rail, false, 4, all);
    expect(lock.open).toBe(false);
    expect(lock.badge).toBe(`Lv ${rail.unlock!.level}`);
    expect(lock.why).toBe(`Learned at level ${rail.unlock!.level} (you're 4)`);
    expect(modelLock(rail, true, 20, all).open).toBe(true);
    // A legendary, and a shield: their level alone
    const hive = models.find((f) => f.rarity === 'legendary' && f.family === 'hive')!;
    const hl = modelLock(hive, false, 4, all);
    expect(hl.badge).toBe(`Lv ${hive.unlock!.level}`);
    expect(hl.why).toBe(`Learned at level ${hive.unlock!.level} (you're 4)`);
    const shield = fn('shield_deflector');
    expect(modelLock(shield, false, 4, all).why).toBe(`Learned at level ${shield.unlock!.level} (you're 4)`);
    for (const m of models) expect(m.unlock?.level, m.id).toBeTypeOf('number');
  });
});

describe('mounting rules on the card and tooltip', () => {
  it('every weapon says its mount and rules in plain words', () => {
    for (const f of models.filter((m) => m.weapon)) expect(mountingText(catalog, { fn: f.id }, tuning).length, f.id).toBeGreaterThan(1);
    expect(mountingText(catalog, { fn: 'autocannon_rattler' }, tuning)).toContain('Turret, 270°');
    expect(mountingText(catalog, { fn: 'flak_burst' }, tuning)).toContain('Side mount (flippable)');
    expect(mountingText(catalog, { fn: 'cannon_longbarrel' }, tuning)).toEqual(expect.arrayContaining(['Needs 3 clear cells ahead', 'Bolts on from behind only']));
    expect(mountingText(catalog, { fn: 'hull' }, tuning)).toEqual([]);
  });

  it("the badge shows a turret's arc and a side mount; the tooltip its rules, and any it breaks", () => {
    expect(mountBadge(catalog, { fn: 'laser_searchlight' })).toMatch(/TURRET 360°.*SIDE/);
    expect(mountBadge(catalog, { fn: 'cannon_pip' })).toMatch(/FIXED/);
    expect(mountBadge(catalog, { fn: 'cannon_pip' })).not.toMatch(/SIDE/);
    const ctx = { catalog, tuning, econ, have: () => 0, canMake: () => true };
    const tip = partTipHtml({ fn: 'cannon_longbarrel', material: fn('cannon_longbarrel').material!, piece: 'rect2', facing: 'N' }, { ...ctx, mounting: ['its barrel needs 3 clear cells ahead (1 in the way)'] });
    expect(tip).toMatch(/Fixed: aims with the ship/);
    expect(tip).toMatch(/Bolts on from behind only · Needs 3 clear cells ahead/);
    expect(tip).toMatch(/1 in the way/);
    expect(partTipHtml({ fn: 'autocannon_rattler', material: fn('autocannon_rattler').material!, piece: 'sq' }, ctx)).toMatch(/Turret, 270°/);
  });
});
