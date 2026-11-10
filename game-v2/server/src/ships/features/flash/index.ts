/**
 * @contract feature.flash.server
 * owns:       the Flash Screen world half entry: the wait after a break and the bloom
 * needs:      ServerFeature, Flash.ts
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/** The Flash Screen's world half (the shared half: common/src/ships/features/flash): Flash.ts, built once by GameServer */
import type { ServerFeature } from '../types.js';
import { Flash } from './Flash.js';

export { Flash };

export const serverFeature: ServerFeature = {
  id: 'flash',
  create: (host) => new Flash(host),
};
