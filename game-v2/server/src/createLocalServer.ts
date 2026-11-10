/**
 * An authoritative GameServer with no network, no accounts and (by default) an empty scene.
 * Browser-safe (no Node imports): used by tests, benches and the replay harness.
 */

import { GameServer } from './GameServer.js';
import { GameData, GameDataFiles } from './data/GameData.js';
import type { UserStore } from './auth/types.js';
import { createShipBridge, type ShipConfig } from './ships/createShipBridge.js';

/** Accounts don't exist in a local server; every join is a guest. */
const noAccounts: UserStore = {
  register: async () => ({ success: false, error: 'No accounts in a local server' }),
  login: async () => ({ success: false, error: 'No accounts in a local server' }),
  validateSession: async () => null,
  logout: async () => {},
  cleanupExpiredSessions: async () => {},
  close: async () => {},
};

export interface LocalServerOptions {
  files: GameDataFiles;
  /** Real-time loop on (browser) or off (tests drive step()). Default true. */
  autoStart?: boolean;
  ships: ShipConfig;
  /** 'empty' (default) or 'sectors': the whole game world, run in the browser (to look at content with admin tools) */
  scene?: 'empty' | 'sectors';
}

export function createLocalServer(opts: LocalServerOptions): GameServer {
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
