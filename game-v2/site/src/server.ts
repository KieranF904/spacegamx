/**
 * The website's server: `npm run dev` (watch) or `npm start` in site/.
 * See src/config.ts for settings and src/app.ts for the routes.
 */

import http from 'http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { HttpLobby } from './lobby.js';
import { FilePilotSource } from './pilots.js';
import { createSiteStore } from './store/index.js';
import { Uploads } from './uploads.js';

const cfg = loadConfig();
const store = await createSiteStore(cfg.dataDir);
const app = createApp({
  cfg,
  store,
  lobby: new HttpLobby(cfg.lobbyUrl, cfg.lobbyAdminSecret),
  pilots: new FilePilotSource(cfg.profilesDir, cfg.statusFile),
  uploads: new Uploads(cfg.dataDir),
});

const server = http.createServer((req, res) => void app.handle(req, res));
server.on('upgrade', (req, socket, head) => app.upgrade(req, socket, head));
server.listen(cfg.port, cfg.host, () => {
  console.log(`[Site] ${cfg.name} on ${cfg.origin} (listening ${cfg.host}:${cfg.port}; lobby ${cfg.lobbyUrl}; game: ${cfg.game.mode}${cfg.game.mode === 'proxy' ? ` via ${cfg.game.devUrl}` : ''})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    app.close();
    server.close();
    void store.close().finally(() => process.exit(0));
  });
}
