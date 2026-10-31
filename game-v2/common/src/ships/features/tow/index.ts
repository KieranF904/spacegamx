/**
 * The Tow Beam as a part feature (features/README.md; the part and its tether: tow.ts). Shared half: what a rebuild
 * derives for it, what it draws, what the UI says about it. Its world half is server/src/ships/features/tow, its
 * key, chip and tether client/src/ships/features/tow.
 */

import type { PartFeature } from '../types.js';
import { towTuning } from './tow.js';

const n0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '—');

export const feature: PartFeature = {
  id: 'tow',
  applies: (fn) => !!fn.tow,
  order: 20,
  // It draws by the tick, only while it tows (the beam's feed group on its circuit, as a gun's)
  burst: true,
  derive(c) {
    for (const i of c.parts) {
      if (c.satisfaction[i] <= 0) continue;
      const t = c.out.tow ??= { power: 0, parts: [] };
      t.power = Math.max(t.power, c.satisfaction[i]);
      t.parts.push(i);
    }
    if (c.out.tow) c.out.tow.power = Math.round(c.out.tow.power * 1000) / 1000;
  },
  load(ship, L, out) {
    // (Only while it tows: the server sets ship.tow)
    if (ship.tow === undefined) return;
    const t = ship.derived.fx?.tow;
    if (!t) return;
    for (const i of t.parts) { const f = L.feedOf[i]; if (f >= 0) out[f] += L.draw[i]; }
  },
  // Pinned to today's positions in features.wire.json: the pilot's own row (after the dodge pair) and the status row others get
  replicate: [
    { name: 'tow', where: 'pilotExtra', who: 'self', default: 0 },
    { name: 'tow', where: 'status', who: 'all', default: 0 },
  ],
  describe({ tuning }) {
    const t = towTuning(tuning);
    return [{
      feature: 'tow', key: 'range', label: 'Tows', value: t.range, unit: 'm', tier: 'stat',
      sentence: `wrecks, debris and pods within ${n0(t.range)} m of your hull · snaps past ${n0(t.snap)} m · into a station to salvage`,
      dim: 'draws only while towing; never a working ship',
      short: `wrecks, debris and pods within ${Math.round(t.range)} m`,
      chip: `tows within ${n0(t.range)} m`,
      drawWhen: 'towing',
    }];
  },
};
