import { describe, expect, it } from 'vitest';
import { ROCK_MATERIALS, ROCK_TILE, buildRockAtlas, rockVeins } from './rockTextures';
import { rockMaterial } from './RockMaterials';
import { drawAsteroid } from '../AsteroidLook';
import { Container } from 'pixi.js';
import miningData from '../../../../data/mining.json';

const types = (miningData as unknown as { types: Record<string, { ores: Record<string, number>; hardness: number; gas?: boolean }> }).types;
const compOf = (type: string) => {
  const t = types[type], total = Object.values(t.ores).reduce((a, b) => a + b, 0), ores: Record<string, number> = {};
  for (const [o, w] of Object.entries(t.ores)) ores[o] = w / total;
  const primary = Object.entries(ores).sort((a, b) => b[1] - a[1])[0][0];
  return { type, ores, primary, hardness: t.hardness, seam: null, units: 100 };
};

describe('asteroid materials', () => {
  it('gives every rock type a material that suits it', () => {
    const want: Record<string, string> = {
      asteroid_metal: 'stone', asteroid_ice: 'ice', asteroid_fuel: 'ice', asteroid_crystal: 'crystal', asteroid_mega: 'metal', comet: 'ice',
      rock_cuprite: 'metal', rock_rutile: 'metal', rock_slag: 'metal', rock_gem_seam: 'crystal', rock_polymer_tar: 'tar', rock_chromite: 'metal',
      rock_cobaltite: 'metal', rock_platinoid: 'metal', rock_opal_husk: 'crystal', rock_ashback: 'stone', rock_aurora_floe: 'ice', rock_leestone: 'leestone',
    };
    for (const [type, mat] of Object.entries(want)) expect(rockMaterial(compOf(type)), type).toBe(mat);
    expect(rockMaterial(undefined)).toBe('stone');
  });

  it('builds a tile per material, centred, with greyseam everywhere but ice', () => {
    const atlas = buildRockAtlas();
    expect(atlas.length).toBe(ROCK_TILE * 3 * ROCK_TILE * 2 * 4);
    ROCK_MATERIALS.forEach((mat, mi) => {
      const ox = (mi % 3) * ROCK_TILE, oy = Math.floor(mi / 3) * ROCK_TILE;
      let sx = 0, n = 0;
      for (let j = 0; j < ROCK_TILE; j += 7) for (let i = 0; i < ROCK_TILE; i += 7) { sx += atlas[((oy + j) * ROCK_TILE * 3 + ox + i) * 4]; n++; }
      // slopes average out flat (128)
      expect(Math.abs(sx / n - 127.5), mat).toBeLessThan(8);
      const veins = rockVeins(mat).reduce((a, b) => a + b, 0);
      if (mat === 'ice') expect(veins).toBe(0); else expect(veins).toBeGreaterThan(100);
    });
  });

  it('gives big rocks finer geometry, small ones the usual', () => {
    const tris = (size: number) => drawAsteroid(new Container(), 42, size, compOf('asteroid_metal')).rock.geometry.idx.length / 3;
    expect(tris(150)).toBeLessThan(tris(400));
    expect(tris(400)).toBeLessThan(tris(900));
    expect(tris(900)).toBeLessThan(tris(2000));
  });

  it('gives each rock its material, and a light mesh far lighter than its full one', () => {
    for (const type of Object.keys(types).filter((t) => !types[t].gas)) {
      const { rock } = drawAsteroid(new Container(), 42, 60, compOf(type));
      const g = rock.geometry, verts = g.vertexCount;
      expect(g.surf.length).toBe(verts * 4);
      expect(g.smo.length).toBe(verts * 3);
      expect(g.mat.length).toBe(verts * 4);
      expect(g.mat[0]).toBe(ROCK_MATERIALS.indexOf(rockMaterial(compOf(type))));
      // every vertex knows the rock's size (the shader's pick by size on screen)
      for (let i = 3; i < g.surf.length; i += 4) expect(g.surf[i]).toBe(60);
      let light = 0;
      for (let i = 3; i < g.mat.length; i += 4) if (g.mat[i] === 1) light++;
      expect(light).toBeGreaterThan(0);
      expect(light).toBeLessThan((verts - light) / 4);
    }
  });
});
