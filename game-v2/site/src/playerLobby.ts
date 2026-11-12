/**
 * What a signed-in pilot reads of their own from the lobby, for the account pages (routes/mine.ts): their donations
 * (server-browser/src/donations, POST /donations/mine) and their inbox (server-browser/src/inbox, POST /inbox/list,
 * read, delete). Every call carries the pilot's own session token, so the lobby answers for that account only; the
 * visitor's address goes along for the lobby's per-address limits. Never throws: null (or false) when it can't be read.
 */

export interface MyDonation { id: number; amount: number; currency: string; status: string; at: number; reference: string | null }
export interface MyDonations { currency: string; total: number; /** The total (cents) that earns the contributor rank; 0: not said */ contributorAt: number; donations: MyDonation[] }
export interface InboxMessage { id: number; from: string; subject: string; body: string; important: boolean; createdAt: number; readAt: number | null }
export interface Inbox { messages: InboxMessage[]; unread: number }

export interface PlayerLobby {
  donations(token: string, ip: string): Promise<MyDonations | null>;
  inbox(token: string, ip: string): Promise<Inbox | null>;
  markRead(token: string, ip: string, id: number | 'all'): Promise<boolean>;
  remove(token: string, ip: string, id: number): Promise<boolean>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export function httpPlayerLobby(lobbyUrl: string, f: Fetch = fetch as unknown as Fetch): PlayerLobby {
  const call = async (path: string, body: object, ip: string): Promise<any | null> => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ip) headers['X-Forwarded-For'] = ip;
      const r = await f(`${lobbyUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      return r.status === 200 && j?.success === true ? j : null;
    } catch {
      return null;
    }
  };
  return {
    async donations(token, ip) {
      const j = await call('/donations/mine', { token }, ip);
      if (!j || !Array.isArray(j.donations)) return null;
      return {
        currency: text(j.currency, 8) || 'USD', total: num(j.total), contributorAt: num(j.contributorAt),
        donations: j.donations.filter((d: any) => d && typeof d === 'object').map((d: any) => ({
          id: num(d.id), amount: num(d.amount), currency: text(d.currency, 8) || 'USD', status: text(d.status, 16), at: num(d.at), reference: text(d.reference, 64) || null,
        })),
      };
    },
    async inbox(token, ip) {
      const j = await call('/inbox/list', { token }, ip);
      if (!j || !Array.isArray(j.messages)) return null;
      return {
        unread: num(j.unread),
        messages: j.messages.filter((m: any) => m && typeof m === 'object').map((m: any) => ({
          id: num(m.id), from: text(m.from, 40) || 'system', subject: text(m.subject, 200), body: text(m.body, 8000), important: m.important === true,
          createdAt: num(m.createdAt), readAt: typeof m.readAt === 'number' ? m.readAt : null,
        })),
      };
    },
    async markRead(token, ip, id) {
      return (await call('/inbox/read', id === 'all' ? { token, all: true } : { token, id }, ip)) !== null;
    },
    async remove(token, ip, id) {
      return (await call('/inbox/delete', { token, id }, ip)) !== null;
    },
  };
}
