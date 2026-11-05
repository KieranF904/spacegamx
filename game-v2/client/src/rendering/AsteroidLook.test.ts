import { describe, expect, it } from 'vitest';
import { rockSmoothing } from './AsteroidLook';

const comp = (type: string, ores: Record<string, number>, primary: string, hardness = 1, seam = false) =>
  ({ type, ores, primary, hardness, seam: seam ? { gem: 'ruby', hardness: 2 } : null, units: 10 });

describe('asteroid facet smoothing', () => {
  it('runs from cut crystal to rounded stone', () => {
    const crystal = rockSmoothing(comp('asteroid_crystal', { silicate: 0.45, crystal: 0.3, copper_ore: 0.25 }, 'silicate', 2));
    const ice = rockSmoothing(comp('asteroid_ice', { ice: 0.7, silicate: 0.3 }, 'ice'));
    const metal = rockSmoothing(comp('asteroid_metal', { iron_ore: 0.6, nickel_ore: 0.3, copper_ore: 0.1 }, 'iron_ore'));
    const stone = rockSmoothing(comp('asteroid_fuel', { ice: 0.1, silicate: 0.85, helium3: 0.05 }, 'silicate'));
    expect(crystal).toBeLessThan(ice);
    expect(ice).toBeLessThan(metal);
    expect(metal).toBeLessThan(stone);
    expect(crystal).toBeLessThanOrEqual(0.05);
    expect(stone).toBeGreaterThan(0.7);
  });

  it('is sharper for hard rock and gem seams', () => {
    const base = comp('asteroid_metal', { iron_ore: 1 }, 'iron_ore');
    expect(rockSmoothing({ ...base, hardness: 2 })).toBeLessThan(rockSmoothing(base));
    expect(rockSmoothing(comp('asteroid_metal', { iron_ore: 1 }, 'iron_ore', 1, true))).toBeLessThan(rockSmoothing(base));
  });
});
