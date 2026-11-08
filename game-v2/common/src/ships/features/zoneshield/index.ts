/**
 * @contract feature.zoneshield.common
 * owns:       the shaped shields part feature, shared half: each powered shield's line or arc, HP and refill
 *             (derived.fx.shaped), card facts and the wire slots for how full each is
 * needs:      PartFeature, zoneshield/shaped.ts, grades.ts
 * invariants: the feature is in the registry, its folder matches its id and its wire slots and input bits are the
 *             pinned ones (none dropped) — common/src/ships/features/zoneshield/contract.test.ts
 *             a ship without the part carries nothing of the feature, and facts are finite, labelled and repeat
 *             exactly — common/src/ships/features/zoneshield/contract.test.ts
 *             the shaped-shield soak rule and geometry hold — common/src/ships/features/zoneshield/zoneshield.test.ts
 * extend:     a new rebuild result or card fact is a field in derive / describe below; a new wire slot is appended in
 *             features.wire.json (npm run wire:sync)
 */

/**
 * Shaped shields as a part feature, id `zoneshield` (it sorts after `weaponry`: server features write their pilot-row values in id
 * order and features.wire.json is append-only). Features/README.md; the geometry and the soak rule: shaped.ts; the design:
 * prototypes/shield-fx). Shared half: what a rebuild derives (`derived.fx.shaped`: each powered shield's line or arc in
 * the ship's grid, its HP and refill), the facts a card shows, and the wire slots that tell clients how full each is.
 * The tick (refill, break, return) is the bridge's (server/src/ships/bridge/flight.ts calls `stepShaped`); the hit rule
 * is common's (hitRules.ts); the drawing is the client half's (client/src/ships/features/zoneshield).
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { fnOutput } from '../../grades.js';
import { MAX_SHAPED, SHAPED_IDLE, SHAPED_RETURN, shapedAt } from './shaped.js';

const n0 = (v: number) => Math.round(v).toLocaleString();

export const feature: PartFeature = {
  id: 'zoneshield',
  applies: (fn) => !!fn.shaped,
  // (After the others: feature numbers follow (order, id), so theirs do not move)
  order: 100,
  derive(c) {
    for (const i of c.parts) {
      if (c.satisfaction[i] <= 0) continue;
      const list = (c.out.shaped ??= { shields: [] }).shields;
      if (list.length >= MAX_SHAPED) break;
      const s = shapedAt(c.fns[i], c.mats[i], i, c.mounts[i]);
      if (s) list.push(s);
    }
  },
  // One number, a nibble a shield (shaped.ts packShaped): the pilot's own row and the status row others get
  replicate: [
    { name: 'shaped', where: 'pilotExtra', who: 'self', default: 0 },
    { name: 'shaped', where: 'status', who: 'all', default: 0 },
  ],
  describe({ fn, mat }) {
    const s = fn.shaped;
    if (!s) return [];
    const o = mat ? Math.round(s.cap * fnOutput(fn, mat)) : s.cap;
    const shape = s.kind === 'wall' ? `a ${s.len}-cell wall ${s.off} out from the hull` : `a ${s.span} degree arc, ${s.rad} cells out`;
    return [
      {
        feature: 'shaped', key: 'cap', label: 'Shield', value: o, tier: 'headline',
        sentence: `${shape}: holds ${n0(o)} and stops only shots that cross it`,
        short: `${n0(o)} HP, ${s.kind === 'wall' ? s.len + ' cells wide' : s.span + ' degrees'}`,
        chip: `${n0(o)} HP ${s.kind}`,
      },
      {
        feature: 'shaped', key: 'rate', label: 'Refill', value: s.rate, tier: 'stat',
        sentence: `${s.rate} a second once unhit for ${SHAPED_IDLE} s; down ${s.delay} s when broken, back at ${Math.round(SHAPED_RETURN * 100)}%`,
        short: `${s.rate} a second, down ${s.delay} s when broken`,
      },
    ];
  },
};
