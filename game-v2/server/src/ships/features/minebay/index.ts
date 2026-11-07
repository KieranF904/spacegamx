/**
 * The Mine Bay's world half (shared half: common/src/ships/features/minebay; docs/design/groups-mines-docking.md,
 * package M): Minefield.ts holds the magazines, the `mineDrop` decision, the live mines, their triggers and blasts
 * (through ShipBridge's damage funnel), expiry and the per-pilot cap. The rearm job is the field fabricator's
 * (game/field/FieldShips.ts), which fills the magazines in the ship record this reads.
 */
import type { ServerFeature } from '../types.js';
import { Minefield } from './Minefield.js';

export { Minefield };

export const serverFeature: ServerFeature = {
  id: 'minebay',
  create: (host) => new Minefield(host),
};
