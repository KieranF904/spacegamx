/**
 * Slag Ray (the Pyreclast's cavern): it sweeps past in long arcs, spitting a cone of embers ahead and leaving a burning
 * slag wake behind (the server's: shells and pools). PASS (arg: which way round, 0 or 1): an arc round you at its
 * range, boosting, its nose along the arc. A wing gone: it rolls towards that side, its arcs tightening.
 */
import { datan2, dhypot } from '../../math/detTrig.js';
import { groupBit, lame, lost } from './flight.js';
import { CO } from './order.js';
import type { CustomDesign } from './types.js';

const WING_L = groupBit('slag_ray', 'wing_l'), WING_R = groupBit('slag_ray', 'wing_r');
export const RAY_PASS = 150;

export const SLAG_RAY: CustomDesign = {
  id: 'slag_ray',
  moves: [{ name: 'pass', ticks: RAY_PASS }],
  fly(c, f) {
    if (c.move === 0) {
      const dx = c.me.x - c.tgt.x, dy = c.me.y - c.tgt.y, d = dhypot(dx, dy) || 1, s = c.arg ? 1 : -1;
      // Round you (along the tangent), drawn in or out towards its range
      const want = c.w[CO.RANGE] || 700, pull = (want - d) / Math.max(200, want);
      const tx = (-dy / d) * s + (dx / d) * pull, ty = (dx / d) * s + (dy / d) * pull, tl = dhypot(tx, ty) || 1;
      f.mx = tx / tl; f.my = ty / tl; f.boost = true; f.face = datan2(ty, tx);
    }
    if (lost(c, WING_L)) lame(c, f, -1);
    if (lost(c, WING_R)) lame(c, f, 1);
  },
};
