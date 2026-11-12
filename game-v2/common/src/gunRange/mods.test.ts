/** The gun range's weapon modifiers (mods.ts, cheatShip.ts): every gun takes every effect, at full strength, live on every shot. */

import { describe, it, expect } from 'vitest';
import { validateBlueprint } from '../ships/blueprint.js';
import { createShipState } from '../ships/state.js';
import { stepGuns } from '../ships/guns.js';
import { shipGunFx } from '../ships/launch.js';
import { FX_MAX, FX_STEPS } from '../ships/modifiers/types.js';
import { buildCheatShip, isRangeWeapon } from './cheatShip.js';
import { rangeGunModded, rangeModNeed } from './mods.js';
import { cleanRangeMods, gunRangeMods } from './options.js';
import type { ShipTuning } from '../ships/tuning.js';
import { readShipJson, testCatalog } from '../ships/testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const mt = tuning.modifiers!;
const all = [...catalog.functions.values()].filter((f) => f.model && f.weapon && isRangeWeapon(catalog, f.id)).map((f) => f.id);
const guns = all.filter((g) => rangeGunModded(catalog, g)), ammo = all.filter((g) => !rangeGunModded(catalog, g));

/** The cheat ship with these effects, checked valid: its one gun's effects by name, and their strength steps */
function fly(gun: string, effects: string[]) {
  const bp = buildCheatShip(catalog, gun, { tuning: mt, effects })!;
  expect(bp.range).toBe(true);
  expect(bp.parts[0].fn).toBe(gun);
  expect(validateBlueprint(catalog, bp, tuning, null).errors.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
  const ship = createShipState(catalog, tuning, 1, bp, 0);
  expect(ship.derived.alive.every(Boolean)).toBe(true);
  const ws = ship.derived.weapons.filter((w) => w.uid >= 0);
  expect(ws.length).toBe(1);
  const fx = shipGunFx(ship, ws[0].part) ?? [];
  return { bp, ship, w: ws[0], names: fx.map((f) => mt.effects[f.fx]), q: fx.map((f) => f.q) };
}

describe('gun range weapon modifiers', () => {
  it('every effect has its parts', () => {
    for (const e of mt.effects) expect(rangeModNeed(catalog, mt, e), e).toBeTruthy();
  });

  it.each(guns)('%s: carries each effect alone, at full strength, on a valid ship', (gun) => {
    for (const e of mt.effects) {
      const r = fly(gun, [e]);
      expect(r.names, e).toEqual([e]);
      expect(r.q, e).toEqual([FX_STEPS]);
    }
  });

  it.each(guns)('%s: carries four effects together', (gun) => {
    for (const set of [['explosive', 'chain', 'burn', 'hyper'], ['pierce', 'wave', 'heavy', 'split'], ['velocity', 'rapid', 'pierce', 'hyper']]) {
      const r = fly(gun, set);
      expect([...r.names].sort(), set.join()).toEqual([...set].sort());
      expect(r.q).toEqual([FX_STEPS, FX_STEPS, FX_STEPS, FX_STEPS]);
    }
  });

  it('a gun fed by ammunition alone takes none (its shot spends no energy to treat): the plain ship', () => {
    expect(guns.length).toBeGreaterThanOrEqual(30);
    expect(ammo).toContain('missile_dart');
    for (const gun of ammo) expect(buildCheatShip(catalog, gun, { tuning: mt, effects: ['velocity', 'burn'] }), gun).toEqual(buildCheatShip(catalog, gun));
  });

  it('with none it is the ship it always was', () => {
    for (const gun of all) expect(buildCheatShip(catalog, gun, { tuning: mt, effects: [] })).toEqual(buildCheatShip(catalog, gun));
  });

  it('every shot of it carries every effect: no power, hopper or upkeep decides it', () => {
    for (const gun of ['cannon_pip', 'laser_glint', 'pulse_strobe']) {
      const r = fly(gun, ['explosive', 'burn']);
      let seen = 0;
      for (let t = 1; t <= 600 && !seen; t++) {
        const out = stepGuns(r.ship, { x: 0, y: 0, angle: -Math.PI / 2 } as never, { firing: true, aimWorld: -Math.PI / 2, aimDist: 400 }, t, tuning);
        seen = out.shots[0]?.fx ?? out.pulses[0]?.fx ?? out.beamFx?.[0] ?? 0;
      }
      expect(seen, gun).toBe(3);
    }
  });

  it('a rapid gun fires faster there', () => {
    const shots = (effects: string[]) => {
      const r = fly('cannon_pip', effects.length ? effects : ['velocity']);
      let n = 0;
      for (let t = 1; t <= 600; t++) n += stepGuns(r.ship, { x: 0, y: 0, angle: -Math.PI / 2 } as never, { firing: true, aimWorld: -Math.PI / 2, aimDist: 400 }, t, tuning).shots.length;
      return n;
    };
    expect(shots(['rapid'])).toBeGreaterThan(shots([]) * 1.2);
  });
});

describe('gun range modifier options', () => {
  const level = (fn: string) => catalog.functions.get(fn)!.unlock!.level;
  it('every pilot is offered every effect, whatever their level (the parts themselves still unlock by level)', () => {
    expect(level('mod_arc')).toBeGreaterThan(0);
    expect(gunRangeMods(catalog, mt, { level: 0 })).toEqual(mt.effects);
    expect(gunRangeMods(catalog, mt, { level: 50 })).toEqual(mt.effects);
    expect(gunRangeMods(catalog, mt)).toEqual(mt.effects);
    expect(gunRangeMods(catalog, undefined, { level: 50 })).toEqual([]);
  });

  it('what is asked for is cut to theirs, each once, no more than a gun carries', () => {
    const mine = ['velocity', 'rapid', 'explosive', 'split', 'pierce'];
    expect(cleanRangeMods(mine, ['split', 'chain', 'split', 'velocity', 7])).toEqual(['velocity', 'split']);
    expect(cleanRangeMods(mine, [...mine])).toHaveLength(FX_MAX);
    expect(cleanRangeMods(mine, 'split')).toEqual([]);
  });
});
