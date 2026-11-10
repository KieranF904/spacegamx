import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { hazardsAt, hazardTolerance, hazardDeficit, type HazardRules } from './hazards.js';
import type { ShipTuning } from './tuning.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const rules = JSON.parse(readFileSync(join(SHIP_DATA_DIR, '../hazards.json'), 'utf-8')) as HazardRules;
const ship = (name: string, material?: string) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
  if (material) bp.parts = bp.parts.map((p) => (p.fn === 'core' ? p : { ...p, material }));
  return createShipState(catalog, tuning, 1, bp, 0).derived;
};

describe('hazards', () => {
  it('a system rates its hazards, raised near its star or black hole', () => {
    const maw = { hazardRatings: { gravitational: 5, corrosive: 1 }, starRadius: 1400, centralBody: { type: 'black_hole' } };
    expect(hazardsAt(rules, maw, 20000, 0)).toEqual({ gravitational: 5, corrosive: 1 });
    const sol = { starRadius: 1000, centralBody: { type: 'sun' } };
    expect(hazardsAt(rules, sol, 4500, 0)).toEqual({});
    expect(hazardsAt(rules, sol, 1500, 0)).toEqual({ thermal: 3 });
  });

  it('tolerance comes from the build: mass holds a ship in a gravity well, a composite hull shrugs off some corrosion', () => {
    const sparrow = ship('sparrow-t'), hammerhead = ship('hauler');
    expect(hazardTolerance(rules, sparrow).gravitational).toBeLessThan(1);
    expect(hazardTolerance(rules, hammerhead).gravitational).toBe(5);
    expect(hazardDeficit({ gravitational: 5 }, hazardTolerance(rules, hammerhead))).toEqual({});
    expect(hazardDeficit({ gravitational: 5 }, hazardTolerance(rules, sparrow)).gravitational).toBeGreaterThan(4);
    // A composite hull (its modules are their own material, its core alloy): tolerance by the share of its cells that are composite (its hull and armour)
    const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
    const area = (fn?: string) => bp.parts.filter((p) => !fn || p.fn === fn).reduce((a, p) => a + catalog.variants.get(p.piece)![0].area, 0);
    expect(area('hull') / area()).toBeGreaterThan(0.2);
    expect(hazardTolerance(rules, ship('sparrow-t', 'composite')).corrosive).toBeCloseTo((area('hull') + area('armor')) / area(), 6);
  });
});

describe('hazard flight', () => {
  it('a light ship in a gravity well is drawn in and steers worse; a heavy one is not', async () => {
    const { stepShipPhysics } = await import('./physics.js');
    const { hazardFlight } = await import('./hazards.js');
    const maw = { hazardRatings: { gravitational: 5 }, starRadius: 1400, centralBody: { type: 'black_hole' } };
    const sparrow = ship('sparrow-t');
    const hz = hazardFlight(rules, maw, sparrow, 20000, 0)!;
    expect(hz.driftAccel).toBeGreaterThan(0);
    expect(hz.control).toBeLessThan(1);
    expect(hazardFlight(rules, maw, ship('hauler'), 20000, 0)).toBeUndefined();
    const fly = (h?: typeof hz) => {
      const body = { x: 20000, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0, jump: 0 };
      const input = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 };
      for (let i = 0; i < 300; i++) stepShipPhysics(body, input, sparrow, tuning, { charge: {}, drainRate: 0 }, null, 1, h);
      return body.x;
    };
    expect(fly(hz)).toBeLessThan(fly() - 50);
  });
});
