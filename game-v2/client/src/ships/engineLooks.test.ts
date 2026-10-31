import { describe, expect, it } from 'vitest';
import { ENGINE_LOOKS, FROST_PAL, engineLookOf, plumeSpec, puffFlicker, sailRing } from './engineLooks';
import { SHIELD_LOOKS } from './shieldLooks';

const ids = (family: string): string[] => (family === 'ion' ? ['engine_ion_drive', 'engine_vernier', 'engine_afterburner', 'engine_torch', 'engine_plasma_drive', 'engine_drift_sail', 'engine_fusion_torch', 'engine_burst_strafer'] : ['shield_deflector', 'shield_flicker_screen', 'shield_bulwark_projector', 'shield_flash_screen']);

describe('engine looks (rework 2026-11 section 5)', () => {
  it('every engine model has its own look', () => {
    for (const id of ids('ion')) expect(ENGINE_LOOKS[id], id).toBeDefined();
  });

  it('the Torch and Vernier do not grow with boost; the Afterburner blows out blue-white with diamonds', () => {
    const at = (id: string, boost: number) => plumeSpec(engineLookOf(id), 1, boost, 20, 20, 1, 0);
    expect(at('engine_torch', 1).L).toBeCloseTo(at('engine_torch', 0).L, 5);
    expect(at('engine_afterburner', 1).L).toBeGreaterThan(at('engine_afterburner', 0).L * 2);
    expect(at('engine_afterburner', 0).diamonds).toBe(0);
    expect(at('engine_afterburner', 1).diamonds).toBeGreaterThan(0);
    expect(at('engine_afterburner', 1).pal?.shape).toBe('cone');
    expect(at('engine_afterburner', 0).pal?.outer).toBe(0xff8a2a);
  });

  it('the Fusion Torch has the longest plume and the Torch a needle', () => {
    const len = (id: string) => plumeSpec(engineLookOf(id), 1, 0, 20, 20, 1, 0).L;
    for (const id of ['engine_ion_drive', 'engine_afterburner', 'engine_torch', 'engine_plasma_drive']) expect(len('engine_fusion_torch')).toBeGreaterThan(len(id));
    expect(engineLookOf('engine_torch').pal?.shape).toBe('needle');
    expect(engineLookOf('engine_fusion_torch').pal?.shape).toBe('sheath');
  });

  it('puffs and sail rings stay in range', () => {
    for (let t = 0; t < 5; t += 0.07) {
      const f = puffFlicker(t, 1.3);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      const r = sailRing(t, 0.4, 1);
      expect(r.a).toBeGreaterThan(0);
      expect(r.r).toBeGreaterThan(0.5);
    }
    expect(engineLookOf('engine_vernier').kind).toBe('puff');
    expect(engineLookOf('engine_drift_sail').kind).toBe('sail');
  });

  it('every shield model has a bubble look, and only the Flash Screen blooms', () => {
    for (const id of ids('shield')) expect(SHIELD_LOOKS[id], id).toBeDefined();
    expect(Object.entries(SHIELD_LOOKS).filter(([, l]) => l.reform).map(([k]) => k)).toEqual(['shield_flash_screen']);
  });

  it('a slowed ship (a Frostbite beam) has short, pale, icy plumes', () => {
    const look = engineLookOf('engine_ion_drive'), warm = plumeSpec(look, 1, 0, 20, 20, 1, 0), cold = plumeSpec(look, 1, 0, 20, 20, 1, 0, 1);
    expect(cold.L).toBeLessThan(warm.L * 0.6);
    expect(cold.pal).toBe(FROST_PAL);
    expect(plumeSpec(look, 1, 0, 20, 20, 1, 0, 0).L).toBe(warm.L);
  });
});
