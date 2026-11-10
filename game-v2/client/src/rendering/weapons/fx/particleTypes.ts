/**
 * @contract client.weapon-fx.particles
 * owns:       the particle record shapes, caps, colour helpers and texture handles that WeaponFx's sub-systems share
 * needs:      fxTextures, impactAnchor (ImpactAnchor type)
 * invariants: impactScale grows as the square root of shell size, never below 0.2 — client/src/rendering/weapons/weaponStyles.test.ts
 *             a layered impact's particle lists are capped (HIT_CAP, FRAG_CAP, SMOKE_CAP), oldest dropped first — client/src/rendering/weapons/fx/fxInvariants.test.ts
 * extend:     a new kind of particle is one interface here, one list on FxField and its draw in FxField / hitDraw
 */

import { disc, softDot, streak, petal, ring, puff, glowBall } from '../../fxTextures';
import type { ImpactAnchor } from '../impactAnchor';

export interface Smoke { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color?: number; alpha?: number; /** The impact it came off rides its target: it flies in the target's frame (impactAnchor rideStep) */ anc?: ImpactAnchor }
export interface Spark {
  x: number; y: number; vx: number; vy: number; life: number; max: number; color: number; width?: number;
  /** An ember: its colour cools to this as it dies (and it stays bright longer before fading) */
  cool?: number;
  /** Its speed kept a frame (default 0.9) */
  drag?: number;
  /** The impact it came off rides its target: it flies in the target's frame, its velocity relative to it (rideStep) */
  anc?: ImpactAnchor;
}
/** A layered impact's core flash or glow (ImpactLayers core, bloom) */
export interface HitGlow {
  x: number; y: number; life: number; max: number; size: number; color: number; core: boolean;
  /** A fireball's (ImpactLayers.fireball): its drift, and the colour it cools to */
  vx?: number; vy?: number; cool?: number;
  /** The impact it belongs to rides its target (ImpactAnchor) */
  anc?: ImpactAnchor;
}
/** A fragment torn off a hull (ImpactLayers.debris): a glowing chunk slowing, cooling and trailing smoke */
export interface Frag { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; hot: number; cool: number; trail: number; drag: number; puff: number; /** Smokes for this share of its life (an outlier's trail crosses the screen) */ smokes: number; anc?: ImpactAnchor }
/** A shock ring racing out from a hit (ImpactLayers shock); `life` starts below 0 for one that follows later */
export interface Shock { x: number; y: number; life: number; max: number; size: number; width: number; color: number; anc?: ImpactAnchor }
/** A glow on the hull where a hit landed, riding with the ship it struck (`owner`, at `ox, oy` in its frame), or still (owner -1) */
export interface Scorch { x: number; y: number; life: number; max: number; size: number; color: number; anc?: ImpactAnchor }
/** A rebound streak (ImpactLayers.flare): out from (x, y) along `a`, `len` long at full reach */
export interface Flare { x: number; y: number; a: number; len: number; width: number; life: number; max: number; color: number; anc?: ImpactAnchor }
/** The light a layered hit throws, fading over its life */
export interface HitLight { x: number; y: number; life: number; max: number; radius: number; power: number; color: number; anc?: ImpactAnchor }
export interface Ring { x: number; y: number; life: number; max: number; size: number; color: number; anc?: ImpactAnchor }

/** A muzzle flash: pinned to the ship that fired it (`owner`, at `ox, oy` and `rel` in its frame) */
export interface Flash {
  x: number; y: number; angle: number; life: number; max: number; size: number; color: number; sparks: { a: number; l: number }[]; petals: number[];
  /** Its flash's width × this (a heavy shell's is fat) */
  girth: number;
  owner: number; ox: number; oy: number; rel: number;
}
export const FADE_FRAMES = 9;
/** Layered impacts' particles at most (the oldest go first past it) */
export const HIT_CAP = 600;
/** Fragments live at most (the oldest go first past it), and smoke puffs they may add */
export const FRAG_CAP = 240;
export const SMOKE_CAP = 700;

/** A layered impact's scale from its shot's (shell size × damage scale): the square root, so a big shell reads big without taking over */
export function impactScale(size: number): number {
  return Math.sqrt(Math.max(0.2, size));
}

export function mixColor(a: number, b: number, t: number): number {
  const r = ((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t;
  const g = ((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t;
  const bl = (a & 255) * (1 - t) + (b & 255) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

export function hueColor(h: number): number {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 0.6 - 0.4 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

export const TEX = { get disc() { return disc(); }, get dot() { return softDot(0.5, 0.1); }, get streak() { return streak(); }, get petal() { return petal(); } };
export const TEX2 = { get ring() { return ring(); }, get puff() { return puff(); } };
/** The layered impacts' pool's texture */
export const TEX3 = { get ball() { return glowBall(); } };

/** A colour with its hue turned by `deg` degrees (impact shards of a prism's rainbow) */
export function turnHue(c: number, deg: number): number {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (d < 1e-6) return c;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360;
  const ch = (1 - Math.abs(2 * l - 1)) * sat, x = ch * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - ch / 2;
  const [r1, g1, b1] = h < 60 ? [ch, x, 0] : h < 120 ? [x, ch, 0] : h < 180 ? [0, ch, x] : h < 240 ? [0, x, ch] : h < 300 ? [x, 0, ch] : [ch, 0, x];
  return (Math.round((r1 + m) * 255) << 16) | (Math.round((g1 + m) * 255) << 8) | Math.round((b1 + m) * 255);
}
