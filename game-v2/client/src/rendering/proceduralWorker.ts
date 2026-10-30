/**
 * Builds procedural textures off the main thread (procedural.ts asks): the
 * asteroids' relief atlas, each stillstone's surface, the stations' hull
 * atlas and each station's baked look. Each is looked up in the asset cache
 * first (here, in the worker: none of it crosses the main thread), and built
 * and stored only if it isn't there. Each answer is sent back by transfer,
 * not copied.
 */

import { assetKind, hashOf } from '../assets/assetCache';
import { buildRockAtlas, ROCK_ATLAS_VERSION } from './rocks/rockTextures';
import { buildStillstoneMap, STILLSTONE_MAP_VERSION } from './stillstoneMap';
import { buildStationAtlas, STATION_ATLAS_VERSION } from './stations/stationTextures';
import { bakeStation, bakeTransfers, STATION_BAKE_VERSION, type BakeOutput } from './stations/stationBake';
import type { ProceduralRequest } from './procedural';

// (Nothing kept in memory here: each is handed over, its buffers moved)
const rockAtlas = assetKind<Uint8Array>('rockAtlas', ROCK_ATLAS_VERSION, { memory: false });
const stillstone = assetKind<{ map: Uint8Array; glow: Uint8Array }>('stillstoneMap', STILLSTONE_MAP_VERSION, { memory: false });
const stationAtlas = assetKind<Uint8Array>('stationAtlas', STATION_ATLAS_VERSION, { memory: false });
const stationBake = assetKind<BakeOutput>('stationBake', STATION_BAKE_VERSION, { memory: false });

const post = (id: number, result: unknown, moved: ArrayBuffer[]) => (self as unknown as Worker).postMessage({ id, result }, moved);

self.onmessage = async (e: MessageEvent<ProceduralRequest>) => {
  const m = e.data;
  if (m.kind === 'rockAtlas') {
    const atlas = await rockAtlas.get('', buildRockAtlas);
    post(m.id, atlas, [atlas.buffer as ArrayBuffer]);
  } else if (m.kind === 'stationAtlas') {
    const atlas = await stationAtlas.get('', buildStationAtlas);
    post(m.id, atlas, [atlas.buffer as ArrayBuffer]);
  } else if (m.kind === 'stationBake') {
    // (a bake that fails leaves that station with today's look, and the worker running; it isn't stored)
    let out: BakeOutput | null = null;
    try { out = await stationBake.get(hashOf(m.data), () => bakeStation(m.data)); } catch (err) { console.warn('station bake failed', err); }
    post(m.id, out, out ? bakeTransfers(out) : []);
  } else {
    const { id, rough, scar, state } = m.data;
    const st = await stillstone.get(hashOf({ id, rough, scar, state }), () => buildStillstoneMap(m.data));
    post(m.id, st, [st.map.buffer as ArrayBuffer, st.glow.buffer as ArrayBuffer]);
  }
};
