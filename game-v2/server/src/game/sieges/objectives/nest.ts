/** A nest: burn it out before it buries itself; until then it keeps sending the night's cheapest ships at the bastion */

import { SECOND } from '../rules.js';
import type { SiegeObjectiveKind } from './index.js';

export const nest: SiegeObjectiveKind = {
  id: 'nest',
  title: (ctx) => ctx.t('sieges.obj.nest'),
  how: (ctx) => ctx.t('sieges.obj.upNest'),
  pay: (rules) => rules.objectives.nest,
  start(ctx, run, x, y) {
    const P = run.profile, night = run.wave + run.offset;
    const [eid] = ctx.host.spawnHostiles(run.num, [{ ship: P.objectives.nest.design, faction: P.objectives.nest.faction, hp: ctx.rules.objectives.nest.hp * (1 + P.hpPerNight * (night - 1)) }], x, y, { x, y }, run.grade);
    if (eid === undefined || eid < 0) return null;
    ctx.host.pin(eid);
    return eid;
  },
  step(ctx, run, o, pilots, now) {
    if (!ctx.host.hostileAlive(o.eid)) return pilots.map((p) => p.conn);
    if (now < o.release) return;
    // It keeps sending the night's cheapest
    const P = run.profile, night = run.wave + run.offset, b = run.sys.surface!.bastion!;
    o.release = now + ctx.rules.objectives.nest.releaseSeconds * SECOND;
    const open = P.roster.filter((r) => r.from <= night && (r.until === undefined || night <= r.until)).sort((a, c) => a.cost - c.cost);
    const u = open[0];
    // (spawnHostiles gives -1 for one it couldn't make: not counted as a kill when the next step finds it "gone")
    if (u) for (const e of ctx.host.spawnHostiles(run.num, [{ ship: u.ship, faction: u.faction, hp: (u.hp ?? 1) * (1 + P.hpPerNight * (night - 1)), range: u.range, aggro: u.aggro }], o.x, o.y, { x: b.x, y: b.y }, run.grade)) if (e >= 0) run.extras.push(e);
  },
  banner(ctx, _run, o, now) {
    const left = Math.max(0, Math.ceil((o.until - now) / SECOND));
    return {
      text: ctx.t('sieges.obj.nestText', { left }), danger: true,
      meter: { label: ctx.t('sieges.obj.nestMeter'), value: Math.round((ctx.host.shipAt(o.eid)?.hull ?? 0) * 100), max: 100 },
    };
  },
};
