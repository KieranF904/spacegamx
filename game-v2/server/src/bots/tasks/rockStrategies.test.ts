import { describe, it, expect } from 'vitest';
import { strategies, strategyOpts, strategyNames, type PickEnv } from './rockStrategies.js';
import type { RockView } from '../core/world.js';

const rock = (eid: number, gap: number, type: string, ores: Record<string, number>, left = 100): RockView => ({ eid, x: gap + 50, y: 0, size: 50, type, hardness: 1, left, ores });
const CHOND = { iron_ore: 0.6, nickel_ore: 0.25, silicate: 0.15 };
const TAEN = { nickel_ore: 0.45, iron_ore: 0.3, copper_ore: 0.2, silicate: 0.05 };
const ICE = { ice: 1 };

function env(rocks: RockView[], short: Record<string, number> = {}, o: Record<string, string | number> = {}): PickEnv {
  return { rocks, gap: (r) => r.x - r.size, short: () => short, price: (ore) => ({ iron_ore: 2, nickel_ore: 3, copper_ore: 6, ice: 1, silicate: 1 }[ore] ?? 1), opts: strategyOpts(o) };
}

describe('rock strategies', () => {
  const rocks = [rock(1, 500, 'asteroid_ice', ICE), rock(2, 1500, 'asteroid_metal', CHOND), rock(3, 2500, 'rock_taenite', TAEN), rock(4, 5000, 'rock_taenite', TAEN)];

  it('lists nearest, metal, taenite-on-sight, needs and value', () => {
    expect(strategyNames()).toEqual(['nearest', 'metal', 'taenite-on-sight', 'needs', 'value']);
  });
  it('nearest takes the first; metal the nearest Chondrite or Taenite', () => {
    expect(strategies.nearest(env(rocks))!.eid).toBe(1);
    expect(strategies.metal(env(rocks))!.eid).toBe(2);
    expect(strategies.metal(env([rocks[0]]))!.eid).toBe(1);
  });
  it('taenite-on-sight diverts to a Taenite within sight, else takes the nearest', () => {
    expect(strategies['taenite-on-sight'](env(rocks))!.eid).toBe(3);
    expect(strategies['taenite-on-sight'](env(rocks, {}, { sight: 1000 }))!.eid).toBe(1);
    expect(strategies['taenite-on-sight'](env([rocks[0], rocks[3]]))!.eid).toBe(1);
  });
  it('needs takes the rock that fills what is short; value the richest per unit', () => {
    expect(strategies.needs(env(rocks, { copper_ore: 13, nickel_ore: 28 }))!.eid).toBe(3);
    expect(strategies.needs(env(rocks, { ice: 50 }))!.eid).toBe(1);
    expect(strategies.needs(env(rocks, {}))!.eid).toBe(1);
    expect(strategies.value(env(rocks))!.eid).toBe(3);
    expect(strategies.value(env(rocks, {}, { radius: 1000 }))!.eid).toBe(1);
  });
});
