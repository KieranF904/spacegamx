/**
 * @contract feature.clamp.server
 * owns:       the Docking Clamps world half entry: the lock, swap and undock decisions and the breaks
 * needs:      ServerFeature, Clamps.ts, common/network/clampProtocol, ships/bridge/clamp.ts
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/**
 * Docking Clamps' world half (shared half: common/src/ships/features/clamp; docs/design/groups-mines-docking.md 3):
 * the presses, the lock, swap and undock decisions and the breaks (Clamps.ts); the joined pair's server step is
 * ships/bridge/clamp.ts.
 */
import type { ServerFeature } from '../types.js';
import { Clamps } from './Clamps.js';

export { Clamps };

export const serverFeature: ServerFeature = {
  id: 'clamp',
  create: (host) => new Clamps(host),
};
