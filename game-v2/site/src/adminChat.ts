/**
 * The website's side of admin chat: its calls to the lobby (server-browser/src/adminchat/routes.ts) with
 * LOBBY_ADMIN_SECRET, made here on the server so a browser never has the secret. Each names the signed-in admin as
 * `actor`; the lobby checks that name is an admin's. Never throws.
 */

export interface OnlinePilot { name: string; guest: boolean; since: number }
export interface ChatServer { name: string; fresh: boolean; online: OnlinePilot[] }
export interface ChatMessage { id: number; at: number; server: string; direction: 'out' | 'in'; admin: string; pilot: string; text: string; status: string }
export interface ChatState { servers: ChatServer[]; messages: ChatMessage[] }
export type SendResult = { ok: true } | { ok: false; error: string; offline?: boolean; status: number };

export interface AdminChatApi {
  state(actor: string, q: { server?: string; with?: string }): Promise<ChatState | null>;
  send(actor: string, server: string, to: string, text: string): Promise<SendResult>;
  inbox(actor: string, to: string, text: string): Promise<SendResult>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const UNAVAILABLE = "The lobby isn't answering. Try again in a moment.";

export function httpAdminChat(lobbyUrl: string, adminSecret: string, f: Fetch = fetch as unknown as Fetch): AdminChatApi {
  const call = async (path: string, body: object): Promise<{ status: number; body: any }> => {
    if (!adminSecret) return { status: 503, body: { success: false, error: "LOBBY_ADMIN_SECRET isn't set, so admin chat is off." } };
    try {
      const r = await f(`${lobbyUrl}/admin/chat/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      let parsed: any = null;
      try { parsed = await r.json(); } catch { /* not JSON */ }
      return { status: r.status, body: parsed };
    } catch {
      return { status: 503, body: null };
    }
  };
  const result = (r: { status: number; body: any }): SendResult =>
    (r.status === 200 && r.body?.success === true ? { ok: true } : { ok: false, error: text(r.body?.error, 200) || UNAVAILABLE, status: r.status, ...(r.body?.offline === true ? { offline: true } : {}) });
  return {
    async state(actor, q) {
      const r = await call('state', { actor, ...(q.server ? { server: q.server } : {}), ...(q.with ? { with: q.with } : {}) });
      const b = r.body;
      if (r.status !== 200 || b?.success !== true || !Array.isArray(b.servers) || !Array.isArray(b.messages)) return null;
      return {
        servers: b.servers.filter((s: any) => s && typeof s.name === 'string').map((s: any) => ({
          name: text(s.name, 64), fresh: s.fresh === true,
          online: (Array.isArray(s.online) ? s.online : []).filter((p: any) => p && typeof p.name === 'string' && p.name).map((p: any) => ({ name: text(p.name, 40), guest: p.guest === true, since: num(p.since) })),
        })),
        messages: b.messages.filter((m: any) => m && typeof m === 'object').map((m: any) => ({
          id: num(m.id), at: num(m.at), server: text(m.server, 64), direction: m.direction === 'in' ? 'in' as const : 'out' as const, admin: text(m.admin, 20), pilot: text(m.pilot, 40), text: text(m.text, 1000), status: text(m.status, 16),
        })),
      };
    },
    async send(actor, server, to, body) { return result(await call('send', { actor, server, ...(to ? { to } : {}), text: body })); },
    async inbox(actor, to, body) { return result(await call('inbox', { actor, to, text: body })); },
  };
}
