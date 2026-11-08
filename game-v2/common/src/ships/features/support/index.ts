/**
 * @contract feature.support.common
 * owns:       the Repair Beam and Point Defence Turret part feature, shared half: declares two weapon roles; gives a
 *             ship nothing at a rebuild
 * needs:      PartFeature, support/support.ts
 * invariants: the feature is in the registry, its folder matches its id and its wire slots and input bits are the
 *             pinned ones (none dropped) — common/src/ships/features/support/contract.test.ts
 *             a ship without the part carries nothing of the feature, and facts are finite, labelled and repeat
 *             exactly — common/src/ships/features/support/contract.test.ts
 * extend:     a new support weapon kind is a new weapon role in the feature object below
 */

/**
 * The support weapons as a part feature (features/README.md; the numbers and the maths: support.ts): the Repair Beam
 * and the Point Defence Turret. Unlike a Tow Beam or a Burst Strafer they are not a function flag but a weapon KIND
 * (tuning.json weapons.<kind>: `heal`, `pointDefence`), so the feature gives a ship nothing at a rebuild and
 * `applies` picks no function; it declares two weapon roles instead. Their world half is
 * server/src/ships/features/support (the beam and the turret's tick, hung on the roles by id, and the support credit).
 *
 * (No imported value is used at module scope here: the plan reaches this file through the registry.)
 */

import type { PartFeature } from '../types.js';
import { pointDefenceDef, repairBeamDef, REPAIR_BEAM, POINT_DEFENCE } from './support.js';

export const feature: PartFeature = {
  id: 'support',
  // (A weapon-kind feature: no function of its own)
  applies: () => false,
  // (After the others: feature numbers follow (order, id), so the Tow Beam and the Burst Strafer keep theirs)
  order: 40,
  weapon: [
    { id: REPAIR_BEAM, applies: repairBeamDef },
    { id: POINT_DEFENCE, applies: pointDefenceDef },
  ],
};
