import { describe, expect, it, afterEach } from 'vitest';
import { WeaponType } from '@space-game/common';
import tuning from '../../../../data/ships/tuning.json';
import { MODEL_STYLES, BEAM_LOOKS, beamLook, clearStyleCache, shotScale, weaponStyle } from './weaponStyles';

afterEach(() => {
  delete MODEL_STYLES.test_fixture;
  delete BEAM_LOOKS.test_beam;
  clearStyleCache();
});

describe('weapon styles', () => {
  it('a model style overrides only the fields it names', () => {
    const kind = weaponStyle(WeaponType.Cannon);
    MODEL_STYLES.test_fixture = { coreColor: 0x123456, pair: { gap: 6 }, casings: 2 };
    const s = weaponStyle(WeaponType.Cannon, 1, 'test_fixture');
    expect(s.coreColor).toBe(0x123456);
    expect(s.pair).toEqual({ gap: 6 });
    expect(s.glowColor).toBe(kind.glowColor);
    // an unknown model keeps the kind's look
    expect(weaponStyle(WeaponType.Cannon, 1, 'nothing_here')).toBe(kind);
  });

  it('the grade scales size and brightness, never the look', () => {
    const k = weaponStyle(WeaponType.Cannon, 1), g5 = weaponStyle(WeaponType.Cannon, 5);
    expect(g5.glowWidth).toBeGreaterThan(k.glowWidth);
    expect(g5.glowColor).toBe(k.glowColor);
    expect(g5.coreColor).toBe(k.coreColor);
    expect(weaponStyle(WeaponType.Cannon, 5)).toBe(g5); // built once
  });

  it('shot scale grows with damage and stays bounded', () => {
    expect(shotScale(undefined)).toBe(1);
    expect(shotScale(14)).toBeCloseTo(1, 5);
    expect(shotScale(420)).toBeGreaterThan(shotScale(62));
    expect(shotScale(1e6)).toBeLessThanOrEqual(1.7);
    expect(shotScale(0.01)).toBeGreaterThanOrEqual(0.75);
  });

  it('beam looks are found by model id', () => {
    expect(beamLook('test_beam')).toBeUndefined();
    BEAM_LOOKS.test_beam = { width: 1.5, cone: 12 };
    expect(beamLook('test_beam')?.cone).toBe(12);
    expect(beamLook(undefined)).toBeUndefined();
  });
});

describe('legendary looks', () => {
  it('the singularity ring is drawn at the radius it pulls ships from', () => {
    const w = (tuning as unknown as { weapons: Record<string, { pull?: { radius: number } }> }).weapons.singularity;
    expect(weaponStyle(WeaponType.Singularity).pull?.radius).toBe(w.pull?.radius);
  });

  it('each legendary names a look of its own', () => {
    for (const id of ['legendary_hive', 'legendary_cinder_bloom', 'legendary_prism', 'legendary_phase', 'legendary_singularity']) expect(MODEL_STYLES[id], id).toBeDefined();
    expect(MODEL_STYLES.legendary_hive.wobble).toBeDefined();
    expect(MODEL_STYLES.legendary_phase.afterimages).toBe(3);
    expect(MODEL_STYLES.legendary_prism.shardHue).toBeGreaterThan(0);
    expect(beamLook('legendary_frostbite')?.frost).toBeGreaterThan(0);
  });
});

describe('impacts by power tier', () => {
  // The projectile guns (models.json infra.tier) whose shots WeaponFx draws; beams (Cutter, Tesla, Lance, Searchlight) are not here
  const TIERS: Record<string, string[]> = {
    heavy: ['cannon_bastion', 'cannon_longbarrel', 'railgun_spear', 'railgun_rail_driver'],
    mid: ['cannon_hammer', 'cannon_slurry', 'railgun_needle', 'railgun_coilgun', 'cannon_twinlink', 'autocannon_chainsaw'],
    simple: ['cannon_pip', 'autocannon_rattler', 'autocannon_stinger'],
  };
  const size = (id: string) => MODEL_STYLES[id].hit?.bloom?.size ?? 0;

  it('heavy guns land the whole stack: core, glow, shock ring, spray, embers, a hull glow', () => {
    for (const id of TIERS.heavy) {
      const h = MODEL_STYLES[id].hit;
      expect(h, id).toBeDefined();
      for (const k of ['core', 'bloom', 'shock', 'spray', 'embers', 'scorch'] as const) expect(h![k], `${id} ${k}`).toBeDefined();
    }
    // the biggest shake for the biggest gun, and a light one at that
    expect(MODEL_STYLES.cannon_bastion.hit?.shake?.strength).toBeLessThanOrEqual(4);
  });

  it('a step down for mid guns, and simple ones stay small and quick', () => {
    const minHeavy = Math.min(...TIERS.heavy.map(size)), maxMid = Math.max(...TIERS.mid.map(size));
    expect(maxMid).toBeLessThan(minHeavy);
    for (const id of TIERS.mid) expect(MODEL_STYLES[id].hit?.shake, id).toBeUndefined();
    for (const id of TIERS.simple) {
      const h = MODEL_STYLES[id].hit!;
      expect(h, id).toBeDefined();
      expect(h.shock ?? h.embers ?? h.scorch ?? h.shake, id).toBeUndefined();
      expect(h.core!.life + (h.bloom?.life ?? 0), id).toBeLessThanOrEqual(12);
      expect(size(id), id).toBeLessThanOrEqual(maxMid);
    }
  });
});
