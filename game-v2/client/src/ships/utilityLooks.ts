/**
 * Beam looks for the utility models of the visuals-parts unit (rework 2026-11 section 5), merged into BEAM_LOOKS when this
 * module loads (PartFx imports it): the Siphon's green motes drawn in to the ship along the gas beam.
 */

import { BEAM_LOOKS } from '../rendering/weapons/weaponStyles';

Object.assign(BEAM_LOOKS, {
  utility_siphon: { width: 0.85, outer: 0x15803d, mid: 0x4ade80, core: 0xdcfce7, motes: 2.5, ramp: 'ring' },
});
