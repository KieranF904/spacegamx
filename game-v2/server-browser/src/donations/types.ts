/**
 * Donations as the lobby keeps them: one row per PayPal order this lobby made. No payer details are kept (no name,
 * email or address): only who it's credited to, how much, and PayPal's two ids.
 */

/**
 * CREATED: the order was made and nothing has been paid. COMPLETED: PayPal captured the money (the only status that
 * counts towards a total). PENDING: PayPal is holding the capture for review. FAILED: PayPal refused the capture.
 */
export type DonationStatus = 'CREATED' | 'COMPLETED' | 'PENDING' | 'FAILED';

export interface DonationRecord {
  id: number;
  /** The account it's credited to (the session that made the order); null: a guest, or the account was deleted */
  user_id: number | null;
  /** Minor units (cents). CREATED: what was asked for; COMPLETED: what PayPal says it captured */
  amount: number;
  /** ISO 4217, upper case ('USD') */
  currency: string;
  paypal_order_id: string;
  /** PayPal's capture id, once captured */
  capture_id: string | null;
  status: DonationStatus;
  /** Epoch ms */
  created_at: number;
  completed_at: number | null;
}

export interface AccountTotal {
  user_id: number | null;
  /** Minor units, COMPLETED rows only */
  total: number;
  count: number;
}

export interface DonationStore {
  /** A new CREATED row for an order (throws when the order id is already there) */
  create(row: { user_id: number | null; amount: number; currency: string; paypal_order_id: string; created_at: number }): Promise<DonationRecord>;
  byOrder(orderId: string): Promise<DonationRecord | null>;
  /**
   * Mark an order's row COMPLETED with what PayPal captured. Does nothing to a row that is already COMPLETED (a second
   * capture answer never counts twice). Returns the row as it is afterwards and `first`: true only for the one call
   * that completed it (what a once-per-donation effect hangs on). Null when there's no such order.
   */
  complete(orderId: string, capture: { capture_id: string; amount: number; currency: string; at: number }): Promise<{ row: DonationRecord; first: boolean } | null>;
  /** PENDING or FAILED, for a row that isn't COMPLETED */
  setStatus(orderId: string, status: 'PENDING' | 'FAILED'): Promise<void>;
  /** What an account has given in one currency: minor units, COMPLETED rows only */
  totalFor(userId: number, currency: string): Promise<number>;
  /** One account's rows that got as far as a payment (not the CREATED ones), newest first */
  forUser(userId: number, limit: number): Promise<DonationRecord[]>;
  /** The newest rows that got as far as a payment (not the CREATED ones), newest first */
  recent(limit: number): Promise<DonationRecord[]>;
  /** COMPLETED totals per account in one currency (user_id null: guests together), largest first */
  totals(currency: string, limit: number): Promise<AccountTotal[]>;
  /** Drop CREATED rows older than `before` (orders nobody paid; PayPal has let them lapse by then) */
  pruneUnpaid(before: number): Promise<number>;
  /** A deleted account: its rows stay (they're the money's record) without the account */
  forgetUser(userId: number): Promise<void>;
  close(): Promise<void>;
}
