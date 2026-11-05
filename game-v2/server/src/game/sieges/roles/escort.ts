/** An escort: flies with the biggest ship of its front (a boss first) and fights round it; when that falls it goes for the bastion */

import { SECOND } from '../rules.js';
import { bastionAt, type SiegeRole } from './index.js';

export const escort: SiegeRole = {
  id: 'escort',
  onSpawn(ctx, run, eids) {
    const front = run.info.get(eids[0])?.front ?? -1;
    let lead = -1, best = -Infinity;
    for (const [e, i] of run.info) {
      if (i.front !== front || i.role === 'escort' || front < 0) continue;
      const v = (i.boss ? 1e6 : 0) + i.cost;
      if (v > best) { best = v; lead = e; }
    }
    for (const e of eids) { const i = run.info.get(e); if (i) { i.lead = lead; i.nextOrder = 0; } }
  },
  step(ctx, run, eid, now) {
    const i = run.info.get(eid);
    if (!i || i.lead === undefined || now < (i.nextOrder ?? 0)) return;
    i.nextOrder = now + SECOND;
    const lead = i.lead >= 0 && ctx.host.hostileAlive(i.lead) ? ctx.host.shipAt(i.lead) : null;
    if (lead) return ctx.host.order([eid], { at: { x: lead.x, y: lead.y } });
    // Its lead's gone: at the bastion, as the rest
    i.lead = undefined;
    ctx.host.order([eid], { at: bastionAt(run) });
  },
};
