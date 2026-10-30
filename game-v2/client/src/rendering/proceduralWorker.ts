/**
 * Builds procedural textures off the main thread (procedural.ts asks): the
 * asteroids' relief atlas, each stillstone's surface, the stations' hull
 * atlas and each station's baked look. Each answer is sent back by transfer,
 * not copied.
 */

import { buildRockAtlas } from './rocks/rockTextures';
import { buildStillstoneMap } from './stillstoneMap';
import { buildStationAtlas } from './stations/stationTextures';
import { bakeStation, bakeTransfers } from './stations/stationBake';
import type { ProceduralRequest } from './procedural';

self.onmessage = (e: MessageEvent<ProceduralRequest>) => {
  const m = e.data;
  if (m.kind === 'rockAtlas') {
    const atlas = buildRockAtlas();
    (self as unknown as Worker).postMessage({ id: m.id, result: atlas }, [atlas.buffer]);
  } else if (m.kind === 'stationAtlas') {
    const atlas = buildStationAtlas();
    (self as unknown as Worker).postMessage({ id: m.id, result: atlas }, [atlas.buffer]);
  } else if (m.kind === 'stationBake') {
    // (a bake that fails leaves that station with today's look, and the worker running)
    let out = null;
    try { out = bakeStation(m.data); } catch (err) { console.warn('station bake failed', err); }
    (self as unknown as Worker).postMessage({ id: m.id, result: out }, out ? bakeTransfers(out) : []);
  } else {
    const st = buildStillstoneMap(m.data);
    (self as unknown as Worker).postMessage({ id: m.id, result: st }, [st.map.buffer, st.glow.buffer]);
  }
};
