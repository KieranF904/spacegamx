/** Den features by kind (systems.json `den[].kind`): a new kind is a module and a line here */

import type { DenFeatureData } from '@space-game/common';
import type { DenFactory } from './types.js';
import { ventFloor } from './ventFloor.js';
import { crustCache } from './crustCache.js';

export const DEN_KINDS: { [K in DenFeatureData['kind']]: DenFactory<Extract<DenFeatureData, { kind: K }>> } = {
  vents: ventFloor,
  cache: crustCache,
};
