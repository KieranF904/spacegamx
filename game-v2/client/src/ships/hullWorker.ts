/**
 * Builds ships' hulls off the main thread (hullWire.ts runHullJob): a rigid design's (a boss's: built whole, hullBuild.ts)
 * with its skeleton cut into what each piece over it covers, and every other hull, for the parts a ship has left.
 * ShipRenderer asks as soon as a hull's needed (hullWorkerClient.ts); the answer comes back as typed arrays, by transfer.
 * An intact design's hull (built whole, or every part on) is the same each time it's built: it's kept in the asset
 * cache, by its blueprint, the job's settings and the ship data. A damaged ship's is built each time.
 */
import { loadCatalog, type ShipTuning } from '@space-game/common';
import shipPieces from '../../../data/ships/pieces.json';
import shipFunctions from '../../../data/ships/functions.json';
import shipMaterials from '../../../data/ships/materials.json';
import shipModels from '../../../data/ships/models.json';
import shipTuning from '../../../data/ships/tuning.json';
import { assetKind, hashOf } from '../assets/assetCache';
import { HULL_GEOMETRY_VERSION, hullBuffers, runHullJob, type DesignCache, type HullDone, type HullJob } from './hullWire';

const tuning = shipTuning as unknown as ShipTuning;
const bespoke = Object.values(import.meta.glob('../../../data/ships/bespoke/*.json', { eager: true, import: 'default' }));
const catalog = loadCatalog({ pieces: shipPieces, functions: shipFunctions, materials: shipMaterials, models: shipModels, bespoke } as never, { overlapShrink: tuning.overlapShrink });
/** Designs' state and geometry, kept between jobs (a ship losing parts is built again and again) */
const designs: DesignCache = new Map();

const hulls = assetKind<Omit<HullDone, 'id'>>('hullGeometry', HULL_GEOMETRY_VERSION, { memory: false });
let data: string | null = null;
/** The ship data hulls are built from, as part of their key: an edited piece is never drawn from a stale hull */
const dataHash = () => (data ??= hashOf([shipPieces, shipFunctions, shipMaterials, shipModels, shipTuning, bespoke]));

self.onmessage = async (e: MessageEvent<HullJob>) => {
  const job = e.data, { id } = job;
  try {
    if (!job.whole && job.alive && !job.alive.every(Boolean)) {
      const { done, moved } = runHullJob(catalog, tuning, job, designs);
      (self as unknown as Worker).postMessage(done, moved);
      return;
    }
    // (Not its id or design number, which are this visit's; nor `alive`, all on)
    const { id: _id, design: _design, alive: _alive, ...settings } = job;
    const hull = await hulls.get(hashOf([dataHash(), settings]), () => {
      const { done: { id: _, ...built } } = runHullJob(catalog, tuning, job, designs);
      return built;
    });
    // (A copy of its own: jobs for one design asked together share the cache's one hull, and a transfer detaches its
    // buffers, so the second answer would fail; a pack of custom enemies appearing at once does just that)
    const own = structuredClone(hull);
    (self as unknown as Worker).postMessage({ ...own, id }, hullBuffers(own));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
