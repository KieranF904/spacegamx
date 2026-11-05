import { describe, expect, it } from 'vitest';
import { WeaponType } from '@space-game/common';
import './energyLooks';
import { beamLook, weaponStyle } from '../rendering/weapons/weaponStyles';
import { pulseLook } from './PulseFx';

describe('energy weapon looks', () => {
  it('fixes the Glint red whatever its grade', () => {
    expect(pulseLook(3, 'laser_glint').mid).toBe(0xff5a5a);
  });
  it('gives the beams their signatures', () => {
    expect(beamLook('laser_cutter')?.pool).toBeDefined();
    expect(beamLook('laser_searchlight')?.cone).toBeGreaterThan(0);
    expect(beamLook('lance_lance')?.braid?.strands).toBe(3);
    expect(beamLook('lance_lance')?.sputter).toBeGreaterThan(0);
    expect(beamLook('arc_tesla')?.zap).toBeGreaterThan(0);
  });
  it('gives the shots theirs over their kind', () => {
    expect(weaponStyle(WeaponType.Emp, 1, 'emp_blackout').radiusRing?.radius).toBe(320);
    expect(weaponStyle(WeaponType.Emp, 1, 'emp_hush').radiusRing).toBeUndefined();
    expect(weaponStyle(WeaponType.Arc, 1, 'arc_spark').jagged).toBeDefined();
    expect(weaponStyle(WeaponType.Pulse, 1, 'pulse_overpulse').ringPulse).toBeDefined();
  });
});
