import { describe, expect, it } from 'vitest';
import { WeaponType } from '@space-game/common';
import { weaponStyle, shotScale, beamLook, muzzleScale } from './weaponStyles';
import { impactSpan } from './impactSpan';
import { BURST, burstLife, burstSpeed } from './impactAim';
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

  it('mid guns: about a third of a second, a few chips flying on to half a second or more; the big slugs about a second, carried by their outliers', () => {
    for (const [id, s] of all(MID)) {
      expect(s.frames / 60, id).toBeGreaterThan(0.28); expect(s.frames / 60, id).toBeLessThan(0.5);
      expect(s.tailFrames / 60, id).toBeGreaterThan(0.5); expect(s.tailFrames / 60, id).toBeLessThan(0.9);
    }
    for (const [id, s] of all(BIG)) { expect(s.tailFrames / 60, id).toBeGreaterThan(0.95); expect(s.fragments, id).toBeGreaterThanOrEqual(4); }
  });

  it('heavy hits last longer, reach further and throw more fragments than light ones: one to two and a bit seconds, 8 or more fragments', () => {
    const lightMax = Math.max(...Object.values(LIGHT).map((s) => s.frames)), lightFrag = Math.max(...Object.values(LIGHT).map((s) => s.fragments));
    const lightReach = Math.max(...Object.values(LIGHT).map((s) => s.size));
    for (const [id, s] of all(HEAVY)) {
      // (the typical fragment gone in about a second, the outliers carrying it on to one and a half to two)
      expect(s.frames, id).toBeGreaterThan(3 * lightMax);
      expect(s.frames / 60, id).toBeLessThanOrEqual(1.2);
      expect(s.tailFrames / 60, id).toBeGreaterThanOrEqual(1.5);
      expect(s.tailFrames / 60, id).toBeLessThanOrEqual(2.3);
      // the outliers fly far past the typical fragment
      expect(s.tailSize, id).toBeGreaterThan(2 * s.size);
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

  it("a warhead's own mark stays well inside its blast (the detonation is the show) and its sparks are capped", () => {
    // [kind, model, damage a shot, shell size, blast radius] (impact-audit's numbers)
    const WARHEADS = [
      [WeaponType.Missile, 'missile_swarm', 10, 1.5, 60], [WeaponType.Missile, 'missile_dart', 30, 1.5, 120], [WeaponType.Missile, 'missile_hammerhead', 105, 2.25, 150],
      [WeaponType.Torpedo, 'torpedo_eel', 420, 2, 90], [WeaponType.Torpedo, 'torpedo_leviathan', 560, 2.8, 160],
      [WeaponType.Mortar, 'mortar_lobber', 0, 1.6, 220], [WeaponType.Mortar, 'mortar_quake', 0, 1.6, 260], [WeaponType.Flak, 'flak_burst', 5, 1.3, 170],
    ] as const;
    for (const [type, model, dmg, size, blast] of WARHEADS) {
      const st = weaponStyle(type, 1, model);
      expect(st.hit?.core, model).toBeDefined();
      expect(impactSpan(st, size * shotScale(dmg)).size, model).toBeLessThan(0.75 * blast);
    }
  });

  it('muzzle flashes follow the shot through the usual range, never a speck, and grow slower past a heavy launch', () => {
    expect(muzzleScale(0.3)).toBe(0.8);
    expect(muzzleScale(1)).toBe(1);
    expect(muzzleScale(2.5)).toBe(2.5);
    expect(muzzleScale(4.76)).toBeGreaterThan(muzzleScale(3.74));
    expect(muzzleScale(4.76)).toBeLessThan(3.8);
    // a Leviathan's launch is the biggest, but no longer three Bastions
    const flash = (type: number, model: string, damage: number, size: number) => weaponStyle(type, 1, model).muzzle.size * muzzleScale(size * shotScale(damage));
    const lev = flash(WeaponType.Torpedo, 'torpedo_leviathan', 560, 2.8), bastion = flash(WeaponType.Cannon, 'cannon_bastion', 324, 2.2);
    expect(lev).toBeGreaterThan(bastion);
    expect(lev).toBeLessThan(1.6 * bastion);
  });

  it('held beams burn in step with their weight: the Cutter throws fragments, the Searchlight only a sizzle', () => {
    const burn = (id: string) => { const b = beamLook(id)!.burn!; return impactSpan({ ...weaponStyle(WeaponType.Cannon), hit: b.hit }, 1); };
    expect(burn('laser_cutter').fragments).toBeGreaterThan(0);
    expect(burn('laser_cutter').frames).toBeGreaterThan(burn('arc_tesla').frames);
    expect(burn('arc_tesla').frames).toBeGreaterThan(burn('laser_searchlight').frames);
    expect(burn('laser_searchlight').fragments).toBe(0);
  });
});

describe('a burst spreads its fragments', () => {
  // (a fixed sequence of uniform draws: the same every run)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const N = 4000, draws = Array.from({ length: N }, () => ({ s: burstSpeed(BURST.outliers, BURST.outSpeed, rnd(), rnd(), rnd()), l: burstLife(BURST.outliers, BURST.outLife, rnd(), rnd(), rnd()) }));
  it('most near the typical speed and life, a share of outliers much faster or longer-lived', () => {
    // (skewed: the middle fragment a little under the typical, the mean pulled up by the quick few)
    const sp = draws.map((d) => d.s).sort((a, b) => a - b), mean = sp.reduce((t, v) => t + v, 0) / N;
    expect(sp[N >> 1]).toBeGreaterThan(0.6); expect(sp[N >> 1]).toBeLessThan(1);
    expect(mean).toBeGreaterThan(1.05); expect(mean).toBeLessThan(1.4);
    // (twice the typical speed or more; more than half again its life)
    const fast = draws.filter((d) => d.s >= 2).length / N, long = draws.filter((d) => d.l >= 1.6).length / N;
    for (const share of [fast, long]) { expect(share).toBeGreaterThan(0.1); expect(share).toBeLessThan(0.22); }
  });
  it('speed and life drawn apart: fast and short, fast and long, slow and short, slow and long all turn up', () => {
    const fast = (d: { s: number }) => d.s > 1.6, long = (d: { l: number }) => d.l > 1.4;
    expect(draws.some((d) => fast(d) && !long(d))).toBe(true);
    expect(draws.some((d) => fast(d) && long(d))).toBe(true);
    expect(draws.some((d) => !fast(d) && !long(d))).toBe(true);
    expect(draws.some((d) => !fast(d) && long(d))).toBe(true);
  });
});
