/**
 * Sky biomes: what the sky looks like around a system, made from the system's
 * id (the seed) and a few hints from its data (central body, nebula hue, star
 * hue shift, where it sits in the galaxy). Nothing is drawn by hand: a system
 * gets an archetype, and the archetype's ranges are filled in by the seeded
 * random, so two systems of the same kind still differ.
 *
 *   band      the galaxy's disc as a bright band of unresolved stars, cut by dust lanes
 *   cluster   inside a young open cluster: many hot blue-white stars, blue reflection haze
 *   emission  a big glowing nebula, two-toned, with dark dust pillars and bright fronts
 *   ember     red and orange smoke, reddened stars, heavy dust
 *   void      far out of the disc: few stars, deep black, distant galaxies everywhere
 *   abyss     a black hole's sky: dark, warm dust swirls, sparse old red stars
 *   remnant   a supernova's shell of glowing filaments across the sky, teal and rose
 *
 * A system can name its archetype (`visuals.biome` in systems.json); otherwise
 * it's chosen from the hints, and failing those, from the seed.
 */

import { hashString, mulberry32 } from '@space-game/common';

export type Rgb = [number, number, number];

export interface SkyBiome {
  kind: BiomeKind;
  /** Offset into the noise tile, so no two systems share cloud shapes */
  seed: [number, number];
  /** Deep background colour */
  base: Rgb;
  band: { angle: number; offset: number; width: number; strength: number; core: Rgb; edge: Rgb };
  dust: { strength: number; tint: Rgb };
  nebula: { strength: number; cover: number; a: Rgb; b: Rgb };
  filaments: { strength: number; color: Rgb };
  shell: { x: number; y: number; radius: number; strength: number; color: Rgb };
  stars: {
    /** −1 old and red … +1 young and blue */
    temperature: number;
    brightness: number;
    /** Overall count, and how strongly far stars crowd into the band and clouds */
    density: number;
    bandBoost: number;
    /** Fraction of the near stars bright enough for diffraction spikes, and their angle */
    spikes: number;
    spikeAngle: number;
    tint: Rgb;
  };
  /** Chance per deep-sky cell of a distant galaxy, and of a globular cluster */
  deep: { galaxies: number; clusters: number };
  /** Faint dust drifting close past the camera (a sense of speed), and its colour */
  motes: number;
  moteColor: Rgb;
}

export const BIOME_KINDS = ['band', 'cluster', 'emission', 'ember', 'void', 'abyss', 'remnant'] as const;
export type BiomeKind = typeof BIOME_KINDS[number];

export interface BiomeHints {
  biome?: string;
  sector?: string;
  position?: { x: number; y: number };
  central?: string;
  hasNebula?: boolean;
  nebulaHue?: number;
  starHueShift?: number;
  specialStarChance?: number;
  specialStarHue?: number;
}

function hsl(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** How far from the galaxy's centre a system is (systems.json positions span about ±170k) */
const GALAXY_RADIUS = 200000;

export function pickBiome(id: string, h: BiomeHints): BiomeKind {
  if (h.biome && (BIOME_KINDS as readonly string[]).includes(h.biome)) return h.biome as BiomeKind;
  if (h.central === 'pulsar') return 'remnant';
  if (h.central === 'black_hole') return (h.specialStarChance ?? 0) > 0 ? 'abyss' : 'void';
  if (h.hasNebula) {
    const hue = ((h.nebulaHue ?? 300) % 360 + 360) % 360;
    return hue < 45 || hue > 340 ? 'ember' : 'emission';
  }
  const sh = h.specialStarHue;
  if (sh !== undefined && sh > 170 && sh < 270) return 'cluster';
  // The core worlds see the galaxy's disc
  if (h.sector === 'core') return 'band';
  const rnd = mulberry32(hashString(`biome:${id}`));
  const d = h.position ? Math.hypot(h.position.x, h.position.y) / GALAXY_RADIUS : 0.5;
  // The galaxy's outskirts are emptier
  if (d > 0.85 && rnd() < 0.5) return 'void';
  return (['band', 'band', 'cluster', 'emission'] as const)[Math.floor(rnd() * 4)];
}

export function skyBiome(id: string, h: BiomeHints = {}): SkyBiome {
  const rnd = mulberry32(hashString(`sky:${id}`));
  const r = (a: number, b: number) => a + (b - a) * rnd();
  const kind = pickBiome(id, h);
  const shift = h.starHueShift ?? 0;
  const nebHue = h.nebulaHue ?? r(0, 360);
  // The band lies along the galaxy's disc: across the direction to its centre, brighter nearer it
  const pos = h.position ?? { x: r(-1, 1) * GALAXY_RADIUS, y: r(-1, 1) * GALAXY_RADIUS };
  const toCentre = Math.atan2(-pos.y, -pos.x);
  const nearCentre = 1.25 - Math.min(1, Math.hypot(pos.x, pos.y) / GALAXY_RADIUS) * 0.6;

  const b: SkyBiome = {
    kind,
    seed: [rnd(), rnd()],
    base: hsl(225 + shift, 0.45, 0.012),
    band: {
      angle: toCentre + Math.PI / 2 + r(-0.5, 0.5),
      offset: r(-15000, 15000),
      width: r(48000, 80000),
      strength: 0.15 * nearCentre,
      core: hsl(38 + shift * 0.3, 0.55, 0.62),
      edge: hsl(215 + shift, 0.4, 0.5),
    },
    dust: { strength: r(0.45, 0.7), tint: hsl(25, 0.5, 0.4) },
    nebula: { strength: 0, cover: 0.62, a: hsl(nebHue, 0.7, 0.45), b: hsl(nebHue + r(25, 60), 0.75, 0.55) },
    filaments: { strength: 0, color: hsl(nebHue, 0.6, 0.6) },
    shell: { x: 0, y: 0, radius: 1, strength: 0, color: [0, 0, 0] },
    stars: {
      temperature: r(-0.15, 0.15), brightness: 1, density: 1, bandBoost: 1.4,
      spikes: 0.25, spikeAngle: r(0, Math.PI / 2), tint: [1, 1, 1],
    },
    deep: { galaxies: 0.08, clusters: 0.04 },
    motes: 1,
    moteColor: [0.62, 0.68, 0.78],
  };

  switch (kind) {
    case 'band':
      b.band.strength *= r(1.15, 1.4);
      b.dust.strength = r(0.75, 0.9);
      b.stars.bandBoost = 2.2;
      b.nebula = { ...b.nebula, strength: r(0.05, 0.1), cover: 0.7 };
      break;
    case 'cluster': {
      const blue = 210 + shift * 0.5;
      b.base = hsl(blue, 0.5, 0.016);
      b.band.strength *= 0.8;
      b.band.edge = hsl(blue, 0.55, 0.55);
      b.dust.strength *= 0.5;
      b.nebula = { strength: r(0.1, 0.16), cover: r(0.5, 0.6), a: hsl(blue, 0.7, 0.35), b: hsl(blue + 25, 0.6, 0.6) };
      b.stars = { ...b.stars, temperature: r(0.55, 0.8), density: 1.6, brightness: 1.15, spikes: 0.5, bandBoost: 1 };
      b.moteColor = [0.6, 0.75, 1];
      b.deep.clusters = 0.12;
      break;
    }
    case 'emission':
      b.base = hsl(nebHue, 0.4, 0.014);
      b.band.strength *= 0.6;
      b.dust.strength = r(0.75, 0.95);
      b.nebula = { ...b.nebula, strength: r(0.32, 0.42), cover: r(0.42, 0.5) };
      b.filaments = { strength: r(0.05, 0.1), color: hsl(nebHue + 40, 0.7, 0.65) };
      b.stars = { ...b.stars, density: 1.2, bandBoost: 2 };
      b.motes = 1.4;
      break;
    case 'ember': {
      const hue = h.nebulaHue ?? r(5, 25);
      b.base = hsl(hue, 0.55, 0.015);
      b.band.core = hsl(hue + 18, 0.75, 0.55);
      b.band.edge = hsl(hue, 0.6, 0.4);
      b.dust = { strength: r(0.85, 1), tint: hsl(hue, 0.8, 0.35) };
      b.nebula = { strength: r(0.24, 0.32), cover: r(0.48, 0.56), a: hsl(hue - 5, 0.85, 0.32), b: hsl(hue + 25, 0.9, 0.52) };
      b.filaments = { strength: r(0.03, 0.06), color: hsl(hue + 30, 0.9, 0.6) };
      b.stars = { ...b.stars, temperature: r(-0.75, -0.5), tint: [1, 0.86, 0.72], bandBoost: 1.8 };
      // Embers
      b.motes = 2.2;
      b.moteColor = [1, 0.55, 0.25];
      break;
    }
    case 'void':
      b.base = hsl(235 + shift * 0.3, 0.35, 0.007);
      b.band.strength *= 0.25;
      b.dust.strength *= 0.4;
      b.stars = { ...b.stars, density: 0.45, brightness: 0.9, spikes: 0.15 };
      b.deep = { galaxies: 0.4, clusters: 0.02 };
      b.motes = 0.6;
      break;
    case 'abyss': {
      const hue = h.specialStarHue ?? 30;
      b.base = hsl(hue, 0.4, 0.008);
      b.band.strength *= 0.45;
      b.band.core = hsl(hue + 10, 0.7, 0.5);
      b.dust = { strength: r(0.8, 1), tint: hsl(hue, 0.7, 0.3) };
      b.nebula = { strength: r(0.2, 0.28), cover: r(0.52, 0.58), a: hsl(hue - 10, 0.8, 0.22), b: hsl(hue + 10, 0.85, 0.42) };
      b.moteColor = [0.9, 0.7, 0.5];
      b.stars = { ...b.stars, temperature: r(-0.6, -0.3), density: 0.65, tint: [1, 0.9, 0.8] };
      b.deep.galaxies = 0.15;
      break;
    }
    case 'remnant': {
      const hue = h.nebulaHue ?? r(160, 200);
      b.base = hsl(hue + 20, 0.45, 0.012);
      b.nebula = { strength: r(0.08, 0.13), cover: r(0.55, 0.62), a: hsl(hue, 0.7, 0.35), b: hsl(hue + 30, 0.6, 0.5) };
      b.filaments = { strength: r(0.14, 0.2), color: hsl(hue - 10, 0.75, 0.62) };
      b.shell = {
        x: r(-40000, 40000), y: r(-40000, 40000), radius: r(70000, 100000), strength: r(0.22, 0.3),
        color: hsl(hue + 150 + r(-20, 20), 0.75, 0.6),
      };
      b.stars = { ...b.stars, temperature: r(0.2, 0.45), spikes: 0.4 };
      b.moteColor = [0.55, 0.85, 0.85];
      break;
    }
  }
  return b;
}
