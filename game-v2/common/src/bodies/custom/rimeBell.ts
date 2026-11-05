/**
 * Rime Bell (Frost Brood): it keeps at mid range; its frill pulses an EMP ring (PULSE: it stills itself while the ring
 * gathers), and its tendrils shed ice splinters at what comes close (the server's guns: no move). Otherwise it flies as
 * the AI does: a drifting animal, its pieces don't steer it.
 */
import { hold } from './flight.js';
import type { CustomDesign } from './types.js';

/** The ring gathers this long, then goes off */
export const BELL_WARN = 48;

export const RIME_BELL: CustomDesign = {
  id: 'rime_bell',
  moves: [{ name: 'pulse', ticks: BELL_WARN + 6 }],
  fly(c, f) {
    if (c.move === 0) hold(c, f);
  },
};
