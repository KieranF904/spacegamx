/**
 * The looks of the energy weapons of the visuals-energy-weapons unit (rework 2026-11 section 4): lasers, pulse guns, the
 * Lance, EMP, Arc and the support beams. Merged into BEAM_LOOKS / MODEL_STYLES when this module loads (MiningBeamFx and
 * ShipClient import it), so the style table itself stays free of per-model numbers.
 *
 *   Glint        fixed red pulse           Cutter       thick short orange beam, molten pool that grows with the ramp
 *   Searchlight  thin pale gold, a cone    Lance        violet beam, braided white core, sputters short of power
 *   Strobe       spaced hot-pink bolts     Overpulse    a magenta ribbon with ripple heads
 *   Blackout     blast radius ring in flight           Spark        a jagged bolt     Tesla  flickering lightning
 *   Repair Beam  braided teal strands, '+' motes
 *
 * The three lasers' burns are a liquid splash (ImpactLayers.liquid, rendering/weapons/liquidSplash.ts).
 */

import { BEAM_LOOKS, MODEL_STYLES, DIRECTED_HIT } from '../rendering/weapons/weaponStyles';

Object.assign(BEAM_LOOKS, {
  // (The lasers' burns lead with a liquid splash, the Impact Lab's: the hull they light runs molten, throwing heavy blobs
  // that fall back and stick, and pooling into a film that creeps the way the beam slides and cools to a crust;
  // ImpactLayers.liquid. A few sparks are kept under it.)
  // Always red, whatever the grade: a light splash, quick to cool
  laser_glint: {
    outer: 0xdc2626, mid: 0xff5a5a, core: 0xfff0f0,
    burn: {
      every: 9, color: 0xff8a7a, hit: {
        liquid: {
          blobs: { count: 2, size: 2.2, speed: 3.6, cone: 55, pull: 0.22, life: 40 },
          film: { length: 16, thickness: 3, creep: 0.25, life: 60 }, hot: 0xffb09a, cool: 0x4a0a0a,
        },
        spray: { count: 2, speed: 6, cone: 30, life: 10, color: 0xffc8c0 }, scatter: 30, light: { radius: 45, power: 0.35 },
      },
    },
  },
  laser_cutter: {
    width: 1.9, outer: 0xea580c, mid: 0xff9a3c, core: 0xfff3dc, pool: 0xff6a14,
    // (a heavy burn: thick molten blobs thrown well clear of the pool, long films that crust over slowly, an ember or two)
    burn: {
      every: 7, color: 0xffb060, hit: {
        liquid: {
          blobs: { count: 3, size: 3.4, speed: 5, cone: 60, pull: 0.25, life: 56 },
          film: { length: 30, thickness: 5, creep: 0.32, life: 100 }, hot: 0xffd27a, cool: 0x5a1606,
        },
        spray: { count: 3, speed: 6.5, cone: 34, life: 12, color: 0xffc890, width: 1.6 }, scatter: 34,
        embers: { count: 1, speed: 3, life: 30, hot: 0xffd080, cool: 0x7a2a08 },
        light: { radius: 70, power: 0.5 },
      },
    },
  },
  // A shaft of gold light with dust glittering in it, a lamp's spill at the muzzle and a spot on what it lights: a light splash
  laser_searchlight: {
    width: 0.8, outer: 0xd9a514, mid: 0xfde68a, core: 0xfffbeb, cone: 3.5, coneLen: 260,
    shaft: { color: 0xfde68a, spread: 0.9, dust: 1 },
    burn: {
      every: 12, color: 0xfde68a, hit: {
        liquid: {
          blobs: { count: 1, size: 1.8, speed: 3, cone: 45, pull: 0.2, life: 36 },
          film: { length: 12, thickness: 2.4, creep: 0.18, life: 52 }, hot: 0xfff0b8, cool: 0x5a4210,
        },
        spray: { count: 3, speed: 5.5, cone: 40, life: 11, color: 0xfff4c0 }, scatter: 34,
        light: { radius: 80, power: 0.5 },
      },
    },
  },
  lance_lance: { outer: 0x7c3aed, mid: 0xc084fc, core: 0xffffff, braid: { color: 0xf5e8ff, strands: 3 }, sputter: 1 },
  arc_tesla: {
    width: 0.9, outer: 0x7c3aed, mid: 0xb8a4ff, core: 0xf5f3ff, zap: 9,
    burn: {
      every: 6, color: 0xc8b8ff, hit: {
        spray: { count: 6, speed: 9, cone: 30, life: 14, color: 0xe8e0ff, width: 1.8 }, flare: { size: 28, width: 2.2, life: 8, count: 2, fan: 30 }, scatter: 30,
        embers: { count: 2, speed: 4, life: 29, hot: 0xf0ecff, cool: 0x3a1a7a }, light: { radius: 60, power: 0.5 },
      },
    },
  },
  utility_repair_beam: { braid: { color: 0x99f6e4, strands: 2 } },
});

Object.assign(MODEL_STYLES, {
  pulse_strobe: {
    tracerTicks: 1.5, coreWidth: 2.2, glowWidth: 9, coreColor: 0xffe4f2, glowColor: 0xff2d8a, glowAlpha: 0.62, headRadius: 3,
    impact: { sparks: 8, speed: 3, life: 12, color: 0xff5fb0, flash: 18 },
  },
  // A continuous ribbon of bolts, a ripple ring riding each head
  pulse_overpulse: {
    tracerTicks: 4.6, coreWidth: 2, glowWidth: 8, coreColor: 0xfdf4ff, glowColor: 0xd946ef, glowAlpha: 0.6, headRadius: 3,
    ringPulse: { color: 0xf5d0fe, size: 9, period: 8 },
    impact: { sparks: 8, speed: 3, life: 12, color: 0xe879f9, flash: 18 },
    // (its hit in its own magenta: the kind's is the Strobe's pink)
    hit: DIRECTED_HIT(0xf5c8ff, 1, 30),
  },
  // The orb carries its blast radius the whole way
  emp_blackout: {
    glowColor: 0x2c4fd6, coreColor: 0xbfd4ff, haloRadius: 28, radiusRing: { color: 0x3b6cf0, radius: 320 },
  },
  // A long blue laser bolt with a hot head that leaves the barrel and flies out to its reach (its life, about 3,960 at
  // 36 ticks): a tracer ten ticks long (about 1,100, the longest of any gun's; not its whole life, which pinned it to the
  // barrel), lightning down it, a short fading wake. Its hit splashes straight out of the hull it burns: a bright streak
  // and a spray along the normal
  arc_spark: {
    tracerTicks: 10, coreWidth: 2.2, glowWidth: 12, coreColor: 0xf4fcff, glowColor: 0x5ec4ff, glowAlpha: 0.6, headRadius: 4.2, haloRadius: 16,
    jagged: { color: 0x9ad8ff, amp: 6 }, contrail: { color: 0x7fd0ff, size: 2, life: 8 },
    muzzle: { life: 6, size: 16, sparks: 4, color: 0xa8e0ff, smoke: 0 },
    impact: { sparks: 6, speed: 4.5, life: 14, color: 0x9ad8ff, flash: 22 },
    hit: {
      core: { size: 3.5, life: 3 }, bloom: { size: 8, life: 6, color: 0x6ac8ff },
      spray: { count: 16, speed: 9.5, cone: 24, life: 18, color: 0xd8f2ff, width: 2 },
      flare: { size: 50, width: 3, life: 12, count: 2, fan: 18 }, scatter: 24,
      embers: { count: 4, speed: 3.5, life: 21, hot: 0xe8f8ff, cool: 0x1a4a8a },
      debris: { count: 2, speed: 9, size: 1.8, life: 16, hot: 0xe8f8ff, cool: 0x1a3a6a, trail: 0x6ac8ff, cone: 40, drag: 0.92 }, light: { radius: 70, power: 0.8 },
    },
  },
  // A canister that blinks (its blink quickening needs the shell's end tick, which the client doesn't have)
  utility_demolition_launcher: { blink: 16 },
});
