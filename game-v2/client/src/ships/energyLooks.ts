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
 */

import { BEAM_LOOKS, MODEL_STYLES } from '../rendering/weapons/weaponStyles';

Object.assign(BEAM_LOOKS, {
  // Always red, whatever the grade
  laser_glint: { outer: 0xdc2626, mid: 0xff5a5a, core: 0xfff0f0 },
  laser_cutter: { width: 1.9, outer: 0xea580c, mid: 0xff9a3c, core: 0xfff3dc, pool: 0xff6a14 },
  laser_searchlight: { width: 0.45, outer: 0xb8860b, mid: 0xfde68a, core: 0xfffbeb, cone: 5, coneLen: 1100 },
  lance_lance: { outer: 0x7c3aed, mid: 0xc084fc, core: 0xffffff, braid: { color: 0xf5e8ff, strands: 3 }, sputter: 1 },
  arc_tesla: { width: 0.9, outer: 0x7c3aed, mid: 0xb8a4ff, core: 0xf5f3ff, zap: 9 },
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
  },
  // The orb carries its blast radius the whole way
  emp_blackout: {
    glowColor: 0x2c4fd6, coreColor: 0xbfd4ff, haloRadius: 28, radiusRing: { color: 0x3b6cf0, radius: 320 },
  },
  // A bolt of lightning down its whole (very fast) path
  arc_spark: {
    tracerTicks: 6, coreWidth: 1.2, glowWidth: 8, coreColor: 0xf0fbff, glowColor: 0x8fd0ff, glowAlpha: 0.4, headRadius: 3,
    jagged: { color: 0x9ad8ff, amp: 6 },
  },
  // A canister that blinks (its blink quickening needs the shell's end tick, which the client doesn't have)
  utility_demolition_launcher: { blink: 16 },
});
