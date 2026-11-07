/**
 * The Mine Bay's world half (shared half: common/src/ships/features/minebay; docs/design/groups-mines-docking.md,
 * package M). A stub until package M fills it: the magazines, the `mineDrop` decision, the live mines, their triggers
 * and blasts (through ShipBridge's damage funnel), expiry and the per-pilot cap.
 */
import type { ServerFeature } from '../types.js';

export const serverFeature: ServerFeature = {
  id: 'minebay',
  create: () => ({}),
};
