/**
 * @contract feature.minebay.server
 * owns:       the Mine Bay world half entry: magazines, the mineDrop decision, live mines, their triggers and blasts
 * needs:      ServerFeature, Minefield.ts, common/network/minesProtocol, ships/bridge damage funnel
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

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
