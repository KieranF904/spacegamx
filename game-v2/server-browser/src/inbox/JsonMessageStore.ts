/**
 * JsonMessageStore: the inbox in a JSON file (local dev), the same rows as the Postgres `messages` table.
 * Written like the accounts (writeFileDurable through a queue); a file that can't be read is never replaced.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import type { InboxPage, MessageRecord, MessageStore, NewMessage, SentSummary } from './types.js';

interface StoreFile {
  version: 1;
  nextId: number;
  messages: MessageRecord[];
}

export class JsonMessageStore implements MessageStore {
  private filePath: string;
  private messages: MessageRecord[] = [];
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
      if (!raw || !Array.isArray(raw.messages)) throw new Error('not a messages file');
      this.messages = raw.messages;
      this.nextId = Math.max(Number(raw.nextId) || 1, ...this.messages.map((m) => m.id + 1));
    } catch (err) {
      throw new Error(`[Inbox] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the messages: fix or move it.`);
    }
  }

  private save(): void {
    if (!this.filePath || this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = { version: 1, nextId: this.nextId, messages: this.messages };
      try { writeFileDurable(this.filePath, JSON.stringify(data)); } catch (err) { console.error('[Inbox] Failed to save:', err); }
    });
  }

  async send(userIds: number[], msg: NewMessage): Promise<{ batch: string; count: number }> {
    const batch = crypto.randomUUID();
    const now = Date.now();
    for (const user_id of new Set(userIds)) {
      this.messages.push({ id: this.nextId++, user_id, ...msg, batch, created_at: now, read_at: null, archived_at: null });
    }
    this.save();
    return { batch, count: new Set(userIds).size };
  }

  async list(userId: number, limit: number): Promise<InboxPage> {
    const mine = this.messages.filter((m) => m.user_id === userId && m.archived_at === null);
    const unread = mine.filter((m) => m.read_at === null);
    return {
      messages: mine.slice().sort((a, b) => b.created_at - a.created_at || b.id - a.id).slice(0, limit).map((m) => ({ ...m })),
      unread: unread.length,
      unreadImportant: unread.filter((m) => m.important).length,
    };
  }

  async markRead(userId: number, ids: number[] | 'all'): Promise<number> {
    const now = Date.now();
    let n = 0;
    for (const m of this.messages) {
      if (m.user_id !== userId || m.read_at !== null || m.archived_at !== null) continue;
      if (ids !== 'all' && !ids.includes(m.id)) continue;
      m.read_at = now;
      n++;
    }
    if (n) this.save();
    return n;
  }

  async archive(userId: number, ids: number[]): Promise<number> {
    const now = Date.now();
    let n = 0;
    for (const m of this.messages) {
      if (m.user_id !== userId || m.archived_at !== null || !ids.includes(m.id)) continue;
      m.archived_at = now;
      // (Deleting counts as having seen it: the banner goes, and the sender's read count says so)
      m.read_at ??= now;
      n++;
    }
    if (n) this.save();
    return n;
  }

  async sent(limit: number): Promise<SentSummary[]> {
    const byBatch = new Map<string, SentSummary>();
    for (const m of this.messages) {
      let s = byBatch.get(m.batch);
      if (!s) {
        s = { batch: m.batch, sent_to: m.sent_to, from_name: m.from_name, subject: m.subject, body: m.body, important: m.important, created_at: m.created_at, recipients: 0, read: 0 };
        byBatch.set(m.batch, s);
      }
      s.recipients++;
      if (m.read_at !== null) s.read++;
    }
    return [...byBatch.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  async forgetUser(userId: number): Promise<void> {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.user_id !== userId);
    if (this.messages.length !== before) this.save();
  }

  async close(): Promise<void> {
    await this.writeQueue;
    this.closed = true;
  }
}
