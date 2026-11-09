/**
 * JsonRankingStore: the rows in a JSON file (local dev), the same records as the Postgres `ranking_rows` table.
 * Written like the friends' file (writeFileDurable through a queue); a file that can't be read is never replaced.
 */
import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import { cleanStats, type RankRecord } from './board.js';
import type { RankingStore } from './types.js';

interface StoreFile { version: 1; rows: Record<string, RankRecord> }

function cleanRecord(userId: number, v: any): RankRecord | null {
  if (!v || typeof v !== 'object') return null;
  const week = Number(v.week);
  return { userId, name: typeof v.name === 'string' ? v.name.slice(0, 40) : '', week: Number.isSafeInteger(week) ? week : 0, weekly: cleanStats(v.weekly), allTime: cleanStats(v.allTime) };
}

export class JsonRankingStore implements RankingStore {
  private filePath: string;
  private rows = new Map<number, RankRecord>();
  private writeQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;

  /** (filePath null: in memory only, for tests) */
  constructor(filePath: string | null) {
    this.filePath = filePath ? path.resolve(filePath) : '';
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      if (!raw || typeof raw.rows !== 'object' || !raw.rows) throw new Error('not a rankings file');
      for (const [k, v] of Object.entries(raw.rows)) {
        const id = Number(k);
        const r = Number.isSafeInteger(id) && id > 0 ? cleanRecord(id, v) : null;
        if (r) this.rows.set(id, r);
      }
    } catch (err) {
      throw new Error(`[Rankings] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the rankings: fix or move it.`);
    }
  }

  private save(): void {
    if (!this.filePath || this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = { version: 1, rows: Object.fromEntries(this.rows) };
      try { writeFileDurable(this.filePath, JSON.stringify(data)); } catch (err) { console.error('[Rankings] Failed to save:', err); }
    });
  }

  async get(userIds: number[]): Promise<Map<number, RankRecord>> {
    const out = new Map<number, RankRecord>();
    for (const id of userIds) { const r = this.rows.get(id); if (r) out.set(id, structuredClone(r)); }
    return out;
  }

  async all(): Promise<RankRecord[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }

  async put(rows: RankRecord[]): Promise<void> {
    for (const r of rows) this.rows.set(r.userId, structuredClone(r));
    if (rows.length) this.save();
  }

  async forgetUser(userId: number): Promise<void> {
    if (this.rows.delete(userId)) this.save();
  }

  async close(): Promise<void> {
    await this.writeQueue;
    this.closed = true;
  }
}
