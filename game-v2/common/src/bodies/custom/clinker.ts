/**
 * Clinker (the Pyreclast's cavern): it settles into a lane and lobs magma over the rock from its chimneys, left then
 * right, with rings where the shells come down (the server's). VOLLEY: it settles, facing you, for the volley. Both
 * chimneys gone: it crawls at you to ram.
 */
import { faceTarget, groupBit, hold, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const CHIMNEY_L = groupBit('clinker', 'chimney_l'), CHIMNEY_R = groupBit('clinker', 'chimney_r');
/** The rings show this long before the shells land; four shells, this many ticks apart */
export const CLINKER_WARN = 60, CLINKER_SHELLS = 4, CLINKER_GAP = 12;

export const CLINKER: CustomDesign = {
  id: 'clinker',
  moves: [{ name: 'volley', ticks: CLINKER_WARN + CLINKER_SHELLS * CLINKER_GAP }],
  ranges: (c, range, reach) => (lost(c, CHIMNEY_L) && lost(c, CHIMNEY_R) ? [0, reach] : [range, reach]),
  fly(c, f) {
    if (c.move === 0) { hold(c, f); faceTarget(c, f); }
  },
};
