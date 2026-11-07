/**
 * Docking Clamps' world half (shared half: common/src/ships/features/clamp; docs/design/groups-mines-docking.md,
 * package K). A stub until package K fills it: the presses, the lock, swap and undock decisions, the joined pair's
 * server step and the breaks (death, disconnect, jump, station dock).
 */
import type { ServerFeature } from '../types.js';

export const serverFeature: ServerFeature = {
  id: 'clamp',
  create: () => ({}),
};
