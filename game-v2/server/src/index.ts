/**
 * Server Entry Point
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GameServer } from './GameServer.js';
import { AdminServer } from './AdminServer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataPath = join(__dirname, '../../data');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || '3001', 10);
const DEV_MODE = process.env.NODE_ENV !== 'production';
const SERVER_NAME = process.env.SERVER_NAME || 'Local Dev Server';
const SERVER_REGION = process.env.SERVER_REGION || 'local';
const BROWSER_URL = process.env.BROWSER_URL || 'https://spacegame-v2.fly.dev';
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'localhost';

console.log('Starting Space Game Server v2...');
console.log(`Data path: ${dataPath}`);
console.log(`Mode: ${DEV_MODE ? 'DEVELOPMENT' : 'PRODUCTION'}`);

// Start admin server (both dev and production for live editing)
let adminServer: AdminServer | null = null;
adminServer = new AdminServer(ADMIN_PORT);
console.log(`Admin server running on port ${ADMIN_PORT}`);

const gameServer = new GameServer(PORT, dataPath, adminServer);

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
