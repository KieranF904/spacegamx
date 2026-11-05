/**
 * The player inbox, kept by the lobby beside the accounts (server-browser/src/inbox/routes.ts; nginx: /lobby/inbox/).
 * Every call carries the session token; the lobby answers only with that account's own mail, and only admins may
 * send or see what was sent.
 */

import { LOBBY_URL } from './lobby';

export interface InboxMessage {
  id: number;
  /** A username, or 'system' */
  from: string;
  subject: string;
  /** Plain text: escape it to show it */
  body: string;
  /** A banner on the join screen until read */
  important: boolean;
  createdAt: number;
  readAt: number | null;
}

export interface SentInfo {
  /** A username, or '*' for everyone */
  to: string;
  from: string;
  subject: string;
  body: string;
  important: boolean;
  createdAt: number;
  recipients: number;
  read: number;
}

export interface InboxCounts { unread: number; unreadImportant: number }
export type InboxAnswer<T> = ({ success: true } & T) | { success: false; error: string };

export interface OutgoingMail { to?: string; everyone?: boolean; subject: string; body: string; important: boolean }

/** The calls (an interface so the join screen's tests can answer them) */
export interface InboxApi {
  list(token: string): Promise<InboxAnswer<{ messages: InboxMessage[] } & InboxCounts>>;
  read(token: string, ids: number[] | 'all'): Promise<InboxAnswer<InboxCounts>>;
  remove(token: string, id: number): Promise<InboxAnswer<InboxCounts>>;
  send(token: string, mail: OutgoingMail): Promise<InboxAnswer<{ sent: number; to: string }>>;
  sent(token: string): Promise<InboxAnswer<{ sent: SentInfo[] }>>;
}

async function call<T>(action: string, body: object): Promise<InboxAnswer<T>> {
  try {
    const r = await fetch(`${LOBBY_URL}/inbox/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!data || typeof data !== 'object') return { success: false, error: `The inbox answered ${r.status}` };
    return data as InboxAnswer<T>;
  } catch {
    return { success: false, error: "Can't reach the inbox right now." };
  }
}

export const lobbyInbox: InboxApi = {
  list: (token) => call('list', { token }),
  read: (token, ids) => call('read', ids === 'all' ? { token, all: true } : { token, ids }),
  remove: (token, id) => call('delete', { token, id }),
  send: (token, mail) => call('send', { token, ...mail }),
  sent: (token) => call('sent', { token }),
};
