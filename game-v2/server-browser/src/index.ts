/**
 * Server Browser / Lobby Server
 * 
 * Central registry for game servers. Provides:
 * - Server registration and heartbeat
 * - Server list for clients
 * - Server stats aggregation
 * - Admin dashboard
 * - SSE for real-time updates
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

// ============================================
// CONFIGURATION
// ============================================

const PORT = parseInt(process.env.BROWSER_PORT || '8787', 10);
const TTL_MS = parseInt(process.env.BROWSER_TTL_MS || '15000', 10);
const DEBUG = process.env.BROWSER_DEBUG !== 'false';
const LOG_LIMIT = parseInt(process.env.BROWSER_LOG_LIMIT || '500', 10);
const STATS_HISTORY_LIMIT = 60;

// Pushover notifications
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || '';
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN || '';

// ============================================
// TYPES
// ============================================

interface ServerEntry {
  host: string;
  port: number;
  name: string;
  region: string;
  maxPlayers: number;
  players: number;
  secure: boolean;
  version: string;
  lastSeen: number;
  adminPort?: number;
}

interface ServerStats {
  history: Array<{
    time: number;
    playerCount: number;
    entityCount: number;
    tickTime: number;
  }>;
  latest: {
    time: number;
    tick: number;
    players: string[];
    playerCount: number;
    maxPlayers: number;
    entityCount: number;
    tickTime: number;
  } | null;
  chatHistory: Array<{
    time: number;
    player: string;
    text: string;
  }>;
}

interface LogEntry {
  time: number;
  type: string;
  message: string;
  server: string;
  data?: any;
}

// ============================================
// STATE
// ============================================

const servers = new Map<string, ServerEntry>();
const serverStats = new Map<string, ServerStats>();
const logs: LogEntry[] = [];
const sseClients = new Set<http.ServerResponse>();

// ============================================
// UTILITY FUNCTIONS
// ============================================

function now(): number {
  return Date.now();
}

function logEvent(message: string, data?: any): void {
  if (!DEBUG) return;
  const stamp = new Date().toISOString();
  if (data) {
    console.log(`[browser ${stamp}] ${message}`, data);
  } else {
    console.log(`[browser ${stamp}] ${message}`);
  }
}

function getClientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function parseJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: any): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function pushLog(entry: LogEntry): void {
  logs.push(entry);
  while (logs.length > LOG_LIMIT) {
    logs.shift();
  }
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

async function sendPushoverNotification(title: string, message: string, priority = 0): Promise<void> {
  if (!PUSHOVER_USER_KEY || !PUSHOVER_APP_TOKEN) return;
  try {
    await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: PUSHOVER_APP_TOKEN,
        user: PUSHOVER_USER_KEY,
        title,
        message,
        priority
      })
    });
  } catch {
    // Ignore pushover errors
  }
}

function cleanup(): void {
  const cutoff = now() - TTL_MS;
  let removed = 0;
  for (const [key, entry] of servers.entries()) {
    if (entry.lastSeen < cutoff) {
      servers.delete(key);
      removed += 1;
    }
  }
  if (removed) {
    logEvent(`cleanup removed ${removed} entries`);
  }
}

// ============================================
// ROUTE HANDLERS
// ============================================

async function handleRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJson(req);
    const host = body.host || getClientIp(req);
    const port = Number(body.port || 3000);
    const name = String(body.name || 'Game Server');
    const region = String(body.region || 'unknown');
    const maxPlayers = Number(body.maxPlayers || 32);
    const players = Number(body.players || 0);
    const secure = Boolean(body.secure);
    const version = String(body.version || '1.0.0');
    const adminPort = body.adminPort ? Number(body.adminPort) : undefined;
    
    const key = `${host}:${port}`;
    const isNew = !servers.has(key);
    
    servers.set(key, {
      host,
      port,
      name,
      region,
      maxPlayers,
      players,
      secure,
      version,
      lastSeen: now(),
      adminPort
    });
    
    if (isNew) {
      logEvent('server registered', { key, name, region });
      pushLog({
        time: now(),
        type: 'register',
        message: `Server "${name}" registered`,
        server: key
      });
      sendPushoverNotification('Server Online', `${name} (${region})`, -1);
    }
    
    sendJson(res, 200, { ok: true });
  } catch (err) {
    logEvent('register error', { error: String(err) });
    sendJson(res, 400, { ok: false, error: 'Invalid request' });
  }
}

function handleList(res: http.ServerResponse): void {
  cleanup();
  const list = Array.from(servers.values()).map((s) => ({
    host: s.host,
    port: s.port,
    name: s.name,
    region: s.region,
    maxPlayers: s.maxPlayers,
    players: s.players,
    secure: s.secure,
    version: s.version,
    adminPort: s.adminPort
  }));
  sendJson(res, 200, { servers: list });
}

async function handleStats(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJson(req);
    const serverName = String(body.server || 'Unknown');
    
    if (!serverStats.has(serverName)) {
      serverStats.set(serverName, {
        history: [],
        latest: null,
        chatHistory: []
      });
    }
    
    const stats = serverStats.get(serverName)!;
    
    stats.latest = {
      time: now(),
      tick: body.tick || 0,
      players: body.players || [],
      playerCount: body.playerCount || 0,
      maxPlayers: body.maxPlayers || 32,
      entityCount: body.entityCount || 0,
      tickTime: body.tickTime || 0
    };
    
    stats.history.push({
      time: now(),
      playerCount: stats.latest.playerCount,
      entityCount: stats.latest.entityCount,
      tickTime: stats.latest.tickTime
    });
    
    while (stats.history.length > STATS_HISTORY_LIMIT) {
      stats.history.shift();
    }
    
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { ok: false });
  }
}

async function handleLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await parseJson(req);
    const type = String(body.type || 'info');
    const message = String(body.message || '');
    const server = String(body.server || '');
    const data = body.data || null;
    
    const entry: LogEntry = {
      time: now(),
      type,
      message,
      server,
      data
    };
    
    pushLog(entry);
    
    // Send Pushover for player joins
    if (type === 'join' && data?.name) {
      sendPushoverNotification(`${server}: Player Joined`, data.name, -1);
    }
    
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 400, { ok: false });
  }
}

function handleStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
}

function handleHealth(res: http.ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    now: now(),
    servers: servers.size
  });
}

function handleGetAllStats(res: http.ServerResponse): void {
  const result: Record<string, any> = {};
  for (const [name, stats] of serverStats) {
    result[name] = stats.latest;
  }
  sendJson(res, 200, { ok: true, servers: result });
}

function handleLogs(res: http.ServerResponse): void {
  sendJson(res, 200, { ok: true, logs });
}

// ============================================
// SERVER BROWSER UI
// ============================================

function renderServerBrowserPage(): string {
  cleanup();
  const serverList = Array.from(servers.values());
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Space Game - Server Browser</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #0a0a12 0%, #1a1a2e 100%);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 40px 20px;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    h1 {
      text-align: center;
      color: #8af;
      margin-bottom: 10px;
      font-size: 2.5rem;
      text-shadow: 0 0 20px rgba(136, 170, 255, 0.3);
    }
    .subtitle {
      text-align: center;
      color: #666;
      margin-bottom: 40px;
    }
    .server-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .server-card {
      background: rgba(30, 30, 50, 0.9);
      border: 1px solid rgba(100, 100, 150, 0.3);
      border-radius: 12px;
      padding: 20px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: all 0.2s;
      cursor: pointer;
    }
    .server-card:hover {
      background: rgba(40, 40, 70, 0.95);
      border-color: rgba(136, 170, 255, 0.4);
      transform: translateY(-2px);
    }
    .server-info h2 {
      color: #fff;
      font-size: 1.3rem;
      margin-bottom: 6px;
    }
    .server-meta {
      display: flex;
      gap: 16px;
      color: #888;
      font-size: 0.85rem;
    }
    .server-meta span {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .server-right {
      display: flex;
      align-items: center;
      gap: 20px;
    }
    .server-players {
      font-size: 1.8rem;
      color: #4f8;
      font-weight: bold;
    }
    .server-players span {
      font-size: 1rem;
      color: #666;
    }
    .join-btn {
      padding: 12px 28px;
      background: linear-gradient(135deg, #4a8 0%, #38a 100%);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 1rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .join-btn:hover {
      background: linear-gradient(135deg, #5b9 0%, #49b 100%);
      transform: scale(1.05);
    }
    .no-servers {
      text-align: center;
      color: #666;
      padding: 60px;
      background: rgba(30, 30, 50, 0.5);
      border-radius: 12px;
    }
    .no-servers h3 {
      font-size: 1.5rem;
      margin-bottom: 10px;
      color: #888;
    }
    .refresh-btn {
      display: block;
      margin: 30px auto 0;
      padding: 12px 30px;
      background: transparent;
      border: 1px solid #4a8;
      color: #4a8;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      transition: all 0.2s;
    }
    .refresh-btn:hover {
      background: rgba(68, 136, 136, 0.1);
    }
    .region-tag {
      background: rgba(136, 170, 255, 0.2);
      color: #8af;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Space Game</h1>
    <p class="subtitle">Select a server to join</p>
    
    <div class="server-list">
      ${serverList.length === 0 ? `
        <div class="no-servers">
          <h3>No servers online</h3>
          <p>Check back later or start your own server!</p>
        </div>
      ` : serverList.map(s => `
        <div class="server-card" onclick="joinServer('${s.host}', ${s.port}, ${s.secure})">
          <div class="server-info">
            <h2>${escapeHtml(s.name)}</h2>
            <div class="server-meta">
              <span class="region-tag">${escapeHtml(s.region)}</span>
              <span>v${escapeHtml(s.version)}</span>
              <span>${s.secure ? '🔒 Secure' : '🔓 Insecure'}</span>
            </div>
          </div>
          <div class="server-right">
            <div class="server-players">${s.players}<span>/${s.maxPlayers}</span></div>
            <button class="join-btn">Join</button>
          </div>
        </div>
      `).join('')}
    </div>
    
    <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
  </div>
  
  <script>
    function joinServer(host, port, secure) {
      const proto = secure ? 'wss' : 'ws';
      const gameUrl = \`/play?server=\${encodeURIComponent(host)}:\${port}&secure=\${secure}\`;
      window.location.href = gameUrl;
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================
// MAIN HTTP SERVER
// ============================================

const server = http.createServer(async (req, res) => {
  setCors(res);
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const url = req.url?.split('?')[0] || '/';
  
  try {
    // Server registration (from game servers)
    if (req.method === 'POST' && url === '/register') {
      await handleRegister(req, res);
      return;
    }
    
    // Server list (for clients)
    if (req.method === 'GET' && url === '/list') {
      handleList(res);
      return;
    }
    
    // Stats submission (from game servers)
    if (req.method === 'POST' && url === '/stats') {
      await handleStats(req, res);
      return;
    }
    
    // Get all stats
    if (req.method === 'GET' && url === '/stats/all') {
      handleGetAllStats(res);
      return;
    }
    
    // Log submission (from game servers)
    if (req.method === 'POST' && url === '/log') {
      await handleLog(req, res);
      return;
    }
    
    // Get logs
    if (req.method === 'GET' && url === '/logs') {
      handleLogs(res);
      return;
    }
    
    // SSE stream
    if (req.method === 'GET' && url === '/stream') {
      handleStream(req, res);
      return;
    }
    
    // Health check
    if (req.method === 'GET' && url === '/health') {
      handleHealth(res);
      return;
    }
    
    // Main page - server browser
    if (req.method === 'GET' && (url === '/' || url === '/browser')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderServerBrowserPage());
      return;
    }
    
    // 404
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('Request error:', err);
    sendJson(res, 500, { error: 'Internal error' });
  }
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
  console.log(`🌐 Server Browser started on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /           - Server browser UI`);
  console.log(`     GET  /list       - JSON server list`);
  console.log(`     POST /register   - Register a game server`);
  console.log(`     POST /stats      - Submit server stats`);
  console.log(`     GET  /stats/all  - Get all server stats`);
  console.log(`     POST /log        - Submit log entry`);
  console.log(`     GET  /logs       - Get all logs`);
  console.log(`     GET  /stream     - SSE log stream`);
  console.log(`     GET  /health     - Health check`);
});

// Periodic cleanup
setInterval(cleanup, 5000);
