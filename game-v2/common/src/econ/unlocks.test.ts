import { describe, it, expect, afterEach } from 'vitest';
import { setUnlockTable, unlocks, unlockedAt, DEFAULT_UNLOCKS } from './unlocks.js';
import { levelAt, xpToReach, GRADE_LEVEL, LEVEL_CAP } from './levels.js';
import { MATERIAL_LEVEL } from './market.js';

describe('unlocks', () => {
  afterEach(() => setUnlockTable(undefined));

  it('start from the base and add what each level reached gives', () => {
    setUnlockTable({ hangarSlots: { base: 2, label: 'Hangar bay', levels: { '3': 1, '15': 1 } } });
    expect(unlocks({ level: 1 }).hangarSlots).toBe(2);
    expect(unlocks({ level: 3 }).hangarSlots).toBe(3);
    expect(unlocks({ level: 40 }).hangarSlots).toBe(4);
    expect(unlockedAt(15)).toEqual(['Hangar bay 4']);
    expect(unlockedAt(16)).toEqual([]);
    // Anything the table leaves out keeps its default
    expect(unlocks({ level: 1 }).partySize).toBe(DEFAULT_UNLOCKS.partySize.base);
  });
});

describe('levels', () => {
  it('run 1 to 100 on 120 × (L^2.2 − 1), each level no more than ~1.3× the one before', () => {
    expect(LEVEL_CAP).toBe(100);
    // Its milestones: L5 4.0k, L10 18.9k, L30 213k, L45 520k
    expect(Math.round(xpToReach(5) / 100)).toBe(40);
    expect(Math.round(xpToReach(10) / 100)).toBe(189);
    expect(Math.round(xpToReach(30) / 1000)).toBe(213);
    expect(Math.round(xpToReach(45) / 1000)).toBe(520);
    expect(Math.round(xpToReach(100) / 1e4)).toBe(301);
    expect(xpToReach(150)).toBe(xpToReach(100));
    for (let l = 3; l <= 100; l++) {
      const step = xpToReach(l) - xpToReach(l - 1), prev = xpToReach(l - 1) - xpToReach(l - 2);
      expect(step / prev).toBeLessThan(l < 6 ? 2 : 1.3);
    }
    for (const l of [1, 2, 9, 10, 50, 100]) expect(levelAt(xpToReach(l))).toBe(l);
    expect(levelAt(xpToReach(10) - 1)).toBe(9);
    expect(levelAt(1e9)).toBe(LEVEL_CAP);
  });

  it("each grade opens at its main-line material's level, in order", () => {
    expect(GRADE_LEVEL.slice(2)).toEqual([MATERIAL_LEVEL.steel, MATERIAL_LEVEL.titanium, MATERIAL_LEVEL.cobalt, MATERIAL_LEVEL.neutronium]);
    for (let g = 2; g <= 5; g++) expect(GRADE_LEVEL[g]).toBeGreaterThan(GRADE_LEVEL[g - 1]);
  });
});
