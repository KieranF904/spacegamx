import { describe, it, expect } from 'vitest';
import { secureHold, SECURE_HOLD, type Stack } from './stacks.js';

describe('secureHold', () => {
  const value: Record<string, number> = { gold: 50, iron: 2, gem: 400, ice: 1, quartz: 10 };
  const v = (id: string) => value[id] ?? 0;

  it('keeps the three stacks worth most, each counted only up to 25', () => {
    const cargo: Stack[] = [{ id: 'iron', n: 900 }, { id: 'gold', n: 30 }, { id: 'gem', n: 2 }, { id: 'ice', n: 5 }, { id: 'quartz', n: 4 }];
    const kept = secureHold(cargo, v);
    // iron 2 × 25 = 50 (not 1800), gold 50 × 25, gem 800, quartz 40, ice 5
    expect([...kept.keys()].map((s) => s.id)).toEqual(['gold', 'gem', 'iron']);
    expect(kept.get(cargo[1])).toBe(25);
    expect(kept.get(cargo[2])).toBe(2);
    expect(kept.get(cargo[0])).toBe(25);
    expect(kept.has(cargo[3])).toBe(false);
  });

  it('ties keep hold order, and the rules can be changed', () => {
    const cargo: Stack[] = [{ id: 'a', n: 3 }, { id: 'b', n: 3 }, { id: 'c', n: 3 }];
    expect([...secureHold(cargo, () => 1, 2, 10).keys()].map((s) => s.id)).toEqual(['a', 'b']);
    expect(secureHold(cargo, () => 1, 0).size).toBe(0);
    expect(SECURE_HOLD).toEqual({ stacks: 3, units: 25 });
  });
});
