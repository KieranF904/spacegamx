/**
 * What each engine model's exhaust looks like (rework 2026-11 section 5): a table by model id read by ThrusterFx (the game)
 * and scripts/native-render/fx.ts (the stills), with the arithmetic of one nozzle's plume in `plumeSpec` so the two draw
 * the same flame. No pixi here.
 *
 *   ion drive      blue plume, soft shock diamonds (the faction/paint tint still colours it)
 *   vernier        white cold-gas puffs that flicker, no flame
 *   afterburner    short orange flame; blows out long, blue-white and wide with diamonds on boost
 *   torch          long thick yellow-white needle with heat shimmer
 *   plasma drive   violet plume with diamonds
 *   drift sail     a shimmering ring "sail" glow and drifting blue motes, no flame
 *   fusion torch   white core in a violet sheath, the longest plume
 *   burst strafer  pink (its dodge jet is features/strafer/jets.ts)
 */

import type { PlumeShape } from '../rendering/fxTextures';

export interface Palette { outer: number; inner: number; glow: number; shape: PlumeShape }

export interface EngineLook {
  kind: 'plume' | 'puff' | 'sail';
  /** The flame's colours and shape; none: the default blue, tinted by the ship's faction or paint */
  pal?: Palette;
  /** The flame once boosting (none: the default violet) */
  boostPal?: Palette;
  /** Length × (cruise), and what boost adds to it (× the boost level); 0: this engine has no boost */
  len: number;
  boostGain: number;
  /** Width × at the nozzle */
  width: number;
  /** The white core's length and width × */
  coreLen: number;
  coreWidth: number;
  /** When shock diamonds show: from high throttle, only while boosting, or never; their strength × */
  diamonds: 'thrust' | 'boost' | 'none';
  diamondMul: number;
  /** More flicker (heat shimmer), × */
  shimmer: number;
  /** Exhaust motes: how many ×, how fast ×, and their three colours (young to old) */
  motes: number;
  moteSpeed: number;
  moteTint: [number, number, number];
}

export const BLUE_MOTES: [number, number, number] = [0xdff2ff, 0x8cc4ff, 0x4a86ff];

const BASE: EngineLook = {
  kind: 'plume', len: 1, boostGain: 0.7, width: 1, coreLen: 1, coreWidth: 1, diamonds: 'thrust', diamondMul: 1, shimmer: 1,
  motes: 1, moteSpeed: 1, moteTint: BLUE_MOTES,
};

const look = (o: Partial<EngineLook>): EngineLook => ({ ...BASE, ...o });

export const ENGINE_LOOKS: Record<string, EngineLook> = {
  engine_ion_drive: look({ diamondMul: 0.6 }),
  engine_vernier: look({ kind: 'puff', boostGain: 0, motes: 0.8, moteSpeed: 0.55, moteTint: [0xffffff, 0xdce6f0, 0xaab8c8] }),
  engine_afterburner: look({
    pal: { outer: 0xff8a2a, inner: 0xffd29a, glow: 0xff5a10, shape: 'plume' }, len: 0.62, boostGain: 2.3,
    boostPal: { outer: 0xa9d2ff, inner: 0xf2f9ff, glow: 0x4f93ff, shape: 'cone' }, diamonds: 'boost', moteTint: [0xfff0d0, 0xffa24a, 0xff5a1a],
  }),
  engine_torch: look({
    pal: { outer: 0xffc83a, inner: 0xfff1b0, glow: 0xff9a1a, shape: 'needle' }, len: 1.4, boostGain: 0, width: 1.9,
    coreLen: 1.7, coreWidth: 0.55, diamonds: 'none', shimmer: 2.6, moteTint: [0xfff7d0, 0xffd060, 0xff8a2a],
  }),
  engine_plasma_drive: look({ pal: { outer: 0xa855f7, inner: 0xe9d5ff, glow: 0x7c3aed, shape: 'plume' }, moteTint: [0xf3e8ff, 0xc084fc, 0x7c3aed] }),
  engine_drift_sail: look({ kind: 'sail', boostGain: 0.3, motes: 0.5, moteSpeed: 0.18, moteTint: [0xe6f6ff, 0x9fd4ff, 0x5aa0ff] }),
  engine_fusion_torch: look({
    pal: { outer: 0x8b5cf6, inner: 0xffffff, glow: 0x6d28d9, shape: 'sheath' }, len: 1.85, boostGain: 0.45, width: 1.1,
    coreLen: 2.2, coreWidth: 0.8, diamonds: 'none', moteTint: [0xffffff, 0xc4b5fd, 0x7c3aed],
  }),
  engine_burst_strafer: look({ pal: { outer: 0xf472b6, inner: 0xfbcfe8, glow: 0xdb2777, shape: 'plume' }, moteTint: [0xfdf2f8, 0xf9a8d4, 0xdb2777] }),
};

export const engineLookOf = (fn: string): EngineLook => ENGINE_LOOKS[fn] ?? BASE;

/** One nozzle's flame, from its engine's look, throttle (0..1), the ship's boost level (0..1), its edge width and cell size */
export interface PlumeSpec {
  /** Length and half-width (world units) of the plume's full texture, as plumeScale takes them */
  L: number;
  w: number;
  /** The colours to use (none: the ship's tinted default), and the shape */
  pal: Palette | undefined;
  boosted: boolean;
  /** The core's scale × and the diamonds' alpha (0: hidden) */
  coreLen: number;
  coreWidth: number;
  diamonds: number;
}

export function plumeSpec(k: EngineLook, thr: number, boost: number, edge: number, cs: number, time: number, seed: number): PlumeSpec {
  const b = k.boostGain > 0 ? boost : 0;
  const boosted = b > 0.5;
  const s = k.shimmer;
  const flicker = 1 + s * (0.07 * Math.sin(time * 41 + seed) + 0.05 * Math.sin(time * 27.3 + seed * 2.1) + 0.03 * Math.sin(time * 73 + seed * 0.7));
  const size = Math.sqrt(edge / cs);
  const L = cs * (1.1 + 3.2 * thr) * size * k.len * (1 + k.boostGain * b) * flicker;
  // (heat shimmer also breathes the width)
  const w = edge * 0.42 * k.width * (s > 1 ? 1 + 0.08 * (s - 1) * Math.sin(time * 57 + seed * 3.3) : 1);
  let d = 0;
  if (k.diamonds === 'thrust') d = thr > 0.6 ? (thr - 0.6) / 0.4 : 0;
  else if (k.diamonds === 'boost') d = boosted ? Math.min(1, thr) : 0;
  return { L, w, pal: boosted ? k.boostPal ?? BOOST_PAL : k.pal, boosted, coreLen: k.coreLen, coreWidth: k.coreWidth, diamonds: d * k.diamondMul };
}

/** The default boost flame (ThrusterFx PAL) */
export const BOOST_PAL: Palette = { outer: 0x8a6bff, inner: 0xe6dcff, glow: 0x2a63ff, shape: 'plume' };

/** The cold-gas puff's flicker (0..1): on in rapid, irregular bursts */
export function puffFlicker(time: number, seed: number): number {
  const v = 0.5 + 0.28 * Math.sin(time * 53 + seed) + 0.22 * Math.sin(time * 31.7 + seed * 1.9);
  return v < 0.18 ? 0 : Math.min(1, v + 0.15);
}

/** The Drift Sail's ring: radius × the nozzle width, and alpha, breathing with time */
export function sailRing(time: number, seed: number, thr: number): { r: number; a: number; r2: number; a2: number } {
  const s = 0.5 + 0.5 * Math.sin(time * 2.3 + seed), s2 = 0.5 + 0.5 * Math.sin(time * 2.3 + seed + Math.PI);
  return { r: 0.9 + 0.35 * s, a: (0.22 + 0.5 * thr) * (0.6 + 0.4 * s), r2: 0.9 + 0.35 * s2, a2: (0.14 + 0.35 * thr) * (0.6 + 0.4 * s2) };
}
