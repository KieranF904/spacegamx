/**
 * Scrap Crawler (Scrapborn): it turns its magnet on you and drags you in, then its claws snap shut just ahead of it.
 * PULL: it braces, facing you, while the magnet draws (the pull is the server's: a cause to that pilot). Both claws
 * gone: it rams instead; no drive: it drifts, only turning.
 */
import { drift, faceTarget, groupBit, hold, lost } from './flight.js';
import type { CustomDesign } from './types.js';

const CLAW_L = groupBit('scrap_crawler', 'claw_l'), CLAW_R = groupBit('scrap_crawler', 'claw_r'), DRIVE = groupBit('scrap_crawler', 'drive');
/** The magnet draws this long; the claws snap this far in */
export const CRAWLER_PULL = 120, CRAWLER_SNAP = 96;

export const SCRAP_CRAWLER: CustomDesign = {
  id: 'scrap_crawler',
  moves: [{ name: 'pull', ticks: CRAWLER_PULL }],
  ranges: (c, range, reach) => (lost(c, CLAW_L) && lost(c, CLAW_R) ? [0, reach] : [range, reach]),
  fly(c, f) {
    if (c.move === 0) { hold(c, f); faceTarget(c, f); }
    if (lost(c, DRIVE)) drift(f);
  },
};
