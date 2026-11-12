/**
 * The admin message log: what admins wrote to pilots from the website, and pilots' private replies to them. Read by
 * admins only (the website's admin panel). Never part of the public activity feed.
 *
 * Kept where the accounts are: PostgresAdminChatStore (`admin_messages` in ../../schema.sql) or JsonAdminChatStore
 * (data/lobby/admin-messages.json). The newest KEEP rows are kept.
 */

/** out: an admin to a pilot (or to everyone); in: a pilot's private reply to an admin */
export type Direction = 'out' | 'in';
/**
 * queued: waiting for the game server to ask. sent: handed to the game server. failed: the pilot had gone (or the
 * server never asked). received: a pilot's reply. inbox: left in the account's inbox instead (they were offline).
 */
export type MessageStatus = 'queued' | 'sent' | 'failed' | 'received' | 'inbox';

/** The Postgres row, 1:1 */
export interface AdminMessageRecord {
  id: number;
  /** Epoch ms */
  at: number;
  /** The game server's name ("AUS Main"); '' for a message left in an inbox */
  server: string;
  direction: Direction;
  /** The admin's account name */
  admin: string;
  /** The pilot's name; '' for a message to everyone on the server */
  pilot: string;
  body: string;
  status: MessageStatus;
}

export type NewAdminMessage = Omit<AdminMessageRecord, 'id'>;

/** Rows kept (the oldest go first) */
export const KEEP = 5000;

export interface AdminChatStore {
  add(row: NewAdminMessage): Promise<AdminMessageRecord>;
  setStatus(ids: number[], status: MessageStatus): Promise<void>;
  /** The newest rows, oldest first: all of them, one server's, or one pilot's conversation (and messages to everyone there) */
  list(q: { server?: string; pilot?: string; limit: number }): Promise<AdminMessageRecord[]>;
  close(): Promise<void>;
}
