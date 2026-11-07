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
