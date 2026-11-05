/**
 * The sky behind a still (bg=starfield, sky=<system or biome>): SkyRenderer's setBiome and update, worked out as plain
 * uniform values (the camera still: no streak, no black-hole lens), for the GL worker to give the game's own haze and star
 * shaders (skyShaders.ts, read as they are). The noise texture is the game's too (noiseTexture.ts).
 */

import { BIOME_KINDS, skyBiome } from '../../client/src/rendering/sky/skyBiome';
import { skyNoiseTexture } from '../../client/src/rendering/sky/noiseTexture';
import { skyVert, hazeFrag, starsFrag } from '../../client/src/rendering/sky/skyShaders';

const SKY_DEPTH = 80, SKY_TILE = 320000, MOTE_DEPTH = 0.3;
/** SkyRenderer's star layers, near to far (it keeps them to itself) */
const LAYERS = [{ depth: 2, px: 240 }, { depth: 4.5, px: 140 }, { depth: 10, px: 82 }, { depth: 22, px: 46 }, { depth: 45, px: 26 }, { depth: SKY_DEPTH, px: 15 }];
const scaleAt = (zoom: number, depth: number) => 1 / (1 / zoom + depth);
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export const toDesktop = (s: string) => s.replace(/^#version 300 es/, '#version 330 core');
export const SKY_SHADERS = { skyVert: toDesktop(skyVert), hazeFrag: toDesktop(hazeFrag), starsFrag: toDesktop(starsFrag) };

/** The noise texture's RGBA bytes (256²) */
export function skyNoise(): { data: Uint8Array; size: number } {
  const src = skyNoiseTexture().source as unknown as { resource: Uint8Array; width: number };
  return { data: src.resource, size: src.width };
}

export interface SkyUniforms { haze: Record<string, number | number[]>; stars: Record<string, number | number[]> }

/** `w`, `h`: the view in CSS px (the shaders work in them whatever the export scale), `zoom` CSS px per world unit, `cam` the world point at its middle */
export function skyUniforms(sky: string, w: number, h: number, zoom: number, cam: [number, number], time: number): SkyUniforms {
  const b = skyBiome(sky, (BIOME_KINDS as readonly string[]).includes(sky) ? { biome: sky as typeof BIOME_KINDS[number] } : {});
  const zSky = scaleAt(zoom, SKY_DEPTH);
  const shared: Record<string, number | number[]> = {
    uCamera: cam, uRes: [w, h], uRot: [1, 0], uSky: [zSky, SKY_TILE, b.seed[0], b.seed[1]],
    uBand: [-Math.sin(b.band.angle), Math.cos(b.band.angle), b.band.offset, b.band.width], uField: [b.dust.strength, b.nebula.cover, 0, 0],
    uLens: [0, 0, 0, 0],
  };
  const haze = {
    ...shared, uBase: b.base, uBandCore: b.band.core, uBandEdge: b.band.edge, uBandStrength: b.band.strength, uDustTint: b.dust.tint,
    uNebA: b.nebula.a, uNebB: b.nebula.b, uNebStrength: b.nebula.strength, uFilColor: b.filaments.color, uFilStrength: b.filaments.strength,
    uShell: [b.shell.x, b.shell.y, b.shell.radius, b.shell.strength], uShellColor: b.shell.color,
  };
  const stars: Record<string, number | number[]> = {
    ...shared, uTime: time, uStarMix: [b.stars.temperature, b.stars.brightness, b.stars.bandBoost, b.stars.spikes], uTint: b.stars.tint, uMoteColor: b.moteColor,
    uSpike: [Math.cos(b.stars.spikeAngle), Math.sin(b.stars.spikeAngle)], uStreak: [0, 0],
  };
  const dens = Math.sqrt(b.stars.density);
  LAYERS.forEach((L, i) => {
    const z = scaleAt(zoom, L.depth), cell = L.px / dens / scaleAt(1, L.depth), ratio = (cell * z) / (L.px / dens);
    stars[`uL${i}`] = [z, cell, Math.min(1, ratio * ratio), smooth(0.28, 0.55, ratio)];
  });
  stars.uMotes = [scaleAt(zoom, MOTE_DEPTH), 140 / scaleAt(1, MOTE_DEPTH), 0.32 * b.motes * smooth(0.15, 0.5, zoom), 0];
  stars.uDeep = [zSky, 700 / scaleAt(1, SKY_DEPTH), b.deep.galaxies, b.deep.clusters];
  return { haze, stars };
}
