/**
 * Test-only: the one server boot every GameServer test shares. makeServer() is a real GameServer on the 'sectors' scene,
 * not auto-started (the test steps it), with the shared game data, the stub user database and the cached ship config;
 * any option a test passes replaces the default. The data files are read once per test file, not once per world.
 * makeEmptyServer() is the same on the 'empty' scene (no sector world, no asteroid orbit filing) for tests that need none of it.
 */
import { join } from 'path';
import * as bitecs from 'bitecs';
import { GameServer, type GameServerOptions } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { LocalTransport } from '../net/LocalTransport.js';
import type { ServerMessage } from '@space-game/common';

export const dataDir = join(__dirname, '../../../data');
let cachedFiles: ReturnType<typeof readGameDataFiles> | undefined;
/** The game data files, read once */
export const gameFiles = () => (cachedFiles ??= readGameDataFiles(dataDir));
/** Clear bitecs' global entity state (a fresh world) */
export const resetGlobals = (): void => (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
/** The stub user database every test server takes */
export const stubUserDB = { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never;

/** A test GameServer: defaults below, `opts` replace them. Does not reset bitecs globals (call resetGlobals() first). */
export function makeServer(opts: Partial<GameServerOptions> = {}): GameServer {
  return new GameServer({
    gameData: new GameData(gameFiles()),
    userDB: stubUserDB,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    ...opts,
  } as GameServerOptions);
}

/** A test GameServer on the 'empty' scene: no stations, NPCs, portals or asteroids, so it boots in milliseconds. For tests that do not need the sector world. */
export const makeEmptyServer = (opts: Partial<GameServerOptions> = {}): GameServer => makeServer({ scene: 'empty', ...opts });

/** A pilot joined over a LocalTransport, with every server message it was sent */
export function joinPilot(server: GameServer, username: string) {
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username } as never);
  const pid = t.getPlayerId();
  return { t, got, pid, conn: server.pilots.connOf(pid)! };
}

/** Step the server n ticks */
export const stepServer = (server: GameServer, n = 1): void => { for (let i = 0; i < n; i++) server.step(); };
