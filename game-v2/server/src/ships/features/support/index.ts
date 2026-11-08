/**
 * @contract feature.support.server
 * owns:       the support weapons world half: Repair Beam and Point Defence ticks hung on weapon roles, and the
 *             support credit ledger
 * needs:      ServerFeature, repairBeam.ts, pointDefence.ts, Support.ts, common REPAIR_BEAM / POINT_DEFENCE
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

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
