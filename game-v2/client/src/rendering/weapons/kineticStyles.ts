/**
 * Looks of the kinetic weapons by model id (cannons, autocannons, flak, railguns): rework-2026-11 section 4.
 *
 * Impacts (`hit`, weaponStyles ImpactLayers) lead with the rebound: their kinds (cannon, autocannon, railgun) throw a
 * hit off the struck surface as a ricochet (hitThrow 'reflect'), and what reads is what goes that way: a bright streak
 * along the rebound line (`flare`), a dense spray in a cone round it, the loose sparks kept to it (`scatter`), and on the
 * rails and heavier slugs a streak or two of the shell itself (`ricochet`). The centred part is small and brief (a
 * pinpoint core, a little glow, no shock ring). Size and length follow the damage a shot does and the gun's tier
 * (scripts/balance/impact-audit.ts prints them side by side): the light guns (Pip, Rattler, Stinger, Chainsaw, Coilgun,
 * Twinlink) a crisp flick of a fifth to a quarter of a second, so a ship with eight of them is not noise; the Needle
 * about half a second with a few chips; the big single slugs (Hammer, Slurry Cannon, Rail Driver) and the heavies
 * (Spear, Longbarrel, Bastion) an explosion at the surface: a fireball thrown out off the hull (`fireball`) and glowing
 * fragments that slow, cool and trail smoke for one to two seconds (`debris`), embers, a glow left on the hull, the
 * heaviest a light shake.
 */

import type { WeaponStyle } from './weaponStyles';
import { CANISTER_SHELL } from './shellBodies';

// ---- Kinetic models (rework-2026-11 section 4): amber and yellow for shells and streams, cyan for rails ----
const CYAN = { core: 0xeafcff, glow: 0x4fd0ff, flash: 0xaee8ff };

export const KINETIC_MODEL_STYLES = {
  // The reference gun: a short amber-white tracer, a small flash, a puff of sparks
  cannon_pip: {
    muzzle: { life: 6, size: 15, sparks: 5, color: 0xffd28a, smoke: 2 },
    impact: { sparks: 3, speed: 3.6, life: 14, color: 0xffc070, flash: 14 },
    hit: { core: { size: 3, life: 2 }, bloom: { size: 6, life: 5, color: 0xffb04a }, spray: { count: 7, speed: 7.5, cone: 26, life: 12, color: 0xffd9a0 }, flare: { size: 22, width: 1.8, life: 8 }, scatter: 30, light: { radius: 35, power: 0.5 } },
  },
  // One slow armour-piercing slug: fat, dull orange, a short heavy tracer; a grey thump at the muzzle, a dust ring where it lands
  cannon_hammer: {
    tracerTicks: 1.5, coreWidth: 4, glowWidth: 12, coreColor: 0xffd9a0, glowColor: 0xd9682a, glowAlpha: 0.42, headRadius: 4.5, haloRadius: 13,
    muzzle: { life: 10, size: 24, sparks: 5, color: 0xd98a4a, smoke: 8, tongue: 0.8, girth: 1.5, ring: { color: 0xa39a90, size: 0.9 } },
    impact: { sparks: 5, speed: 2.2, life: 26, color: 0xd98a4a, flash: 28, ring: 0xa0663a },
    hit: {
      core: { size: 4, life: 3 }, bloom: { size: 8, life: 7, color: 0xe0782a },
      fireball: { size: 11, life: 20, count: 2, color: 0xffa050, cool: 0x5a2010 },
      spray: { count: 13, speed: 8, cone: 30, life: 18, color: 0xffc08a, width: 2.1 }, ricochet: { count: 2, speed: 9, cone: 10, life: 15 },
      flare: { size: 44, width: 3.6, life: 12 }, scatter: 30,
      embers: { count: 4, speed: 3.5, life: 29, hot: 0xffc070, cool: 0x6a2a10 },
      debris: { count: 5, speed: 11, size: 2.4, life: 31, hot: 0xffc070, cool: 0x4a2010, trail: 0xff8a3a, cone: 45, drag: 0.92 },
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
      core: { size: 3, life: 3 }, bloom: { size: 6, life: 6, color: 0xffb04a }, spray: { count: 8, speed: 7.5, cone: 24, life: 13, color: 0xffd9a0 },
      flare: { size: 28, width: 2.2, life: 9 }, scatter: 28,
      embers: { count: 1, speed: 3, life: 13, hot: 0xffd080, cool: 0x6a2a10 }, light: { radius: 45, power: 0.6 },
    },
  },
  // The sniper: one long thin white-gold streak with a contrail down the whole path, a muzzle shock ring, a narrow spark jet (the sight line is ChargeFx's)
  cannon_longbarrel: {
    tracerTicks: 10, coreWidth: 1.7, glowWidth: 5.5, coreColor: 0xfffbe8, glowColor: 0xffd070, glowAlpha: 0.5, headRadius: 3, haloRadius: 9,
    muzzle: { life: 11, size: 30, sparks: 8, color: 0xffe9b0, smoke: 3, tongue: 3.5, girth: 0.55, ring: { color: 0xffe6a0, size: 1.1 } },
    contrail: { color: 0xffe6a0, size: 3, life: 48 },
    impact: { sparks: 6, speed: 7, life: 14, color: 0xffe6a0, flash: 26, ring: 0xffd070 },
    // A sniper's hit: a hard white pinpoint, a long gold streak along the rebound, a narrow jet of sparks glancing off
    hit: {
      core: { size: 5, life: 3 }, bloom: { size: 10, life: 8, color: 0xffd070 },
      fireball: { size: 20, life: 28, count: 3, color: 0xffd080, cool: 0x6a2808 },
      spray: { count: 22, speed: 15, cone: 12, life: 20, color: 0xffe6a0, width: 2 }, ricochet: { count: 3, speed: 16, cone: 5, life: 15 },
      flare: { size: 100, width: 3.4, life: 15 }, scatter: 18,
      embers: { count: 8, speed: 4.5, life: 51, hot: 0xfff0c0, cool: 0x8a5010 },
      debris: { count: 10, speed: 17.5, size: 2.8, life: 58, hot: 0xfff0c0, cool: 0x4a2a10, trail: 0xffc050, cone: 32, drag: 0.92 },
      scorch: { size: 7, life: 100, color: 0xffc050 }, light: { radius: 120, power: 1 },
    },
  },
  // The ship-killer: a red-hot ball round a dark core with a heat haze pulsing off it, a smoke ring and heavy kick at the
  // muzzle. It lands as the heaviest hit in the game: a fan of three thick streaks and a dense spray glancing off the hull,
  // the slug's own streaks, embers cooling to dull red, a glow on the hull where it struck, a light shake
  cannon_bastion: {
    tracerTicks: 1.1, coreWidth: 9, glowWidth: 19, coreColor: 0x2a1008, glowColor: 0xff4a1a, glowAlpha: 0.6, ownerTint: 0, headRadius: 0, haloRadius: 17,
    ringPulse: { color: 0xff9a5a, size: 20, period: 22 },
    muzzle: { life: 13, size: 20, sparks: 8, color: 0xff8a50, smoke: 10, tongue: 1.2, girth: 1.35, ring: { color: 0x9a8e84, size: 1.3 } },
    impact: { sparks: 6, speed: 4.2, life: 26, color: 0xffa060, flash: 44, ring: 0xff5a2a },
    hit: {
      core: { size: 6, life: 4 }, bloom: { size: 14, life: 9, color: 0xff6a2a },
      fireball: { size: 22, life: 32, count: 4, color: 0xffa040, cool: 0x4a1006 },
      spray: { count: 24, speed: 13, cone: 30, life: 24, color: 0xffc890, width: 2.4 }, ricochet: { count: 3, speed: 11, cone: 10, life: 20 },
      flare: { size: 76, width: 4.5, life: 16, count: 3, fan: 24 }, scatter: 30,
      embers: { count: 12, speed: 6, life: 54, hot: 0xffd27a, cool: 0x8a1e08 },
      debris: { count: 12, speed: 14, size: 3.4, life: 61, hot: 0xffc070, cool: 0x3a1408, trail: 0xff7a2a, cone: 50, drag: 0.92 },
      scorch: { size: 9, life: 110, color: 0xff5a1a },
      shake: { strength: 3, radius: 900 }, light: { radius: 120, power: 1 },
    },
    smokeCloud: { color: 0x4a3a30, size: 6, life: 50 },
  },
  // The steady hose: short yellow tracers, every fourth one bright
  autocannon_rattler: {
    coreColor: 0xfff1a0, glowColor: 0xffc830, accent: { every: 4, dim: 0.4 },
    muzzle: { life: 5, size: 11, sparks: 2, color: 0xffe08a, smoke: 1 },
    impact: { sparks: 2, speed: 3.4, life: 12, color: 0xffd060, flash: 12 },
    hit: { core: { size: 3, life: 2 }, bloom: { size: 6, life: 4, color: 0xffc830 }, spray: { count: 5, speed: 7, cone: 26, life: 10, color: 0xfff1a0 }, flare: { size: 16, width: 1.6, life: 6 }, scatter: 30, light: { radius: 30, power: 0.4 } },
  },
  // The minigun: tracers run orange to white-hot as it spins up, brass sprays thicker the longer it holds
  autocannon_chainsaw: {
    heat: { cold: 0xff8a2a, hot: 0xffffff }, casings: 2, coreColor: 0xffd9a0, glowColor: 0xff8a2a, tracerTicks: 1.0,
    muzzle: { life: 5, size: 13, sparks: 3, color: 0xffb04a, smoke: 1, tongue: 1.3 },
    impact: { sparks: 2, speed: 3.4, life: 12, color: 0xffb060, flash: 12 },
    hit: { core: { size: 2.5, life: 2 }, bloom: { size: 5, life: 5, color: 0xff8a2a }, spray: { count: 6, speed: 7.5, cone: 24, life: 11, color: 0xffd9a0 }, flare: { size: 22, width: 1.8, life: 7 }, scatter: 28, light: { radius: 35, power: 0.45 } },
  },
  // The marksman SMG: thin white-yellow needles in a tight line, crisp puncture flashes
  autocannon_stinger: {
    tracerTicks: 1.7, coreWidth: 1.1, glowWidth: 3.5, coreColor: 0xffffff, glowColor: 0xfff0a0, glowAlpha: 0.4, headRadius: 1.8, haloRadius: 6,
    muzzle: { life: 5, size: 12, sparks: 3, color: 0xfff4c0, smoke: 0 },
    impact: { sparks: 2, speed: 4.5, life: 10, color: 0xfff0a0, flash: 15 },
    hit: { core: { size: 3, life: 2 }, bloom: { size: 6, life: 4, color: 0xfff0a0 }, spray: { count: 6, speed: 10, cone: 14, life: 10, color: 0xffffff }, flare: { size: 26, width: 1.4, life: 7 }, scatter: 18, light: { radius: 30, power: 0.45 } },
  },
  // The sky-filler: a banded orange canister blinking its fuse (the airburst, with its lingering cloud, is DamageFx's flak branch)
  flak_burst: {
    shell: { ...CANISTER_SHELL, body: 0x7a4a2a, cap: 0x4a2a16, band: 0xd0662a, lamp: 0xff8a3c, timer: 0xffd0a0 },
    coreColor: 0xffe0b0, glowColor: 0xff8a3c, haloRadius: 10, blink: 7, aimTick: true, muzzle: { life: 6, size: 18, sparks: 4, color: 0xffb070, smoke: 3 },
  },
  // The wall you place: a brown-gold shell blinking like a timer
  flak_cloudmaker: {
    shell: { ...CANISTER_SHELL, body: 0x6a5a3a, cap: 0x44381f, band: 0xb8802c, lamp: 0xe0a040, timer: 0xf0d090 },
    coreColor: 0xf0d090, glowColor: 0xb8802c, glowAlpha: 0.42, haloRadius: 12, blink: 9, aimTick: true,
    muzzle: { life: 7, size: 20, sparks: 4, color: 0xd9a050, smoke: 5 },
  },
  // The cheap rail: today's long thin streak in cyan, an ionised contrail, three coil rings at the muzzle
  railgun_needle: {
    coreColor: CYAN.core, glowColor: CYAN.glow, contrail: { color: 0x8fe4ff, size: 2.6, life: 24 },
    muzzle: { life: 10, size: 28, sparks: 8, color: CYAN.flash, smoke: 2, ring: { color: 0x7fdcff, count: 3, size: 0.7 } },
    impact: { sparks: 5, speed: 6, life: 16, color: CYAN.flash, flash: 30 },
    hit: {
      core: { size: 3.5, life: 3 }, bloom: { size: 8, life: 7, color: CYAN.glow },
      spray: { count: 12, speed: 11, cone: 16, life: 16, color: 0xd8f6ff }, ricochet: { count: 2, speed: 13, cone: 6, life: 12 },
      flare: { size: 50, width: 2.4, life: 11 }, scatter: 22,
      embers: { count: 3, speed: 4, life: 19, hot: 0xe8fbff, cool: 0x12406a },
      debris: { count: 2, speed: 10, size: 1.8, life: 15, hot: 0xe8fbff, cool: 0x2a4a6a, trail: 0x8fdcff, cone: 40, drag: 0.92 }, light: { radius: 60, power: 0.7 },
    },
  },
  // The rail shotgun: five short streaks fanning out, a wide cone flash, a crackle ring
  railgun_coilgun: {
    tracerTicks: 0.9, coreWidth: 1.5, glowWidth: 6, coreColor: CYAN.core, glowColor: CYAN.glow, headRadius: 2, haloRadius: 8,
    muzzle: { life: 8, size: 22, sparks: 3, color: CYAN.flash, smoke: 0, tongue: 0.6, girth: 2.4, ring: { color: 0x9fe8ff, size: 0.8 } },
    impact: { sparks: 2, speed: 5, life: 12, color: CYAN.flash, flash: 20 },
    hit: { core: { size: 2.5, life: 3 }, bloom: { size: 6, life: 5, color: CYAN.glow }, spray: { count: 6, speed: 8.5, cone: 22, life: 12, color: 0xd8f6ff }, flare: { size: 26, width: 2, life: 8 }, scatter: 26, light: { radius: 45, power: 0.55 } },
  },
  // The capital rail: a thick violet-white line that lingers, a big muzzle blast (a shock ring at each hull it passes is DamageFx's)
  railgun_spear: {
    tracerTicks: 3, coreWidth: 5, glowWidth: 17, coreColor: 0xf6f0ff, glowColor: 0xa070ff, glowAlpha: 0.55, ownerTint: 0, headRadius: 5, haloRadius: 18,
    contrail: { color: 0xb89cff, size: 6, life: 60 },
    muzzle: { life: 13, size: 40, sparks: 10, color: 0xd8c4ff, smoke: 4, tongue: 2.2, girth: 1.4, ring: { color: 0xc4a8ff, size: 1.3 } },
    impact: { sparks: 8, speed: 6, life: 20, color: 0xd8c4ff, flash: 40, ring: 0x9a70ff },
    hit: {
      core: { size: 6, life: 4 }, bloom: { size: 14, life: 9, color: 0x9a70ff },
      fireball: { size: 20, life: 26, count: 3, color: 0xd0b8ff, cool: 0x2a1060 },
      spray: { count: 22, speed: 14, cone: 18, life: 22, color: 0xe0d4ff, width: 2.2 }, ricochet: { count: 4, speed: 15, cone: 7, life: 16 },
      flare: { size: 90, width: 5, life: 15, count: 2, fan: 10 }, scatter: 22,
      embers: { count: 8, speed: 4.5, life: 48, hot: 0xf0e8ff, cool: 0x3a1a7a },
      debris: { count: 9, speed: 16, size: 2.8, life: 53, hot: 0xf0e8ff, cool: 0x2a1450, trail: 0xa070ff, cone: 40, drag: 0.92 },
      scorch: { size: 8, life: 90, color: 0xa070ff },
      shake: { strength: 2, radius: 700 }, light: { radius: 140, power: 1 },
    },
  },
  // The semi-automatic rifle: short sharp cyan tracers, a crisp snap (the six rail lights are gunAnim's)
  railgun_rail_driver: {
    tracerTicks: 0.9, coreWidth: 1.7, glowWidth: 6, coreColor: CYAN.core, glowColor: CYAN.glow, headRadius: 2.4, haloRadius: 9,
    muzzle: { life: 5, size: 18, sparks: 5, color: CYAN.flash, smoke: 0, tongue: 0.9, girth: 0.9 },
    impact: { sparks: 5, speed: 5, life: 12, color: CYAN.flash, flash: 22 },
    hit: {
      core: { size: 4.5, life: 3 }, bloom: { size: 10, life: 7, color: CYAN.glow },
      fireball: { size: 12, life: 18, count: 2, color: 0xbfeaff, cool: 0x10305a },
      spray: { count: 16, speed: 12, cone: 16, life: 18, color: 0xd8f6ff, width: 2 }, ricochet: { count: 3, speed: 14, cone: 7, life: 14 },
      flare: { size: 66, width: 3.2, life: 13 }, scatter: 22,
      embers: { count: 4, speed: 3.5, life: 33, hot: 0xe0fbff, cool: 0x10406a },
      debris: { count: 6, speed: 15, size: 2.2, life: 36, hot: 0xe8fbff, cool: 0x1a3a5a, trail: 0x6ad0ff, cone: 35, drag: 0.92 },
      scorch: { size: 5, life: 60, color: CYAN.glow }, light: { radius: 90, power: 0.9 },
    },
  },
  // The Slurry Cannon (mid): the plain amber shell, landing hot and sticky (embers that cling and cool)
  cannon_slurry: {
    impact: { sparks: 4, speed: 3.6, life: 18, color: 0xffc070, flash: 20 },
    hit: {
      core: { size: 3.5, life: 3 }, bloom: { size: 8, life: 7, color: 0xffa040 },
      fireball: { size: 12, life: 22, count: 2, color: 0xffb050, cool: 0x5a2410 },
      spray: { count: 12, speed: 7.5, cone: 32, life: 17, color: 0xffd090 }, flare: { size: 40, width: 3, life: 11 }, scatter: 32,
      embers: { count: 6, speed: 3, life: 36, hot: 0xffd080, cool: 0x7a3010 },
      debris: { count: 6, speed: 10, size: 2.4, life: 35, hot: 0xffd080, cool: 0x5a2a10, trail: 0xffa040, cone: 50, drag: 0.92 },
      scorch: { size: 5, life: 60, color: 0xff9a30 }, light: { radius: 70, power: 0.8 },
    },
  },
} satisfies Record<string, Partial<WeaponStyle>>;
