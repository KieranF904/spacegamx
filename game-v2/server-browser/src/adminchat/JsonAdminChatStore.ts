/**
 * JsonAdminChatStore: the admin message log in a JSON file (local dev), the same rows as the Postgres `admin_messages`
 * table. Written like the accounts (writeFileDurable through a queue); a file that can't be read is never replaced.
 */

import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import { KEEP, type AdminChatStore, type AdminMessageRecord, type MessageStatus, type NewAdminMessage } from './types.js';

interface StoreFile {
  version: 1;
  nextId: number;
  messages: AdminMessageRecord[];
}

export class JsonAdminChatStore implements AdminChatStore {
  private filePath: string;
  private rows: AdminMessageRecord[] = [];
  private nextId = 1;
  private writeQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  /** (null: in memory only, for tests) */
  constructor(filePath: string | null, private keep = KEEP) {
    this.filePath = filePath ? path.resolve(filePath) : '';
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      if (!raw || !Array.isArray(raw.messages)) throw new Error('not an admin messages file');
      this.rows = raw.messages;
      this.nextId = Math.max(Number(raw.nextId) || 1, ...this.rows.map((m) => m.id + 1));
    } catch (err) {
      throw new Error(`[AdminChat] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the log: fix or move it.`);
    }
  }

  private save(): void {
    if (!this.filePath || this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = { version: 1, nextId: this.nextId, messages: this.rows };
      try { writeFileDurable(this.filePath, JSON.stringify(data)); } catch (err) { console.error('[AdminChat] Failed to save:', err); }
    });
  }

  async add(row: NewAdminMessage): Promise<AdminMessageRecord> {
    const rec: AdminMessageRecord = { id: this.nextId++, ...row };
    this.rows.push(rec);
    if (this.rows.length > this.keep) this.rows.splice(0, this.rows.length - this.keep);
    this.save();
    return { ...rec };
  }

  async setStatus(ids: number[], status: MessageStatus): Promise<void> {
    const set = new Set(ids);
    let changed = false;
    for (const r of this.rows) if (set.has(r.id) && r.status !== status) { r.status = status; changed = true; }
    if (changed) this.save();
  }

  async list(q: { server?: string; pilot?: string; limit: number }): Promise<AdminMessageRecord[]> {
    const pilot = q.pilot?.toLowerCase();
    const hits = this.rows.filter((r) => (!q.server || r.server === q.server || r.server === '')
      && (pilot === undefined || r.pilot.toLowerCase() === pilot || (r.pilot === '' && r.server !== '')));
    return hits.slice(-q.limit).map((r) => ({ ...r }));
  }

  async close(): Promise<void> {
    await this.writeQueue;
    this.closed = true;
  }
}
