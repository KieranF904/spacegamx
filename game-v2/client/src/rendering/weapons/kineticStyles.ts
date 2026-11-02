/**
 * Looks of the kinetic weapons by model id (cannons, autocannons, flak, railguns): rework-2026-11 section 4.
 *
 * Impacts (`hit`, weaponStyles ImpactLayers) follow the gun's power tier (its infra.tier in models.json): heavy guns
 * (Bastion, Longbarrel, Spear, Rail Driver) get the whole stack, a white-hot core, a coloured glow, a crisp shock ring, a
 * spray thrown back off the hull, embers that cool, a glow left on the hull, the heaviest a light shake; mid guns
 * (Hammer, Slurry Cannon, Needle, Coilgun, Twinlink, Chainsaw) a smaller core and glow, a spray and at most a thin ring;
 * simple guns (Pip, Rattler, Stinger) a small quick spark and glow, so a ship with eight of them is not noise.
 */

import type { WeaponStyle } from './weaponStyles';

// ---- Kinetic models (rework-2026-11 section 4): amber and yellow for shells and streams, cyan for rails ----
const CYAN = { core: 0xeafcff, glow: 0x4fd0ff, flash: 0xaee8ff };

export const KINETIC_MODEL_STYLES = {
  // The reference gun: a short amber-white tracer, a small flash, a puff of sparks
  cannon_pip: {
    muzzle: { life: 6, size: 15, sparks: 5, color: 0xffd28a, smoke: 2 },
    impact: { sparks: 3, speed: 3.6, life: 14, color: 0xffc070, flash: 14 },
    hit: { core: { size: 5, life: 3 }, bloom: { size: 11, life: 7, color: 0xffb04a }, spray: { count: 3, speed: 6, cone: 40, life: 9 }, light: { radius: 45, power: 0.6 } },
  },
  // One slow armour-piercing slug: fat, dull orange, a short heavy tracer; a grey thump at the muzzle, a dust ring where it lands
  cannon_hammer: {
    tracerTicks: 1.5, coreWidth: 4, glowWidth: 12, coreColor: 0xffd9a0, glowColor: 0xd9682a, glowAlpha: 0.42, headRadius: 4.5, haloRadius: 13,
    muzzle: { life: 10, size: 24, sparks: 5, color: 0xd98a4a, smoke: 8, tongue: 0.8, girth: 1.5, ring: { color: 0xa39a90, size: 0.9 } },
    impact: { sparks: 5, speed: 2.2, life: 26, color: 0xd98a4a, flash: 28, ring: 0xa0663a },
    hit: {
      core: { size: 6, life: 5 }, bloom: { size: 16, life: 12, color: 0xe0782a },
      shock: { size: 26, life: 16, width: 2, color: 0xa39a90 },
      spray: { count: 7, speed: 6, cone: 40, life: 14, color: 0xffc08a },
      embers: { count: 3, speed: 1.8, life: 45, hot: 0xffc070, cool: 0x6a2a10 },
      scorch: { size: 5, life: 55, color: 0xd9682a }, light: { radius: 70, power: 0.8 },
    },
    smokeCloud: { color: 0x8a7a66, size: 7, life: 38 },
  },
  // Paired autoloader: two thin tracers from alternating barrels, brass flung sideways (the barrels glow red while it reloads: gunAnim)
  cannon_twinlink: {
    pair: { gap: 7 }, casings: 2, tracerTicks: 1.8, coreWidth: 2.2, glowWidth: 6, headRadius: 2.6, haloRadius: 8,
    muzzle: { life: 5, size: 14, sparks: 3, color: 0xffd28a, smoke: 1 },
    impact: { sparks: 3, speed: 3.6, life: 16, color: 0xffc070, flash: 16 },
    hit: {
      core: { size: 4.5, life: 4 }, bloom: { size: 10, life: 9, color: 0xffb04a }, spray: { count: 4, speed: 6, cone: 35, life: 11 },
      embers: { count: 1, speed: 1.4, life: 30, hot: 0xffd080, cool: 0x6a2a10 }, light: { radius: 50, power: 0.7 },
    },
  },
  // The sniper: one long thin white-gold streak with a contrail down the whole path, a muzzle shock ring, a narrow spark jet (the sight line is ChargeFx's)
  cannon_longbarrel: {
    tracerTicks: 10, coreWidth: 1.7, glowWidth: 5.5, coreColor: 0xfffbe8, glowColor: 0xffd070, glowAlpha: 0.5, headRadius: 3, haloRadius: 9,
    muzzle: { life: 11, size: 30, sparks: 8, color: 0xffe9b0, smoke: 3, tongue: 3.5, girth: 0.55, ring: { color: 0xffe6a0, size: 1.1 } },
    contrail: { color: 0xffe6a0, size: 3, life: 48 },
    impact: { sparks: 6, speed: 7, life: 14, color: 0xffe6a0, flash: 26, ring: 0xffd070 },
    // A sniper's hit: a hard white pinpoint, a narrow jet of sparks straight back, a thin gold ring
    hit: {
      core: { size: 11, life: 5 }, bloom: { size: 24, life: 12, color: 0xffd070 },
      shock: { size: 44, life: 15, width: 2.4, color: 0xffe6a0 },
      spray: { count: 14, speed: 12, cone: 16, life: 14, color: 0xffe6a0 },
      embers: { count: 4, speed: 2, life: 50, hot: 0xfff0c0, cool: 0x8a5010 },
      scorch: { size: 7, life: 70, color: 0xffc050 }, light: { radius: 130, power: 1 },
    },
  },
  // The ship-killer: a red-hot ball round a dark core with a heat haze pulsing off it, a smoke ring and heavy kick at the
  // muzzle. It lands as the heaviest hit in the game: a white-hot core, a red-orange glow, a double shock ring, a spray of
  // sparks back off the hull, embers cooling to dull red, a glow on the hull where it struck, a light shake
  cannon_bastion: {
    tracerTicks: 1.1, coreWidth: 9, glowWidth: 19, coreColor: 0x2a1008, glowColor: 0xff4a1a, glowAlpha: 0.6, ownerTint: 0, headRadius: 0, haloRadius: 17,
    ringPulse: { color: 0xff9a5a, size: 20, period: 22 },
    muzzle: { life: 13, size: 20, sparks: 8, color: 0xff8a50, smoke: 10, tongue: 1.2, girth: 1.35, ring: { color: 0x9a8e84, size: 1.3 } },
    impact: { sparks: 6, speed: 4.2, life: 26, color: 0xffa060, flash: 44, ring: 0xff5a2a },
    hit: {
      core: { size: 14, life: 7 }, bloom: { size: 34, life: 18, color: 0xff6a2a },
      shock: { size: 62, life: 22, width: 3.2, color: 0xffb27a, count: 1, gap: 5 },
      spray: { count: 16, speed: 12, cone: 38, life: 18, color: 0xffc890 },
      embers: { count: 10, speed: 2.6, life: 75, hot: 0xffd27a, cool: 0x8a1e08 },
      scorch: { size: 9, life: 100, color: 0xff5a1a },
      shake: { strength: 3, radius: 900 }, light: { radius: 140, power: 1.1 },
    },
    smokeCloud: { color: 0x4a3a30, size: 6, life: 50 },
  },
  // The steady hose: short yellow tracers, every fourth one bright
  autocannon_rattler: {
    coreColor: 0xfff1a0, glowColor: 0xffc830, accent: { every: 4, dim: 0.4 },
    muzzle: { life: 5, size: 11, sparks: 2, color: 0xffe08a, smoke: 1 },
    impact: { sparks: 2, speed: 3.4, life: 12, color: 0xffd060, flash: 12 },
    hit: { core: { size: 5.5, life: 3 }, bloom: { size: 12, life: 6, color: 0xffc830 }, spray: { count: 2, speed: 5, cone: 40, life: 8 }, light: { radius: 35, power: 0.45 } },
  },
  // The minigun: tracers run orange to white-hot as it spins up, brass sprays thicker the longer it holds
  autocannon_chainsaw: {
    heat: { cold: 0xff8a2a, hot: 0xffffff }, casings: 2, coreColor: 0xffd9a0, glowColor: 0xff8a2a, tracerTicks: 1.0,
    muzzle: { life: 5, size: 13, sparks: 3, color: 0xffb04a, smoke: 1, tongue: 1.3 },
    impact: { sparks: 2, speed: 3.4, life: 12, color: 0xffb060, flash: 12 },
    hit: { core: { size: 4, life: 3 }, bloom: { size: 9, life: 7, color: 0xff8a2a }, spray: { count: 3, speed: 6, cone: 35, life: 9 }, light: { radius: 40, power: 0.5 } },
  },
  // The marksman SMG: thin white-yellow needles in a tight line, crisp puncture flashes
  autocannon_stinger: {
    tracerTicks: 1.7, coreWidth: 1.1, glowWidth: 3.5, coreColor: 0xffffff, glowColor: 0xfff0a0, glowAlpha: 0.4, headRadius: 1.8, haloRadius: 6,
    muzzle: { life: 5, size: 12, sparks: 3, color: 0xfff4c0, smoke: 0 },
    impact: { sparks: 2, speed: 4.5, life: 10, color: 0xfff0a0, flash: 15 },
    hit: { core: { size: 6, life: 3 }, bloom: { size: 11, life: 5, color: 0xfff0a0 }, spray: { count: 3, speed: 8, cone: 18, life: 8 }, light: { radius: 35, power: 0.5 } },
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
    impact: { sparks: 5, speed: 6, life: 16, color: CYAN.flash, flash: 30 },
    hit: {
      core: { size: 6, life: 4 }, bloom: { size: 14, life: 9, color: CYAN.glow }, shock: { size: 22, life: 10, width: 1.6, color: CYAN.flash },
      spray: { count: 6, speed: 9, cone: 22, life: 11, color: 0xd8f6ff }, light: { radius: 70, power: 0.8 },
    },
  },
  // The rail shotgun: five short streaks fanning out, a wide cone flash, a crackle ring
  railgun_coilgun: {
    tracerTicks: 0.9, coreWidth: 1.5, glowWidth: 6, coreColor: CYAN.core, glowColor: CYAN.glow, headRadius: 2, haloRadius: 8,
    muzzle: { life: 8, size: 22, sparks: 3, color: CYAN.flash, smoke: 0, tongue: 0.6, girth: 2.4, ring: { color: 0x9fe8ff, size: 0.8 } },
    impact: { sparks: 2, speed: 5, life: 12, color: CYAN.flash, flash: 20 },
    hit: { core: { size: 4, life: 4 }, bloom: { size: 9, life: 8, color: CYAN.glow }, spray: { count: 3, speed: 7, cone: 30, life: 10 }, light: { radius: 50, power: 0.6 } },
  },
  // The capital rail: a thick violet-white line that lingers, a big muzzle blast (a shock ring at each hull it passes is DamageFx's)
  railgun_spear: {
    tracerTicks: 3, coreWidth: 5, glowWidth: 17, coreColor: 0xf6f0ff, glowColor: 0xa070ff, glowAlpha: 0.55, ownerTint: 0, headRadius: 5, haloRadius: 18,
    contrail: { color: 0xb89cff, size: 6, life: 60 },
    muzzle: { life: 13, size: 40, sparks: 10, color: 0xd8c4ff, smoke: 4, tongue: 2.2, girth: 1.4, ring: { color: 0xc4a8ff, size: 1.3 } },
    impact: { sparks: 8, speed: 6, life: 20, color: 0xd8c4ff, flash: 40, ring: 0x9a70ff },
    hit: {
      core: { size: 12, life: 6 }, bloom: { size: 34, life: 16, color: 0x9a70ff },
      shock: { size: 66, life: 20, width: 3.6, color: 0xc4a8ff, count: 1, gap: 4 },
      spray: { count: 16, speed: 11, cone: 24, life: 16, color: 0xe0d4ff },
      embers: { count: 6, speed: 2.2, life: 55, hot: 0xf0e8ff, cool: 0x3a1a7a },
      scorch: { size: 8, life: 80, color: 0xa070ff },
      shake: { strength: 2, radius: 700 }, light: { radius: 170, power: 1.1 },
    },
  },
  // The semi-automatic rifle: short sharp cyan tracers, a crisp snap (the six rail lights are gunAnim's)
  railgun_rail_driver: {
    tracerTicks: 0.9, coreWidth: 1.7, glowWidth: 6, coreColor: CYAN.core, glowColor: CYAN.glow, headRadius: 2.4, haloRadius: 9,
    muzzle: { life: 5, size: 18, sparks: 5, color: CYAN.flash, smoke: 0, tongue: 0.9, girth: 0.9 },
    impact: { sparks: 5, speed: 5, life: 12, color: CYAN.flash, flash: 22 },
    hit: {
      core: { size: 8, life: 4 }, bloom: { size: 20, life: 10, color: CYAN.glow }, shock: { size: 34, life: 12, width: 2, color: CYAN.flash },
      spray: { count: 9, speed: 10, cone: 20, life: 12, color: 0xd8f6ff },
      embers: { count: 3, speed: 1.8, life: 40, hot: 0xe0fbff, cool: 0x10406a },
      scorch: { size: 5, life: 50, color: CYAN.glow }, light: { radius: 100, power: 0.9 },
    },
  },
  // The Slurry Cannon (mid): the plain amber shell, landing hot and sticky (embers that cling and cool)
  cannon_slurry: {
    impact: { sparks: 4, speed: 3.6, life: 18, color: 0xffc070, flash: 20 },
    hit: {
      core: { size: 5.5, life: 5 }, bloom: { size: 14, life: 12, color: 0xffa040 }, shock: { size: 20, life: 13, width: 1.6, color: 0xffc070 },
      spray: { count: 6, speed: 6, cone: 40, life: 13 }, embers: { count: 4, speed: 1.6, life: 50, hot: 0xffd080, cool: 0x7a3010 },
      scorch: { size: 4.5, life: 50, color: 0xff9a30 }, light: { radius: 60, power: 0.8 },
    },
  },
} satisfies Record<string, Partial<WeaponStyle>>;
