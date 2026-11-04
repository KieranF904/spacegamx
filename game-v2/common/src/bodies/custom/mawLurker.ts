/**
 * Maw Lurker (Maw Spawn): it hangs far off, its eye draws a thin gold line on you, then its rail fires one slug. AIM
 * (arg: the line, q13): it brakes and holds the line until the slug is away. No eye: it comes in closer to make up for
 * its wandering aim; no rail: it closes to ram with its seed; no tail: it can't hold its range and drifts in. A root
 * gone: it turns slowly towards that side.
 */
import { angleOf, groupBit, hold, lame, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const EYE = groupBit('maw_lurker', 'eye'), RAIL = groupBit('maw_lurker', 'rail'), ROOT_L = groupBit('maw_lurker', 'root_l'), ROOT_R = groupBit('maw_lurker', 'root_r'), TAIL = groupBit('maw_lurker', 'tail');
/** The line shows this long before the slug */
export const LURKER_WARN = 66;

export const MAW_LURKER: CustomDesign = {
  id: 'maw_lurker',
  moves: [{ name: 'aim', ticks: LURKER_WARN + 6 }],
  ranges(c, range, reach) {
    if (lost(c, RAIL)) return [0, reach];
    let r = range;
    if (lost(c, EYE)) r = Math.round(r * 0.6);
    if (lost(c, TAIL)) r = Math.round(r * 0.5);
    return [r, reach];
  },
  fly(c, f) {
    if (c.move === 0) { hold(c, f); f.face = angleOf(c.arg); }
    if (lost(c, ROOT_L)) lame(c, f, -1);
    if (lost(c, ROOT_R)) lame(c, f, 1);
  },
};
