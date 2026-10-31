import { describe, expect, it, afterEach } from 'vitest';
import { WeaponType } from '@space-game/common';
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
