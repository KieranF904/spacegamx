/**
 * Builds ships' hulls off the main thread (hullWire.ts runHullJob): a rigid design's (a boss's: built whole, hullBuild.ts)
 * with its skeleton cut into what each piece over it covers, and every other hull, for the parts a ship has left.
 * ShipRenderer asks as soon as a hull's needed (hullWorkerClient.ts); the answer comes back as typed arrays, by transfer.
 */
import { loadCatalog, type ShipTuning } from '@space-game/common';
import shipPieces from '../../../data/ships/pieces.json';
import shipFunctions from '../../../data/ships/functions.json';
import shipMaterials from '../../../data/ships/materials.json';
import shipModels from '../../../data/ships/models.json';
import shipTuning from '../../../data/ships/tuning.json';
import { runHullJob, type DesignCache, type HullJob } from './hullWire';

const tuning = shipTuning as unknown as ShipTuning;
const bespoke = Object.values(import.meta.glob('../../../data/ships/bespoke/*.json', { eager: true, import: 'default' }));
const catalog = loadCatalog({ pieces: shipPieces, functions: shipFunctions, materials: shipMaterials, models: shipModels, bespoke } as never, { overlapShrink: tuning.overlapShrink });
/** Designs' state and geometry, kept between jobs (a ship losing parts is built again and again) */
const designs: DesignCache = new Map();

self.onmessage = (e: MessageEvent<HullJob>) => {
  const { id } = e.data;
  try {
    const { done, moved } = runHullJob(catalog, tuning, e.data, designs);
    (self as unknown as Worker).postMessage(done, moved);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
