/**
 * Builds the hull atlas (hullTextures.ts) off the main thread, or finds it in the asset cache; the answer is sent back by
 * transfer, then 'stored' once it's in the cache (the worker can be ended then)
 */
import { assetKind, storesSettled } from '../assets/assetCache';
import { buildHullAtlas, HULL_ATLAS_VERSION } from './hullTextures';

const hullAtlas = assetKind<Uint8Array>('hullAtlas', HULL_ATLAS_VERSION, { memory: false });

self.onmessage = async () => {
  const atlas = await hullAtlas.get('', buildHullAtlas);
  (self as unknown as Worker).postMessage(atlas, [atlas.buffer]);
  await storesSettled();
  (self as unknown as Worker).postMessage('stored');
};
