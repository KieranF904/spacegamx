/**
 * The support weapons' world half (the shared half, with the weapon roles: common/src/ships/features/support).
 *   - the Repair Beam's beam and the Point Defence Turret's tick, hung on the roles by id (weapons.ts flattens them for
 *     the bridge's gun step): repairBeam.ts, pointDefence.ts, moved out of bridge/weapons.ts
 *   - the support credit ledger (Support.ts, was game/Support.ts), built once by GameServer
 */
import type { FeatureInstance, ServerFeature } from '../types.js';
import { REPAIR_BEAM, POINT_DEFENCE } from '@space-game/common';
import { repairBeam } from './repairBeam.js';
import { pointDefence } from './pointDefence.js';
import { Support } from './Support.js';

export { Support };

export const serverFeature: ServerFeature = {
  id: 'support',
  // (The ledger has no hooks of its own: GameServer reads it by calls, so it is not shaped as a FeatureInstance)
  create: () => new Support() as unknown as FeatureInstance,
  weapon: {
    [REPAIR_BEAM]: { onFire: repairBeam },
    [POINT_DEFENCE]: { onTick: pointDefence },
  },
};
