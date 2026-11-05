/** Artillery: fights from long range (lobbers), picking fights from further still */

import type { SiegeRole } from './index.js';

export const artillery: SiegeRole = {
  id: 'artillery',
  tune: (s) => ({ ...s, range: s.range ?? 1350, aggro: s.aggro ?? 2600 }),
};
