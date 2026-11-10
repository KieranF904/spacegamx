/**
 * The ship bridge from parsed JSON (bundled in the browser, read from disk in Node)
 */

import { ShipBridge } from './ShipBridge.js';
import { Blueprint, CatalogFiles, ShipTuning, InventoryStub, loadCatalog, type DesignUpdate } from '@space-game/common';

/** Everything the ship bridge needs, as parsed JSON (bundled in the browser, read from disk in Node). */
export interface ShipConfig {
  catalog: CatalogFiles;
  tuning: ShipTuning;
  starter: Blueprint;
  inventory: InventoryStub;
  /** Pre-made ships by file name (derelicts), optional */
  library?: Record<string, Blueprint>;
  /** Enemy ship designs by file name */
  enemies?: Record<string, Blueprint>;
  /** Dev test ships by file name (the F9 ship swap only: never sold, learned or spawned) */
  dev?: Record<string, Blueprint>;
  /** The design update mapping, its blueprints found (loadShipConfig: data/ships/designUpdate.json and blueprints/remakes) */
  designUpdate?: DesignUpdate;
  /** Keep the ship-wide bubble shields working on player ships (catalog.ts PLAYER_BUBBLE_MODELS; tests of the bubble rules) */
  playerBubbles?: boolean;
}

export function createShipBridge(cfg: ShipConfig): ShipBridge {
  return new ShipBridge({
    catalog: loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink, playerBubbles: cfg.playerBubbles }),
    tuning: cfg.tuning,
    starterBlueprint: cfg.starter,
    inventory: cfg.inventory,
    library: cfg.library,
    enemies: cfg.enemies,
    dev: cfg.dev,
    designUpdate: cfg.designUpdate,
    now: () => performance.now(),
  });
}
