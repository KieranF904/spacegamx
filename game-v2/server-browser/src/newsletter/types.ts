/**
 * Newsletter consent as the lobby keeps it: one row per account that has been asked. An account with no row has not
 * been asked and has not consented (every account from before this existed, and one made by a client that sent no
 * answer). Nothing is sent to anyone yet: this only records the answer.
 */

/** Where an answer was given: the sign-up form, the website's one-time question, or the account page's setting */
export type ConsentVia = 'signup' | 'prompt' | 'settings';

/** The Postgres row, 1:1 */
export interface ConsentRecord {
  user_id: number;
  /** They want the email newsletter */
  newsletter: boolean;
  /** They have been asked (true for every row: a row is made by an answer) */
  newsletter_asked: boolean;
  /** When the answer last changed (epoch ms) */
  newsletter_at: number | null;
  newsletter_via: ConsentVia | null;
}

export interface ConsentStore {
  get(userId: number): Promise<ConsentRecord | null>;
  /** Record an answer (the row is made or replaced; asked becomes true) */
  set(userId: number, newsletter: boolean, via: ConsentVia, at: number): Promise<ConsentRecord>;
  /** How many accounts said yes, and how many were asked and said no */
  counts(): Promise<{ consented: number; declined: number }>;
  /** An account is gone: its answer goes too (Postgres does this by ON DELETE CASCADE as well) */
  forgetUser(userId: number): Promise<void>;
  close(): Promise<void>;
}
