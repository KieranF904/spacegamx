/** Looks of the kinetic weapons by model id (cannons, autocannons, flak, railguns): rework-2026-11 section 4 */

import type { WeaponStyle } from './weaponStyles';

// ---- Kinetic models (rework-2026-11 section 4): amber and yellow for shells and streams, cyan for rails ----
const CYAN = { core: 0xeafcff, glow: 0x4fd0ff, flash: 0xaee8ff };

export const KINETIC_MODEL_STYLES = {
  // The reference gun: a short amber-white tracer, a small flash, a puff of sparks
  cannon_pip: {
    muzzle: { life: 6, size: 15, sparks: 5, color: 0xffd28a, smoke: 2 },
  },
  // One slow armour-piercing slug: fat, dull orange, a short heavy tracer; a grey thump at the muzzle, a dust ring where it lands
  cannon_hammer: {
    tracerTicks: 1.5, coreWidth: 4, glowWidth: 12, coreColor: 0xffd9a0, glowColor: 0xd9682a, glowAlpha: 0.42, headRadius: 4.5, haloRadius: 13,
    muzzle: { life: 10, size: 24, sparks: 5, color: 0xd98a4a, smoke: 8, tongue: 0.8, girth: 1.5, ring: { color: 0xa39a90, size: 0.9 } },
    impact: { sparks: 14, speed: 2.2, life: 28, color: 0xd98a4a, flash: 28, ring: 0xa0663a },
    smokeCloud: { color: 0x8a7a66, size: 7, life: 38 },
  },
  // Paired autoloader: two thin tracers from alternating barrels, brass flung sideways (the barrels glow red while it reloads: gunAnim)
  cannon_twinlink: {
    pair: { gap: 7 }, casings: 2, tracerTicks: 1.8, coreWidth: 2.2, glowWidth: 6, headRadius: 2.6, haloRadius: 8,
    muzzle: { life: 5, size: 14, sparks: 3, color: 0xffd28a, smoke: 1 },
  },
  // The sniper: one long thin white-gold streak with a contrail down the whole path, a muzzle shock ring, a narrow spark jet (the sight line is ChargeFx's)
  cannon_longbarrel: {
    tracerTicks: 10, coreWidth: 1.7, glowWidth: 5.5, coreColor: 0xfffbe8, glowColor: 0xffd070, glowAlpha: 0.5, headRadius: 3, haloRadius: 9,
    muzzle: { life: 11, size: 30, sparks: 8, color: 0xffe9b0, smoke: 3, tongue: 3.5, girth: 0.55, ring: { color: 0xffe6a0, size: 1.1 } },
    contrail: { color: 0xffe6a0, size: 3, life: 48 },
    impact: { sparks: 20, speed: 7, life: 14, color: 0xffe6a0, flash: 26, ring: 0xffd070 },
  },
  // The ship-killer: a red-hot ball round a dark core with a heat haze pulsing off it, a smoke ring and heavy kick at the muzzle, a big double-ringed impact
  cannon_bastion: {
    tracerTicks: 1.1, coreWidth: 9, glowWidth: 19, coreColor: 0x2a1008, glowColor: 0xff4a1a, glowAlpha: 0.6, ownerTint: 0, headRadius: 0, haloRadius: 17,
    ringPulse: { color: 0xff9a5a, size: 20, period: 22 },
    muzzle: { life: 13, size: 32, sparks: 8, color: 0xff8a50, smoke: 10, tongue: 1.1, girth: 1.7, ring: { color: 0x9a8e84, size: 1.3 } },
    impact: { sparks: 30, speed: 4.2, life: 30, color: 0xffa060, flash: 44, ring: 0xff5a2a },
    smokeCloud: { color: 0x4a3a30, size: 9, life: 50 },
  },
  // The steady hose: short yellow tracers, every fourth one bright
  autocannon_rattler: {
    coreColor: 0xfff1a0, glowColor: 0xffc830, accent: { every: 4, dim: 0.4 },
    muzzle: { life: 5, size: 11, sparks: 2, color: 0xffe08a, smoke: 1 },
  },
  // The minigun: tracers run orange to white-hot as it spins up, brass sprays thicker the longer it holds
  autocannon_chainsaw: {
    heat: { cold: 0xff8a2a, hot: 0xffffff }, casings: 2, coreColor: 0xffd9a0, glowColor: 0xff8a2a, tracerTicks: 1.0,
    muzzle: { life: 5, size: 13, sparks: 3, color: 0xffb04a, smoke: 1, tongue: 1.3 },
  },
  // The marksman SMG: thin white-yellow needles in a tight line, crisp puncture flashes
  autocannon_stinger: {
    tracerTicks: 1.7, coreWidth: 1.1, glowWidth: 3.5, coreColor: 0xffffff, glowColor: 0xfff0a0, glowAlpha: 0.4, headRadius: 1.8, haloRadius: 6,
    muzzle: { life: 5, size: 12, sparks: 3, color: 0xfff4c0, smoke: 0 },
    impact: { sparks: 8, speed: 4.5, life: 10, color: 0xfff0a0, flash: 15 },
  },
  // The sky-filler: a stubby orange shell (the airburst, with its lingering cloud, is DamageFx's flak branch)
  flak_burst: {
    coreColor: 0xffe0b0, glowColor: 0xff8a3c, muzzle: { life: 6, size: 18, sparks: 4, color: 0xffb070, smoke: 3 },
  },
  // The wall you place: a brown-gold shell blinking like a timer
  flak_cloudmaker: {
    coreColor: 0xf0d090, glowColor: 0xb8802c, glowAlpha: 0.42, haloRadius: 12, blink: 9, aimTick: true,
    muzzle: { life: 7, size: 20, sparks: 4, color: 0xd9a050, smoke: 5 },
  },
  // The cheap rail: today's long thin streak in cyan, an ionised contrail, three coil rings at the muzzle
  railgun_needle: {
    coreColor: CYAN.core, glowColor: CYAN.glow, contrail: { color: 0x8fe4ff, size: 2.6, life: 24 },
    muzzle: { life: 10, size: 28, sparks: 8, color: CYAN.flash, smoke: 2, ring: { color: 0x7fdcff, count: 3, size: 0.7 } },
    impact: { sparks: 20, speed: 6, life: 18, color: CYAN.flash, flash: 30 },
  },
  // The rail shotgun: five short streaks fanning out, a wide cone flash, a crackle ring
  railgun_coilgun: {
    tracerTicks: 0.9, coreWidth: 1.5, glowWidth: 6, coreColor: CYAN.core, glowColor: CYAN.glow, headRadius: 2, haloRadius: 8,
    muzzle: { life: 8, size: 22, sparks: 3, color: CYAN.flash, smoke: 0, tongue: 0.6, girth: 2.4, ring: { color: 0x9fe8ff, size: 0.8 } },
    impact: { sparks: 8, speed: 5, life: 14, color: CYAN.flash, flash: 20 },
  },
  // The capital rail: a thick violet-white line that lingers, a big muzzle blast (a shock ring at each hull it passes is DamageFx's)
  railgun_spear: {
    tracerTicks: 3, coreWidth: 5, glowWidth: 17, coreColor: 0xf6f0ff, glowColor: 0xa070ff, glowAlpha: 0.55, ownerTint: 0, headRadius: 5, haloRadius: 18,
    contrail: { color: 0xb89cff, size: 6, life: 60 },
    muzzle: { life: 13, size: 40, sparks: 10, color: 0xd8c4ff, smoke: 4, tongue: 2.2, girth: 1.4, ring: { color: 0xc4a8ff, size: 1.3 } },
    impact: { sparks: 26, speed: 6, life: 22, color: 0xd8c4ff, flash: 40, ring: 0x9a70ff },
  },
  // The semi-automatic rifle: short sharp cyan tracers, a crisp snap (the six rail lights are gunAnim's)
  railgun_rail_driver: {
    tracerTicks: 0.9, coreWidth: 1.7, glowWidth: 6, coreColor: CYAN.core, glowColor: CYAN.glow, headRadius: 2.4, haloRadius: 9,
    muzzle: { life: 5, size: 18, sparks: 5, color: CYAN.flash, smoke: 0, tongue: 0.9, girth: 0.9 },
    impact: { sparks: 12, speed: 5, life: 12, color: CYAN.flash, flash: 22 },
  },
} satisfies Record<string, Partial<WeaponStyle>>;
