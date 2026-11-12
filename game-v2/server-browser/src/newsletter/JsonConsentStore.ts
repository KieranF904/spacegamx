/**
 * JsonConsentStore: newsletter consent in a JSON file (local dev), the same rows as the Postgres `newsletter_consent`
 * table. Written like the accounts (writeFileDurable through a queue); a file that can't be read is never replaced.
 */

import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import type { ConsentRecord, ConsentStore, ConsentVia } from './types.js';

interface StoreFile {
  version: 1;
  consents: ConsentRecord[];
}

export class JsonConsentStore implements ConsentStore {
  private filePath: string;
  private rows = new Map<number, ConsentRecord>();
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
      if (!raw || !Array.isArray(raw.consents)) throw new Error('not a consent file');
      for (const r of raw.consents) this.rows.set(r.user_id, r);
    } catch (err) {
      throw new Error(`[Newsletter] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the answers: fix or move it.`);
    }
  }

  private save(): void {
    if (!this.filePath || this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = { version: 1, consents: [...this.rows.values()] };
      try { writeFileDurable(this.filePath, JSON.stringify(data)); } catch (err) { console.error('[Newsletter] Failed to save:', err); }
    });
  }

  async get(userId: number): Promise<ConsentRecord | null> {
    const r = this.rows.get(userId);
    return r ? { ...r } : null;
  }

  async set(userId: number, newsletter: boolean, via: ConsentVia, at: number): Promise<ConsentRecord> {
    const r: ConsentRecord = { user_id: userId, newsletter, newsletter_asked: true, newsletter_at: at, newsletter_via: via };
    this.rows.set(userId, r);
    this.save();
    return { ...r };
  }

  async counts(): Promise<{ consented: number; declined: number }> {
    let consented = 0, declined = 0;
    for (const r of this.rows.values()) {
      if (r.newsletter) consented++;
      else if (r.newsletter_asked) declined++;
    }
    return { consented, declined };
  }

  async forgetUser(userId: number): Promise<void> {
    if (this.rows.delete(userId)) this.save();
  }

  async close(): Promise<void> {
    await this.writeQueue;
    this.closed = true;
  }
}
