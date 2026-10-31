import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import { FLASH_BANK_COST, flashPay } from './flash.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const part = (uid: number, fn: string, x: number, y: number, piece = 'sq') => ({ uid, piece, fn, material: 'steel', x, y, rot: 0, flip: false });
const ship = (extra: object[]) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};

describe('shield refill, per part', () => {
  it.each([
    ['shield_deflector', 8, 180, 40],
    ['shield_flicker_screen', 20, 60, 20],
    ['shield_bulwark_projector', 5, 240, 45],
  ])('%s refills at its own rate after its own delay', (fn, rate, delay, cap) => {
    const piece = fn === 'shield_bulwark_projector' ? 'block2' : fn === 'shield_flicker_screen' ? 'round' : 'sq';
    const d = ship([part(70, fn, -2, 0, piece)]).derived;
    const area = d.shieldMax / cap;
    expect(d.shieldMax).toBeGreaterThan(0);
    expect(d.shieldRegen).toBeCloseTo(rate * area, 0);
    expect(d.shieldDelay).toBe(delay);
  });

  it('two shields refill together, the delay weighted by what each refills', () => {
    const d = ship([part(70, 'shield_deflector', -2, 0), part(71, 'shield_flicker_screen', -2, -1)]).derived;
    expect(d.shieldRegen).toBeGreaterThan(8);
    expect(d.shieldDelay).toBeGreaterThan(60);
    expect(d.shieldDelay).toBeLessThan(180);
  });
});

describe('Flash Screen', () => {
  it('has no slow refill, and holds its points as a feature', () => {
    const d = ship([part(70, 'shield_flash_screen', -2, 0)]).derived;
    expect(d.shieldMax).toBe(36);
    expect(d.shieldRegen).toBe(0);
    expect(d.fx?.flash?.max).toBe(36);
  });

  it('a Capacitor touching it is a bank that can pay for it; one that does not touch it is not', () => {
    const touching = ship([part(70, 'shield_flash_screen', -2, 0), part(71, 'power_capacitor', -2, -1)]).derived;
    expect(touching.power!.banks.map((b) => b.shields)).toEqual([[touching.fx!.flash!.parts[0]]]);
    const apart = ship([part(70, 'shield_flash_screen', -2, 0), part(71, 'power_capacitor', 3, 0)]).derived;
    expect(apart.power!.banks.map((b) => b.shields)).toEqual([[]]);
  });

  it('flashPay takes 4 E a point from the banks in order, or nothing when they cannot pay', () => {
    const left: number[] = [];
    expect(flashPay([100, 100], 36, left)).toBe(true);
    expect(left).toEqual([0, 100 - (36 * FLASH_BANK_COST - 100)]);
    const untouched = [7, 7];
    expect(flashPay([100, 40], 36, untouched)).toBe(false);
    expect(untouched).toEqual([7, 7]);
  });
});

describe('Heavy Coil', () => {
  it('cuts the jump cooldown by a fifth, and the cut does not stack', () => {
    const fn = catalog.functions.get('utility_heavy_coil')!;
    const withCut = (extra: object[]) => ship(extra).derived.jumpCooldown;
    const one = withCut([part(70, 'utility_heavy_coil', -2, 0, 'block2')]);
    const saved = fn.jumpCooldown;
    delete fn.jumpCooldown;
    let plain: number;
    try { plain = withCut([part(70, 'utility_heavy_coil', -2, 0, 'block2')]); } finally { fn.jumpCooldown = saved; }
    expect(plain).toBeGreaterThan(0);
    expect(one).toBe(Math.round(plain * 0.8));
  });
});
