/**
 * Censer (Cinder Cult): it holds off, draws its lance's line on you and fires down it. LANCE (arg: the line, q13): it
 * brakes and holds the line until the beam is done. No lance: it dives to ram with its blunt nose. A vane gone: it
 * turns slowly towards that side, so its aim lags if you circle the other way. No drive: it only turns.
 */
import { angleOf, drift, groupBit, hold, lame, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const LANCE = groupBit('censer', 'lance'), VANE_L = groupBit('censer', 'vane_l'), VANE_R = groupBit('censer', 'vane_r'), DRIVE = groupBit('censer', 'drive');
/** The line shows this long before the beam, which burns this long */
export const CENSER_WARN = 72, CENSER_BURN = 18;

export const CENSER: CustomDesign = {
  id: 'censer',
  moves: [{ name: 'lance', ticks: CENSER_WARN + CENSER_BURN }],
  ranges: (c, range, reach) => (lost(c, LANCE) ? [0, reach] : [range, reach]),
  fly(c, f) {
    if (c.move === 0) { hold(c, f); f.face = angleOf(c.arg); }
    if (lost(c, VANE_L)) lame(c, f, -1);
    if (lost(c, VANE_R)) lame(c, f, 1);
    if (lost(c, DRIVE)) drift(f);
  },
};
