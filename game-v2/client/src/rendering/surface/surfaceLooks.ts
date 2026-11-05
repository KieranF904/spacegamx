/**
 * How each surface's ground looks (SurfaceRenderer, surfaceShaders.ts): a
 * palette and a set of features per kind of world, and per surface where one
 * should stand apart from others of its kind (Terra Nova's farmland and
 * rivers, Selene's craters and dark maria, Gloam's violet dark, each lava
 * world's own crust). Pure data and the uniform values made from it: no Pixi,
 * so the native stills (scripts/surface-art) draw from the very same numbers.
 *
 * Look only: the ground's height field is never collided against (a surface's
 * solid rock is data/terrain/, drawn by TerrainView).
 */

import type { SurfaceData } from '@space-game/common';

type Kind = SurfaceData['kind'];
export type Rgb = [number, number, number];

export interface SurfaceLook {
  /** Sea level, snow line (of the land's height) and cloud cover (0..1) */
  sea: number; snow: number; cloud: number;
  deep: number; shallow: number; shore: number; low: number; high: number; rock: number; peak: number; haze: number; urban: number;
  /** Dry ground (terran scrub and ripe crops; ice: bare blue ice; lava: ash; rocky: the maria's dark basalt) */
  dry: number;
  /** Bare earth (terran ploughed fields; rocky: fresh ejecta; ice: crevasse blue; lava: the crust's glow) */
  soil: number;
  /** The colour of the sky's light in the shade (shadows take it, not just black) */
  skylight: number;
  /** The sun's colour on the ground */
  sunlight: number;
  /** Which shader path draws it: 0 terran, 1 rocky, 2 ice, 3 lava, 4 desert, 5 toxic */
  style: number;
  /** Forest cover, rivers, farmland, craters (0..1 each) */
  forest: number; rivers: number; fields: number; craters: number;
  /** Relief (how strongly slopes are shaded), fine detail, cracks (ice floes, lava crust), moisture bias */
  relief: number; detail: number; cracks: number; moisture: number;
  /** How thick the air is (haze at altitude; 0: airless, crisp black shade) */
  atmosphere: number;
  /** Ripples (dunes of sand, ash, wind-cut snow) */
  ripples: number;
  /** The clouds' colour (white; ash and smoke over lava) */
  cloudTint: number;
  /** Night's light (a moon siege's nights): what the ground keeps of each colour at full dark, and dusk's (and dawn's) warm light */
  nightTint: number; duskTint: number;
}

const STYLE: Record<Kind, number> = { terran: 0, rocky: 1, ice: 2, lava: 3, desert: 4, toxic: 5, cavern: 3 };

const BASE: Record<Kind, SurfaceLook> = {
  terran: {
    sea: 0.47, snow: 0.8, cloud: 0.36,
    deep: 0x0b2a4a, shallow: 0x1d6f86, shore: 0xd2c08f, low: 0x689449, high: 0x2c5428, rock: 0x7a7262, peak: 0xf1f5f8, haze: 0xb4cde6, urban: 0x8d939b,
    dry: 0xb7a35a, soil: 0x7a5a3c, skylight: 0x5d7fa8, sunlight: 0xfff4e0,
    style: 0, forest: 0.55, rivers: 0.6, fields: 0.0, craters: 0, relief: 0.9, detail: 1, cracks: 0, moisture: 0, atmosphere: 1, ripples: 0, cloudTint: 0xffffff,
    nightTint: 0x29334f, duskTint: 0xffa070,
  },
  rocky: {
    sea: 0.0, snow: 0.95, cloud: 0.05,
    deep: 0x3a3631, shallow: 0x4a453e, shore: 0x8a8174, low: 0x8d877c, high: 0x77726a, rock: 0x5d5952, peak: 0xb8b3a8, haze: 0xc8c2b8, urban: 0x7d8086,
    dry: 0x4f4c48, soil: 0xbdb7aa, skylight: 0x2a2c34, sunlight: 0xfffaf0,
    style: 1, forest: 0, rivers: 0, fields: 0, craters: 0.8, relief: 0.55, detail: 1, cracks: 0.2, moisture: 0, atmosphere: 0.1, ripples: 0, cloudTint: 0xffffff,
    nightTint: 0x29334f, duskTint: 0xffa878,
  },
  desert: {
    sea: 0.0, snow: 0.95, cloud: 0.1,
    deep: 0x7a5a3a, shallow: 0x8a6a48, shore: 0xd8b07a, low: 0xc99a62, high: 0xb07a48, rock: 0x8a5a3a, peak: 0xe3c08f, haze: 0xe6c9a4, urban: 0x9a8f80,
    dry: 0xdcb47c, soil: 0x9a6a40, skylight: 0x8a7a8c, sunlight: 0xfff0d8,
    style: 4, forest: 0, rivers: 0, fields: 0, craters: 0.1, relief: 0.8, detail: 1, cracks: 0, moisture: 0, atmosphere: 0.8, ripples: 1, cloudTint: 0xffffff,
    nightTint: 0x2f2c4a, duskTint: 0xff9a5c,
  },
  ice: {
    sea: 0.36, snow: 0.55, cloud: 0.35,
    deep: 0x0f2a48, shallow: 0x2f6488, shore: 0xcfe0ee, low: 0xd8e3ee, high: 0xb8cce0, rock: 0x4f5866, peak: 0xffffff, haze: 0xe2eefa,
    urban: 0x9aa4ae, dry: 0x7fb4dc, soil: 0x2f6e9c, skylight: 0x5a7fb8, sunlight: 0xfffaf2,
    style: 2, forest: 0, rivers: 0, fields: 0, craters: 0, relief: 0.6, detail: 1, cracks: 0.8, moisture: 0, atmosphere: 0.9, ripples: 0.7, cloudTint: 0xffffff,
    nightTint: 0x2e3f62, duskTint: 0xff9e88,
  },
  lava: {
    sea: 0.42, snow: 0.95, cloud: 0.3,
    deep: 0xff4a12, shallow: 0xffa040, shore: 0x2a201d, low: 0x3a302c, high: 0x2b2321, rock: 0x241c1a, peak: 0x4e403a, haze: 0x5a2a1a, urban: 0x5a5658,
    dry: 0x55504c, soil: 0xff6a1c, skylight: 0x4a2a24, sunlight: 0xffd8b0,
    style: 3, forest: 0, rivers: 0, fields: 0, craters: 0.15, relief: 0.8, detail: 1, cracks: 0.6, moisture: 0, atmosphere: 0.8, ripples: 0.5, cloudTint: 0x8a7268,
    nightTint: 0x3c2226, duskTint: 0xff8a4c,
  },
  cavern: {
    sea: 0.0, snow: 1.0, cloud: 0.0,
    deep: 0xff5a14, shallow: 0xffa040, shore: 0x1a1416, low: 0x1c1517, high: 0x1c1517, rock: 0x1c1517, peak: 0x1c1517, haze: 0x5a2416, urban: 0x1c1517,
    dry: 0x1c1517, soil: 0xff5a14, skylight: 0x000000, sunlight: 0x000000,
    style: 3, forest: 0, rivers: 0, fields: 0, craters: 0, relief: 0, detail: 0, cracks: 0, moisture: 0, atmosphere: 0, ripples: 0, cloudTint: 0xffffff,
    nightTint: 0xffffff, duskTint: 0xffffff,
  },
  toxic: {
    sea: 0.45, snow: 0.95, cloud: 0.6,
    deep: 0x2d4a14, shallow: 0x7fae2c, shore: 0x8a8a4a, low: 0x6b6a3a, high: 0x4f5a2a, rock: 0x5a5440, peak: 0xa8a87a, haze: 0xb8c27a, urban: 0x7c8270,
    dry: 0x8a8040, soil: 0x5a4a2a, skylight: 0x5a6a3a, sunlight: 0xf4ffd8,
    style: 5, forest: 0.35, rivers: 0.3, fields: 0, craters: 0, relief: 0.9, detail: 1, cracks: 0, moisture: 0.2, atmosphere: 1.2, ripples: 0, cloudTint: 0xffffff,
    nightTint: 0x27391f, duskTint: 0xe8c070,
  },
};

/** Surfaces that stand apart from others of their kind (by system id) */
export const BY_SURFACE: Record<string, Partial<SurfaceLook>> = {
  // A living temperate world: forests, meadows, rivers, farmland round New Meridian
  terra_nova_surface: { fields: 1, rivers: 0.8, forest: 0.6 },
  // Terra Nova's moon: airless grey regolith, dark maria, craters on craters
  selene_siege: { craters: 1, cracks: 0, atmosphere: 0, skylight: 0x1c1e24, low: 0x9a958c, high: 0x86827a, dry: 0x55534f, peak: 0xc4c0b6 },
  // A dead moon lit by an accretion disk: dark, violet, fractured
  gloam_siege: {
    craters: 0.55, cracks: 0.7, atmosphere: 0.05,
    low: 0x575262, high: 0x484352, rock: 0x3a3642, peak: 0x787088, dry: 0x302c3a, soil: 0x9a8fba, shore: 0x55505e,
    skylight: 0x2a2048, sunlight: 0xd8ccff, haze: 0x3a3050, nightTint: 0x2c2152, duskTint: 0xd890c0,
  },
  // Glacia's moon: rougher, more rock showing, less sea
  rimeholt_siege: { sea: 0.3, snow: 0.45, rock: 0x5f6d80, cracks: 1, ripples: 1, nightTint: 0x2c4470 },
  // A molten planet, its crust cracking: ash plains, glowing seams
  ashfall_surface: { sea: 0.4, cracks: 0.8, ripples: 0.8 },
  // The ember giant's moon: mostly crusted over, dim red seams
  cinderhold_siege: { sea: 0.44, cracks: 1, deep: 0xe0380e, shallow: 0xff8a30, soil: 0xd8400e, dry: 0x4a4440 },
  // Near the disk, burning: open bright lava, yellow-hot
  lastlight_siege: { sea: 0.45, cracks: 0.55, deep: 0xff5a10, shallow: 0xffc050, soil: 0xff9a2a, haze: 0x6a3418 },
  // A foundry's floor: lava kept in check under a heavy crust
  halcyon_foundry: { sea: 0.42, cracks: 0.9, deep: 0xff5410, shallow: 0xffa848, dry: 0x4c4744 },
};

export function lookFor(s: Pick<SurfaceData, 'kind'> & { id?: string }): SurfaceLook {
  const base = BASE[s.kind] ?? BASE.rocky;
  const own = (s.id && BY_SURFACE[s.id]) || {};
  return { ...base, ...own, style: STYLE[s.kind] ?? base.style };
}

/** The palettes from before the art pass (the classic shader's: SurfaceRenderer's dev toggle) */
export const CLASSIC: Record<Kind, { sea: number; snow: number; cloud: number; deep: number; shallow: number; shore: number; low: number; high: number; rock: number; peak: number; haze: number; urban: number }> = {
  terran: { sea: 0.47, snow: 0.8, cloud: 0.36, deep: 0x0d2c4f, shallow: 0x1f6a8f, shore: 0xcdbb8b, low: 0x5b8a3e, high: 0x2e5a2b, rock: 0x75705f, peak: 0xeef3f6, haze: 0xb9d3ea, urban: 0x8d939b },
  rocky: { sea: 0.0, snow: 0.9, cloud: 0.05, deep: 0x3a3631, shallow: 0x4a453e, shore: 0x8a8174, low: 0x8a8174, high: 0x6d665c, rock: 0x5a544c, peak: 0xb8b2a6, haze: 0xc8c2b8, urban: 0x7d8086 },
  desert: { sea: 0.0, snow: 0.95, cloud: 0.1, deep: 0x7a5a3a, shallow: 0x8a6a48, shore: 0xd8b07a, low: 0xc99a62, high: 0xb07a48, rock: 0x8a5a3a, peak: 0xe3c08f, haze: 0xe6c9a4, urban: 0x9a8f80 },
  ice: { sea: 0.36, snow: 0.55, cloud: 0.35, deep: 0x1f3f63, shallow: 0x3f78a0, shore: 0xcfe0ee, low: 0xdfe9f2, high: 0xb9cfe2, rock: 0x8aa0b6, peak: 0xffffff, haze: 0xe8f2fb, urban: 0x9aa4ae },
  lava: { sea: 0.42, snow: 0.95, cloud: 0.3, deep: 0xff4a12, shallow: 0xffa040, shore: 0x2a201d, low: 0x3a2f2c, high: 0x2d2422, rock: 0x241c1a, peak: 0x4a3a34, haze: 0x5a2a1a, urban: 0x5a5658 },
  cavern: { sea: 0.0, snow: 1.0, cloud: 0.0, deep: 0xff5a14, shallow: 0xffa040, shore: 0x1a1416, low: 0x1c1517, high: 0x1c1517, rock: 0x1c1517, peak: 0x1c1517, haze: 0x5a2416, urban: 0x1c1517 },
  toxic: { sea: 0.45, snow: 0.95, cloud: 0.6, deep: 0x2d4a14, shallow: 0x7fae2c, shore: 0x8a8a4a, low: 0x6b6a3a, high: 0x4f5a2a, rock: 0x5a5440, peak: 0xa8a87a, haze: 0xb8c27a, urban: 0x7c8270 },
};

/** The look to draw: the art pass's, or (classic) the palette from before it with no features */
export function lookOf(s: Pick<SurfaceData, 'kind'> & { id?: string }, classic: boolean): SurfaceLook {
  return classic ? { ...lookFor(s), ...(CLASSIC[s.kind] ?? CLASSIC.rocky), cloudTint: 0xffffff } : lookFor(s);
}

export const hexRgb = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

/**
 * Darkness `n` (0 day .. 1 night) as light: what the ground keeps of each
 * colour, and what the lighting's ambient and the sun keep. Dusk (and dawn,
 * on the way back) passes through the warm `duskTint`, strongest half way;
 * full night is the cold `nightTint` (the lighting darker still: headlights
 * and lamps carry the night).
 */
export function nightShade(l: Pick<SurfaceLook, 'nightTint' | 'duskTint'>, n: number): { ground: Rgb; ambient: Rgb; sun: Rgb } {
  const k = Math.max(0, Math.min(1, n));
  const d = Math.pow(Math.sin(Math.PI * k), 1.5);
  const night = hexRgb(l.nightTint), dusk = hexRgb(l.duskTint);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const ground = [0, 1, 2].map((i) => mix(1, night[i], k) * mix(1, dusk[i], d * 0.6)) as Rgb;
  const ambient = [0, 1, 2].map((i) => mix(1, night[i] * 0.62, k) * mix(1, dusk[i], d * 0.6)) as Rgb;
  const sun = [0, 1, 2].map((i) => mix(1, dusk[i], d * 0.85)) as Rgb;
  return { ground, ambient, sun };
}

/** The ground shader's look uniforms, as plain values (SurfaceRenderer sets them; the stills harness too) */
export function lookUniforms(l: SurfaceLook): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = {};
  const colours = ['deep', 'shallow', 'shore', 'low', 'high', 'rock', 'peak', 'haze', 'urban', 'dry', 'soil', 'skylight', 'sunlight'] as const;
  for (const c of colours) out['u' + c[0].toUpperCase() + c.slice(1)] = hexRgb(l[c]);
  out.uFeat = [l.forest, l.rivers, l.fields, l.craters];
  out.uFeat2 = [l.relief, l.detail, l.cracks, l.moisture];
  out.uStyle = [l.style, l.atmosphere, l.ripples, 0];
  return out;
}
