/**
 * Rivet Sower (Scrapborn): it gets ahead of you, then sows a line of mines across the way you're flying and turns
 * away. LAY (arg: the line's heading, q13): first it goes for a point ahead of you (along your heading, or across the
 * line when you're still), then runs along the line while its drum drops mines (the server's: mobs, one LAUNCH of their
 * ids). No sensors: it holds where it is and drops them round itself. No drive: it drifts.
 */
import { dcos, dhypot, dsin } from '../../math/detTrig.js';
import { angleOf, drift, goTo, groupBit, hold, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const SENSORS = groupBit('rivet_sower', 'sensors'), DRIVE = groupBit('rivet_sower', 'drive');
/** Ticks getting ahead, then sowing; how far ahead of you it lays */
export const SOWER_AHEAD = 90, SOWER_SOW = 60, SOWER_LEAD = 900;

export const RIVET_SOWER: CustomDesign = {
  id: 'rivet_sower',
  moves: [{ name: 'lay', ticks: SOWER_AHEAD + SOWER_SOW }],
  fly(c, f) {
    if (c.move === 0) {
      if (lost(c, SENSORS)) hold(c, f);
      else if (c.k < SOWER_AHEAD) {
        const v = dhypot(c.tgt.vx, c.tgt.vy), line = angleOf(c.arg);
        const ux = v > 1 ? c.tgt.vx / v : -dsin(line), uy = v > 1 ? c.tgt.vy / v : dcos(line);
        goTo(c, f, c.tgt.x + ux * SOWER_LEAD, c.tgt.y + uy * SOWER_LEAD, 1600);
      } else {
        const a = angleOf(c.arg);
        f.mx = dcos(a); f.my = dsin(a); f.face = a; f.boost = false;
      }
    }
    if (lost(c, DRIVE)) drift(f);
  },
};
