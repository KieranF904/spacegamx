import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { hazardFlight, hazardTolerance, type HazardRules } from './hazards.js';
import { coldRate, insulationOf, secondsToFreeze, starHeat, stepWarmth, warmthStage, withNumb, WARMTH_STAGES } from './warmth.js';
import { stepGuns } from './guns.js';
import type { ShipTuning } from './tuning.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const rules = JSON.parse(readFileSync(join(SHIP_DATA_DIR, '../hazards.json'), 'utf-8')) as HazardRules;
const w = rules.warmth!;
const blueprint = (name: string, material?: string) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
  if (material) bp.parts = bp.parts.map((p) => (p.fn === 'core' ? p : { ...p, material }));
  return bp;
};
const ship = (name: string, material?: string) => createShipState(catalog, tuning, 1, blueprint(name, material), 0).derived;

describe('warmth', () => {
  it('cold builds up in a cold place, about five minutes from warm to frozen through at a rating of 3', () => {
    expect(secondsToFreeze(w, 3, 0)).toBeGreaterThan(240);
    expect(secondsToFreeze(w, 3, 0)).toBeLessThan(360);
    expect(secondsToFreeze(w, 0, 0)).toBe(Infinity);
    let x = 1;
    for (let s = 0; s < 60; s++) x = stepWarmth(w, x, 1, 3, 0, 0);
    expect(x).toBeCloseTo(1 - 60 * coldRate(w, 3, 0), 6);
    // Anywhere that isn't cold it comes back by itself
    expect(stepWarmth(w, 0.5, 1, 0, 0, 0)).toBeCloseTo(0.5 + w.ambient, 6);
  });

  it('heat beats the cold: near a star it comes back, fading out towards the edge of its reach', () => {
    const r = 14000, m = w.sources.star!.margin;
    expect(starHeat(w, r + m * 0.4, r)).toBe(w.sources.star!.rate);
    expect(starHeat(w, r + m * 0.75, r)).toBeCloseTo(w.sources.star!.rate / 2, 6);
    expect(starHeat(w, r + m + 1, r)).toBe(0);
    // Every heat source warms faster than the coldest place there is cools
    for (const rate of [w.sources.star!.rate, w.sources.station!.rate, w.sources.station!.docked, w.sources.burning!.rate, w.sources.planet!.rate]) {
      expect(rate).toBeGreaterThan(coldRate(w, 5, 0));
    }
    expect(stepWarmth(w, 0.5, 1, 3, 0, w.sources.station!.rate)).toBeGreaterThan(0.5);
  });

  it('insulating materials slow the cold by their share of the hull, and only buy time', () => {
    const plain = ship('sparrow-t'), polymer = ship('sparrow-t', 'insulated_polymer'), ceramic = ship('sparrow-t', 'ceramic_laminate');
    expect(insulationOf(plain)).toBe(0);
    expect(insulationOf(polymer)).toBeGreaterThan(insulationOf(ceramic));
    expect(insulationOf(ceramic)).toBeGreaterThan(0);
    // (The core stays alloy: under the material's own figure)
    expect(insulationOf(polymer)).toBeLessThan(catalog.materials.get('insulated_polymer')!.insulation!);
    const base = secondsToFreeze(w, 3, insulationOf(plain)), slow = secondsToFreeze(w, 3, insulationOf(polymer));
    expect(slow).toBeGreaterThan(base * 1.1);
    expect(slow).toBeLessThan(base * 1.5);
    // Cold has no tolerance any more (conduits are gone, and no material is rated against it)
    expect(hazardTolerance(rules, polymer).cryo).toBe(0);
    // ...nor does it drain the batteries: what it costs is the meter's
    expect(hazardFlight(rules, { hazardRatings: { cryo: 3 } }, plain, 50000, 0)?.cap ?? 1).toBe(1);
  });

  it('stages: guns slower below half, then the drive numb too, then frozen through', () => {
    expect(warmthStage(100).name).toBe('warm');
    expect(warmthStage(50).name).toBe('warm');
    expect(warmthStage(49).name).toBe('chilled');
    expect(warmthStage(24).name).toBe('numb');
    expect(warmthStage(0).name).toBe('frozen');
    for (let i = 1; i < WARMTH_STAGES.length; i++) {
      expect(WARMTH_STAGES[i].guns).toBeGreaterThanOrEqual(WARMTH_STAGES[i - 1].guns);
      expect(WARMTH_STAGES[i].control).toBeLessThanOrEqual(WARMTH_STAGES[i - 1].control);
    }
    expect(withNumb(undefined, warmthStage(40))).toBeUndefined();
    expect(withNumb(undefined, warmthStage(10))!.control).toBe(warmthStage(10).control);
  });

  it('a cold ship\'s guns recycle slower', () => {
    const shots = (slow: number) => {
      const s = createShipState(catalog, tuning, 1, blueprint('sparrow-t'), 0);
      let n = 0;
      for (let t = 0; t < 600; t++) n += stepGuns(s, { x: 0, y: 0, angle: 0 }, { firing: true, aimDist: 0, slow }, t, tuning).shots.length;
      return n;
    };
    const warm = shots(1), cold = shots(warmthStage(10).guns);
    expect(warm).toBeGreaterThan(0);
    expect(cold).toBeLessThan(warm);
    expect(cold).toBeGreaterThanOrEqual(Math.floor(warm / warmthStage(10).guns) - 2);
  });
});
