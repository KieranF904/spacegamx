import { describe, expect, it } from 'vitest';
import { skyBiome, pickBiome, BIOME_KINDS } from './skyBiome';
import systemsData from '../../../../data/systems.json';

type Sys = { id: string; sector?: string; position?: { x: number; y: number }; centralBody: { type: string }; visuals?: Record<string, any> };
const hintsOf = (s: Sys) => ({
  biome: s.visuals?.biome, sector: s.sector, position: s.position, central: s.centralBody.type,
  hasNebula: s.visuals?.hasNebula, nebulaHue: s.visuals?.nebulaHue, starHueShift: s.visuals?.starHueShift,
  specialStarChance: s.visuals?.specialStarChance, specialStarHue: s.visuals?.specialStarHue,
});

describe('sky biomes', () => {
  it('give each system a fitting kind', () => {
    const kinds = Object.fromEntries((systemsData as { systems: (Sys & { surface?: unknown })[] }).systems.filter((s) => !s.surface && !(s as { private?: boolean }).private && !(s as { pocket?: unknown }).pocket).map((s) => [s.id, pickBiome(s.id, hintsOf(s))]));
    expect(kinds).toEqual({
      sol: 'band', borealis: 'cluster', nebula_prime: 'emission', void_sector: 'void',
      cinder_reach: 'ember', the_maw: 'abyss', glasswater: 'remnant', ashfall: 'ember',
    });
  });

  it('are the same every time for a system, and differ between systems', () => {
    expect(skyBiome('sol', { sector: 'core' })).toEqual(skyBiome('sol', { sector: 'core' }));
    expect(skyBiome('alpha', { sector: 'core' }).band.angle).not.toEqual(skyBiome('beta', { sector: 'core' }).band.angle);
  });

  it('can be named in the data, and make something of any unknown system', () => {
    for (const k of BIOME_KINDS) expect(skyBiome('x', { biome: k }).kind).toBe(k);
    for (let i = 0; i < 50; i++) {
      const b = skyBiome(`system-${i}`);
      expect(BIOME_KINDS).toContain(b.kind);
      for (const v of [...b.base, ...b.band.core, ...b.nebula.a, ...b.nebula.b]) expect(v).toBeGreaterThanOrEqual(0);
      expect(b.band.width).toBeGreaterThan(0);
    }
  });
});
