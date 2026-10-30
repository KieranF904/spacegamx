/**
 * Server Entry Point
 */

import { join, dirname } from 'path';
import { appendFile, mkdir, writeFile, rename } from 'fs/promises';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer.js';
import { AdminServer } from './AdminServer.js';
import { createUserStore } from './auth/index.js';
import { readGameDataFiles } from './data/loadGameDataFromDisk.js';
import { GameData } from './data/GameData.js';
import { withDevData, devGuestShips } from './data/devData.js';
import { checkGameData } from './data/validateGameData.js';
import { SocketTransport } from './net/SocketTransport.js';
import { loadShipConfigFromDisk } from './ships/loadShipConfig.js';
import { createShipBridge } from './proto/createProtoServer.js';
import { createProfileStore } from './profile/index.js';
import { contribFileStore } from './game/contribFiles.js';

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

// Start admin server (both dev and production for live editing)
let adminServer: AdminServer | null = null;
adminServer = new AdminServer(ADMIN_PORT);
console.log(`Admin server running on port ${ADMIN_PORT}`);

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
  // Guests are admins on the dev server (never in production: GameServer refuses it there too)
  guestAdmin: DEV_MODE,
  // Admins may build anything in the hangar for free (the admin panel's switch; never in production: GameServer refuses it there too)
  freeBuild: DEV_MODE,
  // ...and find these designs in their hangar (data/ships/blueprints/dev/guest-*.json)
  guestShips: DEV_MODE ? devGuestShips(dataPath) as never : undefined,
  // Where new pilots die and what they get done in their first hour (data/telemetry/, kept between deploys)
  telemetry: telemetryFile(join(dataPath, 'telemetry', 'pilots.jsonl')),
  // Contributor notes and who has the rank (data/contributor/, kept between deploys)
  contributorStore: contribFileStore(join(dataPath, 'contributor')),
});
new SocketTransport(gameServer, PORT);

// How it's running, every 2 s, for the box's resource monitor (deploy/vps/monitor): written whole, then swapped in
const statusDir = join(dataPath, 'status');
setInterval(() => {
  const file = join(statusDir, 'live.json'), tmp = `${file}.tmp`;
  void mkdir(statusDir, { recursive: true })
    .then(() => writeFile(tmp, JSON.stringify({ t: Date.now(), ...gameServer.liveStatus() }), { mode: 0o644 }))
    .then(() => rename(tmp, file))
    .catch(() => {});
}, 2000).unref();

// Save every pilot before exiting (systemd stop, Ctrl+C)
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: saving pilots...`);
  try {
    await gameServer.saveAll();
    await profileStore.close();
    await userStore.close();
  } catch (e) {
    console.error('Shutdown save failed:', e);
  }
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

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
