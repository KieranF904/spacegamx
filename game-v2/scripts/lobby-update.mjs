#!/usr/bin/env node
/**
 * Schedule, cancel or read the game-server update at the lobby (it calls the lobby's admin routes; nothing else).
 *
 *   LOBBY_URL=https://lobby.example LOBBY_ADMIN_SECRET=... node scripts/lobby-update.mjs schedule 15
 *   node scripts/lobby-update.mjs cancel
 *   node scripts/lobby-update.mjs status
 *
 * Awake servers hear it in their next heartbeat (10 s), warn at 15 / 5 / 1 minutes, close sign-ins for the last minute,
 * then save everyone and exit; the process manager starts the new build. Sleeping servers just start on it.
 */
const [action = 'status', minutes] = process.argv.slice(2);
const url = (process.env.LOBBY_URL || 'http://localhost:8787').replace(/\/$/, '');
const secret = process.env.LOBBY_ADMIN_SECRET || '';
if (!secret) { console.error('Set LOBBY_ADMIN_SECRET'); process.exit(2); }
if (!['schedule', 'cancel', 'status'].includes(action)) { console.error('Usage: lobby-update.mjs schedule <minutes> | cancel | status'); process.exit(2); }
const body = action === 'schedule' ? { inMinutes: Number(minutes), by: 'cli' } : {};
const r = await fetch(`${url}/admin/update/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
const out = await r.json().catch(() => ({}));
console.log(r.status, JSON.stringify(out));
process.exit(r.ok && out.success ? 0 : 1);
