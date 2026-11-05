import { describe, expect, it } from 'vitest';
import { animOf, lightsLit, reloadShare } from './gunAnim';
import { MODEL_STYLES } from '../rendering/weapons/weaponStyles';

describe('gun animation', () => {
  it('rail lights show the clip, then refill one by one on a reload', () => {
    expect(lightsLit(6, 6, 0, 90)).toBe(6);
    expect(lightsLit(6, 2, 0, 90)).toBe(2);
    expect(lightsLit(6, 0, 90, 90)).toBe(0);
    expect(lightsLit(6, 0, 45, 90)).toBeCloseTo(3, 5);
    expect(lightsLit(6, 0, 1, 90)).toBeGreaterThan(5.9);
  });

  it('the reload glow fades as the clip is seated', () => {
    expect(reloadShare(0, 90)).toBe(0);
    expect(reloadShare(90, 90)).toBe(1);
    expect(reloadShare(30, 90)).toBeCloseTo(1 / 3, 5);
  });

  it('the Rail Driver has six lights, the Chainsaw spins', () => {
    expect(animOf('railgun_rail_driver')?.lights?.n).toBe(6);
    expect(animOf('autocannon_chainsaw')?.spin).toBe(true);
    expect(animOf('cannon_pip')).toBeUndefined();
  });
});

describe('kinetic model styles', () => {
  it('every kinetic model has a look, in amber or yellow (cannons, autocannons, flak) or cyan-white or violet (rails)', () => {
    for (const id of ['cannon_pip', 'cannon_hammer', 'cannon_twinlink', 'cannon_longbarrel', 'cannon_bastion', 'autocannon_rattler', 'autocannon_chainsaw',
      'autocannon_stinger', 'flak_burst', 'flak_cloudmaker', 'railgun_needle', 'railgun_coilgun', 'railgun_spear', 'railgun_rail_driver']) {
      expect(MODEL_STYLES[id], id).toBeDefined();
    }
    expect(MODEL_STYLES.cannon_twinlink.pair).toBeDefined();
    expect(MODEL_STYLES.cannon_longbarrel.contrail).toBeDefined();
    expect(MODEL_STYLES.cannon_bastion.ringPulse).toBeDefined();
    expect(MODEL_STYLES.autocannon_chainsaw.heat).toBeDefined();
    expect(MODEL_STYLES.railgun_spear.contrail?.life).toBeGreaterThanOrEqual(60);
  });
});
