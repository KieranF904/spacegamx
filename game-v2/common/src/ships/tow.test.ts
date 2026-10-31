import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import type { ShipTuning } from './tuning.js';
import { DEFAULT_TOW, canTow, towAnswer, towLoad, towPull, towTuning } from './tow.js';
import { gunLoad } from './energy.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
/** The Sparrow with a Tow Beam on its left flank, emitter out to the left */
const TOW_PART = { uid: 70, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -3, y: 0, rot: 0, flip: false, facing: 'W' };
const sparrow = (extra: object[] = []) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};
const T = DEFAULT_TOW;
const end = (o: object = {}) => ({ x: 0, y: 0, vx: 0, vy: 0, r: 20, ...o });

describe('Tow Beam: the part', () => {
  it('is a data-driven utility model in band L8-15 that gives a ship a tow once powered', () => {
    const fn = catalog.functions.get('utility_tow_beam')!;
    expect(fn.tow).toBe(true);
    expect(fn.unlock?.level).toBeGreaterThanOrEqual(8);
    expect(fn.unlock?.level).toBeLessThanOrEqual(15);
    expect(fn.demand).toBeGreaterThan(0);
    expect(canTow(sparrow().derived)).toBe(false);
    const d = sparrow([TOW_PART]).derived;
    expect(d.tow!.parts.length).toBe(1);
    expect(canTow(d)).toBe(true);
    expect(towTuning(tuning).range).toBeGreaterThan(0);
  });

  it('draws only while it tows (on its circuit, as a gun does)', () => {
    const ship = sparrow([TOW_PART]);
    const part = ship.derived.tow!.parts[0];
    const f = ship.derived.power!.feedOf[part];
    expect(f).toBeGreaterThanOrEqual(0);
    const idle = gunLoad(ship, 0) ?? [];
    expect(idle[f] ?? 0).toBe(0);
    const towing = gunLoad({ ...ship, tow: 99 }, 0)!;
    expect(towing[f]).toBeCloseTo(ship.derived.power!.draw[part], 6);
  });
});

describe('Tow Beam: the tether', () => {
  it('slack inside its rest length; stretched, it pulls the towed thing towards the ship', () => {
    const ship = end({ x: 0 });
    expect(towPull(ship, end({ x: -(T.rest + 30) }), 10, 1).dvx).toBe(0);
    const p = towPull(ship, end({ x: -(T.rest + 40 + 200) }), 10, 1);
    expect(p.snapped).toBe(false);
    expect(p.dvx).toBeGreaterThan(0);
    expect(p.dvy).toBe(0);
  });

  it('a heavier thing answers less, a weak beam pulls less, and too far it snaps', () => {
    const ship = end(), obj = end({ x: -(T.rest + 40 + 300) });
    const light = towPull(ship, obj, T.refMass / 2, 1).dvx, heavy = towPull(ship, obj, T.refMass * 4, 1).dvx, weak = towPull(ship, obj, T.refMass / 2, 0.5).dvx;
    expect(heavy).toBeCloseTo(light * towAnswer(T.refMass * 4), 9);
    expect(heavy).toBeLessThan(light);
    expect(weak).toBeCloseTo(light / 2, 9);
    expect(towPull(ship, end({ x: -(T.rest + 40 + T.snap + 1) }), 10, 1).snapped).toBe(true);
  });

  it('damps: a thing already closing on the ship is pulled less (or held back)', () => {
    const ship = end(), at = -(T.rest + 40 + 100);
    const still = towPull(ship, end({ x: at }), 10, 1).dvx, closing = towPull(ship, end({ x: at, vx: 5 }), 10, 1).dvx;
    expect(closing).toBeLessThan(still);
  });

  it('the ship carries the towed mass as load, up to a cap of its own mass', () => {
    expect(towLoad(10, 20)).toBeCloseTo(10 * T.loadShare, 9);
    expect(towLoad(1000, 20)).toBe(20 * T.loadCap);
  });

  it('pulled along: the towed thing follows a ship flying away, and stays within the snap', () => {
    const ship = end({ vx: 8 }), obj = end({ x: -(T.rest + 40) });
    let maxStretch = 0;
    for (let t = 0; t < 600; t++) {
      ship.x += ship.vx;
      const p = towPull(ship, obj, 40, 1);
      expect(p.snapped).toBe(false);
      maxStretch = Math.max(maxStretch, p.stretch);
      obj.vx += p.dvx; obj.vy += p.dvy;
      obj.vx *= 0.985; obj.vy *= 0.985;
      obj.x += obj.vx; obj.y += obj.vy;
    }
    expect(obj.vx).toBeGreaterThan(6);
    expect(maxStretch).toBeLessThan(T.snap);
  });
});
