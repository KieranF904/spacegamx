import { describe, it, expect } from 'vitest';
import { SKILLS, SKILL_POINT_CAP, skillValue, refundRetiredSkills, engineeringSlots, giveSkillPoints, skillPointsSpent } from './quests.js';

describe('skills', () => {
  it('each point is worth less than the one before', () => {
    for (const id of Object.keys(SKILLS)) {
      expect(SKILLS[id].max).toBe(20);
      let prev = Infinity;
      for (let n = 1; n <= SKILLS[id].max; n++) {
        const step = skillValue(id, n) - skillValue(id, n - 1);
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThan(prev);
        prev = step;
      }
      // Ten points: about 6.5 × the first, twenty 8.8 ×; never past the maximum
      expect(skillValue(id, 10)).toBeCloseTo(SKILLS[id].first * 6.51, 2);
      expect(skillValue(id, SKILLS[id].max)).toBeCloseTo(SKILLS[id].first * 8.78, 2);
      expect(skillValue(id, 99)).toBe(skillValue(id, SKILLS[id].max));
    }
    // (Ten points come to what they did before the caps rose: within a point or two of a percent)
    expect(skillValue('mining', 10)).toBeCloseTo(0.531, 1);
    expect(skillValue('engineering', 10)).toBeCloseTo(0.425, 1);
    expect([0, 1, 2, 4, 5, 8, 9, 10].map(engineeringSlots)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('a pilot holds at most every skill full (60 points), spent and unspent', () => {
    expect(SKILL_POINT_CAP).toBe(60);
    const p = { skills: { mining: 20, engineering: 18 }, skillPoints: 20 };
    expect(skillPointsSpent(p)).toBe(38);
    expect(giveSkillPoints(p, 1)).toBe(1);
    expect(giveSkillPoints(p, 5)).toBe(1);
    expect(p.skillPoints).toBe(22);
    expect(giveSkillPoints(p, 1)).toBe(0);
  });

  it('Gunnery is gone: its points (and any past a maximum) come back to spend', () => {
    expect(SKILLS.gunnery).toBeUndefined();
    const p = { skills: { gunnery: 4, mining: 22, navigation: 3 }, skillPoints: 1 };
    expect(refundRetiredSkills(p)).toBe(true);
    expect(p.skills).toEqual({ mining: 20, navigation: 3 });
    expect(p.skillPoints).toBe(1 + 4 + 2);
    expect(refundRetiredSkills(p)).toBe(false);
  });

  it('a save past the cap keeps what it spent and loses only the unspent past it; one short of its levels is owed them', () => {
    // 50 spent, 30 unspent: 10 of those stay
    const rich = { skills: { mining: 20, engineering: 20, navigation: 10 }, skillPoints: 30, level: 90 };
    expect(refundRetiredSkills(rich)).toBe(true);
    expect(rich.skills).toEqual({ mining: 20, engineering: 20, navigation: 10 });
    expect(rich.skillPoints).toBe(10);
    // Every skill full: nothing unspent, nothing taken
    const full = { skills: { mining: 20, engineering: 20, navigation: 20 }, skillPoints: 4, level: 99 };
    refundRetiredSkills(full);
    expect(full.skillPoints).toBe(0);
    expect(skillPointsSpent(full)).toBe(60);
    // Level 40 (from XP on a gentler curve) with 12 points in all: owed a point a level
    const owed = { skills: { mining: 8 }, skillPoints: 4, level: 40 };
    expect(refundRetiredSkills(owed)).toBe(true);
    expect(owed.skillPoints + skillPointsSpent(owed)).toBe(39);
    expect(refundRetiredSkills(owed)).toBe(false);
    // Ahead of its levels (jobs' points): kept
    const ahead = { skills: { mining: 5 }, skillPoints: 6, level: 4 };
    expect(refundRetiredSkills(ahead)).toBe(false);
    expect(ahead.skillPoints).toBe(6);
  });
});
