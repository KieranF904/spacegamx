import { describe, expect, it } from 'vitest';
import { WeaponType } from '@space-game/common';
import { weaponStyle, shotScale, beamLook } from './weaponStyles';
import { impactSpan } from './impactSpan';
import '../../ships/energyLooks';

/** A gun's hit as its shell lands: its kind, model, damage a shot and shell size (scripts/balance/impact-audit.ts prints them all) */
const span = (type: number, model: string, damage: number, size: number) => impactSpan(weaponStyle(type, 1, model), size * shotScale(damage));
const LIGHT = { pip: span(WeaponType.Cannon, 'cannon_pip', 14, 1), rattler: span(WeaponType.Autocannon, 'autocannon_rattler', 7, 0.6), stinger: span(WeaponType.Autocannon, 'autocannon_stinger', 8, 0.6), chainsaw: span(WeaponType.Autocannon, 'autocannon_chainsaw', 5, 0.6) };
const MID = { spark: span(WeaponType.Arc, 'arc_spark', 29, 1.1), needle: span(WeaponType.Railgun, 'railgun_needle', 62, 0.8) };
const BIG = { hammer: span(WeaponType.Cannon, 'cannon_hammer', 48, 1.6), slurry: span(WeaponType.Cannon, 'cannon_slurry', 65, 1.5), railDriver: span(WeaponType.Railgun, 'railgun_rail_driver', 72, 0.8) };
const HEAVY = { spear: span(WeaponType.Railgun, 'railgun_spear', 256, 0.8), bastion: span(WeaponType.Cannon, 'cannon_bastion', 324, 2.2), longbarrel: span(WeaponType.Cannon, 'cannon_longbarrel', 510, 1) };
const all = (o: Record<string, ReturnType<typeof span>>) => Object.entries(o);

describe('impacts scale with what a gun can do', () => {
  it('light guns stay crisp and quick: a fifth to a third of a second, no fragments', () => {
    for (const [id, s] of all(LIGHT)) {
      expect(s.frames / 60, id).toBeGreaterThanOrEqual(0.15);
      expect(s.frames / 60, id).toBeLessThanOrEqual(0.35);
      expect(s.fragments, id).toBe(0);
    }
  });

  it('mid guns last about half a second with a few chips; the big slugs about a second', () => {
    for (const [id, s] of all(MID)) { expect(s.frames / 60, id).toBeGreaterThan(0.4); expect(s.frames / 60, id).toBeLessThan(0.8); }
    for (const [id, s] of all(BIG)) { expect(s.frames / 60, id).toBeGreaterThan(0.9); expect(s.fragments, id).toBeGreaterThanOrEqual(4); }
  });

  it('heavy hits last longer, reach further and throw more fragments than light ones: one to two and a bit seconds, 8 or more fragments', () => {
    const lightMax = Math.max(...Object.values(LIGHT).map((s) => s.frames)), lightFrag = Math.max(...Object.values(LIGHT).map((s) => s.fragments));
    const lightReach = Math.max(...Object.values(LIGHT).map((s) => s.size));
    for (const [id, s] of all(HEAVY)) {
      expect(s.frames, id).toBeGreaterThan(4 * lightMax);
      expect(s.frames / 60, id).toBeLessThanOrEqual(2.3);
      expect(s.fragments, id).toBeGreaterThanOrEqual(8);
      expect(s.fragments, id).toBeGreaterThan(lightFrag);
      expect(s.size, id).toBeGreaterThan(1.8 * lightReach);
    }
    // an explosion at the surface on every heavy hit
    for (const [type, model] of [[WeaponType.Railgun, 'railgun_spear'], [WeaponType.Cannon, 'cannon_bastion'], [WeaponType.Cannon, 'cannon_longbarrel']] as const) {
      expect(weaponStyle(type, 1, model).hit?.fireball, model).toBeDefined();
    }
    // and each step up lasts longer than the one below it
    const minOf = (o: Record<string, ReturnType<typeof span>>) => Math.min(...Object.values(o).map((s) => s.frames));
    const maxOf = (o: Record<string, ReturnType<typeof span>>) => Math.max(...Object.values(o).map((s) => s.frames));
    expect(minOf(MID)).toBeGreaterThan(maxOf(LIGHT));
    expect(minOf(BIG)).toBeGreaterThan(maxOf(MID));
    expect(minOf(HEAVY)).toBeGreaterThan(maxOf(BIG));
  });

  it('held beams burn in step with their weight: the Cutter throws fragments, the Searchlight only a sizzle', () => {
    const burn = (id: string) => { const b = beamLook(id)!.burn!; return impactSpan({ ...weaponStyle(WeaponType.Cannon), hit: b.hit }, 1); };
    expect(burn('laser_cutter').fragments).toBeGreaterThan(0);
    expect(burn('laser_cutter').frames).toBeGreaterThan(burn('arc_tesla').frames);
    expect(burn('arc_tesla').frames).toBeGreaterThan(burn('laser_searchlight').frames);
    expect(burn('laser_searchlight').fragments).toBe(0);
  });
});
