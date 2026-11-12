/**
 * @contract server.admin-chat-link
 * owns:       this game server's link to the lobby for admin chat (game/AdminChat.ts): one small call that says who is
 *             on, hands over pilots' replies and failed deliveries, and brings back the admins' messages
 * needs:      fetch (injectable), AdminChat, the lobby's POST /admin/chat/poll (server-browser/src/adminchat/routes.ts)
 *             behind LOBBY_ADMIN_SECRET
 * invariants: a reply the lobby didn't take is offered again, and one it took is not sent twice — server/src/game/adminChat.test.ts
 *             with pilots on it asks every FAST_MS, with nobody on every IDLE_MS — server/src/game/adminChat.test.ts
 *             a lobby that is down or answers nonsense never throws — server/src/game/adminChat.test.ts
 * extend:     more to tell the lobby is one field in the body of pollOnce()
 */
/**
 * The game server asks; the lobby never calls in (it has no way to: game servers aren't listening for it). So an
 * admin's message waits at the lobby for the next ask: at most FAST_MS while anyone is on. Nobody on: IDLE_MS, and
 * there is nobody to write to.
 */

import type { AdminChat, AdminChatConn, AdminMessage } from './game/AdminChat.js';

/** How often the lobby is asked while pilots are on, and while nobody is */
export const FAST_MS = 2_000;
export const IDLE_MS = 10_000;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

export interface AdminChatLinkOpts { url: string; secret: string; server: string; fetch?: Fetch }

/** One ask: true when the lobby answered */
export async function pollOnce<C extends AdminChatConn>(chat: AdminChat<C>, o: AdminChatLinkOpts): Promise<boolean> {
  const f = o.fetch ?? (fetch as unknown as Fetch);
  const out = chat.outgoing();
  try {
    const r = await f(`${o.url.replace(/\/$/, '')}/admin/chat/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.secret}` },
      body: JSON.stringify({ server: o.server, online: chat.roster(), replies: out.replies, failed: out.failed, ack: chat.ack }),
      signal: AbortSignal.timeout(5000),
    });
    const j = r.ok ? await r.json() : null;
    if (!j || j.success !== true) return false;
    out.sent();
    chat.lobby(j.epoch);
    if (Array.isArray(j.messages)) for (const m of j.messages as AdminMessage[]) chat.deliver(m);
    return true;
  } catch {
    return false;
  }
}

/** How long until the next ask */
export function nextDelay<C extends AdminChatConn>(chat: AdminChat<C>): number {
  return chat.roster().length > 0 || chat.pending ? FAST_MS : IDLE_MS;
}

/** Keep asking until stop() */
export function startAdminChatLink<C extends AdminChatConn>(chat: AdminChat<C>, o: AdminChatLinkOpts): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = async () => {
    if (stopped) return;
    await pollOnce(chat, o);
    if (stopped) return;
    timer = setTimeout(() => void loop(), nextDelay(chat));
    (timer as { unref?: () => void }).unref?.();
  };
  void loop();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
