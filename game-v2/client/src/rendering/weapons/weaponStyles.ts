/**
 * How each weapon's shots look. Aimed at believable space weapons: thin,
 * hot tracers with a soft additive glow, brief muzzle flashes, spark bursts on
 * impact. Colours are mostly physical (white-hot cores, warm or plasma glows);
 * the owner's hue only tints the glow a little so friend and foe stay readable.
 */

import { WeaponType } from '@space-game/common';

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
  /** Soft halo around the head (0 = none) */
  haloRadius: number;
  /** tongue: the forward flame's length × this; girth: the flash's width × this (a heavy shell's flash is fat) */
  muzzle: { life: number; size: number; sparks: number; color: number; smoke: number; tongue?: number; girth?: number };
  /** ring: a second, wider shock ring of this colour (the heavier marks) */
  impact: { sparks: number; speed: number; life: number; color: number; flash: number; ring?: number };
  /** Leaves a smoke trail (missiles) */
  trail?: { color: number; size: number; life: number };
  /** Drawn as a crackling orb rather than a tracer (EMP) */
  orb?: boolean;
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
  [WeaponType.Cannon]: KINETIC,
  // Railgun: a hypersonic slug, a long thin blue-white streak and a hard flash
  [WeaponType.Railgun]: {
    ...KINETIC, tracerTicks: 1.4, coreWidth: 2, glowWidth: 9, coreColor: 0xf2fbff, glowColor: 0x6ab8ff, glowAlpha: 0.45, ownerTint: 0.05,
    headRadius: 3.5, haloRadius: 14, muzzle: { life: 9, size: 30, sparks: 10, color: 0xbfe3ff, smoke: 4 },
    impact: { sparks: 22, speed: 6, life: 20, color: 0xbfe3ff, flash: 34 },
  },
  // Flak: a stubby glowing shell (the burst is the show)
  [WeaponType.Flak]: {
    ...KINETIC, tracerTicks: 1.2, coreWidth: 3, glowWidth: 8, coreColor: 0xffe0b0, glowColor: 0xff8a3c, glowAlpha: 0.38,
    headRadius: 3.5, haloRadius: 10, muzzle: { life: 6, size: 20, sparks: 5, color: 0xffb070, smoke: 4 },
  },
  // Missile: a body with an engine flare and a smoke trail, steered by the server
  [WeaponType.Missile]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 0.8, coreWidth: 4, glowWidth: 10, coreColor: 0xdfe6ee, glowColor: 0xff9a3c, glowAlpha: 0.5,
    headRadius: 3, haloRadius: 12, muzzle: { life: 8, size: 22, sparks: 4, color: 0xffc080, smoke: 6 },
    trail: { color: 0x8c8780, size: 7, life: 50 },
  },
  // EMP: a crackling blue orb
  [WeaponType.Emp]: {
    ...KINETIC, tracerTicks: 1.5, coreWidth: 0, glowWidth: 14, coreColor: 0xe8f7ff, glowColor: 0x4fc3f7, glowAlpha: 0.3, ownerTint: 0,
    headRadius: 6, haloRadius: 22, muzzle: { life: 8, size: 24, sparks: 6, color: 0x9fe0ff, smoke: 0 },
    impact: { sparks: 14, speed: 4, life: 16, color: 0x9fe0ff, flash: 30 }, orb: true,
  },
  // ---- Legendary ----
  // Rustjaw's Hive: little seekers with short smoky trails
  [WeaponType.Hive]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 0.6, coreWidth: 3, glowWidth: 8, coreColor: 0xfff1d6, glowColor: 0xff9a3c, glowAlpha: 0.5,
    headRadius: 2.5, haloRadius: 9, muzzle: { life: 6, size: 16, sparks: 3, color: 0xffc080, smoke: 3 },
    trail: { color: 0x7d7770, size: 4, life: 28 },
  },
  // Cinder Bloom: a burning slug dripping embers
  [WeaponType.CinderBloom]: {
    ...KINETIC, tracerTicks: 2, coreWidth: 3.5, glowWidth: 12, coreColor: 0xfff0c0, glowColor: 0xff5a1a, glowAlpha: 0.55, ownerTint: 0,
    headRadius: 4.5, haloRadius: 16, muzzle: { life: 9, size: 26, sparks: 10, color: 0xff9a4a, smoke: 5 },
    impact: { sparks: 20, speed: 3.5, life: 26, color: 0xff7a2a, flash: 30 }, trail: { color: 0x4a2a1a, size: 5, life: 26 },
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
    impact: { sparks: 14, speed: 4, life: 16, color: 0xffc060, flash: 18 },
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
    impact: { sparks: 18, speed: 5, life: 16, color: 0x67e8f9, flash: 26 },
  },
  [WeaponType.PrismShard]: {
    ...KINETIC, tracerTicks: 2.4, coreWidth: 1.6, glowWidth: 6, coreColor: 0xffffff, glowColor: 0x67e8f9, glowAlpha: 0.5, ownerTint: 0,
    headRadius: 2, haloRadius: 7, muzzle: { life: 1, size: 1, sparks: 0, color: 0xffffff, smoke: 0 },
    impact: { sparks: 6, speed: 3, life: 10, color: 0xf0abfc, flash: 12 },
  },
  // Phase Cannon: a shimmering violet slug
  [WeaponType.Phase]: {
    ...KINETIC, tracerTicks: 2.6, coreWidth: 4, glowWidth: 16, coreColor: 0xf5f3ff, glowColor: 0x8b5cf6, glowAlpha: 0.5, ownerTint: 0,
    headRadius: 6, haloRadius: 24, muzzle: { life: 10, size: 34, sparks: 6, color: 0xc4b5fd, smoke: 0 },
    impact: { sparks: 14, speed: 4, life: 18, color: 0xc4b5fd, flash: 30 },
  },
  // Singularity: a dark orb ringed with light
  [WeaponType.Singularity]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 1, coreWidth: 0, glowWidth: 26, coreColor: 0x1a0b2e, glowColor: 0x9b5de5, glowAlpha: 0.35, ownerTint: 0,
    headRadius: 12, haloRadius: 46, muzzle: { life: 12, size: 40, sparks: 10, color: 0xc084fc, smoke: 0 },
    impact: { sparks: 20, speed: 5, life: 20, color: 0xd8b4fe, flash: 40 }, orb: true,
  },
  // Autocannon: short, quick tracers
  [WeaponType.Autocannon]: {
    ...KINETIC, tracerTicks: 0.9, coreWidth: 1.6, glowWidth: 5, coreColor: 0xffe8c0, glowColor: 0xffa040, glowAlpha: 0.35,
  },
  // Pulse laser: hot pink bolts
  [WeaponType.Pulse]: {
    ...KINETIC, tracerTicks: 2.2, coreWidth: 2.4, glowWidth: 10, coreColor: 0xffe4f2, glowColor: 0xff4fa3, glowAlpha: 0.55, ownerTint: 0,
    impact: { sparks: 8, speed: 3, life: 12, color: 0xff8cc6, flash: 18 },
  },
  // Torpedo: a fat, slow, glowing slug
  [WeaponType.Torpedo]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 1.2, coreWidth: 6, glowWidth: 18, coreColor: 0xfff3d6, glowColor: 0xffa040, glowAlpha: 0.5, ownerTint: 0,
    impact: { sparks: 24, speed: 5, life: 22, color: 0xffc46b, flash: 50 },
  },
  // Mortar: a dull shell (sent as it flies)
  [WeaponType.Mortar]: {
    ...KINETIC, motion: 'tracked', tracerTicks: 1, coreWidth: 4, glowWidth: 9, coreColor: 0xe6ee9c, glowColor: 0x9e9d24, glowAlpha: 0.4,
  },
  // Mining charge: a blinking amber canister
  [WeaponType.Charge]: {
    ...KINETIC, tracerTicks: 1, coreWidth: 3.5, glowWidth: 10, coreColor: 0xfff3c4, glowColor: 0xffb300, glowAlpha: 0.5, ownerTint: 0,
  },
  // Arc projector: a crackling blue spark
  [WeaponType.Arc]: {
    ...KINETIC, tracerTicks: 2.8, coreWidth: 2.2, glowWidth: 14, coreColor: 0xf0fbff, glowColor: 0x6ac8ff, glowAlpha: 0.6, ownerTint: 0,
    impact: { sparks: 12, speed: 4, life: 14, color: 0x9ad8ff, flash: 26 },
  },
};

/**
 * Cannon shells by grade (tuning.json weaponGrades gives each mark its own
 * character; these match it). Mk I is the plain kinetic round; each mark up
 * reads stronger, and differently:
 *   Mk II   heavy shell: fatter, slower-looking, deep amber; a big fat muzzle flash and a thump of smoke
 *   Mk III  high-velocity slug: a long white-gold streak, thin and sharp
 *   Mk IV   autoloader: quick teal-white darts, crisp double impact ring
 *   Mk V    siege slug: a violet-white plasma-jacketed bolt with a heavy halo and a shock ring
 */
const CANNON_GRADES: Partial<WeaponStyle>[] = [
  {},
  {
    tracerTicks: 1.9, coreWidth: 3.1, glowWidth: 9.5, coreColor: 0xfff0d6, glowColor: 0xff8a2a, glowAlpha: 0.42,
    headRadius: 3.8, haloRadius: 14, muzzle: { life: 12, size: 31, sparks: 12, color: 0xffa850, smoke: 10, tongue: 1, girth: 1.5 },
    impact: { sparks: 16, speed: 3.4, life: 22, color: 0xffa050, flash: 28 },
  },
  {
    tracerTicks: 3.6, coreWidth: 2, glowWidth: 7.5, coreColor: 0xffffff, glowColor: 0xffe08a, glowAlpha: 0.48, ownerTint: 0.1,
    headRadius: 3.2, haloRadius: 11, muzzle: { life: 8, size: 30, sparks: 12, color: 0xfff0b8, smoke: 3, tongue: 1.7, girth: 0.8 },
    impact: { sparks: 18, speed: 5.6, life: 16, color: 0xfff0b0, flash: 26 },
  },
  {
    tracerTicks: 2.4, coreWidth: 2.4, glowWidth: 9, coreColor: 0xf0fffb, glowColor: 0x3fe0c8, glowAlpha: 0.5, ownerTint: 0.08,
    headRadius: 3.4, haloRadius: 13, muzzle: { life: 6, size: 27, sparks: 9, color: 0x9ff5e6, smoke: 2, tongue: 1.2, girth: 1 },
    impact: { sparks: 18, speed: 4.4, life: 18, color: 0x8ff0e0, flash: 30, ring: 0x3fe0c8 },
  },
  {
    tracerTicks: 3, coreWidth: 3.6, glowWidth: 13, coreColor: 0xfdf6ff, glowColor: 0xb36bff, glowAlpha: 0.55, ownerTint: 0,
    headRadius: 4.6, haloRadius: 21, muzzle: { life: 14, size: 44, sparks: 16, color: 0xd9b3ff, smoke: 5, tongue: 1.35, girth: 1.4 },
    impact: { sparks: 26, speed: 5, life: 24, color: 0xd6a8ff, flash: 44, ring: 0xb36bff },
  },
];

const graded = new Map<number, WeaponStyle>();

/**
 * A shot's look: its weapon type's, and its gun's grade (Mk I-V). Cannons have
 * a look per mark (CANNON_GRADES); other weapons just burn a little bigger and
 * brighter each mark up. Each pair is built once.
 */
export function weaponStyle(weaponType: number, grade = 1): WeaponStyle {
  const base = WEAPON_STYLES[weaponType] ?? KINETIC;
  const g = Math.max(1, Math.min(5, Math.round(grade) || 1));
  if (g === 1) return base;
  const key = weaponType * 8 + g;
  let s = graded.get(key);
  if (s) return s;
  if (base === KINETIC) s = { ...KINETIC, ...CANNON_GRADES[g - 1] };
  else {
    const k = 1 + 0.07 * (g - 1);
    s = {
      ...base, glowWidth: base.glowWidth * k, haloRadius: base.haloRadius * k, glowAlpha: Math.min(0.8, base.glowAlpha * (1 + 0.06 * (g - 1))),
      muzzle: { ...base.muzzle, size: base.muzzle.size * k },
      impact: { ...base.impact, flash: base.impact.flash * (1 + 0.12 * (g - 1)), sparks: Math.round(base.impact.sparks * k) },
    };
  }
  graded.set(key, s);
  return s;
}
