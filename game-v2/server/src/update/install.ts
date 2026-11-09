/**
 * @contract server.update.install
 * owns:       wiring the update countdown into a running server: its host (chat, banner, exit), the heartbeat's identity fields, the /update admin command, the lobby call
 * needs:      GameServer, net/ClientConnection, common/network (PROTOCOL_VERSION), update/UpdateCountdown
 * invariants: with no lobby answer or no schedule nothing happens: a one-server setup behaves as before — server/src/update/countdown.test.ts
 *             /update asks the lobby (behind LOBBY_ADMIN_SECRET); the game server never schedules by itself — server/src/update/countdown.test.ts
 * extend:     a new /update word is a branch in updateAdmin
 */

import { PROTOCOL_VERSION } from '@space-game/common';
import type { GameServer } from '../GameServer.js';
import type { ClientConnection } from '../net/ClientConnection.js';
import { UpdateCountdown, type UpdateHost } from './UpdateCountdown.js';

/** The build this process runs: BUILD_ID (the deploy sets it, e.g. the git commit), else the package version */
export function buildId(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BUILD_ID || env.GIT_COMMIT || env.npm_package_version || '2.0.0').slice(0, 40);
}

/** The fields a heartbeat adds so the lobby can match this server to its definition and filter by version */
export function heartbeatIdentity(env: NodeJS.ProcessEnv = process.env): { serverId?: string; protocol: number; build: string } {
  return { ...(env.SERVER_ID ? { serverId: env.SERVER_ID } : {}), protocol: PROTOCOL_VERSION, build: buildId(env) };
}

/** The countdown's host on a real server: chat and banner to every client, exit through the server's own shutdown (which saves everyone) */
export function updateHost(gs: GameServer, exit: (code: number) => void | Promise<void>): UpdateHost {
  return {
    now: () => Date.now(),
    say: (text) => { for (const c of gs.clients.values()) gs.send(c.ws, { type: 'systemMessage', text: `📢 ${text}`, color: '#fbbf24' }); },
    banner: (inMs) => { for (const c of gs.clients.values()) gs.send(c.ws, { type: 'serverUpdate', inMs }); },
    exit,
    log: (t) => console.log(`[update] ${t}`),
  };
}

export interface LobbyLink { url: string; secret: string }

/** One call to the lobby's admin update routes */
export async function lobbyUpdate(link: LobbyLink, action: 'schedule' | 'cancel' | 'status', body: Record<string, unknown> = {}): Promise<{ success: boolean; error?: string; inMs?: number; scheduled?: boolean; cancelled?: boolean }> {
  try {
    const r = await fetch(`${link.url}/admin/update/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.secret}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return (await r.json()) as Awaited<ReturnType<typeof lobbyUpdate>>;
  } catch {
    return { success: false, error: "Can't reach the lobby" };
  }
}

const USAGE = 'Usage: /update <minutes> (schedule a restart, at least 1) · /update cancel · /update (the schedule)';

/**
 * The admin `/update` chat command. It asks the lobby, which tells every awake server in its next heartbeat answer (so it
 * takes up to 10 s to start), then answers the admin when the lobby has
 */
export function installUpdateAdmin(gs: GameServer, link: LobbyLink, fetcher: typeof lobbyUpdate = lobbyUpdate): void {
  gs.admin.extensions.set('update', (c, words) => {
    if (!link.secret) return { ok: false, text: "No LOBBY_ADMIN_SECRET here: schedule it at the lobby (scripts/lobby-update.mjs)" };
    const conn = c as unknown as ClientConnection;
    const reply = (ok: boolean, text: string) => gs.send(conn.ws, { type: 'adminResult', ok, text } as never);
    const sub = (words[0] ?? '').toLowerCase();
    if (sub === 'cancel') {
      void fetcher(link, 'cancel').then((r) => reply(r.success, r.success ? (r.cancelled ? 'Update cancelled' : 'No update was scheduled') : r.error ?? 'Failed'));
    } else if (sub === '') {
      void fetcher(link, 'status').then((r) => reply(r.success, !r.success ? r.error ?? 'Failed' : r.scheduled ? `Update in ${Math.ceil((r.inMs ?? 0) / 60_000)} min` : 'No update scheduled'));
    } else {
      const minutes = Number(sub.replace(/m$/, ''));
      if (!Number.isFinite(minutes) || minutes < 1) return { ok: false, text: USAGE };
      void fetcher(link, 'schedule', { inMinutes: minutes, by: conn.username }).then((r) => reply(r.success, r.success ? `Update scheduled in ${minutes} min (servers hear within 10 s)` : r.error ?? 'Failed'));
    }
    return { ok: true, text: 'Asking the lobby...' };
  });
}

/** Everything in one call: the countdown, its once-a-second tick, the join gate and /update. Returns it for the heartbeat to feed */
export function installUpdate(gs: GameServer, link: LobbyLink, exit: (code: number) => void | Promise<void>): UpdateCountdown {
  const countdown = new UpdateCountdown(updateHost(gs, exit));
  gs.joinGate = () => countdown.joinRefusal();
  setInterval(() => countdown.tick(), 1000).unref();
  installUpdateAdmin(gs, link);
  return countdown;
}
