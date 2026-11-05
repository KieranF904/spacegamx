/**
 * The player inbox: messages to accounts, from an admin or from the game ("system").
 *
 * Kept where the accounts are, in both backends:
 *   - JsonMessageStore      (local dev: data/lobby/messages.json)
 *   - PostgresMessageStore  (production: the `messages` table in ../../schema.sql)
 *
 * One row per recipient: a message to everyone is a copy for each account (sharing a `batch`), so reading,
 * deleting and a deleted account's mail going with it are each one player's own row. Bodies are plain text,
 * stored as sent (trimmed, control characters dropped); escaping is the display's job.
 */

/** One message in one player's inbox (the Postgres row, 1:1) */
export interface MessageRecord {
  id: number;
  /** The recipient's account */
  user_id: number;
  /** The admin who sent it (null: the game, "system") */
  from_user_id: number | null;
  /** Their username when they sent it, or 'system' */
  from_name: string;
  subject: string;
  body: string;
  /** Shown as the join screen's banner until read (admins' messages are, by default) */
  important: boolean;
  /** One send: every copy of a message to everyone shares it */
  batch: string;
  /** Who the send was to: a username, or '*' for everyone */
  sent_to: string;
  /** Epoch ms */
  created_at: number;
  read_at: number | null;
  /** Deleted by the player: hidden from them, still counted in the sender's list */
  archived_at: number | null;
}

/** What a send writes into each recipient's row */
export interface NewMessage {
  from_user_id: number | null;
  from_name: string;
  subject: string;
  body: string;
  important: boolean;
  sent_to: string;
}

/** One send, as the admins' "sent" list shows it */
export interface SentSummary {
  batch: string;
  sent_to: string;
  from_name: string;
  subject: string;
  body: string;
  important: boolean;
  created_at: number;
  /** Copies sent, and how many of them have been read */
  recipients: number;
  read: number;
}

export interface InboxPage {
  /** Newest first, not deleted */
  messages: MessageRecord[];
  unread: number;
  /** Unread and important (the join screen's banner) */
  unreadImportant: number;
}

export interface MessageStore {
  /** A copy for each recipient (one batch); returns the batch and how many were written */
  send(userIds: number[], msg: NewMessage): Promise<{ batch: string; count: number }>;
  /** This player's messages (newest first, at most `limit`) and their unread counts */
  list(userId: number, limit: number): Promise<InboxPage>;
  /** Mark these of the player's messages read ('all': every one); how many changed */
  markRead(userId: number, ids: number[] | 'all'): Promise<number>;
  /** Delete (archive) these of the player's messages; how many changed */
  archive(userId: number, ids: number[]): Promise<number>;
  /** The latest sends (newest first) */
  sent(limit: number): Promise<SentSummary[]>;
  /** An account is gone: its mail goes too (Postgres does this by ON DELETE CASCADE as well) */
  forgetUser(userId: number): Promise<void>;
  close(): Promise<void>;
}
