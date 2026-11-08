/**
 * @contract feature.strafer.server
 * owns:       the Burst Strafer world half: the pilot's own snapshot row values (dodge counter and way)
 * needs:      ServerFeature, common features.wire.json pilotExtra order
 * invariants: its hooks run in feature id order and its message names never clash with another feature or the game —
 *             server/src/ships/features/host.test.ts
 * extend:     a new pilot-row value is appended in features.wire.json and written in wire() below
 */

/**
 * The Burst Strafer's world half (the shared half, which flies it: common/src/ships/features/strafer). All it has here
 * is the pilot's own snapshot row: the dodge counter and the last dodge's way, first after the charge groups
 * (features.wire.json pilotExtra), so the pilot's prediction replays a dodge from the server's state.
 */
import type { ServerFeature } from '../types.js';

export const serverFeature: ServerFeature = {
  id: 'strafer',
  create: (host) => ({
    wire(pilot, out) {
      const ship = host.ships.get(pilot);
      out[0] = ship?.dodge ?? 0;
      out[1] = ship?.dodgeDir ?? 0;
      return 2;
    },
  }),
};
