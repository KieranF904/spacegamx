/**
 * The railguns (docs/design/rework-2026-11.md section 4): the Needle on ammo, the Coilgun's cone, the Spear's pierce at full damage,
 * and the Rail Driver rifle (a clip of four at 12 ticks, a 90-tick reload drawing 48 E, no ammo). Numbers as docs/design/heavier-shots-2026-11.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState, type ShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { stepGuns } from './guns.js';
import { gunDef, volleyAngles, launchShot } from './launch.js';
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
  return createShipState(catalog, tuning, 1, b, 0);
}

const defOf = (s: ShipState) => { const w = s.derived.weapons[0]; return gunDef(tuning, w.kind, { model: w.model, grade: w.grade, size: w.size }); };

describe('railguns', () => {
  it('the Rail Driver fires four, reloads for 90 ticks, and spends no ammo', () => {
    const s = armed('railgun_rail_driver');
    const w = s.derived.weapons[0];
    const def = defOf(s);
    expect(def.ammo).toBeNull();
    expect(def).toMatchObject({ damage: 60, pierce: 1, speed: 150 });
    expect(w.fire).toMatchObject({ model: 'clip', clip: 4, interval: 12, reload: 90, reloadE: 48 });
    const shots: number[] = [];
    for (let t = 1; t < 300; t++) {
      const r = stepGuns(s, pose, { firing: t % 2 === 1, aimWorld: UP, aimDist: 0 }, t, tuning);
      for (const sh of r.shots) { shots.push(t); expect(sh.shot.ammo).toBeFalsy(); }
    }
    expect(shots.slice(0, 4)).toEqual([1, 13, 25, 37]);
    // (The fourth shot empties it; the reload starts the next tick and takes 90, then the next clip begins)
    expect(shots[4] - shots[3]).toBe(1 + 90);
    expect(shots.slice(4, 8).map((t) => t - shots[4])).toEqual([0, 12, 24, 36]);
  });

  it('the Coilgun throws three slugs in a 6 degree cone, 25 damage each, reaching 2,700', () => {
    const s = armed('railgun_coilgun');
    const w = s.derived.weapons[0];
    const def = defOf(s);
    expect(def).toMatchObject({ burst: 3, damage: 25, pierce: 1, life: 18, speed: 150 });
    expect(def.ammo).toBeNull();
    expect((def.life ?? 0) * (def.speed ?? 0)).toBe(2700);
    expect(w.fire).toMatchObject({ model: 'cycle', interval: 54 });
    const angles = volleyAngles(def, 0);
    expect(angles).toHaveLength(3);
    expect((Math.max(...angles) - Math.min(...angles)) * 180 / Math.PI).toBeCloseTo(6, 6);
    // The fan is exact: no scatter, so every slug flies where the cone puts it
    const shape = { speedScale: 1, sizeScale: 1, turret: false };
    angles.forEach((a, i) => {
      const l = launchShot(def, 'railgun', shape, a, 0, 0, 7, `k:${i}`);
      expect(Math.abs(Math.atan2(l.vy, l.vx) - a)).toBeLessThan(1e-9);
    });
  });

  it('the Spear pierces three ships at full damage; the Needle two, on ammo', () => {
    const spear = defOf(armed('railgun_spear'));
    expect(spear).toMatchObject({ damage: 160, pierce: 3, pierceKeep: 1 });
    expect(spear.ammo).toBeNull();
    expect(armed('railgun_spear').derived.weapons[0].fire).toMatchObject({ model: 'cycle', interval: 114 });
    const needle = armed('railgun_needle');
    expect(defOf(needle)).toMatchObject({ damage: 90, pierce: 2, speed: 150, ammo: { item: 'railgun_slugs', rounds: 200 } });
    expect(needle.derived.weapons[0].fire).toMatchObject({ model: 'ammo', interval: 75 });
  });

  it('a cycle railgun draws its section 4 energy a shot', () => {
    for (const [id, e] of [['railgun_coilgun', 14], ['railgun_spear', 120]] as const) {
      const fn = catalog.functions.get(id)!;
      // (The test ship seats it on a one-cell piece, so the draw is taken at the model's own piece)
      const area = { rect2: 2, block2: 4 }[fn.pieces![0] as string]!;
      expect((fn.demand! * area * fn.fire!.interval) / 60).toBeCloseTo(e, 0);
    }
  });
});

describe('semi-automatic: one click, one shot', () => {
  it('holding the trigger fires once', () => {
    const s = armed('railgun_rail_driver');
    let held = 0;
    for (let t = 1; t < 120; t++) held += stepGuns(s, pose, { firing: true, aimWorld: UP, aimDist: 0 }, t, tuning).shots.length;
    expect(held).toBe(1);
  });
});
