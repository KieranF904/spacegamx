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
