/**
 * @contract feature.flash.common
 * owns:       the Flash Screen part feature, shared half: the shield points a rebuild derives for the Flash Screens
 * needs:      PartFeature, grades.ts fnOutput, flash/flash.ts (restore ticks)
 * invariants: the feature is in the registry, its folder matches its id and its wire slots and input bits are the
 *             pinned ones (none dropped) — common/src/ships/features/flash/contract.test.ts
 *             a ship without the part carries nothing of the feature, and facts are finite, labelled and repeat
 *             exactly — common/src/ships/features/flash/contract.test.ts
 * extend:     a new rebuild result or card fact is a field in derive / describe below; a new wire slot is appended in
 *             features.wire.json (npm run wire:sync)
 */

/**
 * The Flash Screen as a part feature (features/README.md; the numbers: flash.ts). Shared half: what a rebuild derives
 * (the shield points the Flash Screens hold). Its world half is server/src/ships/features/flash (the wait after a
 * break, the Capacitor bank's instant return, and the flash bloom). The shield itself and its capacity are the ordinary
 * shield's (rebuild.ts shieldMax); the Flash Screen has no regen of its own (functions: shieldRegen 0).
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
  derive(c) {
    for (const i of c.parts) {
      const f = c.out.flash ??= { max: 0, parts: [] };
      f.max += (c.fns[i].shield ?? 0) * c.area[i] * fnOutput(c.fns[i], c.mats[i]);
      f.parts.push(i);
    }
    if (c.out.flash) c.out.flash.max = Math.round(c.out.flash.max * 100) / 100;
  },
  describe() {
    const s = FLASH_RESTORE_TICKS / 60;
    return [{
      feature: 'flash', key: 'restore', label: 'Returns whole', value: s, unit: 's', tier: 'stat',
      sentence: `no slow refill: it returns whole ${s} s after it breaks`,
      short: `returns whole ${s} s after it breaks`,
      chip: `back in ${s} s`,
    }];
  },
};
