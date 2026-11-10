/** The gun range's cheat ship (cheatShip.ts): valid, mounting rules kept, one fully powered gun, no jump drive, for every weapon model. */

import { describe, it, expect } from 'vitest';
import { validateBlueprint, parseBlueprint } from '../ships/blueprint.js';
import { createShipState } from '../ships/state.js';
import { stepGuns } from '../ships/guns.js';
import type { Charge } from '../ships/energy.js';
import { createPortsState } from '../ships/power/ports.js';
import { buildCheatShip, isRangeWeapon } from './cheatShip.js';
import type { ShipTuning } from '../ships/tuning.js';
import { readShipJson, testCatalog } from '../ships/testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const guns = [...catalog.functions.values()].filter((f) => f.model && f.weapon && isRangeWeapon(catalog, f.id)).map((f) => f.id);

describe('gun range cheat ship', () => {
  it('covers every weapon model', () => {
    const models = [...catalog.functions.values()].filter((f) => f.model && f.weapon && !f.exclusive && !f.legacy);
    expect(guns.length).toBeGreaterThanOrEqual(40);
    expect(models.filter((f) => !isRangeWeapon(catalog, f.id)).map((f) => f.id)).toEqual([]);
  });

  it.each(guns)('%s: a valid ship with its one gun fully powered, flagged, with no jump drive', (id) => {
    const bp = buildCheatShip(catalog, id)!;
    expect(bp).toBeTruthy();
    expect(bp.range).toBe(true);
    const v = validateBlueprint(catalog, bp, tuning, null);
    expect(v.errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    const ship = createShipState(catalog, tuning, 1, bp, 0);
    expect(ship.derived.alive.every(Boolean)).toBe(true);
    const ws = ship.derived.weapons.filter((w) => w.uid >= 0);
    expect(ws.length).toBe(1);
    expect(bp.parts.find((q) => q.uid === ws[0].uid)!.fn).toBe(id);
    expect(ship.derived.jumpRange).toBe(0);
  });

  it('refuses what is not a weapon model', () => {
    expect(buildCheatShip(catalog, 'hull')).toBeNull();
    expect(buildCheatShip(catalog, 'nope')).toBeNull();
  });

  it('a client can never claim the flag: a parsed design drops it', () => {
    const bp = buildCheatShip(catalog, 'cannon_pip')!;
    expect(parseBlueprint(JSON.stringify(bp)).range).toBeUndefined();
  });

  it('its guns never want for power: held on a dead-flat store, its beam still burns every tick', () => {
    const bp = buildCheatShip(catalog, 'laser_cutter')!;
    const { range: _flag, ...plain } = bp;
    const burns = (b: typeof bp) => {
      const ship = createShipState(catalog, tuning, 1, b, 0);
      // (No power at all: every part of it empty, and nothing refilling it)
      const e = createPortsState(ship.derived.ports);
      e.held.fill(0);
      const charge: Charge = { e };
      let n = 0;
      for (let t = 1; t <= 600; t++) {
        const r = stepGuns(ship, { x: 0, y: 0, angle: -Math.PI / 2 } as never, { firing: true, aimWorld: -Math.PI / 2, aimDist: 400, energy: { charge } }, t, tuning);
        n += r.beams.length;
      }
      return n;
    };
    expect(burns(bp)).toBeGreaterThan(500);
    expect(burns(plain)).toBeLessThan(burns(bp));
  });
});
