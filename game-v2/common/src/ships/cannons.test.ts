/**
 * The five cannons (docs/design/rework-2026-11.md §4): the table's numbers as the guns resolve them, the Longbarrel's
 * charge (fires itself at tick 120 of a hold, nothing on a release at 114), and the Twinlink's and Bastion's clips.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState, type ShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { stepGuns } from './guns.js';
import { gunDef } from './launch.js';
import type { ShipTuning } from './tuning.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const UP = -Math.PI / 2;
const pose = { x: 0, y: 0, angle: UP };

function armed(model: string): ShipState {
  const b = parseBlueprint(sparrowText);
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = model;
  pips[1].fn = 'hull';
  delete pips[1].facing;
  const s = createShipState(catalog, tuning, 1, b, 0);
  expect(s.derived.weapons).toHaveLength(1);
  return s;
}

function run(s: ShipState, n: number, held: (t: number) => boolean, from = 1) {
  const shots: number[] = [];
  for (let t = from; t < from + n; t++) {
    const r = stepGuns(s, pose, { firing: held(t), aimWorld: UP, aimDist: 0 }, t, tuning);
    if (r.shots.length) shots.push(t);
  }
  return shots;
}

const def = (model: string) => {
  const w = armed(model).derived.weapons[0];
  return { w, d: gunDef(tuning, w.kind, { grade: w.grade, size: w.size, model: w.model }) as unknown as Record<string, number> };
};

describe('cannons', () => {
  it('rows of the section 4 table: damage, speed, size, penetration, range and rate', () => {
    const pip = def('cannon_pip');
    expect(pip.d).toMatchObject({ damage: 14, speed: 48 });
    expect(pip.w.fire).toMatchObject({ model: 'cycle', interval: 15 });
    expect(pip.w.energy).toBeCloseTo(2, 6);

    const hammer = def('cannon_hammer');
    expect(hammer.d.damage).toBeCloseTo(48, 4);
    expect(hammer.d.speed).toBeCloseTo(38, 4);
    expect(hammer.d.size).toBeCloseTo(1.6, 6);
    expect(hammer.d.pen).toBe(1);
    expect(hammer.w.fire).toMatchObject({ model: 'cycle', interval: 42 });
    // (The test ship swaps it onto a one-cell Pip's place; the real Hammer is two cells: 2 x 3.5 = 7 E a shot)
    expect(hammer.w.energy * 2).toBeCloseTo(7, 4);

    const twin = def('cannon_twinlink');
    expect(twin.d.damage).toBeCloseTo(12, 4);
    expect(twin.d.burst ?? 1).toBe(1);
    expect(twin.w.mount).toBe('turret');
    expect(twin.w.fire).toMatchObject({ model: 'clip', clip: 16, interval: 6, reload: 90, reloadE: 24 });

    const long = def('cannon_longbarrel');
    expect(long.d.damage).toBeCloseTo(170, 3);
    expect(long.d.speed).toBeCloseTo(140, 3);
    expect(long.d.life).toBeCloseTo(60, 3);
    expect(long.d.spread).toBe(0);
    expect(long.d.pen).toBe(1);
    expect(long.d.speed * long.d.life).toBeCloseTo(8400, 0);
    expect(long.w.fire).toMatchObject({ model: 'charge', charge: 120, cooldown: 90, chargeE: 36 });

    const bast = def('cannon_bastion');
    expect(bast.d.damage).toBeCloseTo(180, 3);
    expect(bast.d.speed).toBeCloseTo(32, 3);
    expect(bast.d.size).toBeCloseTo(2.2, 6);
    expect(bast.d.pen).toBe(1);
    expect(bast.w.fire).toMatchObject({ model: 'clip', clip: 2, interval: 18, reload: 180, reloadE: 60 });
  });

  it('Longbarrel: a hold fires itself at tick 120 with no further input; a release at 114 fires nothing', () => {
    const held = armed('cannon_longbarrel');
    expect(run(held, 130, () => true)[0]).toBe(120);
    const early = armed('cannon_longbarrel');
    expect(run(early, 300, (t) => t <= 114)).toEqual([]);
    // (Fires itself: let go at the very tick it fills and it still goes)
    const exact = armed('cannon_longbarrel');
    expect(run(exact, 200, (t) => t <= 120)).toEqual([120]);
  });

  it('Twinlink: a clip of 16 at a 6-tick beat, then a 90-tick reload', () => {
    const s = armed('cannon_twinlink');
    const shots = run(s, 400, () => true);
    expect(shots.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => 1 + i * 6));
    expect(shots[16]).toBe(1 + 15 * 6 + 1 + 90);
    expect(shots.filter((t) => t < shots[16]).length).toBe(16);
  });

  it('Bastion: two rounds 18 ticks apart, then a 180-tick reload', () => {
    const s = armed('cannon_bastion');
    const shots = run(s, 600, () => true);
    expect(shots.slice(0, 2)).toEqual([1, 19]);
    expect(shots[2]).toBe(19 + 1 + 180);
    expect(shots[3]).toBe(shots[2] + 18);
    expect(shots.filter((t) => t < shots[2]).length).toBe(2);
  });
});
