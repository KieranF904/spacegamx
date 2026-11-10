/**
 * Server Entry Point
 */

import { join, dirname } from 'path';
import { appendFile, mkdir, writeFile, rename } from 'fs/promises';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer.js';
import { devAuthOn } from './auth/devAuth.js';
import { createUserStore } from './auth/index.js';
import { readGameDataFiles } from './data/loadGameDataFromDisk.js';
import { GameData } from './data/GameData.js';
import { withDevData, devGuestShips } from './data/devData.js';
import { SocketTransport } from './net/SocketTransport.js';
import { loadShipConfigFromDisk } from './ships/loadShipConfig.js';
import { createShipBridge } from './ships/createShipBridge.js';
import { createProfileStore } from './profile/index.js';
import { contribFileStore } from './game/contribFiles.js';
import { worldFileStore } from './game/SystemMemory.js';
import { BotManager } from './bots/index.js';
import { installRockeryTools } from './bots/rockeryTools.js';
import { activity } from './activity/index.js';
import { LobbyFriends } from './game/social/LobbyFriends.js';
import { LobbyRankings } from './game/rankings/RankingsBackend.js';
import { heartbeatIdentity, installUpdate } from './update/install.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, '../../data');

const PORT = parseInt(process.env.PORT || '3000', 10);
/** The address it listens on: every interface unless HOST says (the VPS unit: 127.0.0.1, behind nginx) */
const HOST = process.env.HOST || undefined;
const DEV_MODE = process.env.NODE_ENV !== 'production';
// The dev Rockery start (every pilot joins in data/dev/rockery.json): dev only, and only with DEV_START=rockery; it replaces the training yard
const DEV_ROCKERY = DEV_MODE && process.env.DEV_START === 'rockery';
// The training yard for new pilots (game/tutorial): on everywhere (dev too) unless TUTORIAL=0 or the dev Rockery start is chosen
const TUTORIAL_ON = !DEV_ROCKERY && process.env.TUTORIAL !== '0';
const SERVER_NAME = process.env.SERVER_NAME || 'Local dev';
const SERVER_REGION = process.env.SERVER_REGION || 'local';
const BROWSER_URL = process.env.BROWSER_URL || 'http://localhost:8787';
/** Shared with the lobby: lets the admin tools manage accounts (ranks, bans). Dev lobbies share a fixed one */
const LOBBY_ADMIN_SECRET = process.env.LOBBY_ADMIN_SECRET || (devAuthOn() ? 'dev-lobby-admin-secret' : '');
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';

console.log('Starting Space Game Server v2...');
console.log(`Data path: ${dataPath}`);
console.log(`Mode: ${DEV_MODE ? 'DEVELOPMENT' : 'PRODUCTION'}`);

// Accounts: the lobby keeps them (one account for every server); we ask it
const userStore = createUserStore(BROWSER_URL, LOBBY_ADMIN_SECRET);
if (!LOBBY_ADMIN_SECRET) console.log("LOBBY_ADMIN_SECRET isn't set: the admin tools can't change admin ranks or ban players, and friends are kept in memory only");
// Pilots' progress: same backend switch (data/profiles/ by default)
const profileStore = await createProfileStore(dataPath);

// The data files, read once (in development, with the dev-only rock system: data/dev/rockery.json), and checked once:
// every file against the others, ship designs included (so the GameData built on them doesn't check them again)
const shipConfig = loadShipConfigFromDisk(dataPath);
const gameDataFiles = withDevData(readGameDataFiles(dataPath), dataPath);
GameData.checkFiles(gameDataFiles, { ships: shipConfig });

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
  gameData: new GameData(gameDataFiles),
  userDB: userStore,
  ships: createShipBridge(shipConfig),
  profileStore,
  // Friends and status live per account in the lobby, so they follow the account to every server (game/social).
  // Without the lobby's secret they're kept in memory only (lost at restart)
  // Rankings are central too: every pilot's ranked stats are reported to the lobby, which ranks all servers together
  rankings: LOBBY_ADMIN_SECRET ? new LobbyRankings(BROWSER_URL, LOBBY_ADMIN_SECRET) : undefined,
  serverName: SERVER_NAME,
  friends: LOBBY_ADMIN_SECRET ? new LobbyFriends(BROWSER_URL, LOBBY_ADMIN_SECRET) : undefined,
  devTeleport: DEV_MODE,
  // Everyone (guests and signed-in pilots) is an admin on the dev server (never in production: GameServer refuses it there too)
  guestAdmin: DEV_MODE,
  // Crowd fallbacks (net/crowd/CrowdControl.ts): every client takes them (the full caps set is required at join)
  crowd: true,
  // Admins may build anything in the hangar for free (the admin panel's switch; never in production: GameServer refuses it there too)
  freeBuild: DEV_MODE,
  // Every pilot joins and respawns in the dev Rockery (data/dev/rockery.json), not Sol (never in production: GameServer refuses it there too)
  devStart: DEV_ROCKERY ? 'dev_rockery' : undefined,
  tutorial: TUTORIAL_ON,
  // ...and find these designs in their hangar (data/ships/blueprints/dev/guest-*.json)
  guestShips: DEV_MODE ? devGuestShips(dataPath) as never : undefined,
  // Where new pilots die and what they get done in their first hour (data/telemetry/, kept between deploys)
  telemetry: telemetryFile(join(dataPath, 'telemetry', 'pilots.jsonl')),
  // Contributor notes and who has the rank (data/contributor/, kept between deploys)
  contributorStore: contribFileStore(join(dataPath, 'contributor')),
  // What's alive, dead and due back in every system, so a restart picks the world up where it was (data/world/, kept between deploys)
  worldStore: worldFileStore(join(dataPath, 'world', 'memory.json')),
});
// Dev-only player bots (docs/areas/bots.md): `/bot spawn mine-and-deposit 1 npc` in chat as an admin, or BOTS=mine-and-deposit:1:client
// (task:count:driver, comma separated) at start. Never in production: BotManager refuses to exist there.
if (DEV_MODE) {
  const bots = new BotManager(gameServer, { statsDir: join(__dirname, '..', 'stats', 'bots') });
  // The Rockery spawn tools (client F7 panel): drones, a still dummy, bot players on random flight (docs/areas/bots.md)
  installRockeryTools(gameServer, bots);
  for (const spec of (process.env.BOTS ?? '').split(',').filter(Boolean)) {
    const [task, n, kind] = spec.split(':');
    for (let i = 0; i < Math.max(1, Number(n) || 1); i++) bots.spawn(task, kind === 'npc' ? 'npc' : 'client');
  }
}
// Player activity for the website's admin panel, sent to the lobby in batches under SERVER_NAME (server/src/activity);
// it needs the lobby's admin secret, and ACTIVITY_FEED=0 turns it off. ACTIVITY_TYPES picks the event types
// (default: sign-ins, joins/leaves, public chat and the operational ones; e.g. "+death,+boss_kill" or "all")
if (LOBBY_ADMIN_SECRET && process.env.ACTIVITY_FEED !== '0') {
  activity.start({ url: BROWSER_URL, secret: LOBBY_ADMIN_SECRET, server: SERVER_NAME, types: process.env.ACTIVITY_TYPES });
  activity.watch(gameServer.pilots);
}
const transport = new SocketTransport(gameServer, PORT, HOST);

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
    // (The last activity lines, best effort: 2 s at most)
    await activity.stop(2000).catch(() => {});
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

// A scheduled update (the lobby tells us in the heartbeat answer): warnings, a join block, then save everyone and exit
// with UPDATE_EXIT_CODE so the process manager starts the new build (systemd Restart=always)
const updates = installUpdate(gameServer, { url: BROWSER_URL, secret: LOBBY_ADMIN_SECRET }, (code) => shutdown('update', code));

// Register with server browser
async function registerWithBrowser() {
  // In production nginx takes the game's socket on 443 (TLS) and passes it to PORT on 127.0.0.1
  const publicPort = DEV_MODE ? PORT : 443;
  
  try {
    const response = await fetch(`${BROWSER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(LOBBY_ADMIN_SECRET ? { Authorization: `Bearer ${LOBBY_ADMIN_SECRET}` } : {}) },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        host: PUBLIC_HOST,
        port: publicPort,
        name: SERVER_NAME,
        region: SERVER_REGION,
        maxPlayers: 32,
        players: gameServer.getPlayerCount(),
        secure: !DEV_MODE,
        version: '2.0.0',
        // (Who this is and what it runs: the lobby matches it to its definition, and offers it only to clients on this protocol)
        ...heartbeatIdentity()
      })
    });
    if (response.ok) {
      console.log('✓ Registered with server browser');
      // Accounts deleted at the lobby: their profiles go here
      const body = await response.json().catch(() => null) as { deletedAccounts?: unknown; update?: { inMs: number } } | null;
      // The lobby's schedule for a server update (none: nothing, or called off): see update/UpdateCountdown.ts
      if (body) updates.onLobby(body.update);
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
