/**
 * What each engine model's exhaust looks like: a table by model id (ENGINE_LOOKS), read by ThrusterFx (the game) and
 * scripts/native-render/fx.ts (the stills). The arithmetic lives here too, with no pixi: `nozzleDraw` turns a look, a
 * nozzle's throttle and the ship's boost into the nozzle's sprite layers (the same fixed slots for every model, each on or
 * off), and `moteRate` / `initMote` / `stepMote` are the exhaust particles' rules. The game and the stills both draw from
 * these, so they draw the same flame. A new look is a table entry: no model is special-cased in the draw loops.
 *
 *   ion drive          a steady, clean column (the ship's faction or paint colours it), faint diamonds and a soft shimmer
 *   vernier            no flame: crisp white cold-gas puffs, blinking
 *   afterburner        a roaring orange cone with shock diamonds and a shower of sparks; boost blows it out white-hot
 *   torch              a long, narrow, white-yellow needle, fast fine crackle, always-hot nozzle; no boost
 *   plasma drive       a violet-magenta stream pinched by travelling magnetic rings, swirling motes
 *   fusion torch       a blinding white core in a blue-violet sheath, a wide heat haze, a long lingering glowing trail
 *   drift sail         no flame: a soft wide sheet of light, ripples rolling off it, motes drifting slowly away
 *   reaction thruster  a chunky pink plume (its #e879f9 glow) that throbs as the feed is pumped, slugs of reaction mass
 *                      riding out in it and fat droplets left behind
 *   burst strafer      gas bursts popping out sideways and gone fast (it has no cruise push; its dodge jet is
 *                      features/strafer/jets.ts, which takes its colours from here)
 *   (legacy thruster)  the default: the faction-coloured flame enemies and bosses fly on
 */

import type { PlumeShape } from '../rendering/fxTextures';

export interface Palette { outer: number; inner: number; glow: number; shape: PlumeShape }

/** Exhaust particles: spawn rate ×, speed ×, life ×, size ×, sideways scatter ×, the share born hot, drag per frame */
export interface Motes {
  rate: number;
  speed: number;
  life: number;
  size: number;
  spread: number;
  hot: number;
  drag: number;
  /** Brightness × */
  alpha: number;
  /** Swirl (rad/s): each mote corkscrews about its path (0: straight) */
  swirl: number;
  /** Their three colours, young to old */
  tint: [number, number, number];
}

/** A wide soft glow (the puff texture) along the plume: centre at `at` × the plume length, `len` × that length long, `wid` × the nozzle wide */
export interface Haze { at: number; len: number; wid: number; tint?: number; idle: number; thr: number; boost: number; breathe: number }

/**
 * Two blobs (the puff texture): `flicker`, cold-gas puffs blinking on and off; `burst`, discrete pops thrown out and
 * sideways (`side` × the plume length), fading fast; `slug`, droplets riding down the plume. `rate`: bursts or slugs a
 * second (flicker: × its speed); `size` × the nozzle width; `reach` × the plume length.
 */
export interface Blobs { mode: 'flicker' | 'burst' | 'slug'; rate: number; size: number; reach: number; side: number; tint: [number, number]; alpha: number }

/**
 * Two rings (the ring texture): `pinch`, magnetic rings travelling down the plume, tightening as they go; `ripple`,
 * wavefronts rolling off the nozzle and spreading. `squash`: their depth along the plume ÷ their width.
 */
export interface Rings { mode: 'pinch' | 'ripple'; rate: number; size: number; reach: number; squash: number; tint?: number; idle: number; alpha: number }

export interface EngineLook {
  /** A flame (body, white core, diamonds); false: none (cold gas, a sail) */
  flame: boolean;
  /** The flame's colours and shape; none: the default blue, tinted by the ship's faction or paint */
  pal?: Palette;
  /** The flame once boosting (none: the default violet) */
  boostPal?: Palette;
  /** Length × (cruise), and what boost adds to it (× the boost level); 0: this engine has no boost */
  len: number;
  boostGain: number;
  /** Width × at the nozzle */
  width: number;
  /** The white core's length, width and brightness × (brightness: more again on boost by `coreBoost`) */
  coreLen: number;
  coreWidth: number;
  coreAlpha: number;
  coreBoost: number;
  /** When shock diamonds show: from `diamondFrom` throttle, only while boosting, or never; their strength ×, and × (1 + diamondBoost) on boost */
  diamonds: 'thrust' | 'boost' | 'none';
  diamondMul: number;
  diamondFrom: number;
  diamondBoost: number;
  /** Flicker: how much (× the default), and how fast */
  shimmer: number;
  flickerRate: number;
  /** A throb in length, brightness and exhaust: rate (Hz) and depth (0..1) */
  pulse?: { rate: number; depth: number };
  /** The faint glow in the nozzle, × (0: none) */
  idle: number;
  haze?: Haze;
  blobs?: Blobs;
  rings?: Rings;
  motes: Motes;
  /** The engines' light on the hull (none: the flame's own colour) */
  light?: number;
}

export const BLUE_MOTES: [number, number, number] = [0xdff2ff, 0x8cc4ff, 0x4a86ff];

const MOTES: Motes = { rate: 1, speed: 1, life: 1, size: 1, spread: 1, hot: 0.35, drag: 0.97, alpha: 1, swirl: 0, tint: BLUE_MOTES };

/** The default: the flame every engine had before models had looks (and the legacy thrusters enemies fly on) */
export const DEFAULT_LOOK: EngineLook = {
  flame: true, len: 1, boostGain: 0.7, width: 1, coreLen: 1, coreWidth: 1, coreAlpha: 1, coreBoost: 0,
  diamonds: 'thrust', diamondMul: 1, diamondFrom: 0.6, diamondBoost: 0, shimmer: 1, flickerRate: 1, idle: 1, motes: MOTES,
};

const look = (o: Partial<Omit<EngineLook, 'motes'>> & { motes?: Partial<Motes> }): EngineLook => ({ ...DEFAULT_LOOK, ...o, motes: { ...MOTES, ...o.motes } });

export const ENGINE_LOOKS: Record<string, EngineLook> = {
  engine_ion_drive: look({
    len: 1.05, width: 0.8, coreLen: 1.15, coreWidth: 0.85, diamondMul: 0.35, shimmer: 0.3, flickerRate: 0.7,
    motes: { rate: 0.7, speed: 1.05, life: 0.9, size: 0.85, spread: 0.45, hot: 0.3 },
  }),
  engine_vernier: look({
    flame: false, idle: 0, len: 0.25, boostGain: 0,
    blobs: { mode: 'flicker', rate: 1.3, size: 1.1, reach: 0.8, side: 0, tint: [0xf2f7ff, 0xc9d6e6], alpha: 1 },
    motes: { rate: 0.8, speed: 0.55, life: 0.6, size: 0.7, spread: 1.2, hot: 0.2, tint: [0xffffff, 0xdce6f0, 0xaab8c8] },
  }),
  engine_afterburner: look({
    pal: { outer: 0xff7a1a, inner: 0xffd8a0, glow: 0xff4a00, shape: 'cone' }, len: 0.85, boostGain: 1.9,
    boostPal: { outer: 0xffa646, inner: 0xfffaf0, glow: 0xff6010, shape: 'cone' }, width: 1.1, coreLen: 0.75, coreWidth: 0.6, coreAlpha: 1.1, coreBoost: 0.4,
    diamondMul: 0.6, diamondFrom: 0.45, diamondBoost: 0.7, shimmer: 1.6, flickerRate: 1.5,
    haze: { at: 0.5, len: 1.1, wid: 2.4, tint: 0xff6a1a, idle: 0, thr: 0.05, boost: 0.22, breathe: 0.1 },
    motes: { rate: 1.6, speed: 1.6, life: 0.7, size: 0.5, spread: 2.4, hot: 0.8, drag: 0.96, tint: [0xfff4c0, 0xffa24a, 0xff4a1a] },
  }),
  engine_torch: look({
    pal: { outer: 0xffe066, inner: 0xfffef0, glow: 0xffb020, shape: 'needle' }, len: 1.7, boostGain: 0, width: 1.4,
    coreLen: 2, coreWidth: 0.5, coreAlpha: 1.4, diamonds: 'none', shimmer: 0.45, flickerRate: 2.4, idle: 1.6,
    motes: { rate: 0.3, speed: 2, life: 0.6, size: 0.5, spread: 0.3, hot: 0.9, tint: [0xfffbe0, 0xffd860, 0xff9a2a] },
  }),
  engine_plasma_drive: look({
    pal: { outer: 0xc04df5, inner: 0xf5d0fe, glow: 0x8b2be2, shape: 'plume' }, len: 1.2, boostGain: 0.35, width: 0.75,
    boostPal: { outer: 0xe07bff, inner: 0xfbe8ff, glow: 0xa21caf, shape: 'plume' },
    diamonds: 'none', shimmer: 0.7, flickerRate: 0.8,
    rings: { mode: 'pinch', rate: 1.6, size: 1.05, reach: 0.62, squash: 0.28, tint: 0xf0abfc, idle: 0, alpha: 0.75 },
    motes: { rate: 0.9, speed: 0.7, life: 1.3, size: 0.6, spread: 0.4, swirl: 9, tint: [0xfdf4ff, 0xd8b4fe, 0x9333ea] },
  }),
  engine_fusion_torch: look({
    pal: { outer: 0x7c8cff, inner: 0xb8c4ff, glow: 0x4338ca, shape: 'sheath' }, len: 1.85, boostGain: 0.45, width: 1.15,
    boostPal: { outer: 0xa5b4fc, inner: 0xeef0ff, glow: 0x6366f1, shape: 'sheath' },
    coreLen: 2.3, coreWidth: 0.45, coreAlpha: 1.1, coreBoost: 0.3, diamonds: 'none', shimmer: 0.6, flickerRate: 0.6,
    haze: { at: 0.45, len: 1.2, wid: 3, tint: 0x5b6cf0, idle: 0.03, thr: 0.13, boost: 0.07, breathe: 0.12 },
    motes: { rate: 0.5, speed: 0.75, life: 2.6, size: 1, spread: 0.4, hot: 0.3, drag: 0.99, alpha: 0.6, tint: [0xffffff, 0xc7d2fe, 0x6366f1] },
    light: 0xb4c0ff,
  }),
  engine_drift_sail: look({
    flame: false, idle: 0, len: 0.4, boostGain: 0.3,
    haze: { at: 0.35, len: 0.55, wid: 3.4, tint: 0x8fd0ff, idle: 0.12, thr: 0.22, boost: 0.1, breathe: 0.15 },
    rings: { mode: 'ripple', rate: 0.55, size: 2.4, reach: 1, squash: 0.42, tint: 0xbfe6ff, idle: 0.14, alpha: 0.42 },
    motes: { rate: 0.45, speed: 0.15, life: 2.2, size: 1.1, spread: 3, hot: 0.2, drag: 0.99, tint: [0xe6f6ff, 0x9fd4ff, 0x5aa0ff] },
    light: 0x8fd0ff,
  }),
  engine_reaction_thruster: look({
    pal: { outer: 0xe879f9, inner: 0xfdf0ff, glow: 0xc026d3, shape: 'plume' }, len: 0.95, boostGain: 0.6, width: 1.15,
    boostPal: { outer: 0xf5a3ff, inner: 0xffffff, glow: 0xd946ef, shape: 'cone' }, diamonds: 'none', shimmer: 0.4,
    pulse: { rate: 3.2, depth: 0.3 },
    blobs: { mode: 'slug', rate: 3.2, size: 0.55, reach: 0.85, side: 0, tint: [0xfdf0ff, 0xf5d0fe], alpha: 0.9 },
    motes: { rate: 0.4, speed: 0.75, life: 0.9, size: 2, spread: 0.8, hot: 0.5, drag: 0.975, tint: [0xfdf0ff, 0xf0abfc, 0xc026d3] },
  }),
  engine_burst_strafer: look({
    flame: false, idle: 0, len: 0.4, boostGain: 0,
    pal: { outer: 0xf472b6, inner: 0xfbcfe8, glow: 0xdb2777, shape: 'plume' },
    blobs: { mode: 'burst', rate: 5, size: 1.2, reach: 1, side: 0.9, tint: [0xfbcfe8, 0xf472b6], alpha: 1 },
    motes: { rate: 0.5, speed: 0.9, life: 0.3, size: 0.9, spread: 2.5, tint: [0xfdf2f8, 0xf9a8d4, 0xdb2777] },
  }),
};

/**
 * Legacy engine functions (enemies and bosses still fly them) take their family's look in the ship's own colours, so a
 * faction still reads by its flame: its palette and tints dropped (the model's own colours are for player models).
 */
const tinted = (l: EngineLook): EngineLook => ({
  ...l, pal: undefined, boostPal: undefined, light: undefined,
  haze: l.haze && { ...l.haze, tint: undefined }, rings: l.rings && { ...l.rings, tint: undefined },
});
const LEGACY_LOOKS: Record<string, EngineLook> = {
  thruster: DEFAULT_LOOK,
  afterburner: tinted(ENGINE_LOOKS.engine_afterburner),
  plasma_drive: tinted(ENGINE_LOOKS.engine_plasma_drive),
};

export const engineLookOf = (fn: string | undefined): EngineLook => (fn && (ENGINE_LOOKS[fn] ?? LEGACY_LOOKS[fn])) || DEFAULT_LOOK;

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
  /** The throb now (1: none) */
  pulse: number;
}

/** `out`: filled and returned instead of a new object (the per-frame callers reuse one) */
export function plumeSpec(k: EngineLook, thr: number, boost: number, edge: number, cs: number, time: number, seed: number, frost = 0, out?: PlumeSpec): PlumeSpec {
  const b = k.boostGain > 0 ? boost : 0;
  const boosted = b > 0.5;
  const s = k.shimmer, r = k.flickerRate;
  const flicker = 1 + s * (0.07 * Math.sin(time * 41 * r + seed) + 0.05 * Math.sin(time * 27.3 * r + seed * 2.1) + 0.03 * Math.sin(time * 73 * r + seed * 0.7));
  const pulse = k.pulse ? 1 + k.pulse.depth * Math.sin(time * k.pulse.rate * Math.PI * 2 + seed) : 1;
  const size = Math.sqrt(edge / cs);
  const L = cs * (1.1 + 3.2 * thr) * size * k.len * (1 + k.boostGain * b) * flicker * pulse * (1 - FROST_SHORTEN * frost);
  // (heat shimmer also breathes the width)
  const w = edge * 0.42 * k.width * (s > 1 ? 1 + 0.08 * (s - 1) * Math.sin(time * 57 * r + seed * 3.3) : 1);
  let d = 0;
  if (k.diamonds === 'thrust') d = thr > k.diamondFrom ? (thr - k.diamondFrom) / (1 - k.diamondFrom) : 0;
  else if (k.diamonds === 'boost') d = boosted ? Math.min(1, thr) : 0;
  const o = out ?? ({} as PlumeSpec);
  o.L = L; o.w = w; o.pal = frost > 0 ? FROST_PAL : boosted ? k.boostPal ?? BOOST_PAL : k.pal; o.boosted = boosted;
  o.coreLen = k.coreLen; o.coreWidth = k.coreWidth; o.diamonds = Math.min(1, d * k.diamondMul * (1 + k.diamondBoost * b)); o.pulse = pulse;
  return o;
}

/** A slowed ship (a Frostbite's beam, seen by all): its plumes run this much shorter, pale and icy, with white-blue motes */
export const FROST_SHORTEN = 0.45;
export const FROST_PAL: Palette = { outer: 0xbfe6ff, inner: 0xffffff, glow: 0x7cc4ff, shape: 'plume' };
export const FROST_MOTES: [number, number, number] = [0xffffff, 0xcdeeff, 0x8fd0ff];

/** The default boost flame (ThrusterFx PAL) */
export const BOOST_PAL: Palette = { outer: 0x8a6bff, inner: 0xe6dcff, glow: 0x2a63ff, shape: 'plume' };
/** The engines' light while boosting with the default flame */
export const BOOST_LIGHT = 0x9a7bff;

/** The cold-gas puff's flicker (0..1): on in rapid, irregular bursts */
export function puffFlicker(time: number, seed: number): number {
  const v = 0.5 + 0.28 * Math.sin(time * 53 + seed) + 0.22 * Math.sin(time * 31.7 + seed * 1.9);
  return v < 0.18 ? 0 : Math.min(1, v + 0.15);
}

// ---- A nozzle's sprite layers --------------------------------------------------------------------------------------

/**
 * The fixed sprite slots every nozzle has, drawn in this order, and the texture each takes: `white` (1 px), `body` (the
 * plume texture of the palette, or the ship's tinted flame), `core` / `diamonds` (the plume's), `puff` / `ring` (64 px).
 * body, core and diamonds anchor at the nozzle (PLUME_ANCHOR) and are sized as plumeScale takes it (len, half-width);
 * the rest are centred, `len` along the plume and `wid` across it.
 */
export const SLOTS = ['haze', 'idle', 'ringA', 'ringB', 'body', 'core', 'diamonds', 'blobA', 'blobB'] as const;
export type Slot = typeof SLOTS[number];
export type SlotTex = 'white' | 'body' | 'core' | 'diamonds' | 'puff' | 'ring';
export const SLOT_TEX: Record<Slot, SlotTex> = { haze: 'puff', idle: 'white', ringA: 'ring', ringB: 'ring', body: 'body', core: 'core', diamonds: 'diamonds', blobA: 'puff', blobB: 'puff' };
/** Which slots anchor at the nozzle and scale as a plume */
export const PLUME_SLOT: Record<Slot, boolean> = { haze: false, idle: false, ringA: false, ringB: false, body: true, core: true, diamonds: true, blobA: false, blobB: false };
/** A texture's size in px, for the centred slots */
export const TEX_PX: Record<SlotTex, number> = { white: 1, body: 1, core: 1, diamonds: 1, puff: 64, ring: 64 };
/** The ring texture's line sits at 28 of its 32 px radius: a ring D across needs a sprite D × this */
const RING_FIT = 64 / 56;

/** One sprite: `a` along the plume and `s` across it from the nozzle's exit, its size, its turn from the plume's, tint and alpha */
export interface Layer { on: boolean; a: number; s: number; len: number; wid: number; rot: number; tint: number; alpha: number }
/** `pal`: the body's palette (none: the ship's tinted flame); `pulse`: the throb now (1: none; the exhaust follows it) */
export type NozzleDraw = Record<Slot, Layer> & { pal: Palette | undefined; pulse: number };

export const newNozzleDraw = (): NozzleDraw => {
  const d = { pal: undefined, pulse: 1 } as NozzleDraw;
  for (const s of SLOTS) d[s] = { on: false, a: 0, s: 0, len: 0, wid: 0, rot: 0, tint: 0xffffff, alpha: 0 };
  return d;
};

/**
 * Turn a layer on. A layer stays on while its part of the look is in use, even faded to nothing (a blinking puff, a
 * ripple between waves): showing or hiding a sprite rebuilds its render group's draw list, a fade costs nothing.
 */
const set = (l: Layer, a: number, s: number, len: number, wid: number, tint: number, alpha: number): void => {
  l.on = true; l.a = a; l.s = s; l.len = len; l.wid = wid; l.rot = 0; l.tint = tint; l.alpha = Math.max(0, Math.min(1, alpha));
};
const SPEC = {} as PlumeSpec;
const frac = (x: number) => x - Math.floor(x);

/**
 * Fill `d` (reused: nothing allocated) with one nozzle's layers. `tintInner`: the ship's tinted flame's inner colour,
 * for looks with no colours of their own. `seed` keeps neighbouring nozzles out of step.
 */
export function nozzleDraw(d: NozzleDraw, k: EngineLook, thr: number, boost: number, edge: number, cs: number, time: number, seed: number, tintInner: number, frost = 0): NozzleDraw {
  for (const s of SLOTS) d[s].on = false;
  const sp = plumeSpec(k, thr, boost, edge, cs, time, seed, frost, SPEC);
  const b = k.boostGain > 0 ? boost : 0;
  const live = thr >= 0.03;
  const L = sp.L, w = sp.w, inner = sp.pal ? sp.pal.inner : tintInner;
  d.pal = sp.pal;
  d.pulse = live ? sp.pulse : 1;

  // The nozzle's own glow (a bar across its mouth)
  if (k.idle > 0) set(d.idle, 0, 0, Math.max(1.5, cs * 0.18), edge * 0.84, inner, (0.18 + 0.6 * thr) * k.idle * (live ? sp.pulse : 1));

  if (k.flame && live) {
    const ca = Math.min(1, thr * 1.4 * k.coreAlpha * (1 + k.coreBoost * b));
    set(d.body, 0, 0, L, w, 0xffffff, thr * (0.75 + 0.25 * sp.pulse));
    set(d.core, 0, 0, L * sp.coreLen, w * sp.coreWidth, 0xffffff, ca);
    if (k.diamonds !== 'none') set(d.diamonds, 0, 0, L, w, 0xffffff, sp.diamonds);
  }

  const h = k.haze;
  if (h && (live || h.idle > 0)) {
    const br = 1 + h.breathe * Math.sin(time * 2.1 + seed * 1.3);
    set(d.haze, L * h.at, 0, L * h.len * br, edge * h.wid * br, frost > 0 ? FROST_PAL.glow : h.tint ?? tintInner, h.idle + h.thr * thr + h.boost * b);
  }

  const r = k.rings;
  if (r) {
    const tint = frost > 0 ? FROST_PAL.outer : r.tint ?? tintInner;
    for (let i = 0; i < 2; i++) {
      const l = i ? d.ringB : d.ringA, p = frac(time * r.rate * (1 + 0.6 * b) + i * 0.5 + seed * 0.13);
      if (r.mode === 'pinch') {
        // Magnetic rings riding down the stream, tightening as they go (only while it burns)
        if (!live) continue;
        const across = w * 2 * r.size * (1 - 0.45 * p) * RING_FIT;
        set(l, L * (0.1 + r.reach * p), 0, across * r.squash, across, tint, thr * r.alpha * Math.sin(Math.PI * p));
      } else {
        // Wavefronts rolling off and spreading, faint at idle
        const across = edge * r.size * (0.45 + 0.55 * p) * RING_FIT;
        set(l, L * (0.15 + r.reach * p), 0, across * r.squash, across, tint, (r.idle + r.alpha * thr) * (1 - p) * Math.min(1, p * 5));
      }
    }
  }

  const o = k.blobs;
  if (o && live) {
    const env = Math.min(1, thr * 1.5);
    if (o.mode === 'flicker') {
      const f = puffFlicker(time * o.rate, seed) * env;
      const s0 = edge * o.size * (0.8 + 0.4 * f), s1 = edge * o.size * (1.3 + 0.5 * f);
      set(d.blobA, L * o.reach * 0.35, 0, s0, s0, o.tint[0], 0.85 * f * o.alpha);
      set(d.blobB, L * o.reach, 0, s1, s1, o.tint[1], 0.4 * f * o.alpha);
    } else if (o.mode === 'burst') {
      // Each burst pops out of the mouth and to one side, its partner to the other, both gone before the next
      const x = time * o.rate + seed * 0.37, p = frac(x), side = Math.floor(x) % 2 ? 1 : -1;
      const e = (1 - p) * (1 - p) * env, s0 = edge * o.size * (0.6 + 1.4 * p);
      set(d.blobA, L * o.reach * (0.15 + 0.6 * p), side * L * o.side * p, s0, s0, o.tint[0], 0.9 * e * o.alpha);
      set(d.blobB, L * o.reach * (0.1 + 0.4 * p), -side * L * o.side * p * 0.7, s0 * 0.8, s0 * 0.8, o.tint[1], 0.6 * e * o.alpha);
    } else {
      // Slugs riding out in the stream, in step with the throb
      for (let i = 0; i < 2; i++) {
        const p = frac(time * o.rate + i * 0.5 + seed * 0.11), s0 = edge * o.size * (1 - 0.5 * p);
        set(i ? d.blobB : d.blobA, L * o.reach * p, 0, s0 * 1.3, s0, o.tint[i], thr * (1 - p) * o.alpha);
      }
    }
  }
  return d;
}

// ---- Exhaust motes -------------------------------------------------------------------------------------------------

/** One exhaust particle (the game's Spark extends this with its sprite) */
export interface Mote {
  x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: boolean;
  tint: [number, number, number]; alpha: number; drag: number;
  /** The corkscrew: rate (rad/s), phase, radius, and the axis it swings along */
  sw: number; ph: number; amp: number; px: number; py: number;
}

export const newMote = (): Mote => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 1, hot: false, tint: BLUE_MOTES, alpha: 1, drag: 0.97, sw: 0, ph: 0, amp: 0, px: 0, py: 0 });

/** Motes a second out of one nozzle (none below a quarter throttle); `pulse` from plumeSpec */
export function moteRate(k: EngineLook, thr: number, boost: number, edge: number, cs: number, pulse = 1): number {
  if (thr <= 0.25) return 0;
  return thr * (edge / cs) * (1 + boost * (k.boostGain > 0 ? 1 : 0)) * 38 * k.motes.rate * pulse;
}

/**
 * Fill `m` as a mote thrown out of a nozzle whose exit's middle is (ox, oy), pointing (nx, ny), across it (tx, ty), all in
 * the space the motes live in; (bvx, bvy) is the ship's own velocity carried in. `rnd`: Math.random or a seeded one.
 */
export function initMote(m: Mote, k: EngineLook, thr: number, boost: number, edge: number, cs: number, frost: number, rnd: () => number,
  ox: number, oy: number, nx: number, ny: number, tx: number, ty: number, bvx: number, bvy: number): Mote {
  const mo = k.motes, bg = k.boostGain > 0 ? 1 : 0;
  const off = (rnd() - 0.5) * edge * 0.7;
  m.x = ox + tx * off + nx * cs * 0.3;
  m.y = oy + ty * off + ny * cs * 0.3;
  const speed = (220 + rnd() * 180) * (1 + boost * 0.6 * bg) * (0.6 + 0.4 * thr) * mo.speed * (frost > 0 ? 0.6 : 1);
  const j = 40 * mo.spread;
  m.vx = bvx + nx * speed + (rnd() - 0.5) * j;
  m.vy = bvy + ny * speed + (rnd() - 0.5) * j;
  m.life = m.max = (0.25 + rnd() * 0.45) * mo.life;
  m.size = (edge * 0.11 + 1.2) * (0.7 + rnd() * 0.6) * mo.size;
  m.hot = rnd() < mo.hot;
  m.tint = frost > 0 ? FROST_MOTES : mo.tint;
  m.alpha = mo.alpha;
  m.drag = mo.drag;
  m.sw = mo.swirl;
  m.ph = rnd() * Math.PI * 2;
  m.amp = edge * 0.18;
  m.px = tx; m.py = ty;
  return m;
}

/** Age a mote by dt; false once it's spent. Its look now: radius r, tint and alpha */
export function stepMote(m: Mote, dt: number): boolean {
  m.life -= dt;
  if (m.life <= 0) return false;
  m.x += m.vx * dt;
  m.y += m.vy * dt;
  if (m.sw !== 0) {
    // (the derivative of amp × sin: the mote swings across its path and back)
    const v = m.amp * m.sw * Math.cos(m.ph + (m.max - m.life) * m.sw) * dt;
    m.x += m.px * v; m.y += m.py * v;
  }
  m.vx *= m.drag;
  m.vy *= m.drag;
  return true;
}

/** A live mote's radius, tint and alpha (hot ones brighter; all cool through their three colours) */
export const moteRadius = (m: Mote): number => m.size * (0.6 + 0.9 * (1 - m.life / m.max));
export const moteTint = (m: Mote): number => { const k = m.life / m.max; return k > 0.6 ? m.tint[0] : k > 0.3 ? m.tint[1] : m.tint[2]; };
export const moteAlpha = (m: Mote): number => (m.hot ? 0.75 : 0.5) * (m.life / m.max) * m.alpha;
