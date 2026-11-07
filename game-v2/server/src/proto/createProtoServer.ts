/**
 * Proto mode: an authoritative GameServer with no network, no accounts and an
 * empty scene. Browser-safe (no Node imports), so the client can host it.
 */

import { GameServer } from '../GameServer.js';
import { GameData, GameDataFiles } from '../data/GameData.js';
import type { UserStore } from '../auth/types.js';
import { ShipBridge } from '../ships/ShipBridge.js';
import { Blueprint, CatalogFiles, ShipTuning, InventoryStub, loadCatalog, type DesignUpdate } from '@space-game/common';

/** Accounts don't exist in proto mode; every join is a guest. */
const noAccounts: UserStore = {
  register: async () => ({ success: false, error: 'No accounts in proto mode' }),
  login: async () => ({ success: false, error: 'No accounts in proto mode' }),
  validateSession: async () => null,
  logout: async () => {},
  cleanupExpiredSessions: async () => {},
  close: async () => {},
};

export interface ProtoServerOptions {
  files: GameDataFiles;
  /** Real-time loop on (browser) or off (tests drive step()). Default true. */
  autoStart?: boolean;
  ships: ShipConfig;
  /** 'empty' (default) or 'sectors': the whole game world, run in the browser (to look at content with admin tools) */
  scene?: 'empty' | 'sectors';
}

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
}

export function createShipBridge(cfg: ShipConfig): ShipBridge {
  return new ShipBridge({
    catalog: loadCatalog(cfg.catalog, { overlapShrink: cfg.tuning.overlapShrink }),
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

export function createProtoServer(opts: ProtoServerOptions): GameServer {
  return new GameServer({
    gameData: new GameData(opts.files),
    userDB: noAccounts,
    scene: opts.scene ?? 'empty',
    autoStart: opts.autoStart ?? true,
    everyoneAdmin: true,
    ships: createShipBridge(opts.ships),
    // No stations in the empty scene, so the hangar works anywhere
    shipEditAnywhere: true,
    devTeleport: true,
  });
}
