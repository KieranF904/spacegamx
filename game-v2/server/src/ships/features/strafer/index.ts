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
