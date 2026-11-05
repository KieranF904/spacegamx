/**
 * What the siege ground (BastionView) reads from the siege panel each frame:
 * the server's last siegeState (null: no siege), and the pad picked or
 * hovered in the panel (its reach ring is drawn on the ground). The panel
 * (ui/SiegePanel.ts) writes it; nothing else does.
 */

import type { ServerSiegeStateMessage } from '@space-game/common';

export const siegeFeed: {
  msg: ServerSiegeStateMessage | null;
  /** The pad picked or hovered in the panel (-1 none) */
  padFocus: () => number;
  /** The server tick now */
  tick: () => number;
} = { msg: null, padFocus: () => -1, tick: () => 0 };
