/**
 * The six legendaries' looks (rework-2026-11 section 4): a model style for each shot, a beam look for Frostbite.
 * weaponStyles.ts folds them into MODEL_STYLES and BEAM_LOOKS.
 */

import type { WeaponStyle, BeamLook } from './weaponStyles';

export const LEGENDARY_STYLES: Record<string, Partial<WeaponStyle>> = {
  // Rustjaw's Hive: amber bee seekers, weaving a little off their line, a short glowing wake
  legendary_hive: {
    coreColor: 0xfff0c0, glowColor: 0xffb42a, wobble: { amp: 3.2, period: 15 }, contrail: { color: 0xffc04a, size: 2.6, life: 14 },
    impact: { sparks: 10, speed: 3.2, life: 16, color: 0xffb040, flash: 20 },
  },
  // Cinder Bloom: an ember-dripping slug, a hot wake behind it; it lands in a spray of cinders
  legendary_cinder_bloom: {
    contrail: { color: 0xff7a1a, size: 4.6, life: 34 },
    impact: { sparks: 26, speed: 3.2, life: 30, color: 0xff6a1a, flash: 30 },
  },
  // Prism Splitter: a faceted white crystal in a magenta halo, a ring swelling off it; its impact sparks span the rainbow
  legendary_prism: {
    coreColor: 0xffffff, glowColor: 0xe879f9, ringPulse: { color: 0xf0abfc, size: 20, period: 36 }, shardHue: 360,
    impact: { sparks: 22, speed: 5, life: 18, color: 0x67e8f9, flash: 26 },
  },
  // Phase Cannon: a shimmering violet slug with three flickering ghosts behind it, and a ripple round it
  legendary_phase: {
    afterimages: 3, ringPulse: { color: 0xc4b5fd, size: 22, period: 30 },
  },
  // Singularity: a black core with a violet lens ring (the pull ring and inward stream are the kind's)
  legendary_singularity: {
    ringPulse: { color: 0xd8b4fe, size: 30, period: 54 }, lightning: { color: 0xc084fc, forks: 2, length: 9 },
  },
};

export const LEGENDARY_BEAMS: Record<string, BeamLook> = {
  // Frostbite: a pale-ice beam with frost motes drifting off it; a lit hull gets frost crystals (MiningBeamFx)
  legendary_frostbite: { outer: 0x7dd3fc, mid: 0xcdeeff, core: 0xffffff, frost: 1 },
};
