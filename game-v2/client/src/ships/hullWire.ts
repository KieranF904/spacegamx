/**
 * A built hull as it crosses to and from the hull worker (hullWorker.ts): each geometry field a typed array (moved,
 * not copied), turned back into geometry on arrival. The arrays stay typed: the hull is never added to again, and
 * what reads it (ShipBatch's merge, LitGeometry.toGeometry) only indexes it.
 *
 * And the job itself (runHullJob: pure, so it runs in the worker and in tests alike): a design's hull built whole (a
 * boss's, with its skeletons cut by what's over them), or built for the parts a ship has left (`alive`, about its
 * centre of mass then: `com`).
 */
import { blueprintGeometry, createShipState, type Blueprint, type Catalog, type PlacedGeom, type ShipState, type ShipTuning } from '@space-game/common';
import { LitGeometry } from '../rendering/lighting/LitGeometry';
import { ShipGeometry } from '../rendering/lighting/ShipBatch';
import { buildHull, skeletonCovered, type BarrelSpec } from './hullBuild';
import { buildSkeleton } from './skeletonBuild';

export interface WireGeometry { ship: boolean; f: Record<string, Float32Array | Uint32Array> }
export interface HullJob {
  id: number;
  blueprint: unknown;
  cs: number;
  tint?: number;
  /** Which design this is (the worker keeps each design's state and geometry by it, a few at a time) */
  design?: number;
  /** Built whole (a rigid design's: every part, its skeletons cut); else for the parts in `alive`, about `com` */
  whole?: boolean;
  kind?: 'ship' | 'debris';
  alive?: boolean[];
  com?: [number, number];
}
export interface HullDone { id: number; full: WireGeometry; far: WireGeometry; barrels: BarrelSpec[]; bones: { sk: number; cover: number; g: WireGeometry }[] }

/**
 * What a job makes, by version (assetCache.ts: intact hulls are kept): bump it whenever the hull build's output changes
 * (hullBuild, skeletonBuild, bakeHull, ShipGeometry's fields). Changes to the ship data are caught without it
 */
export const HULL_GEOMETRY_VERSION = 1;

const LIT = ['pos', 'nrm', 'col', 'slot'], SHIP = ['part', 'kind', 'tone', 'hullMat', 'grade', 'engine', 'expo', 'bend', 'dep'];

export function toWire(g: LitGeometry): WireGeometry {
  const ship = g instanceof ShipGeometry, src = g as unknown as Record<string, number[]>, f: WireGeometry['f'] = {};
  for (const k of ship ? [...LIT, ...SHIP] : LIT) f[k] = new Float32Array(src[k]);
  f.idx = new Uint32Array(g.idx);
  return { ship, f };
}

export function fromWire<T extends LitGeometry>(w: WireGeometry): T {
  const g = w.ship ? new ShipGeometry() : new LitGeometry(), dst = g as unknown as Record<string, unknown>;
  for (const [k, a] of Object.entries(w.f)) dst[k] = a;
  return g as T;
}

/** A design's state and placed geometry, by its `design` number (the last few) */
export type DesignCache = Map<number, { ship: ShipState; geoms: PlacedGeom[] }>;
const DESIGNS_KEPT = 24;

/** A job done (and the buffers to move with it) */
export function runHullJob(catalog: Catalog, tuning: ShipTuning, job: HullJob, cache?: DesignCache): { done: HullDone; moved: ArrayBuffer[] } {
  const { id, blueprint, cs, tint } = job;
  let base = job.design !== undefined ? cache?.get(job.design) : undefined;
  if (!base) {
    const ship = createShipState(catalog, tuning, 1, blueprint as Blueprint, 0);
    base = { ship, geoms: blueprintGeometry(catalog, ship.blueprint) };
    if (cache && job.design !== undefined) {
      cache.set(job.design, base);
      for (const k of cache.keys()) { if (cache.size <= DESIGNS_KEPT) break; cache.delete(k); }
    }
  } else if (cache && job.design !== undefined) { cache.delete(job.design); cache.set(job.design, base); }
  const { geoms } = base;
  // (read only: the cached state is never changed, a job's own kind, parts and centre laid over it)
  const ship = job.whole
    ? ({ ...base.ship, kind: job.kind ?? 'ship' } as ShipState)
    : ({ ...base.ship, kind: job.kind ?? 'ship', derived: { ...base.ship.derived, alive: job.alive ?? base.ship.derived.alive, com: job.com ?? base.ship.derived.com } } as ShipState);
  const { hull, barrels } = buildHull(catalog, geoms, ship, cs, tint, !!job.whole);
  // Its skeletons (built whole only), cut by what's over them
  const bones: HullDone['bones'] = [];
  if (job.whole) {
    const over = (i: number) => { const pc = catalog.pieces.get(ship.blueprint.parts[i].piece); return !pc?.skeleton && !pc?.under; };
    ship.blueprint.parts.forEach((p, i) => {
      const sk = catalog.pieces.get(p.piece)?.skeleton;
      if (!sk) return;
      const g = new LitGeometry();
      buildSkeleton(g, sk, ship.derived.com, cs);
      for (const [cover, piece] of skeletonCovered(g, geoms, ship.derived.com, cs, over)) bones.push({ sk: i, cover, g: toWire(piece) });
    });
  }
  const done = { id, full: toWire(hull.full), far: toWire(hull.far), barrels, bones };
  return { done, moved: hullBuffers(done) };
}

/** A built hull's buffers (to move with it) */
export function hullBuffers(h: Omit<HullDone, 'id'>): ArrayBuffer[] {
  return [h.full, h.far, ...h.bones.map((b) => b.g)].flatMap((w) => Object.values(w.f).map((a) => a.buffer as ArrayBuffer));
}
