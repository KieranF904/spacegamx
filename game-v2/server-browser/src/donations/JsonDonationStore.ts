/**
 * JsonDonationStore: donations in a JSON file (local dev), the same rows as the Postgres `donations` table.
 * Written like the accounts (writeFileDurable through a queue); a file that can't be read is never replaced.
 */

import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import type { AccountTotal, DonationRecord, DonationStore } from './types.js';

interface StoreFile {
  version: 1;
  nextId: number;
  donations: DonationRecord[];
}

export class JsonDonationStore implements DonationStore {
  private filePath: string;
  private rows: DonationRecord[] = [];
  private nextId = 1;
  private writeQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  /** (null: in memory only, for tests) */
  constructor(filePath: string | null) {
    this.filePath = filePath ? path.resolve(filePath) : '';
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      if (!raw || !Array.isArray(raw.donations)) throw new Error('not a donations file');
      this.rows = raw.donations;
      this.nextId = Math.max(Number(raw.nextId) || 1, ...this.rows.map((d) => d.id + 1));
    } catch (err) {
      throw new Error(`[Donations] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the records: fix or move it.`);
    }
  }

  private save(): void {
    if (!this.filePath || this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = { version: 1, nextId: this.nextId, donations: this.rows };
      try { writeFileDurable(this.filePath, JSON.stringify(data)); } catch (err) { console.error('[Donations] Failed to save:', err); }
    });
  }

  async create(row: { user_id: number | null; amount: number; currency: string; paypal_order_id: string; created_at: number }): Promise<DonationRecord> {
    if (this.rows.some((d) => d.paypal_order_id === row.paypal_order_id)) throw new Error('That order is already recorded');
    const rec: DonationRecord = { id: this.nextId++, ...row, capture_id: null, status: 'CREATED', completed_at: null };
    this.rows.push(rec);
    this.save();
    return { ...rec };
  }

  async byOrder(orderId: string): Promise<DonationRecord | null> {
    const d = this.rows.find((r) => r.paypal_order_id === orderId);
    return d ? { ...d } : null;
  }

  async complete(orderId: string, capture: { capture_id: string; amount: number; currency: string; at: number }): Promise<{ row: DonationRecord; first: boolean } | null> {
    const d = this.rows.find((r) => r.paypal_order_id === orderId);
    if (!d) return null;
    const first = d.status !== 'COMPLETED';
    if (first) {
      // (As the table's UNIQUE: one capture is one row)
      if (this.rows.some((r) => r.capture_id === capture.capture_id)) throw new Error('That capture is already recorded');
      d.status = 'COMPLETED';
      d.capture_id = capture.capture_id;
      d.amount = capture.amount;
      d.currency = capture.currency;
      d.completed_at = capture.at;
      this.save();
    }
    return { row: { ...d }, first };
  }

  async setStatus(orderId: string, status: 'PENDING' | 'FAILED'): Promise<void> {
    const d = this.rows.find((r) => r.paypal_order_id === orderId);
    if (!d || d.status === 'COMPLETED' || d.status === status) return;
    d.status = status;
    this.save();
  }

  async totalFor(userId: number, currency: string): Promise<number> {
    let sum = 0;
    for (const d of this.rows) if (d.user_id === userId && d.status === 'COMPLETED' && d.currency === currency) sum += d.amount;
    return sum;
  }

  async forUser(userId: number, limit: number): Promise<DonationRecord[]> {
    return this.rows.filter((d) => d.user_id === userId && d.status !== 'CREATED').sort((a, b) => b.id - a.id).slice(0, limit).map((d) => ({ ...d }));
  }

  async recent(limit: number): Promise<DonationRecord[]> {
    return this.rows.filter((d) => d.status !== 'CREATED').sort((a, b) => b.id - a.id).slice(0, limit).map((d) => ({ ...d }));
  }

  async totals(currency: string, limit: number): Promise<AccountTotal[]> {
    const by = new Map<number | null, AccountTotal>();
    for (const d of this.rows) {
      if (d.status !== 'COMPLETED' || d.currency !== currency) continue;
      const t = by.get(d.user_id) ?? { user_id: d.user_id, total: 0, count: 0 };
      t.total += d.amount;
      t.count++;
      by.set(d.user_id, t);
    }
    return [...by.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  }

  async pruneUnpaid(before: number): Promise<number> {
    const kept = this.rows.filter((d) => d.status !== 'CREATED' || d.created_at >= before);
    const gone = this.rows.length - kept.length;
    if (gone) { this.rows = kept; this.save(); }
    return gone;
  }

  async forgetUser(userId: number): Promise<void> {
    let changed = false;
    for (const d of this.rows) if (d.user_id === userId) { d.user_id = null; changed = true; }
    if (changed) this.save();
  }

  async close(): Promise<void> {
    await this.writeQueue;
    this.closed = true;
  }
}
