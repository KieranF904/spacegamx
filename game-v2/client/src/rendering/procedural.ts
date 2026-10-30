/**
 * Procedural textures, built in a worker (proceduralWorker.ts) so the game
 * doesn't stall while they're made: the asteroids' relief atlas (once), each
 * stillstone's surface (once per stone), the stations' hull atlas (once) and
 * each station's baked look (stations/stationBake.ts). Without a worker
 * (tests, or one that fails) they're built here instead, a moment later.
 */

import type { LodestoneData } from '@space-game/common';
import { buildRockAtlas } from './rocks/rockTextures';
import { buildStillstoneMap } from './stillstoneMap';
import { buildStationAtlas } from './stations/stationTextures';
import { bakeStation, type BakeInput, type BakeOutput } from './stations/stationBake';

export type ProceduralRequest = { id: number; kind: 'rockAtlas' } | { id: number; kind: 'stillstone'; data: LodestoneData }
  | { id: number; kind: 'stationAtlas' } | { id: number; kind: 'stationBake'; data: BakeInput };
type Job = { req: ProceduralRequest; done: (v: unknown) => void };
/** A request before it has its id */
type Ask = ProceduralRequest extends infer R ? (R extends ProceduralRequest ? Omit<R, 'id'> : never) : never;

let worker: Worker | null | undefined;
const pending = new Map<number, Job>();
let nextId = 1;

function inline(req: ProceduralRequest): unknown {
  switch (req.kind) {
    case 'rockAtlas': return buildRockAtlas();
    case 'stillstone': return buildStillstoneMap(req.data);
    case 'stationAtlas': return buildStationAtlas();
    case 'stationBake': try { return bakeStation(req.data); } catch (err) { console.warn('station bake failed', err); return null; }
  }
}

function startWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./proceduralWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; result: unknown }>) => {
      const job = pending.get(e.data.id);
      pending.delete(e.data.id);
      job?.done(e.data.result);
    };
    // A worker that fails: the rest are built here
    w.onerror = () => {
      worker = null;
      w.terminate();
      const jobs = [...pending.values()];
      pending.clear();
      for (const j of jobs) setTimeout(() => j.done(inline(j.req)), 0);
    };
    return w;
  } catch {
    return null;
  }
}

function run<T>(req: Ask): Promise<T> {
  if (worker === undefined) worker = startWorker();
  const full = { ...req, id: nextId++ } as ProceduralRequest;
  return new Promise<T>((resolve) => {
    const done = resolve as (v: unknown) => void;
    if (!worker) { setTimeout(() => done(inline(full)), 0); return; }
    pending.set(full.id, { req: full, done });
    worker.postMessage(full);
  });
}

let atlas: Promise<Uint8Array> | null = null;
/** The asteroids' relief atlas (rockTextures.ts), RGBA */
export function rockAtlasData(): Promise<Uint8Array> {
  return (atlas ??= run<Uint8Array>({ kind: 'rockAtlas' }));
}

const stones = new Map<string, Promise<{ map: Uint8Array; glow: Uint8Array }>>();
/** A stillstone's surface (stillstoneMap.ts); the same stone in the same state is built once */
export function stillstoneMapData(data: LodestoneData): Promise<{ map: Uint8Array; glow: Uint8Array }> {
  const key = `${data.id}:${data.state ?? 'active'}:${data.rough ? 1 : 0}`;
  let p = stones.get(key);
  if (!p) stones.set(key, (p = run({ kind: 'stillstone', data })));
  return p;
}

let stationAtlas: Promise<Uint8Array> | null = null;
/** The stations' hull panel atlas (stations/stationTextures.ts), RGBA */
export function stationAtlasData(): Promise<Uint8Array> {
  return (stationAtlas ??= run<Uint8Array>({ kind: 'stationAtlas' }));
}

/** A station's baked look (stations/stationBake.ts; null if it failed); its input's arrays are copied over, not handed over */
export function stationBakeData(data: BakeInput): Promise<BakeOutput | null> {
  return run<BakeOutput | null>({ kind: 'stationBake', data });
}
