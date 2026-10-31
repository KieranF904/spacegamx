/** The Tow Beam's world half (the shared half: common/src/ships/features/tow): Towing.ts, built once by GameServer */
import type { ServerFeature } from '../types.js';
import { Towing } from './Towing.js';

export { Towing };

export const serverFeature: ServerFeature = {
  id: 'tow',
  create: (host) => new Towing(host),
};
