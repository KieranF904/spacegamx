/**
 * JsonActivityStore: the activity feed in a JSON file (local dev), the same rows as the Postgres `activity` table.
 * Writes are put off a couple of seconds (a busy server sends a batch every few seconds) and go through
 * writeFileDurable; a file that can't be read is set aside rather than stopping the lobby (it's a log, not accounts).
 */

import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import { KEEP_PER_SERVER, MAX_SERVERS, type ActivityEvent, type ActivityQuery, type ActivityStore, type NewActivity } from './types.js';

interface StoreFile {
  version: 1;
  nextId: number;
  events: ActivityEvent[];
}

/** Does an event pass a query's filters (ids aside)? Shared by the JSON store and the tests */
export function matches(e: ActivityEvent, q: ActivityQuery): boolean {
  if (q.server && e.server !== q.server) return false;
  if (q.type && e.type !== q.type) return false;
  if (q.player) {
    const p = q.player.toLowerCase();
    if (e.player.toLowerCase() !== p && e.other.toLowerCase() !== p) return false;
  }
  if (q.search) {
    const hay = `${e.player} ${e.other} ${e.type} ${e.detail}`.toLowerCase();
    if (!q.search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return true;
}

export class JsonActivityStore implements ActivityStore {
  private filePath: string;
  /** Per server, oldest first */
  private byServer = new Map<string, ActivityEvent[]>();
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  /** (null: in memory only, for tests) */
  constructor(filePath: string | null, private keep = KEEP_PER_SERVER, private saveDelayMs = 2000) {
    this.filePath = filePath ? path.resolve(filePath) : '';
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      if (!raw || !Array.isArray(raw.events)) throw new Error('not an activity file');
      for (const e of raw.events) this.push(e);
      this.nextId = Math.max(Number(raw.nextId) || 1, ...raw.events.map((e) => e.id + 1));
    } catch (err) {
      const aside = `${this.filePath}.unreadable-${Date.now()}`;
      try { fs.renameSync(this.filePath, aside); } catch { /* leave it */ }
      console.error(`[Activity] ${this.filePath} couldn't be read (${(err as Error).message}): set aside as ${path.basename(aside)}, starting empty`);
    }
  }

  private push(e: ActivityEvent): boolean {
    let list = this.byServer.get(e.server);
    if (!list) {
      if (this.byServer.size >= MAX_SERVERS) return false;
      list = [];
      this.byServer.set(e.server, list);
    }
    list.push(e);
    if (list.length > this.keep) list.splice(0, list.length - this.keep);
    return true;
  }

  async add(events: NewActivity[]): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = [];
    for (const n of events) {
      const e = { id: this.nextId, ...n };
      if (!this.push(e)) continue;
      this.nextId++;
      out.push(e);
    }
    if (out.length) this.save();
    return out;
  }

  async list(q: ActivityQuery): Promise<ActivityEvent[]> {
    const lists = q.server ? [this.byServer.get(q.server) ?? []] : [...this.byServer.values()];
    const out: ActivityEvent[] = [];
    for (const list of lists) {
      // (Each list is oldest first: walk back from the newest)
      let n = 0;
      for (let i = list.length - 1; i >= 0 && n < q.limit; i--) {
        const e = list[i];
        if (q.after !== undefined && e.id <= q.after) break;
        if (q.before !== undefined && e.id >= q.before) continue;
        if (!matches(e, q)) continue;
        out.push({ ...e });
        n++;
      }
    }
    return out.sort((a, b) => b.id - a.id).slice(0, q.limit);
  }

  async facets(): Promise<{ servers: string[]; types: string[] }> {
    const types = new Set<string>();
    for (const list of this.byServer.values()) for (const e of list) types.add(e.type);
    return { servers: [...this.byServer.keys()].sort(), types: [...types].sort() };
  }

  private save(): void {
    if (!this.filePath || this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, this.saveDelayMs);
    this.timer.unref?.();
  }

  private writeNow(): void {
    if (!this.filePath) return;
    const events = [...this.byServer.values()].flat().sort((a, b) => a.id - b.id);
    const data: StoreFile = { version: 1, nextId: this.nextId, events };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileDurable(this.filePath, JSON.stringify(data));
    } catch (err) {
      console.error('[Activity] Failed to save:', (err as Error).message);
    }
  }

  async close(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; this.writeNow(); }
    this.closed = true;
  }
}
