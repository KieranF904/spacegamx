/** The Flash Screen's world half (the shared half: common/src/ships/features/flash): Flash.ts, built once by GameServer */
import type { ServerFeature } from '../types.js';
import { Flash } from './Flash.js';

export { Flash };

export const serverFeature: ServerFeature = {
  id: 'flash',
  create: (host) => new Flash(host),
};
