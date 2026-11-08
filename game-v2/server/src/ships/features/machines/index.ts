/**
 * @contract feature.machines.server
 * owns:       the field machines world half entry: every pilot's fabricator and refiner jobs and the field messages
 * needs:      ServerFeature, game/field/FieldShips.ts
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/**
 * The field machines' world half (the shared half: common/src/ships/features/machines; docs/design/field-fabrication.md):
 * game/field/FieldShips.ts runs every pilot's fabricator and refiner each tick and handles the field messages
 * (fieldPlan, fieldPlanClear, machine, fieldCancel, fieldRecycle). Built once by GameServer; the repair bank (package
 * B) reaches it through `features.get('machines')` for isClaimed and machineContents.
 */
import type { ServerFeature } from '../types.js';
import { FieldShips } from '../../../game/field/FieldShips.js';

export { FieldShips };

export const serverFeature: ServerFeature = {
  id: 'machines',
  create: (host) => new FieldShips(host),
};
