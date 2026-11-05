/** A sapper: goes for the nearest turret instead of the bastion (the next nearest when it falls; the bastion when none are left) */

import type { Run, SiegeCtx } from '../types.js';
import { bastionAt, type SiegeRole } from './index.js';
import { dhypot } from '@space-game/common';

/** The nearest turret standing to (x, y), or the bastion */
function nearestTurret(ctx: SiegeCtx, run: Run, x: number, y: number): { eid: number; x: number; y: number } {
  let best = { eid: run.bastion, ...bastionAt(run) }, bd = Infinity;
  for (const t of run.turrets) {
    const at = t && ctx.host.shipAt(t.eid);
    if (!t || !at) continue;
    const d = dhypot(at.x - x, at.y - y);
    if (d < bd) { bd = d; best = { eid: t.eid, x: at.x, y: at.y }; }
  }
  return best;
}

function send(ctx: SiegeCtx, run: Run, eids: number[], x: number, y: number): void {
  const t = nearestTurret(ctx, run, x, y);
  ctx.host.order(eids, { at: { x: t.x, y: t.y }, prey: t.eid });
  for (const e of eids) { const i = run.info.get(e); if (i) i.prey = t.eid; }
}

export const sapper: SiegeRole = {
  id: 'sapper',
  onSpawn(ctx, run, eids) {
    const at = ctx.host.shipAt(eids[0]);
    if (at) send(ctx, run, eids, at.x, at.y);
  },
  step(ctx, run, eid) {
    const i = run.info.get(eid);
    if (!i || (i.prey !== undefined && (i.prey === run.bastion || ctx.host.shipAt(i.prey)))) return;
    // Its turret's down: on to the next
    const at = ctx.host.shipAt(eid);
    if (at) send(ctx, run, [eid], at.x, at.y);
  },
};
