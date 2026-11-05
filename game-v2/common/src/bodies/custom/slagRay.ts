/**
 * Slag Ray (the Pyreclast's cavern): it sweeps past in long arcs, spitting a cone of embers ahead and leaving a burning
 * slag wake behind (the server's: shells and pools). PASS (arg: which side it passes you on, 0 or 1), one attack run
 * and its turn away:
 *
 *   run   (RAY_RUN ticks) in at you, aimed to pass just off your side, its nose on where its embers would meet you: it
 *         spits them only while its nose is on that (the server's); once you're behind it, it carries on along its way
 *   arc   (the rest) round you at its range, boosting, its nose along the arc, to come in again: nothing spat
 *
 * A wing gone: it rolls towards that side, its arcs tightening and its aim lagging that way.
 */
import { datan2, dhypot } from '../../math/detTrig.js';
import { groupBit, lame, leadFrom, lost } from './flight.js';
import { CO } from './order.js';
import type { CustomDesign } from './types.js';

const WING_L = groupBit('slag_ray', 'wing_l'), WING_R = groupBit('slag_ray', 'wing_r');
export const RAY_PASS = 150;
/** Its run's ticks (then the arc away); how far off your side it aims to pass; its embers' speed (a cannon shell) */
export const RAY_RUN = 80, RAY_OFFSET = 260, RAY_EMBER_SPEED = 48;
/** Closer than this on its run, it's passing you: on along its way */
const RAY_PAST = 340;

export const SLAG_RAY: CustomDesign = {
  id: 'slag_ray',
  moves: [{ name: 'pass', ticks: RAY_PASS }],
  fly(c, f) {
    if (c.move === 0) {
      const dx = c.tgt.x - c.me.x, dy = c.tgt.y - c.me.y, d = dhypot(dx, dy) || 1, s = c.arg ? 1 : -1;
      const v = dhypot(c.me.vx, c.me.vy);
      if (c.k < RAY_RUN) {
        // (Still ahead of it, by the way it's going: it runs in; past, it follows through)
        if (d > RAY_PAST && (v < 2 || dx * c.me.vx + dy * c.me.vy > 0)) {
          const ux = dx / d, uy = dy / d, px = c.tgt.x - uy * s * RAY_OFFSET - c.me.x, py = c.tgt.y + ux * s * RAY_OFFSET - c.me.y, p = dhypot(px, py) || 1;
          f.mx = px / p; f.my = py / p; f.boost = d > 900;
          f.face = leadFrom(c.me.x, c.me.y, c.tgt, RAY_EMBER_SPEED);
        } else if (v > 0.5) {
          f.mx = c.me.vx / v; f.my = c.me.vy / v; f.boost = true; f.face = datan2(c.me.vy, c.me.vx);
        }
      } else {
        // Round you (along the tangent), drawn in or out towards its range
        const ox = -dx, oy = -dy;
        const want = c.w[CO.RANGE] || 700, pull = (want - d) / Math.max(200, want);
        const tx = (-oy / d) * s + (ox / d) * pull, ty = (ox / d) * s + (oy / d) * pull, tl = dhypot(tx, ty) || 1;
        f.mx = tx / tl; f.my = ty / tl; f.boost = true; f.face = datan2(ty, tx);
      }
    }
    if (lost(c, WING_L)) lame(c, f, -1);
    if (lost(c, WING_R)) lame(c, f, 1);
  },
};
