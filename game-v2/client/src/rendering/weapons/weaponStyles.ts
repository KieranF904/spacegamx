/**
 * How each weapon's shots look. Aimed at believable space weapons: thin,
 * hot tracers with a soft additive glow, brief muzzle flashes, spark bursts on
 * impact. Colours are mostly physical (white-hot cores, warm or plasma glows);
 * the owner's hue only tints the glow a little so friend and foe stay readable.
 */

import { WeaponType } from '@space-game/common';
import { KINETIC_MODEL_STYLES } from './kineticStyles';
import { ORDNANCE_STYLES } from './ordnanceStyles';
import { LEGENDARY_STYLES, LEGENDARY_BEAMS } from './legendaryStyles';
import type { HitThrow } from './impactAim';

export interface WeaponStyle {
  /** How the head is placed: from spawn point + velocity (straight shots), or from the server's interpolated position (guided or slowing shots) */
  motion: 'linear' | 'tracked';
  /** Tracer length, in ticks of travel */
  tracerTicks: number;
  /** Tracer core and glow widths (world units) */
  coreWidth: number;
  glowWidth: number;
  coreColor: number;
  glowColor: number;
  glowAlpha: number;
  /** How much of the owner's hue bleeds into the glow (0..1) */
  ownerTint: number;
  /** Bright head dot radius (0 = none) */
  headRadius: number;
  /** Colour of the head dot (default white; a dark one makes a black core, drawn in normal blend) */
  headColor?: number;
  /** Soft halo around the head (0 = none) */
  haloRadius: number;
  /** tongue: the forward flame's length × this; girth: the flash's width × this (a heavy shell's flash is fat) */
  muzzle: { life: number; size: number; sparks: number; color: number; smoke: number; tongue?: number; girth?: number; ring?: { color: number; count?: number; size?: number } };
  /** ring: a second, wider shock ring of this colour (the heavier marks) */
  impact: { sparks: number; speed: number; life: number; color: number; flash: number; ring?: number };
  /** Leaves a smoke trail (missiles) */
  trail?: { color: number; size: number; life: number };
  /** Drawn as a crackling orb rather than a tracer (EMP) */
  orb?: boolean;
  // ---- Per-model extras (rework-2026-11 section 7). Each is optional; the kind styles set none of them. ----
  /** Two parallel tracers `gap` world units apart (twin barrels), each a little thinner */
  pair?: { gap: number };
  /** Spent casings thrown out sideways at the muzzle, this many a shot */
  casings?: number;
  /** A glowing wake behind the head: a segment laid each frame, fading over `life` frames */
  contrail?: { color: number; size: number; life: number };
  /** Ghost copies of the head trailing behind it, this many */
  afterimages?: number;
  /** A ring round the head that swells and fades every `period` ticks */
  ringPulse?: { color: number; size: number; period: number; closing?: number };
  /** A cloud of smoke or gas left where it lands (and a thin one as it flies, when `fly`) */
  smokeCloud?: { color: number; size: number; life: number; fly?: boolean };
  /** Arcs of lightning round the head, `forks` of them, `length` long (world units); `orb` styles use the same crackle */
  lightning?: { color: number; forks: number; length: number };
  /** The head sways sideways across its line: amplitude (world units) and period (ticks) */
  wobble?: { amp: number; period: number };
  /** The whole shot blinks on and off every `period` ticks */
  blink?: number;
  /** × the crackle's size (EMP, Arc and lightning): default 1 */
  arcScale?: number;
  /** The shell swells to (1 + lob) × its size at the top of its flight and shrinks again as it lands (a mortar's arc; needs the shell's endTick) */
  lob?: number;
  /** A light at the nose: a hard blink (`blink`) or a soft pulse, every `period` ticks */
  nose?: { color: number; size: number; period: number; blink?: boolean };
  /** A shell that bursts where its endTick says when it is removed (a mortar's landing), shaking a screen within `shake` units at full strength */
  landBurst?: { shake?: number };
  /** Draws a dashed guide from the shell to your cursor while you hold fire (your own guided shells) */
  guide?: boolean;
  /** Your own shell marks the point it will burst (its endTick) with a faint tick across its line: the Cloudmaker's aim distance */
  aimTick?: boolean;
  /** Warns a pilot it is heading at, from the shell's velocity: the miss distance (world units) that counts as heading at you */
  incoming?: { radius: number };
  /** Impact sparks spread over this many degrees of hue round their colour (a prism's rainbow) */
  shardHue?: number;
  /** Only every `every`th shot is drawn at full brightness, the rest at `dim` of it (a stream's tracer rounds) */
  accent?: { every: number; dim: number };
  /** The shot's colours turn from `cold` to `hot` with the firing gun's spin (0..1) when it leaves the barrel (a minigun's) */
  heat?: { cold: number; hot: number };
  /** A faint ring of this world radius round the head the whole flight (a blast radius you can see coming: the Blackout) */
  radiusRing?: { color: number; radius: number };
  /** A jagged polyline along the shot's whole tracer, re-jittered every frame (a lightning bolt: the Spark) */
  jagged?: { color: number; amp: number };
  /** A faint ring at this radius round the head (a gravity well's pull) and motes streaming in to it, seen by everyone */
  pull?: { radius: number; color: number };
  /** A layered impact (see ImpactLayers): when set, it replaces the flat flash and ring discs of `impact` */
  hit?: ImpactLayers;
  /**
   * Which way its hits throw their spray, sparks, embers and ricochet (impactAim.ts), off the surface struck (the edge
   * of the part or rock the shell crossed): 'reflect' mirrors the shell's line off it (a ricochet: slugs and rails),
   * 'normal' leaves straight out of it (a burn splashing back: lasers, pulse bolts, arcs), 'back' goes back up the
   * shell's line whatever it struck (default: explosives, flak). Set on a kind, its models inherit it.
   */
  hitThrow?: HitThrow;
}

/** How a burst's fragments or embers spread round their typical speed and life (ImpactLayers debris, embers; impactAim burstSpeed) */
export interface BurstSpread {
  /** The share that are outliers, drawn separately for speed and for life (default 0.15) */
  outliers?: number;
  /** An outlier's speed and life, × the typical (defaults 2.2 and 1.8) */
  outSpeed?: number;
  outLife?: number;
}

/**
 * A layered impact, sized by the gun's power tier (heavy and super guns get all of it, mid ones a step down, simple ones a
 * small quick mark). Every layer is optional. Sizes are world units for a shot of scale 1: the hit scales them by the
 * square root of its shell size × damage scale (WeaponFx impactScale), gentler than the flat flash, so a big shell reads
 * big without covering the screen; particle counts by the same, capped at 1.5×. `impact.sparks` is still thrown as a
 * loose scatter round the hit (counted the same way), and `impact.color` is the default colour of every layer.
 */
export interface ImpactLayers {
  /** A brief white-hot core: radius and frames (it shrinks a little as it dies) */
  core?: { size: number; life: number };
  /** The coloured glow round the core, swelling and fading: radius, frames */
  bloom?: { size: number; life: number; color?: number };
  /** A crisp shock ring racing out (eased) and thinning as it fades: radius reached, frames, band width at the start; `count` more follow `gap` frames apart, each smaller */
  shock?: { size: number; life: number; width: number; color?: number; count?: number; gap?: number };
  /** A spray of fast streaks thrown off the hit (the way its style's hitThrow says) in a cone `cone` degrees either side, `width` thick (default 1.7) */
  spray?: { count: number; speed: number; cone: number; life: number; color?: number; width?: number };
  /**
   * The rebound line itself: `count` bright streaks shooting out from the hit along the throw (fanned across `fan` degrees),
   * reaching `size` long (world units, scaled as the layers are) and `width` thick, then thinning away over `life` frames:
   * the leading read of a directional hit
   */
  flare?: { size: number; width: number; life: number; count?: number; fan?: number; color?: number };
  /** How wide the loose scatter of `impact.sparks` fans round the throw, degrees either side (default 40 for a directional hitThrow, 69 for 'back') */
  scatter?: number;
  /**
   * A fireball at the surface (heavy guns): `count` swelling glows thrown a little way out from the hull (between the
   * surface's normal and the throw), turning from `color` to `cool` as they drift and fade over `life` frames, `size` across
   */
  fireball?: { size: number; life: number; count?: number; color?: number; cool?: number };
  /**
   * Fragments torn off the hull (heavy and mid guns): `count` glowing chunks `size` across thrown out (between the normal
   * and the throw, `cone` degrees either side), slowing (`drag` a frame, default 0.95), cooling from `hot` to `cool`,
   * leaving a fading streak of `trail` and puffs of smoke, dimming away at the end. `speed` and `life` are the typical
   * fragment's: each is drawn on its own from a skewed spread round them (impactAim burstSpeed, burstLife), and a share
   * (`outliers`, default 0.15, drawn separately for each) goes `outSpeed` times as fast (default 2.2) or lives `outLife`
   * times as long (default 1.8): those carry the long streaks and smoke across the screen
   */
  debris?: { count: number; speed: number; size: number; life: number; hot: number; cool: number; trail?: number; cone?: number; drag?: number } & BurstSpread;
  /** The shell glancing off: a few long streaks of its own colour along the throw (a ricochet), `cone` degrees either side */
  ricochet?: { count: number; speed: number; cone: number; life: number };
  /** Embers: slow, heavier sparks that drift off (out of the surface, where one is known) and cool from `hot` to `cool` as they die */
  embers?: { count: number; speed: number; life: number; hot: number; cool: number } & BurstSpread;
  /** A glow left on the hull where it struck (it rides with the ship), cooling from white through `color` to nothing */
  scorch?: { size: number; life: number; color: number };
  /** A light shake for a screen within `radius` world units of the hit: strength (triggerScreenShake's), seconds */
  shake?: { strength: number; radius: number; time?: number };
  /** How far the hit lights its surroundings (world units, scaled as the layers are) and how brightly (default: from the bloom) */
  light?: { radius: number; power: number };
}

/**
 * A weapon model's look, by its function id (PlacedPart.fn): any field of its kind's style it names is replaced, the
 * rest stay the kind's. Filled in by the per-model units; empty here.
 */
export const MODEL_STYLES: Record<string, Partial<WeaponStyle>> = { ...ORDNANCE_STYLES };


/** A beam's look: PulseFx (pulse guns) and MiningBeamFx (cutting beams) read it; absent fields keep the grade's look */
export interface BeamLook {
  /** × the beam's drawn width */
  width?: number;
  /** Outer glow, body and core colours */
  outer?: number; mid?: number; core?: number;
  /** Two strands wound round the beam, this colour (see PulseLook.helix); with `braid` strands more than two */
  braid?: { color: number; strands: number };
  /** × the motes drawn in to the muzzle on the ramp (0: none) */
  motes?: number;
  /** A cone spread at the muzzle, half-angle in degrees (a searchlight's, a flamer's); 0: a line */
  cone?: number;
  /** Which pool the ramp-up charge draws from */
  ramp?: 'orb' | 'ring' | 'none';
  /** The beam breaks up and flickers when starved of power: × the usual (0: steady) */
  sputter?: number;
  /** The cone only reaches this far from the muzzle (a searchlight's is a spill of light, not the whole beam); default the beam */
  coneLen?: number;
  /** A molten pool of this colour at the hit point, growing with how long the beam has burned the same spot (the Cutter's) */
  pool?: number;
  /** The beam is a lightning polyline of this amplitude (world units), re-jittered every frame (the Tesla's) */
  zap?: number;
  /** Frost motes drifting off the beam and white crystals on what it lights: × the amount (0 or absent: none) */
  frost?: number;
  /**
   * What a held beam's burn throws off the surface it lights, every `every` frames while it burns (WeaponFx.beamBurn):
   * an impact like a shot's (ImpactLayers), splashing straight out of the surface; `color` its sparks' default
   */
  burn?: { every: number; color: number; hit: ImpactLayers };
}

/** Beam looks by model id (PlacedPart.fn); filled in by the per-model units */
export const BEAM_LOOKS: Record<string, BeamLook> = {};

/** The look of a beam model, if it has one */
export function beamLook(modelId: string | undefined): BeamLook | undefined {
  return modelId ? BEAM_LOOKS[modelId] : undefined;
}

// The legendaries' looks (their own file, so the other visuals units' tables stay apart)
Object.assign(MODEL_STYLES, LEGENDARY_STYLES);
Object.assign(BEAM_LOOKS, LEGENDARY_BEAMS);

/** Damage that reads as the base shot's size (a cannon's) */
const REF_DAMAGE = 14;

/**
 * How big a shot's recoil, flash and impact are against the base shot's, from its damage: a fifth-root-ish curve, so a
 * torpedo is big and a flak shard small but neither takes over the screen. Unknown or no damage: 1.
 */
export function shotScale(damage: number | undefined): number {
  if (!damage || damage <= 0) return 1;
  return Math.max(0.75, Math.min(1.7, Math.pow(damage / REF_DAMAGE, 0.3)));
}

/** A shot's scale (shell size × shotScale) where the muzzle flash stops growing in step with it */
const FLASH_KNEE = 3;

/**
 * How big a muzzle flash is against its style's size, from the shot's scale (shell size × shotScale): in step with it
 * through the usual range, at least 0.8 (a stream's flash still reads beside its tracer), and growing at 0.4 of the rate
 * past 3 (a heavy torpedo or missile launch is big, not a screen of light)
 */
export function muzzleScale(s: number): number {
  const v = Math.max(0.8, s);
  return v <= FLASH_KNEE ? v : FLASH_KNEE + (v - FLASH_KNEE) * 0.4;
}

const styled = new Map<string, WeaponStyle>();

/**
 * A shot's look: its model's if it has one (MODEL_STYLES over its kind's), else its weapon type's. The grade only scales
 * size and brightness (a little bigger, brighter mark by mark), never the look itself. Each combination is built once.
 */
export function weaponStyle(weaponType: number, grade = 1, modelId?: string): WeaponStyle {
  const kind = WEAPON_STYLES[weaponType] ?? KINETIC;
  // (An augmented shot, a ports ship's (common/src/ships/power/ports.ts): `<model>+aug`, its own entry if it has one, else its model's charged up)
  const augOf = modelId?.endsWith(AUG) ? modelId.slice(0, -AUG.length) : undefined;
  const over = !modelId ? undefined : augOf !== undefined ? MODEL_STYLES[modelId] ?? augmented({ ...kind, ...(MODEL_STYLES[augOf] ?? {}) }) : MODEL_STYLES[modelId];
  const g = Math.max(1, Math.min(5, Math.round(grade) || 1));
  if (g === 1 && !over) return kind;
  const key = `${modelId ?? ''}|${weaponType}|${g}`;
  let s = styled.get(key);
  if (s) return s;
  const base: WeaponStyle = over ? { ...kind, ...over } : kind;
  if (g === 1) s = base;
  else {
    const k = 1 + 0.07 * (g - 1);
    s = {
      ...base, glowWidth: base.glowWidth * k, haloRadius: base.haloRadius * k, glowAlpha: Math.min(0.8, base.glowAlpha * (1 + 0.06 * (g - 1))),
      muzzle: { ...base.muzzle, size: base.muzzle.size * k },
      impact: { ...base.impact, flash: base.impact.flash * (1 + 0.12 * (g - 1)), sparks: Math.round(base.impact.sparks * k) },
    };
  }
  styled.set(key, s);
  return s;
}

/** The model suffix of an augmented shot's look */
export const AUG = '+aug';
/**
 * An augmented shot's look, from its gun's own: the same colours run hotter (a white core, a wider glow and halo), a short
 * charged wake behind it, and a hit a step up (its layers a third bigger)
 */
function augmented(s: WeaponStyle): Partial<WeaponStyle> {
  const k = 1.33, hit = s.hit;
  return {
    ...s,
    coreColor: 0xffffff, coreWidth: s.coreWidth * 1.15, glowWidth: s.glowWidth * 1.35, glowAlpha: Math.min(0.85, s.glowAlpha * 1.25),
    headRadius: Math.max(s.headRadius, 2) * 1.2, haloRadius: s.haloRadius * 1.35,
    contrail: s.contrail ? { ...s.contrail, size: s.contrail.size * 1.3 } : { color: s.glowColor, size: Math.max(2, s.coreWidth), life: 22 },
    impact: { ...s.impact, flash: s.impact.flash * k, sparks: Math.round(s.impact.sparks * k) },
    ...(hit ? { hit: Object.fromEntries(Object.entries(hit).map(([key, v]) => [key, v && typeof v === 'object' && 'size' in v ? { ...v, size: (v as { size: number }).size * k } : v])) as typeof hit } : {}),
  };
}

/** Forget the built styles (tests that change MODEL_STYLES) */
export function clearStyleCache(): void {
  styled.clear();
}


/**
 * A directional hit (ImpactLayers) for a kind with no model of its own (an NPC's shells, a model that sets none): led by a
 * streak along the throw and a spray in a `cone`-degree cone round it, the centred core and glow small and brief, no
 * shock ring. `k` scales it, size and length both (a rail's bigger and longer than an autocannon's: from 1.2 a few
 * embers, from 1.5 a few fragments too); `color` is the spray's and streak's.
 */
export function DIRECTED_HIT(color: number, k: number, cone = 28): ImpactLayers {
  return {
    core: { size: 3 * k, life: 2 + Math.round(k) }, bloom: { size: 6 * k, life: 4 + Math.round(k * 2), color },
    spray: { count: Math.round(8 * k), speed: 7.5 * Math.sqrt(k), cone, life: Math.round(10 + 3 * k), color },
    flare: { size: 26 * k, width: 2 * Math.sqrt(k), life: Math.round(7 + 2 * k) }, scatter: cone,
    light: { radius: 35 * k, power: 0.5 },
    // (the bigger ones a few embers, the biggest a few chips trailing off too)
    ...(k >= 1.2 ? { embers: { count: Math.round(2 * k), speed: 3.6, life: Math.round(14 * k), hot: color, cool: 0x3a2010 } } : {}),
    ...(k >= 1.5 ? { debris: { count: Math.round(2 * k), speed: 10, size: 2, life: Math.round(14 * k), hot: color, cool: 0x3a2010, drag: 0.92 } } : {}),
  };
}

/**
 * A warhead's own mark where its shell strikes (missiles, torpedoes, mortars, flak, EMP, the Hive's seekers, charges): a
 * white pinpoint, a brief glow in the shot's impact colour, a few embers. Small, because the blast is the detonation's
 * (DamageFx.onDetonation, sized by its blast radius); before, these drew the old flat flash at the shot's full scale, so
 * a Leviathan's shell mark (476) reached three times past its own blast (160). Thrown back up the shell's line, centred.
 */
function BURST_MARK(ember: number, k = 1): ImpactLayers {
  return {
    core: { size: 4 * k, life: 3 }, bloom: { size: 10 * k, life: 8 },
    embers: { count: Math.round(3 * k), speed: 3, life: Math.round(20 * k), hot: ember, cool: 0x3a1a0a },
    light: { radius: 60 * k, power: 0.8 },
  };
}

// Sized for ships with 24-unit cells; each shot is further scaled by its shell size
const KINETIC: WeaponStyle = {
  motion: 'linear',
  tracerTicks: 2.2,
  coreWidth: 2.4,
  glowWidth: 7,
  coreColor: 0xfff7e6,
  glowColor: 0xffb04a,
  glowAlpha: 0.34,
  ownerTint: 0.2,
  headRadius: 3,
  haloRadius: 10,
  muzzle: { life: 7, size: 18, sparks: 6, color: 0xffd28a, smoke: 3 },
  impact: { sparks: 12, speed: 3.6, life: 18, color: 0xffc070, flash: 20 },
};

/**
 * Styles by projectile weapon type. Ships and enemies fire kinetic rounds
 * today; new weapon types get an entry here.
 */
export const WEAPON_STYLES: Record<number, WeaponStyle> = {
  // (Slugs ricochet off what they strike, hitThrow 'reflect'; bolts of light splash straight back out, 'normal'; the rest
  // (explosives, flak, seekers, orbs) throw back up their line as before, their shell's own mark small: BURST_MARK)
  // (and their hits lead with that throw: a streak along it, a spray round it, the centred flash small; ImpactLayers)
  [WeaponType.Cannon]: { ...KINETIC, hitThrow: 'reflect', hit: DIRECTED_HIT(0xffc070, 1) },
  // Railgun: a hypersonic slug, a long thin blue-white streak and a hard flash
  [WeaponType.Railgun]: {
    ...KINETIC, tracerTicks: 1.4, coreWidth: 2, glowWidth: 9, coreColor: 0xf2fbff, glowColor: 0x6ab8ff, glowAlpha: 0.45, ownerTint: 0.05,
    headRadius: 3.5, haloRadius: 14, muzzle: { life: 9, size: 30, sparks: 10, color: 0xbfe3ff, smoke: 4 },
    impact: { sparks: 22, speed: 6, life: 20, color: 0xbfe3ff, flash: 34 }, hitThrow: 'reflect', hit: DIRECTED_HIT(0xd8f6ff, 1.6, 18),
  },
  // Flak: a stubby glowing shell (the burst is the show)
  [WeaponType.Flak]: {
    ...KINETIC, tracerTicks: 1.2, coreWidth: 3, glowWidth: 8, coreColor: 0xffe0b0, glowColor: 0xff8a3c, glowAlpha: 0.38,
    headRadius: 3.5, haloRadius: 10, muzzle: { life: 6, size: 20, sparks: 5, color: 0xffb070, smoke: 4 }, hit: BURST_MARK(0xffb070, 0.8),
  },
  // Missile: a body with an engine flare and a smoke trail, steered by the server
  [WeaponType.Missile]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 0.8, coreWidth: 4, glowWidth: 10, coreColor: 0xdfe6ee, glowColor: 0xff9a3c, glowAlpha: 0.5,
    headRadius: 3, haloRadius: 12, muzzle: { life: 8, size: 22, sparks: 4, color: 0xffc080, smoke: 6 },
    trail: { color: 0x8c8780, size: 7, life: 50 }, hit: BURST_MARK(0xffc070),
  },
  // EMP: a crackling blue orb
  [WeaponType.Emp]: {
    ...KINETIC, tracerTicks: 1.5, coreWidth: 0, glowWidth: 14, coreColor: 0xe8f7ff, glowColor: 0x4fc3f7, glowAlpha: 0.3, ownerTint: 0,
    headRadius: 6, haloRadius: 22, muzzle: { life: 8, size: 24, sparks: 6, color: 0x9fe0ff, smoke: 0 },
    impact: { sparks: 14, speed: 4, life: 16, color: 0x9fe0ff, flash: 30 }, orb: true, hit: BURST_MARK(0xd8f4ff),
  },
  // ---- Legendary ----
  // Rustjaw's Hive: little seekers with short smoky trails
  [WeaponType.Hive]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 0.6, coreWidth: 3, glowWidth: 8, coreColor: 0xfff1d6, glowColor: 0xff9a3c, glowAlpha: 0.5,
    headRadius: 2.5, haloRadius: 9, muzzle: { life: 6, size: 16, sparks: 3, color: 0xffc080, smoke: 3 },
    trail: { color: 0x7d7770, size: 4, life: 28 }, hit: BURST_MARK(0xffc080, 0.8),
  },
  // Cinder Bloom: a burning slug dripping embers
  [WeaponType.CinderBloom]: {
    ...KINETIC, tracerTicks: 2, coreWidth: 3.5, glowWidth: 12, coreColor: 0xfff0c0, glowColor: 0xff5a1a, glowAlpha: 0.55, ownerTint: 0,
    headRadius: 4.5, haloRadius: 16, muzzle: { life: 9, size: 26, sparks: 10, color: 0xff9a4a, smoke: 5 },
    impact: { sparks: 20, speed: 3.5, life: 26, color: 0xff7a2a, flash: 30 }, trail: { color: 0x4a2a1a, size: 5, life: 26 }, hit: BURST_MARK(0xffa040, 1.2),
  },
  // Magma (a boss's turrets): a great slow ball of molten rock, white-hot at its heart, trailing smoke and embers
  [WeaponType.Magma]: {
    ...KINETIC, tracerTicks: 0.9, coreWidth: 6, glowWidth: 18, coreColor: 0xffe6b0, glowColor: 0xff5a14, glowAlpha: 0.6, ownerTint: 0,
    headRadius: 8, haloRadius: 24, muzzle: { life: 14, size: 40, sparks: 14, color: 0xff8a3a, smoke: 10, tongue: 1.4, girth: 1.8 },
    impact: { sparks: 30, speed: 4, life: 34, color: 0xff7a2a, flash: 46, ring: 0xff5a1a }, trail: { color: 0x3a1c12, size: 11, life: 44 },
  },
  // A boss's heart (the Pyreclast's): magma, hotter than its turrets' (white-hot through, a yellow glow: brighter than the
  // lava under it); a slow molten spark, and a seeker trailing smoke and embers
  // (its spark is a great slow orb, shot at 13× a shell's size: its parts are sized for that, a white-hot heart a little
  // bigger than the boss's own glowing core, a molten rim round it)
  [WeaponType.HeartSpark]: {
    ...KINETIC, tracerTicks: 0.5, coreWidth: 4, glowWidth: 7, coreColor: 0xfffbe8, glowColor: 0xffa02a, glowAlpha: 0.8, ownerTint: 0,
    headRadius: 5, haloRadius: 7.5, muzzle: { life: 8, size: 3, sparks: 1, color: 0xffd080, smoke: 0 },
    impact: { sparks: 3, speed: 3.5, life: 22, color: 0xff9a3a, flash: 4, ring: 0xff5a1a }, trail: { color: 0x3a1c12, size: 0.6, life: 20 },
  },
  [WeaponType.HeartSeeker]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 0.7, coreWidth: 4, glowWidth: 13, coreColor: 0xfff4d0, glowColor: 0xff7a1a, glowAlpha: 0.7, ownerTint: 0,
    headRadius: 5, haloRadius: 15, muzzle: { life: 8, size: 22, sparks: 5, color: 0xffb060, smoke: 2 },
    impact: { sparks: 18, speed: 4, life: 20, color: 0xff8a2a, flash: 30, ring: 0xff5a1a }, trail: { color: 0x3a1c12, size: 8, life: 34 },
  },
  // The Scrap Mother's: a rivet (a hot steel slug, hazard yellow), a great scrap chunk (dark metal, greyseam glowing at its
  // edges: at 11× a shell's size, its parts sized for that) and a greyseam seeker trailing green
  [WeaponType.Rivet]: {
    ...KINETIC, tracerTicks: 1.6, coreWidth: 3, glowWidth: 9, coreColor: 0xfff6d0, glowColor: 0xffc030, glowAlpha: 0.55, ownerTint: 0,
    headRadius: 3.5, haloRadius: 10, muzzle: { life: 7, size: 22, sparks: 6, color: 0xffd080, smoke: 3 },
    impact: { sparks: 14, speed: 4, life: 16, color: 0xffc060, flash: 18 }, hitThrow: 'reflect', hit: DIRECTED_HIT(0xffd080, 1.2),
  },
  [WeaponType.ScrapChunk]: {
    ...KINETIC, tracerTicks: 0.5, coreWidth: 4, glowWidth: 7, coreColor: 0x2a2d31, glowColor: 0x3aff9a, glowAlpha: 0.85, ownerTint: 0,
    headRadius: 3.2, haloRadius: 8.5, muzzle: { life: 8, size: 3, sparks: 1, color: 0xa8ffe4, smoke: 1 },
    impact: { sparks: 3, speed: 3.5, life: 22, color: 0x9affe0, flash: 4, ring: 0x3affb0 }, trail: { color: 0x2a2d31, size: 0.7, life: 20 },
  },
  [WeaponType.SeamSeeker]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 0.7, coreWidth: 4, glowWidth: 13, coreColor: 0xf0fffa, glowColor: 0x3affc0, glowAlpha: 0.7, ownerTint: 0,
    headRadius: 5, haloRadius: 15, muzzle: { life: 8, size: 22, sparks: 5, color: 0xa8ffe4, smoke: 0 },
    impact: { sparks: 18, speed: 4, life: 20, color: 0x7affd2, flash: 30, ring: 0x2ad8a0 }, trail: { color: 0x1a3a30, size: 8, life: 34 },
  },
  // Prism Splitter: a faceted crystal bolt
  [WeaponType.Prism]: {
    ...KINETIC, tracerTicks: 1.8, coreWidth: 3, glowWidth: 13, coreColor: 0xffffff, glowColor: 0xe879f9, glowAlpha: 0.5, ownerTint: 0,
    headRadius: 5, haloRadius: 18, muzzle: { life: 8, size: 24, sparks: 8, color: 0xf5d0fe, smoke: 0 },
    impact: { sparks: 18, speed: 5, life: 16, color: 0x67e8f9, flash: 26 }, hitThrow: 'normal', hit: { ...DIRECTED_HIT(0xf5d0fe, 1.4, 34), flare: { size: 40, width: 3, life: 10, count: 3, fan: 36 } },
  },
  [WeaponType.PrismShard]: {
    ...KINETIC, tracerTicks: 2.4, coreWidth: 1.6, glowWidth: 6, coreColor: 0xffffff, glowColor: 0x67e8f9, glowAlpha: 0.5, ownerTint: 0,
    headRadius: 2, haloRadius: 7, muzzle: { life: 1, size: 1, sparks: 0, color: 0xffffff, smoke: 0 },
    impact: { sparks: 6, speed: 3, life: 10, color: 0xf0abfc, flash: 12 }, shardHue: 360, hitThrow: 'normal', hit: DIRECTED_HIT(0xf0abfc, 0.7),
  },
  // Phase Cannon: a shimmering violet slug
  [WeaponType.Phase]: {
    ...KINETIC, tracerTicks: 2.6, coreWidth: 4, glowWidth: 16, coreColor: 0xf5f3ff, glowColor: 0x8b5cf6, glowAlpha: 0.5, ownerTint: 0,
    headRadius: 6, haloRadius: 24, muzzle: { life: 10, size: 34, sparks: 6, color: 0xc4b5fd, smoke: 0 },
    impact: { sparks: 14, speed: 4, life: 18, color: 0xc4b5fd, flash: 30 }, hitThrow: 'normal', hit: { ...DIRECTED_HIT(0xddd6fe, 1.6, 26), flare: { size: 50, width: 3.6, life: 11, count: 2, fan: 14 } },
  },
  // Singularity: a dark orb ringed with light
  [WeaponType.Singularity]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 1, coreWidth: 0, glowWidth: 26, coreColor: 0x1a0b2e, glowColor: 0x9b5de5, glowAlpha: 0.35, ownerTint: 0,
    headRadius: 12, headColor: 0x0b0414, haloRadius: 46, muzzle: { life: 12, size: 40, sparks: 10, color: 0xc084fc, smoke: 0 },
    impact: { sparks: 20, speed: 5, life: 20, color: 0xd8b4fe, flash: 40 }, orb: true, hit: BURST_MARK(0xf0e0ff),
    // (the pull radius is the model's: data/ships/tuning.json singularity.pull.radius, pinned by weaponStyles.test.ts)
    pull: { radius: 900, color: 0xb98cf0 },
  },
  // Autocannon: short, quick tracers
  [WeaponType.Autocannon]: {
    ...KINETIC, tracerTicks: 0.9, coreWidth: 1.6, glowWidth: 5, coreColor: 0xffe8c0, glowColor: 0xffa040, glowAlpha: 0.35, hitThrow: 'reflect', hit: DIRECTED_HIT(0xffd9a0, 0.8),
  },
  // Pulse laser: hot pink bolts
  [WeaponType.Pulse]: {
    ...KINETIC, tracerTicks: 2.2, coreWidth: 2.4, glowWidth: 10, coreColor: 0xffe4f2, glowColor: 0xff4fa3, glowAlpha: 0.55, ownerTint: 0,
    impact: { sparks: 8, speed: 3, life: 12, color: 0xff8cc6, flash: 18 }, hitThrow: 'normal', hit: DIRECTED_HIT(0xffb0d8, 1, 30),
  },
  // Torpedo: a fat, slow, glowing slug
  [WeaponType.Torpedo]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 1.2, coreWidth: 6, glowWidth: 18, coreColor: 0xfff3d6, glowColor: 0xffa040, glowAlpha: 0.5, ownerTint: 0,
    impact: { sparks: 24, speed: 5, life: 22, color: 0xffc46b, flash: 50 }, hit: BURST_MARK(0xffd08a, 1.2),
  },
  // Mortar: a dull shell (sent as it flies)
  [WeaponType.Mortar]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 1, coreWidth: 4, glowWidth: 9, coreColor: 0xe6ee9c, glowColor: 0x9e9d24, glowAlpha: 0.4, hit: BURST_MARK(0xf0e0a0),
  },
  // Mining charge: a blinking amber canister
  [WeaponType.Charge]: {
    ...KINETIC, tracerTicks: 1, coreWidth: 3.5, glowWidth: 10, coreColor: 0xfff3c4, glowColor: 0xffb300, glowAlpha: 0.5, ownerTint: 0, hit: BURST_MARK(0xffd060),
  },
  // Arc projector: a crackling blue spark
  [WeaponType.Arc]: {
    ...KINETIC, tracerTicks: 2.8, coreWidth: 2.2, glowWidth: 14, coreColor: 0xf0fbff, glowColor: 0x6ac8ff, glowAlpha: 0.6, ownerTint: 0,
    impact: { sparks: 12, speed: 4, life: 14, color: 0x9ad8ff, flash: 26 }, hitThrow: 'normal', hit: DIRECTED_HIT(0xd8f2ff, 1.1, 26),
  },
};

// Per-model looks, by family (each in its own file)
Object.assign(MODEL_STYLES, KINETIC_MODEL_STYLES);
