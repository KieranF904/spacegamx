/**
 * @contract feature.tow.server
 * owns:       the Tow Beam world half entry: Towing.ts built once by GameServer
 * needs:      ServerFeature, Towing.ts
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/** The Tow Beam's world half (the shared half: common/src/ships/features/tow): Towing.ts, built once by GameServer */
import type { ServerFeature } from '../types.js';
import { Towing } from './Towing.js';

export { Towing };

export const serverFeature: ServerFeature = {
  id: 'tow',
  create: (host) => new Towing(host),
};
