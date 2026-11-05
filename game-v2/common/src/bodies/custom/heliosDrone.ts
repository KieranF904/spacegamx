/**
 * Helios Drone (Sol): a maintenance drone strayed from the Array, a starter's first kill. It drifts on its round; riled,
 * it keeps off you at its range (factions.json custom), matching your way, and plinks at you with sparks from its torch
 * (the server's gun, only with its torch on you). Slow (its blueprint's drive: about half a starter's cruise), gentle in
 * its turns, never boosting, never ramming. TORCH: if you come within its reach it welds you there (the burn is the
 * server's), holding where it is. No drive: it drifts.
 */
import { dhypot } from '../../math/detTrig.js';
import { drift, faceTarget, groupBit, keepAt, lost, turnAtMost } from './flight.js';
import { CO } from './order.js';
import type { CustomDesign } from './types.js';

const DRIVE = groupBit('helios_drone', 'drive');
export const TORCH_TICKS = 90;
/** The most it turns its nose a tick (radians): about three times as long to come round as a starter */
export const DRONE_TURN = 0.035;
/** How fast it closes on its station off you (world units a tick, on top of your own speed) */
const DRONE_CLOSE = 5;

export const HELIOS_DRONE: CustomDesign = {
  id: 'helios_drone',
  moves: [{ name: 'torch', ticks: TORCH_TICKS }],
  fly(c, f) {
    // (its own side of you: where it is now; its range, or nearer if you came in on it, but no nearer than it is)
    const dx = c.me.x - c.tgt.x, dy = c.me.y - c.tgt.y, d = dhypot(dx, dy) || 1;
    const stand = c.move === 0 ? Math.min(d, c.w[CO.RANGE] || 900) : c.w[CO.RANGE] || 900;
    keepAt(c, f, c.tgt.x + (dx / d) * stand, c.tgt.y + (dy / d) * stand, c.tgt.vx, c.tgt.vy, 0.03, DRONE_CLOSE);
    faceTarget(c, f);
    turnAtMost(c, f, DRONE_TURN);
    if (lost(c, DRIVE)) drift(f);
  },
};
