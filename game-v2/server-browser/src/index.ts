/**
 * Server Browser / Lobby Server
 * 
 * Central registry for game servers. Provides:
 * - Server registration and heartbeat
 * - Server list for clients
 */

import http from 'http';
import { AccountRoutes, DATA_DIR } from './accounts/routes.js';
import { InboxRoutes } from './inbox/routes.js';
import { ActivityRoutes } from './activity/routes.js';
import { FriendRoutes } from './friends/routes.js';
import { RankingRoutes } from './rankings/routes.js';
import { BodyError, clientIp, readJson } from './accounts/request.js';
import { MAX_SERVERS, parseHeartbeat, type ServerEntry } from './servers.js';
import { loadDefs } from './regions/defs.js';
import { askedProtocol, filterByProtocol, latestVersion, mergeServers } from './regions/merge.js';
import { UpdateRoutes } from './update/schedule.js';

// ============================================
// CONFIGURATION
// ============================================

const PORT = parseInt(process.env.BROWSER_PORT || '8787', 10);
const TTL_MS = parseInt(process.env.BROWSER_TTL_MS || '15000', 10);
const DEBUG = process.env.BROWSER_DEBUG !== 'false';
// Pushover notifications
const PUSHOVER_USER_KEY = process.env.PUSHOVER_USER_KEY || '';
const PUSHOVER_APP_TOKEN = process.env.PUSHOVER_APP_TOKEN || '';

// ============================================
// STATE
// ============================================

const servers = new Map<string, ServerEntry>();

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

/** (X-Forwarded-For only believed from this machine: see clientIp) */
const getClientIp = clientIp;

/** A JSON object body, at most 64 KB (BodyError otherwise) */
const parseJson = (req: http.IncomingMessage) => readJson(req);

/** Status for a body that couldn't be read */
function bodyStatus(err: unknown): number {
  return err instanceof BodyError ? err.status : 400;
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // (Accounts use a token in the body, never cookies, so open CORS is safe)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: any): void {
  if (res.headersSent || res.writableEnded) return;
  // (A body too large is left unread: close rather than keep reading it)
  res.writeHead(statusCode, statusCode === 413 ? { 'Content-Type': 'application/json', Connection: 'close' } : { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
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
    const beat = parseHeartbeat(body, getClientIp(req));
    if ('error' in beat) {
      sendJson(res, 400, { ok: false, error: beat.error });
      return;
    }
    const { host, port, name, region } = beat;
    
    const key = `${host}:${port}`;
    const isNew = !servers.has(key);
    if (isNew && servers.size >= MAX_SERVERS) {
      cleanup();
      if (servers.size >= MAX_SERVERS) {
        sendJson(res, 503, { ok: false, error: 'Server list is full' });
        return;
      }
    }
    
    servers.set(key, { ...beat, lastSeen: now() });
    
    if (isNew) {
      logEvent('server registered', { key, name, region });
      sendPushoverNotification('Server Online', `${name} (${region})`, -1);
    }
    
    // (Each heartbeat tells the server which accounts are gone, so it deletes their profiles)
    sendJson(res, 200, { ok: true, deletedAccounts: accounts.deletedAccounts(), update: updates.schedule.forHeartbeat() });
  } catch (err) {
    logEvent('register error', { error: String(err) });
    sendJson(res, bodyStatus(err), { ok: false, error: 'Invalid request' });
  }
}

function handleList(res: http.ServerResponse, query: string): void {
  cleanup();
  // (The defined servers merged with who's heartbeating; ?protocol=N keeps only the servers that client can talk to)
  const all = mergeServers(serverDefs, Array.from(servers.values()), process.env.NODE_ENV === 'production');
  const { servers: list, hidden } = filterByProtocol(all, askedProtocol(query));
  // (`latest`: the newest build any server runs, so an older client can ask its player to reload; `update`: ms until a scheduled restart)
  const update = updates.schedule.forHeartbeat();
  sendJson(res, 200, { servers: list, hidden, latest: latestVersion(all), ...(update ? { update } : {}) });
}

function handleHealth(res: http.ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    now: now(),
    servers: servers.size
  });
}

// ============================================
// MAIN HTTP SERVER
// ============================================

// Accounts: one for every game server (see accounts/routes.ts)
const accounts = await AccountRoutes.create(sendJson, parseJson, getClientIp);
// The player inbox: messages from admins to accounts, kept beside them (see inbox/routes.ts)
const inbox = await InboxRoutes.create(accounts.users, sendJson, parseJson, getClientIp, { adminSecret: accounts.secret, dataDir: DATA_DIR });
// Friends, friend requests and the saved status, per account: the game servers read and change them (see friends/routes.ts)
// The scheduled game-server update (see update/schedule.ts): set by an admin, learnt by the servers in their heartbeat answer
const updates = UpdateRoutes.create(DATA_DIR, sendJson, parseJson, accounts.secret);
// The game servers defined here (data/servers.json), so a sleeping one is listed too (see regions/)
const serverDefs = loadDefs(DATA_DIR);
const friends = await FriendRoutes.create(accounts.users, sendJson, parseJson, { adminSecret: accounts.secret, dataDir: DATA_DIR });
// Rankings, one row per account: the game servers report, the clients read (see rankings/routes.ts)
const rankings = await RankingRoutes.create(accounts.users, sendJson, parseJson, getClientIp, { adminSecret: accounts.secret, dataDir: DATA_DIR });
accounts.onAccountDeleted = (id) => { inbox.forgetUser(id); void friends.forgetUser(id); void rankings.forgetUser(id); };
// The player activity feed: game servers send it, the website's admin panel reads it (see activity/routes.ts)
const activity = await ActivityRoutes.create(accounts.users, sendJson, parseJson, getClientIp, {
  adminSecret: accounts.secret, dataDir: DATA_DIR, live: () => [...new Set([...servers.values()].map((s) => s.name))],
});
accounts.onActivity = (type, player, detail, other) => activity.record(type, player, detail, other);

const server = http.createServer(async (req, res) => {
  setCors(res);
  // (The activity feed's answers go only to the origins it allows)
  activity.cors(req, res, req.url?.split('?')[0] || '/');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const url = req.url?.split('?')[0] || '/';
  
  try {
    // (The inbox, the feed and friends first: their /admin/ calls would otherwise be the accounts')
    if (await activity.handle(req, res, url)) return;
    if (await inbox.handle(req, res, url)) return;
    if (await friends.handle(req, res, url)) return;
    if (await rankings.handle(req, res, url)) return;
    if (await updates.handle(req, res, url)) return;
    if (await accounts.handle(req, res, url)) return;

    // Server registration (from game servers)
    if (req.method === 'POST' && url === '/register') {
      await handleRegister(req, res);
      return;
    }
    
    // Server list (for clients)
    if (req.method === 'GET' && url === '/list') {
      handleList(res, req.url?.split('?')[1] || '');
      return;
    }
    
    // Health check
    if (req.method === 'GET' && url === '/health') {
      handleHealth(res);
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

// (BROWSER_HOST=127.0.0.1 keeps it off the network entirely, when everything that calls it is on this machine)
server.listen({ port: PORT, host: process.env.BROWSER_HOST || undefined }, () => {
  console.log(`🌐 Server Browser started on http://localhost:${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /list       - JSON server list`);
  console.log(`     POST /register   - Register a game server`);
  console.log(`     GET  /health     - Health check`);
  console.log(`     POST /auth/*     - Accounts: login, register, validate, logout, account, change-password/email, logout-all, delete-account`);
  console.log(`     POST /inbox/*    - Player inbox: list, read, delete; admins: send, sent`);
  console.log(`     POST /activity/read - Activity feed (an admin's session); game servers send to /admin/activity/ingest`);
  console.log(`     POST /admin/friends/* - Friends and status per account (game servers, behind LOBBY_ADMIN_SECRET)`);
  console.log(`     POST /admin/rankings/report|import - Ranked stats per account (game servers, behind LOBBY_ADMIN_SECRET); POST /rankings/view - the boards`);
});

// Periodic cleanup
setInterval(cleanup, 5000);

// Finish writing accounts before exiting (systemd stop, Ctrl+C)
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  activity.close()
    .catch((err) => console.error('[browser] closing the activity feed failed:', err))
    .then(() => inbox.close())
    .catch((err) => console.error('[browser] closing the inbox failed:', err))
    .then(() => friends.close())
    .catch((err) => console.error('[browser] closing the friends lists failed:', err))
    .then(() => rankings.close())
    .catch((err) => console.error('[browser] closing the rankings failed:', err))
    .then(() => accounts.close())
    .catch((err) => console.error('[browser] closing the accounts failed:', err))
    .finally(() => process.exit(code));
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => stop(0));
}
// One bad request (or a lost database) mustn't take the lobby down unseen: a stray rejection is logged;
// a thrown error leaves the process in an unknown state, so save and exit (systemd starts it again)
process.on('unhandledRejection', (err) => console.error('[browser] unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  console.error('[browser] uncaught exception:', err);
  stop(1);
});
