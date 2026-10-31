/** The weapons range's test rig (rangeRig.ts): valid, mounting rules kept, two guns, and power to spare, for every weapon model. */

import { describe, it, expect } from 'vitest';
import { validateBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { buildRangeRig, isRigGun } from './rangeRig.js';
import type { ShipTuning } from './tuning.js';
import { readShipJson, testCatalog } from './testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const guns = [...catalog.functions.values()].filter((f) => f.model && f.weapon && isRigGun(catalog, f.id)).map((f) => f.id);

describe('range rig', () => {
  it('covers every weapon model', () => {
    expect(guns.length).toBeGreaterThanOrEqual(40);
  });

  it.each(guns)('%s: a valid rig with two guns that are fully powered', (id) => {
    const bp = buildRangeRig(catalog, [id])!;
    expect(bp).toBeTruthy();
    const v = validateBlueprint(catalog, bp, tuning, null);
    expect(v.errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    const ship = createShipState(catalog, tuning, 1, bp, 0);
    expect(ship.derived.alive.every(Boolean)).toBe(true);
    expect(ship.derived.weapons.filter((w) => w.uid >= 0).length).toBe(2);
    for (const w of ship.derived.weapons) expect(w.satisfaction).toBeGreaterThanOrEqual(0.99);
  });

  it('carries two different guns, and refuses what is not a weapon', () => {
    const bp = buildRangeRig(catalog, ['cannon_pip', 'railgun_spear'])!;
    expect(validateBlueprint(catalog, bp, tuning, null).errors).toEqual([]);
    expect(createShipState(catalog, tuning, 1, bp, 0).derived.weapons.map((w) => w.kind).sort()).toEqual(['cannon', 'railgun']);
    expect(buildRangeRig(catalog, ['hull'])).toBeNull();
    expect(buildRangeRig(catalog, ['nope'])).toBeNull();
  });
});
