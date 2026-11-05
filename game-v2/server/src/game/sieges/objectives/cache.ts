/** A supply drop: hold it (stay within its radius) long enough to bring it in */

import { SECOND } from '../rules.js';
import type { SiegeObjectiveKind } from './index.js';
import { dhypot } from '@space-game/common';

export const cache: SiegeObjectiveKind = {
  id: 'cache',
  title: (ctx) => ctx.t('sieges.obj.cache'),
  how: (ctx) => ctx.t('sieges.obj.upCache'),
  pay: (rules) => rules.objectives.cache,
  start: () => -1,
  step(ctx, _run, o, pilots) {
    const C = ctx.rules.objectives.cache;
    const there = pilots.filter((p) => dhypot(p.x - o.x, p.y - o.y) < C.radius);
    if (there.length) o.held += 10;
    if (o.held >= C.holdSeconds * SECOND) return there.map((p) => p.conn);
  },
  banner(ctx, _run, o, now) {
    const C = ctx.rules.objectives.cache;
    const left = Math.max(0, Math.ceil((o.until - now) / SECOND));
    return {
      text: ctx.t('sieges.obj.cacheText', { secs: C.holdSeconds, left }),
      meter: { label: ctx.t('sieges.obj.cacheMeter'), value: Math.round((o.held / (C.holdSeconds * SECOND)) * 100), max: 100 },
    };
  },
};
