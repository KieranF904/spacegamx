/**
 * Hookboat (pirates): it harpoons you from its bow and reels you towards its pack. HARPOON (arg: its aim, q13): it
 * swings its bow onto the line and fires; the reel is a pull on what it struck (the server's: a cause to that pilot).
 * No outrigger: it lists, its turns to port going wide. A drive lost (they're mismatched): it crabs.
 */
import { angleOf, crab, groupBit, lame, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const OUTRIGGER = groupBit('hookboat', 'outrigger'), DRIVE_L = groupBit('hookboat', 'drive_l'), DRIVE_R = groupBit('hookboat', 'drive_r');
/** It swings onto the line this long, then fires */
export const HOOK_WARN = 24;

export const HOOKBOAT: CustomDesign = {
  id: 'hookboat',
  moves: [{ name: 'harpoon', ticks: HOOK_WARN + 12 }],
  fly(c, f) {
    if (c.move === 0) f.face = angleOf(c.arg);
    if (lost(c, OUTRIGGER)) lame(c, f, -1);
    if (lost(c, DRIVE_L)) crab(f, 0.5);
    if (lost(c, DRIVE_R)) crab(f, -0.35);
  },
};
