/**
 * Mortars, missiles and torpedoes (docs/design/rework-2026-11.md §4): the table's numbers as the guns resolve them, the
 * point-defence hits each takes to bring down, and the Quake's landing points.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState, type ShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { gunDef, aimReach, lifeToReach, endsAtAim, firesStraight } from './launch.js';
import { interceptHits } from './features/support/support.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');

function armed(model: string): ShipState {
  const b = parseBlueprint(sparrowText);
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = model;
  pips[1].fn = 'hull';
  delete pips[1].facing;
  return createShipState(catalog, tuning, 1, b, 0);
}

const def = (model: string) => {
  const w = armed(model).derived.weapons[0];
  return { w, d: gunDef(tuning, w.kind, { grade: w.grade, size: w.size, model: w.model }) as WeaponTuning };
};

describe('ordnance: point-defence hits to bring each down', () => {
  it.each([
    ['mortar_lobber', 1], ['mortar_quake', 1], ['missile_dart', 1], ['missile_swarm', 1], ['missile_hammerhead', 2], ['torpedo_eel', 3], ['torpedo_leviathan', 5],
  ])('%s takes %i', (model, hits) => {
    expect(interceptHits(def(model).d)).toBe(hits);
  });
});

describe('ordnance: the section 4 rows', () => {
  it('mortars: the Lobber lands at the cursor out to 2,640; the Quake is a three-round salvo every 180 ticks', () => {
    const lob = def('mortar_lobber');
    expect(lob.w.fire).toMatchObject({ model: 'ammo', interval: 90 });
    expect(lob.d.splash).toEqual({ radius: 220, damage: 70 });
    expect(lob.d.ammo?.rounds).toBe(40);
    expect(aimReach(9999, lob.d)).toBeGreaterThan(2640);
    expect(lifeToReach(lob.d.life!, lob.d.speed!, 9999) * lob.d.speed!).toBe(2640);
    const q = def('mortar_quake');
    expect(q.w.fire).toMatchObject({ model: 'ammo', rounds: 3, interval: 180 });
    expect(q.d.splash).toEqual({ radius: 260, damage: 60 });
    expect(q.d.walk).toEqual({ at: [0.7, 1, 1.3], gap: 15 });
  });

  it('Quake landing points: 70%, 100% and 130% of the aim distance', () => {
    const q = def('mortar_quake').d;
    expect([0, 1, 2].map((i) => aimReach(1000, q, i))).toEqual([700, 1000, 1300]);
    // (a cursor on the ship still lobs them clear: the minimum reach scales the same way)
    expect([0, 1, 2].map((i) => aimReach(0, q, i))).toEqual([140, 200, 260]);
    expect(endsAtAim(q)).toBe(true);
  });

  it("missiles: the Dart, the Swarm's six rockets over 30 ticks, the steered Hammerhead", () => {
    const dart = def('missile_dart');
    expect(dart.w.fire).toMatchObject({ model: 'ammo', interval: 108 });
    expect(dart.d).toMatchObject({ homing: 0.07, damage: 30, splash: { radius: 120, damage: 34 } });
    expect(dart.d.ammo?.rounds).toBe(24);
    const sw = def('missile_swarm');
    expect(sw.w.fire).toMatchObject({ model: 'ammo', rounds: 6, interval: 180 });
    expect(sw.d.salvo).toEqual({ count: 6, gap: 6 });
    expect((sw.d.salvo!.count - 1) * sw.d.salvo!.gap).toBe(30);
    expect(sw.d).toMatchObject({ damage: 10, splash: { radius: 60, damage: 12 } });
    expect(sw.d.homing).toBeCloseTo(0.091, 5);
    expect(firesStraight(sw.d)).toBe(false);
    const hh = def('missile_hammerhead');
    expect(hh.w.fire.interval).toBe(198);
    expect(hh.d).toMatchObject({ damage: 105, splash: { radius: 150, damage: 54 }, guided: { turn: 0.05 } });
  });

  it('torpedoes: the Eel homes gently; the Leviathan is two rounds a shot, straight, armed after 60 ticks', () => {
    const eel = def('torpedo_eel');
    expect(eel.w.fire).toMatchObject({ model: 'ammo', interval: 240 });
    expect(eel.d).toMatchObject({ damage: 420, vsShield: 0, splash: { radius: 90, damage: 80 } });
    expect(eel.d.homing).toBeGreaterThan(0);
    expect(eel.d.ammo?.rounds).toBe(6);
    const lev = def('torpedo_leviathan');
    expect(lev.w.fire).toMatchObject({ model: 'ammo', rounds: 2, interval: 360 });
    expect(lev.d).toMatchObject({ damage: 1000, vsShield: 0, arm: 60, splash: { radius: 200, damage: 200 } });
    expect(lev.d.homing).toBeUndefined();
    expect(firesStraight(lev.d)).toBe(true);
  });
});
