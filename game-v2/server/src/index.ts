/**
 * Server Entry Point
 */

import { join, dirname } from 'path';
import { appendFile, mkdir, writeFile, rename } from 'fs/promises';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer.js';
import { AdminServer, adminPassword } from './AdminServer.js';
import { createUserStore } from './auth/index.js';
import { readGameDataFiles } from './data/loadGameDataFromDisk.js';
import { GameData } from './data/GameData.js';
import { withDevData, devGuestShips, loadRangeConfig } from './data/devData.js';
import { checkGameData } from './data/validateGameData.js';
import { SocketTransport } from './net/SocketTransport.js';
import { loadShipConfigFromDisk } from './ships/loadShipConfig.js';
import { createShipBridge } from './proto/createProtoServer.js';
import { createProfileStore } from './profile/index.js';
import { contribFileStore } from './game/contribFiles.js';
import { worldFileStore } from './game/SystemMemory.js';
import { CAPS } from '@space-game/common';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, '../../data');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3005', 10);
const DEV_MODE = process.env.NODE_ENV !== 'production';
const SERVER_NAME = process.env.SERVER_NAME || 'Local Dev Server';
const SERVER_REGION = process.env.SERVER_REGION || 'local';
const BROWSER_URL = process.env.BROWSER_URL || 'http://localhost:8787';
/** Shared with the lobby: lets the admin tools manage accounts (ranks, bans). Dev lobbies share a fixed one */
const LOBBY_ADMIN_SECRET = process.env.LOBBY_ADMIN_SECRET || (DEV_MODE ? 'dev-lobby-admin-secret' : '');
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';

console.log('Starting Space Game Server v2...');
console.log(`Data path: ${dataPath}`);
console.log(`Mode: ${DEV_MODE ? 'DEVELOPMENT' : 'PRODUCTION'}`);

// Start admin server (both dev and production for live editing), with a password from the environment
// (adminPassword: development falls back to 'admin'; production has none, so without one it stays off)
let adminServer: AdminServer | null = null;
const ADMIN_PASSWORD = adminPassword();
if (ADMIN_PASSWORD) {
  adminServer = new AdminServer(ADMIN_PORT, ADMIN_PASSWORD);
  console.log(`Admin server running on port ${ADMIN_PORT}`);
} else {
  console.log("Admin server not started: no ADMIN_SERVER_PASSWORD, ADMIN_PASSWORD or LOBBY_ADMIN_SECRET is set (production has no default password)");
}

// Accounts: the lobby keeps them (one account for every server); we ask it
const userStore = createUserStore(BROWSER_URL, LOBBY_ADMIN_SECRET);
if (!LOBBY_ADMIN_SECRET) console.log("LOBBY_ADMIN_SECRET isn't set: the admin tools can't change admin ranks or ban players");
// Pilots' progress: same backend switch (data/profiles/ by default)
const profileStore = await createProfileStore(dataPath);

// Every data file checked against the others, ship designs included (GameData checks the rest alone)
const shipConfig = loadShipConfigFromDisk(dataPath);
checkGameData(readGameDataFiles(dataPath), { ships: shipConfig });

/** Appends telemetry lines to a file, making its folder the first time */
function telemetryFile(file: string): (lines: string) => Promise<void> {
  let ready: Promise<unknown> | null = null;
  return async (lines) => {
    ready ??= mkdir(dirname(file), { recursive: true });
    await ready;
    await appendFile(file, lines);
  };
}

const gameServer = new GameServer({
  // (in development, with the dev-only rock system: data/dev/rockery.json)
  gameData: new GameData(DEV_MODE ? withDevData(readGameDataFiles(dataPath), dataPath) : readGameDataFiles(dataPath)),
  userDB: userStore,
  adminServer,
  ships: createShipBridge(shipConfig),
  profileStore,
  devTeleport: DEV_MODE,
  // The dev weapons range (data/dev/range.json; never in production: GameServer refuses it there too)
  devRange: DEV_MODE ? loadRangeConfig(dataPath) : undefined,
  // Everyone (guests and signed-in pilots) is an admin on the dev server (never in production: GameServer refuses it there too)
  guestAdmin: DEV_MODE,
  // Confirmed hits, client-detected hits, bit-packed frames and coalescing for clients that offer them
  // (docs/design/confirmed-hits.md parts C, D, E; docs/design/packed-frames.md): the dev server; NET_CAPS (a bit mask: 1
  // confirmed, 2 client-detected, 4 packed, 8 coalesced, 16 own shots as fire events, 32 adaptive validation, 64 its own ship
  // stepped by itself, 128 compact inputs; 255 all) elsewhere
  netCaps: process.env.NET_CAPS !== undefined ? Number(process.env.NET_CAPS) || 0 : DEV_MODE ? CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.INPUTS | CAPS.BODIES | CAPS.BLOCKS | CAPS.FOCUS | CAPS.CAUSES | CAPS.WAYPOINTS | CAPS.PILOTS | CAPS.CROWD : 0,
  // Admins may build anything in the hangar for free (the admin panel's switch; never in production: GameServer refuses it there too)
  freeBuild: DEV_MODE,
  // Every pilot joins and respawns in the dev Rockery (data/dev/rockery.json), not Sol (never in production: GameServer refuses it there too)
  devStart: DEV_MODE ? 'dev_rockery' : undefined,
  // ...and find these designs in their hangar (data/ships/blueprints/dev/guest-*.json)
  guestShips: DEV_MODE ? devGuestShips(dataPath) as never : undefined,
  // Where new pilots die and what they get done in their first hour (data/telemetry/, kept between deploys)
  telemetry: telemetryFile(join(dataPath, 'telemetry', 'pilots.jsonl')),
  // Contributor notes and who has the rank (data/contributor/, kept between deploys)
  contributorStore: contribFileStore(join(dataPath, 'contributor')),
  // What's alive, dead and due back in every system, so a restart picks the world up where it was (data/world/, kept between deploys)
  worldStore: worldFileStore(join(dataPath, 'world', 'memory.json')),
});
const transport = new SocketTransport(gameServer, PORT);

// How it's running, every 2 s, for the box's resource monitor (deploy/vps/monitor): written whole, then swapped in
const statusDir = join(dataPath, 'status');
setInterval(() => {
  const file = join(statusDir, 'live.json'), tmp = `${file}.tmp`;
  void mkdir(statusDir, { recursive: true })
    .then(() => writeFile(tmp, JSON.stringify({ t: Date.now(), ...gameServer.liveStatus() }), { mode: 0o644 }))
    .then(() => rename(tmp, file))
    .catch(() => {});
}, 2000).unref();

// Save every pilot before exiting (systemd stop, Ctrl+C). systemd waits 90 s (TimeoutStopSec) before it
// kills the process; the saves are given SHUTDOWN_SAVE_MS of that, so a hung store can't keep it from exiting.
const SHUTDOWN_SAVE_MS = 20_000;
let shuttingDown = false;
async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: saving pilots...`);
  // No new pilots while the last ones are saved
  try { transport.stopAccepting(); } catch { /* already closed */ }
  const deadline = new Promise<'late'>((r) => setTimeout(() => r('late'), SHUTDOWN_SAVE_MS).unref());
  try {
    const saved = await Promise.race([
      (async () => {
        // (The stores are closed, so their writes in flight finish, even if a save failed)
        let failed: unknown = null;
        await gameServer.saveAll().catch((e) => { failed = e; });
        await profileStore.close().catch((e) => { failed ??= e; });
        await userStore.close().catch((e) => { failed ??= e; });
        if (failed) throw failed;
        return 'ok' as const;
      })(),
      deadline,
    ]);
    if (saved === 'late') console.error(`Shutdown: saves still running after ${SHUTDOWN_SAVE_MS / 1000} s; exiting anyway`);
    else console.log('Shutdown: everything saved');
  } catch (e) {
    console.error('Shutdown save failed:', e);
    code ||= 1;
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A promise nobody waited on failed: logged loudly, and the server goes on (the game state isn't
// touched halfway by these: they're saves, lobby calls and timers, each on its own)
process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandled promise rejection (kept running):', reason);
});
// Something threw outside every guard (the tick, the messages and the sockets each have their own):
// the process may be in a bad state, so save who we can and exit; systemd starts it again (Restart=always)
process.on('uncaughtException', (e) => {
  console.error('[Process] uncaught exception, saving and restarting:', e);
  void shutdown('uncaughtException', 1);
});

// Register with server browser
async function registerWithBrowser() {
  // In production, Fly.io routes HTTPS through port 443
  const publicPort = DEV_MODE ? PORT : 443;
  
  try {
    const response = await fetch(`${BROWSER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: PUBLIC_HOST,
        port: publicPort,
        name: SERVER_NAME,
        region: SERVER_REGION,
        maxPlayers: 32,
        players: gameServer.getPlayerCount(),
        secure: !DEV_MODE,
        version: '2.0.0',
        adminPort: ADMIN_PORT
      })
    });
    if (response.ok) {
      console.log('✓ Registered with server browser');
      // Accounts deleted at the lobby: their profiles go here
      const body = await response.json().catch(() => null) as { deletedAccounts?: unknown } | null;
      if (Array.isArray(body?.deletedAccounts)) void gameServer.forgetAccounts(body.deletedAccounts.map(Number));
    } else {
      console.log(`⚠ Browser registration failed: ${response.status}`);
    }
  } catch (err) {
    // Browser not available, that's fine for local dev
    if (DEV_MODE) {
      console.log('⚠ Server browser not available (running locally)');
    } else {
      console.log('⚠ Failed to register with browser:', err);
    }
  }
}

// Register immediately and then every 10 seconds
registerWithBrowser();
setInterval(registerWithBrowser, 10000);
