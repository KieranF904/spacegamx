/**
 * @contract feature.weaponry.common
 * owns:       the shared shot behaviours and weapon statuses part feature, shared half: declares weapon roles picked
 *             by a gun's resolved tuning
 * needs:      PartFeature, weaponry/weaponry.ts
 * invariants: the feature is in the registry, its folder matches its id and its wire slots and input bits are the
 *             pinned ones (none dropped) — common/src/ships/features/weaponry/contract.test.ts
 *             a ship without the part carries nothing of the feature, and facts are finite, labelled and repeat
 *             exactly — common/src/ships/features/weaponry/contract.test.ts
 * extend:     a new shot behaviour or status is a new weapon role in the feature object below
 */

/**
 * The shared shot behaviours and weapon statuses as a part feature (features/README.md; the numbers and the maths:
 * weaponry.ts). Like `support` it is not a function flag but weapon roles picked by a gun's resolved tuning, so it
 * gives a ship nothing at a rebuild and `applies` picks no function. Its world half is server/src/ships/features/weaponry
 * (a marking or slowing beam, hung on the beam roles; the statuses' wire values); the shells' own behaviours are shot
 * options the projectile code reads (server game/Weapons.ts, ships/bridge/weapons.ts).
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { ROLE_END_AT_AIM, ROLE_WALK, ROLE_GUIDED, ROLE_MARK, ROLE_SLOW, endsAtAimRole, walksRole, guidedRole, marksRole, slowsRole } from './weaponry.js';

export const feature: PartFeature = {
  id: 'weaponry',
  // (A weapon-kind feature: no function of its own)
  applies: () => false,
  // (After the others: feature numbers follow (order, id), so every earlier feature keeps its number)
  order: 50,
  weapon: [
    { id: ROLE_END_AT_AIM, applies: endsAtAimRole },
    { id: ROLE_WALK, applies: walksRole },
    { id: ROLE_GUIDED, applies: guidedRole },
    { id: ROLE_MARK, applies: marksRole },
    { id: ROLE_SLOW, applies: slowsRole },
  ],
  replicate: [
    // The pilot's own row: ticks left marked and slowed (its prediction flies a slowed ship: flight.ts withSlowed)
    { name: 'marked', where: 'pilotExtra', who: 'self', default: 0 },
    { name: 'slowed', where: 'pilotExtra', who: 'self', default: 0 },
    // Everyone else's status row: the bits (weaponry.ts STATUS_MARKED, STATUS_SLOWED)
    { name: 'statuses', where: 'status', who: 'all', default: 0 },
    // Replicas fly a slowed ship by its control bit (replica.ts CTL.slowed)
    { name: 'slowed', where: 'ctl', who: 'all', default: 0 },
  ],
};
