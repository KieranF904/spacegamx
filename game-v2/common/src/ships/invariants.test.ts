/**
 * Pins for header invariants that had none: ships/damage.ts (grade steps) and ships/functionRegistry.ts (every flag
 * a catalog loads is registered).
 */
import { describe, it, expect } from 'vitest';
import { penetrationMul, hitMultiplier, weaponHit, partArmour, DAMAGE_TYPES } from './damage.js';
import { isWeaponFn, partFacingRule, partNeedsFacing, registeredFunction, hasRegisteredFunctions, WEAPON_FNS } from './functionRegistry.js';
import { readShipJson, testCatalog } from './testData.js';
import type { ShipTuning } from './tuning.js';

describe('damage: grade steps', () => {
  const tuning = readShipJson('tuning.json') as ShipTuning;
  const table = (tuning as any).damage.penetration as Record<string, number>;

  it('equal grade does full damage, each whole step under follows the table and falls', () => {
    expect(penetrationMul(0, tuning)).toBe(1);
    let last = 1;
    for (const gap of [-1, -2, -3, -4]) {
      const m = penetrationMul(gap, tuning);
      expect(m).toBe(table[String(gap)]);
      expect(m).toBeLessThan(last);
      last = m;
    }
  });
  it('between whole steps it interpolates, and past the table ends it holds the end value', () => {
    expect(penetrationMul(-0.5, tuning)).toBeCloseTo((table['-1'] + table['0']) / 2, 10);
    expect(penetrationMul(-9, tuning)).toBe(table['-4']);
    expect(penetrationMul(9, tuning)).toBe(table['1']);
  });
  it('against a real catalog block, a gun one grade under its armour does the table share of an equal gun', () => {
    const catalog = testCatalog();
    const parts = [...catalog.materials.values()].map((m) => ({ material: m.id, fn: 'hull' }));
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) {
      const armour = partArmour(catalog, p);
      for (const type of DAMAGE_TYPES) {
        const equal = hitMultiplier(catalog, tuning, p, { type, pen: armour });
        const lower = hitMultiplier(catalog, tuning, p, { type, pen: armour - 1 });
        expect(lower).toBeLessThanOrEqual(equal);
        if (equal > 0) expect(lower / equal).toBeCloseTo(table['-1'], 10);
      }
    }
    expect(weaponHit('cannon', undefined, 2).pen).toBe(2);
  });
});

describe('functionRegistry: the catalog registers every flag it loads', () => {
  it('every function, weapon, facing and one-way flag is registered', () => {
    const catalog = testCatalog();
    expect(hasRegisteredFunctions()).toBe(true);
    const defs = readShipJson('functions.json').functions as any[];
    expect(defs.length).toBeGreaterThan(10);
    for (const f of defs) {
      expect(registeredFunction(f.id)?.id).toBe(f.id);
      expect(isWeaponFn(f.id)).toBe(!!f.weapon);
      if (f.oneWay) expect(partFacingRule(f.id)).toBe('joined');
      else if (f.weapon || (f.thrust ?? 0) > 0 || f.facing) expect(partFacingRule(f.id)).toBe('free');
      else expect(partFacingRule(f.id)).toBeNull();
      expect(partNeedsFacing(f.id)).toBe(partFacingRule(f.id) !== null);
    }
    for (const id of WEAPON_FNS) expect(catalog.functions.get(id)?.weapon).toBeTruthy();
  });
});
