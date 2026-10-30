/**
 * Progression: the unlock track (what each level opens, as the level-up
 * message and the field guide say it), nothing opening early, and
 * reputation's top rank within reach.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import { unlockTrack, levelUnlockNames, nextBuildUnlock, nextUnlockHint } from './track.js';
import { setUnlockTable } from './unlocks.js';
import { GRADE_LEVEL } from './levels.js';
import { MATERIAL_LEVEL, materialLicensed } from './market.js';
import { REP_RANKS, REP_MAX, REP_MIN, repRank, addStanding } from './quests.js';

const catalog = testCatalog();
const fns = () => catalog.functions.values();
const data = (f: string) => JSON.parse(readFileSync(join(SHIP_DATA_DIR, '..', f), 'utf-8'));

describe('the unlock track', () => {
  beforeAll(() => setUnlockTable(data('unlocks.json')));
  afterAll(() => setUnlockTable(undefined));

  it('every levelled model is on it once, at its level; materials at theirs; room where unlocks.json says', () => {
    const track = unlockTrack(fns());
    const seen = track.flatMap((s) => s.models.map((m) => m.id));
    const levelled = [...fns()].filter((f) => f.model && (f.unlock?.level ?? 0) > 0);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(levelled.map((m) => m.id).sort());
    for (const s of track) for (const m of s.models) expect(m.unlock!.level).toBe(s.level);
    // Starters aren't on it; the legendaries are, at their level
    expect(seen).not.toContain('cannon_pip');
    expect(track.find((s) => s.level === catalog.functions.get('legendary_hive')!.unlock!.level)!.models.map((m) => m.id)).toContain('legendary_hive');
    for (const [id, l] of Object.entries(MATERIAL_LEVEL)) if (l > 0) expect(track.find((s) => s.level === l)!.materials).toContain(id);
    expect(track.map((s) => s.level)).toEqual([...track.map((s) => s.level)].sort((a, b) => a - b));
  });

  it('names what a level opens: models, materials and room', () => {
    const at12 = levelUnlockNames(fns(), 12);
    expect(at12).toEqual(expect.arrayContaining(['Twinlink', 'Reactive Armour', 'Siphon', 'Titanium structure']));
    expect(at12.some((n) => /^Build points \d+$/.test(n))).toBe(true);
    // (Models first, room last)
    expect(at12.indexOf('Twinlink')).toBeLessThan(at12.indexOf('Titanium structure'));
    expect(levelUnlockNames(fns(), 30)).toEqual(expect.arrayContaining(['Bastion', 'Hangar bay 6']));
    expect(levelUnlockNames(fns(), 1)).toEqual([]);
  });

  it('hints at the next thing to build', () => {
    expect(nextBuildUnlock(fns(), 11)).toMatchObject({ level: 12 });
    expect(nextUnlockHint(fns(), 12)).toBe('Needle at Lv 13');
    expect(nextUnlockHint(fns(), 1)).toBe('Constructor and Vernier at Lv 2');
    expect(nextUnlockHint(fns(), 11)).toBe('Twinlink, Frostbite Lance and 5 more at Lv 12');
    expect(nextUnlockHint(fns(), 30)).toBe('Lance and Neutronium structure at Lv 32');
    // Past the last model: nothing to hint (room still comes, but nothing new to build)
    expect(nextUnlockHint(fns(), 99)).toBeNull();
  });
});

describe('nothing opens early', () => {
  it("a structure material opens at its grade's level, whatever licence a pilot holds", () => {
    for (const id of ['steel', 'titanium', 'cobalt', 'neutronium']) {
      const g = catalog.materials.get(id)!.grade!;
      expect(GRADE_LEVEL[g], id).toBe(MATERIAL_LEVEL[id]);
      expect(materialLicensed(id, [`material:${id}`], MATERIAL_LEVEL[id] - 1), id).toBe(false);
      expect(materialLicensed(id, [], MATERIAL_LEVEL[id]), id).toBe(true);
    }
  });
});

describe('reputation', () => {
  it('the top rank is within the standing a pilot can hold, and every vendor line with it', () => {
    const top = REP_RANKS[REP_RANKS.length - 1];
    expect(top.at).toBeLessThanOrEqual(REP_MAX);
    expect(repRank(REP_MAX).rank).toBe(REP_RANKS.length - 1);
    expect(repRank(REP_MAX).name).toBe(top.name);
    expect(addStanding(95, 40)).toBe(REP_MAX);
    expect(addStanding(-90, -40)).toBe(REP_MIN);
    expect(addStanding(10, 5)).toBe(15);
    const reps = data('quests.json').reputations as Record<string, { vendor?: { stock: { item: string; rank: number }[] } }>;
    for (const [id, r] of Object.entries(reps)) for (const s of r.vendor?.stock ?? []) expect(REP_RANKS[s.rank]?.at, `${id} ${s.item}`).toBeLessThanOrEqual(REP_MAX);
  });
});
