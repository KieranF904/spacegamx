/**
 * @contract feature.zoneshield.server
 * owns:       the shaped shields world half: how full each shield is, packed into the pilot row and the status row
 * needs:      ServerFeature, common packShaped, features.wire.json pilotExtra/status "shaped"
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new behaviour is a method on the instance created below (FeatureInstance hooks, types.ts)
 */

/**
 * Shaped shields' world half (the shared half: common/src/ships/features/zoneshield). The tick (refill, break, return) is the
 * bridge's own (bridge/flight.ts, beside the bubble's) and the hit is common's (hitRules.ts), run by bridge/weapons.ts.
 * What is here is the wire: how full each shield is, one number a ship (a nibble a shield, shaped.ts packShaped), in the
 * pilot's own row (features.wire.json pilotExtra "shaped") and the status row others get (status "shaped"), so a client
 * can draw each shield and work out which one a shot meets.
 */
import type { FeatureInstance, ServerFeature, ShipsOf } from '../types.js';
import { packShaped } from '@space-game/common';

class Shaped implements FeatureInstance {
  constructor(private host: ShipsOf<'get'>) {}

  wire(eid: number, out: number[]): number {
    const ship = this.host.ships.get(eid);
    out[0] = ship?.derived.fx?.shaped ? packShaped(ship) : 0;
    return 1;
  }

  status(eid: number): number {
    const ship = this.host.ships.get(eid);
    return ship?.derived.fx?.shaped ? packShaped(ship) : 0;
  }
}

export const serverFeature: ServerFeature = {
  id: 'zoneshield',
  create: (host) => new Shaped(host),
};
