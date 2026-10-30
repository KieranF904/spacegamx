/** Builds the hull atlas (hullTextures.ts) off the main thread; the answer is sent back by transfer */
import { buildHullAtlas } from './hullTextures';

self.onmessage = () => {
  const atlas = buildHullAtlas();
  (self as unknown as Worker).postMessage(atlas, [atlas.buffer]);
};
