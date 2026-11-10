/**
 * @contract server.dens.registry
 * owns:       den features by kind (systems.json den[].kind)
 * needs:      DenFeatureData (common), DenFactory (dens/types), the den feature modules
 * invariants: the vents and cache dens work through their kinds — server/src/game/dens/kiln.test.ts
 * extend:     a new den kind is a module and one entry in DEN_KINDS (tsc fails if a kind of DenFeatureData has no
 *             entry)
 */

/** Den features by kind (systems.json `den[].kind`): a new kind is a module and a line here */

import type { DenFeatureData } from '@space-game/common';
import type { DenFactory } from './types.js';
import { ventFloor } from './ventFloor.js';
import { crustCache } from './crustCache.js';

export const DEN_KINDS: { [K in DenFeatureData['kind']]: DenFactory<Extract<DenFeatureData, { kind: K }>> } = {
  vents: ventFloor,
  cache: crustCache,
};
