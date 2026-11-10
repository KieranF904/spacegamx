/**
 * @contract feature.flash.common
 * owns:       the Flash Screen part feature, shared half: the shield points a rebuild derives for the Flash Screens
 * needs:      PartFeature, grades.ts fnOutput, flash/flash.ts (restore ticks, the store's payment)
 * invariants: the feature is in the registry, its folder matches its id and its wire slots and input bits are the
 *             pinned ones (none dropped) — common/src/ships/features/flash/contract.test.ts
 *             a ship without the part carries nothing of the feature, and facts are finite, labelled and repeat
 *             exactly — common/src/ships/features/flash/contract.test.ts
 * extend:     a new rebuild result or card fact is a field in derive / describe below; a new wire slot is appended in
 *             features.wire.json (npm run wire:sync)
 */

/**
 * The Flash Screen as a part feature (features/README.md; the numbers: flash.ts). Shared half: what a rebuild derives
 * (the shield points the Flash Screens hold, each one's). Its world half is server/src/ships/features/flash (the store's
 * instant return, the wait after a break, and the flash bloom). The shield itself and its capacity are the ordinary
 * shield's (rebuild.ts shieldMax); the Flash Screen has no regen of its own (functions: shieldRegen 0). Its store is its
 * buffer on the ports core (power/ports.ts PortsLayout.flash: a tool with no draw of its own).
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { fnOutput } from '../../grades.js';
import { FLASH_RESTORE_TICKS } from './flash.js';

export const feature: PartFeature = {
  id: 'flash',
  applies: (fn) => !!fn.flash,
  // (After the others: feature numbers follow (order, id), so the existing ones keep theirs)
  order: 50,
  // (Its store fills only after it is spent: no steady draw)
  burst: true,
  derive(c) {
    for (const i of c.parts) {
      const f = c.out.flash ??= { max: 0, parts: [], pts: [] };
      const pts = (c.fns[i].shield ?? 0) * c.area[i] * fnOutput(c.fns[i], c.mats[i]);
      f.max += pts;
      f.parts.push(i);
      f.pts.push(Math.round(pts * 100) / 100);
    }
    if (c.out.flash) c.out.flash.max = Math.round(c.out.flash.max * 100) / 100;
  },
  describe({ fn }) {
    const s = FLASH_RESTORE_TICKS / 60, cost = fn.flashCost ?? 0;
    return [{
      feature: 'flash', key: 'restore', label: 'Returns whole', value: s, unit: 's', tier: 'stat',
      sentence: cost > 0
        ? `no slow refill: a full store (${cost} E a point) brings it back at once when it breaks, else it returns whole ${s} s later`
        : `no slow refill: it returns whole ${s} s after it breaks`,
      short: cost > 0 ? `back at once from its store, else in ${s} s` : `returns whole ${s} s after it breaks`,
      chip: cost > 0 ? 'back at once' : `back in ${s} s`,
      ...(cost > 0 ? { drawWhen: 'refilling' } : {}),
    }];
  },
};
