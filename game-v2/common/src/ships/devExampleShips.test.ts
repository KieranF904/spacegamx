/**
 * The dev example ships of the weapon modifiers (data/ships/blueprints/dev: mod-showcase-1 and the four beam-* ships):
 * each is a valid design, each of its weapons is in a weapon group of its own (left to right: 1, 2, ...), each weapon
 * carries the modifier effects it was built to show, and each accelerates at least as hard as the Wren (dev/ports-wren).
 * Each has the power for what it shows: any group held on its own, any two together (the two mouse buttons) and all of
 * them at once fire at their full rate for as long as they are held, with the engines boosting the whole time.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlueprint, validateBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { SHIP_DATA_DIR } from './testData.js';
import { WEAPON_GROUPS, partWeaponGroups } from './weaponGroups.js';
import { catalog, tuning } from './power/testData.js';
import { portsLoadTest, type PortsScenario } from './power/portsLoadTest.js';

const dev = (name: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev', `${name}.json`), 'utf-8'));
const fxName = tuning.modifiers!.effects;

function built(name: string) {
  const bp = dev(name);
  const d = createShipState(catalog, tuning, 1, bp, 0).derived;
  /** The weapons left to right: model, group mask, effects by name, the power its lines bring (eu a tick) */
  const guns = d.weapons
    .map((w) => ({ fn: bp.parts[w.part].fn, x: bp.parts[w.part].x, wg: partWeaponGroups(bp.parts[w.part]), fx: (d.ports!.mod?.gunFx?.[w.part] ?? []).map((s) => `${fxName[s.fx]}:${s.q}`).join(' '), rate: d.ports!.rate[w.part] }))
    .sort((a, b) => a.x - b.x);
  return { bp, d, guns, thrustToMass: d.maxThrust.forward / d.mass };
}

/** Longer than any store aboard lasts (a Drive Cell runs an Ion Drive for 36 s cruising, a bank a Lance for a few) */
const HELD_SECONDS = 45;
/**
 * The hangar's load test (the ship's own power tick) with only these weapon groups held: the lowest share of full-power
 * work any of their guns did, over any of its windows and over the end of the test (1: supply kept up with draw
 * throughout), the engines' share, and the first brownout (-1: none)
 */
function held(s: ReturnType<typeof built>, groups: number[], scenario: PortsScenario) {
  const mask = groups.reduce((m, g) => m | (1 << (g - 1)), 0);
  const weapons = s.d.weapons.filter((w) => partWeaponGroups(s.bp.parts[w.part]) & mask);
  const r = portsLoadTest({ ...s.d, weapons }, scenario, HELD_SECONDS)!;
  return { fired: weapons.length, guns: Math.min(...weapons.map((w) => Math.min(r.low[w.part], r.end[w.part]))), engines: r.engines, firstBrown: r.firstBrown };
}
const FULL = { guns: 1, engines: 1, firstBrown: -1 };

/** Each ship's weapons left to right: [model, effects at their strength (0..15), power in] */
const SHIPS: Record<string, [fn: string, fx: string, rate: number][]> = {
  'mod-showcase-1': [
    ['autocannon_rattler', 'chain:15', 77], ['cannon_pip', 'velocity:15', 51], ['cannon_pip', 'velocity:15 rapid:15 explosive:15 split:15', 51],
    ['cannon_hammer', 'pierce:15', 64], ['autocannon_stinger', 'heavy:15', 93],
  ],
  'beam-split-1': [['laser_glint', 'split:15', 96], ['pulse_strobe', 'split:15', 77], ['laser_cutter', 'split:15', 798], ['lance_lance', 'split:14', 1220]],
  'beam-pierce-1': [['laser_glint', 'pierce:15', 96], ['pulse_strobe', 'pierce:15', 77], ['laser_glint', 'wave:15', 96], ['laser_cutter', 'pierce:15', 798]],
  'beam-ends-1': [['laser_glint', 'explosive:15', 96], ['laser_glint', 'chain:15', 96], ['laser_glint', 'burn:15', 96], ['pulse_strobe', 'burn:15', 77]],
  'beam-stack-1': [['laser_glint', 'split:15 burn:15', 96], ['laser_glint', 'pierce:15 burn:15', 96], ['laser_cutter', 'pierce:11 explosive:8', 798]],
};

describe('the dev example ships', () => {
  const wren = built('ports-wren');

  it('the Wren, the bar: four Ion Drives on 47.8 mass', () => {
    expect(wren.d.mass).toBeCloseTo(47.8, 5);
    expect(wren.thrustToMass).toBeGreaterThan(0.18);
  });

  for (const [name, want] of Object.entries(SHIPS)) {
    describe(name, () => {
      const s = built(name);

      it('is a valid design, all of it standing', () => {
        expect(validateBlueprint(catalog, s.bp, tuning, null, { devParts: true }).errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
        expect(s.d.alive.every(Boolean)).toBe(true);
        expect(new Set(s.bp.parts.map((p) => p.uid)).size).toBe(s.bp.parts.length);
      });

      it('each weapon is in a group of its own, left to right from 1', () => {
        expect(s.guns.length).toBeLessThanOrEqual(WEAPON_GROUPS);
        expect(s.guns.map((g) => g.wg)).toEqual(s.guns.map((_, i) => 1 << i));
      });

      it('each weapon has its modifier effects and its power', () => {
        expect(s.guns.map((g) => [g.fn, g.fx, g.rate])).toEqual(want);
      });

      it('every engine is fed by a generator: boosting with no gun held, the thrust never falls', () => {
        expect(held(s, [], 'boost')).toEqual({ fired: 0, guns: Infinity, engines: 1, firstBrown: -1 });
        // (a store with nothing feeding it would do for a while: every engine's line starts at a generator)
        const L = s.d.ports!, fed = new Uint8Array(L.n);
        for (const g of L.gens) fed[g] = 1;
        for (let pass = 0; pass < L.n; pass++) for (let l = 0; l < L.links; l++) if (fed[L.linkFrom[l]]) fed[L.linkTo[l]] = 1;
        expect(Array.from(L.thrusters).filter((p) => !fed[p])).toEqual([]);
        expect(s.d.weapons.filter((w) => !fed[w.part])).toEqual([]);
      });

      for (let g = 1; g <= want.length; g++) {
        it(`group ${g} (${want[g - 1][0]}) held on its own: full rate for as long as it is held, cruising and boosting`, () => {
          expect(held(s, [g], 'fire')).toEqual({ fired: 1, ...FULL });
          expect(held(s, [g], 'both')).toEqual({ fired: 1, ...FULL });
        });
      }

      it('any two groups held together (both mouse buttons), and all of them, boosting: full rate', () => {
        for (let a = 1; a <= want.length; a++) for (let b = a + 1; b <= want.length; b++) expect([a, b, held(s, [a, b], 'both')]).toEqual([a, b, { fired: 2, ...FULL }]);
        expect(held(s, want.map((_, i) => i + 1), 'both')).toEqual({ fired: want.length, ...FULL });
      });

      it('accelerates at least as hard as the Wren, and not half as hard again', () => {
        expect(s.thrustToMass).toBeGreaterThanOrEqual(wren.thrustToMass);
        expect(s.thrustToMass).toBeLessThan(wren.thrustToMass * 1.5);
      });
    });
  }
});
