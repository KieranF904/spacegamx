/**
 * Scrap Darter (Scrapborn, the Scrap Mother's Nest Rock): a fast flanker. DART (arg: which side, 0 its target's left,
 * 1 its right): it goes for a point off its target's flank (beside the way it faces), holds there facing it while it
 * draws a line and rakes a short burst down it (the server's), then peels away out past that side. No gun: it rams (its
 * range drops to nothing). A fin lost: it turns slowly towards that side and overshoots. No pod: it crawls. No drive: it
 * drifts.
 */
import { dcos, dsin } from '../../math/detTrig.js';
import { drift, faceTarget, goTo, groupBit, hold, lame, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const GUN = groupBit('scrap_darter', 'gun'), FIN_L = groupBit('scrap_darter', 'fin_l'), FIN_R = groupBit('scrap_darter', 'fin_r');
const POD = groupBit('scrap_darter', 'pod'), DRIVE = groupBit('scrap_darter', 'drive');
/** Ticks getting onto the flank, drawing the line, raking it, peeling off; how far off the flank it comes in */
export const DART_IN = 75, DART_WARN = 30, DART_FIRE = 12, DART_OUT = 55, DART_FLANK = 750;
/** Without its fuel pod it makes this much of its thrust */
export const DART_CRAWL = 0.3;

export const SCRAP_DARTER: CustomDesign = {
  id: 'scrap_darter',
  moves: [{ name: 'dart', ticks: DART_IN + DART_WARN + DART_FIRE + DART_OUT }],
  ranges: (c, range, reach) => (lost(c, GUN) ? [0, reach] : [range, reach]),
  fly(c, f) {
    if (c.move === 0 && !lost(c, GUN)) {
      // (its target's flank: beside the way it faces, on the side the move drew)
      const side = c.arg & 1 ? 1 : -1, nx = -dsin(c.tgt.angle) * side, ny = dcos(c.tgt.angle) * side;
      if (c.k < DART_IN) goTo(c, f, c.tgt.x + nx * DART_FLANK, c.tgt.y + ny * DART_FLANK, 0);
      else if (c.k < DART_IN + DART_WARN + DART_FIRE) { hold(c, f); faceTarget(c, f); }
      else goTo(c, f, c.tgt.x + nx * DART_FLANK * 3, c.tgt.y + ny * DART_FLANK * 3, 0);
    }
    if (lost(c, FIN_L)) lame(c, f, -1);
    if (lost(c, FIN_R)) lame(c, f, 1);
    if (lost(c, POD)) { f.mx *= DART_CRAWL; f.my *= DART_CRAWL; f.boost = false; }
    if (lost(c, DRIVE)) drift(f);
  },
};
