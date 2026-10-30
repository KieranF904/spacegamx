/**
 * JsonProfileStore: one JSON file per account under a directory.
 *
 * Writes go to a temp file first and are renamed into place, so a crash mid-
 * write never leaves a corrupt profile. Saves for the same account are
 * serialised (the newest one wins), and close() waits for any in flight.
 */

import { promises as fs, mkdirSync } from 'fs';
import { join } from 'path';
import type { ProfileStore } from './ProfileStore.js';

export class JsonProfileStore implements ProfileStore {
  private writing = new Map<number, Promise<void>>();
  private pending = new Map<number, string>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(userId: number): string {
    return join(this.dir, `${Math.floor(userId)}.json`);
  }

  async load(userId: number): Promise<unknown | null> {
    await this.writing.get(userId);
    try {
      return JSON.parse(await fs.readFile(this.file(userId), 'utf-8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // A broken file shouldn't lock anyone out: keep it aside and start fresh
      console.error(`[ProfileStore] unreadable profile ${userId}, moving it aside:`, e);
      await fs.rename(this.file(userId), `${this.file(userId)}.broken-${Date.now()}`).catch(() => {});
      return null;
    }
  }

  save(userId: number, profile: unknown): Promise<void> {
    this.pending.set(userId, JSON.stringify(profile, null, 1));
    const prev = this.writing.get(userId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const json = this.pending.get(userId);
      if (json === undefined) return; // a later save already wrote this
      this.pending.delete(userId);
      const tmp = `${this.file(userId)}.tmp`;
      await fs.writeFile(tmp, json);
      await fs.rename(tmp, this.file(userId));
    }).catch((e) => console.error(`[ProfileStore] save ${userId} failed:`, e));
    this.writing.set(userId, next);
    void next.then(() => { if (this.writing.get(userId) === next) this.writing.delete(userId); });
    return next;
  }

  /** Drops a queued save, waits for one in flight, then removes the file */
  async delete(userId: number): Promise<void> {
    this.pending.delete(userId);
    await this.writing.get(userId);
    await fs.rm(this.file(userId), { force: true });
  }

  /** Game-wide documents live beside the profiles as _<key>.json */
  async loadDoc(key: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(join(this.dir, `_${key.replace(/[^a-z0-9_-]/gi, '')}.json`), 'utf-8'));
    } catch {
      return null;
    }
  }

  async saveDoc(key: string, doc: unknown): Promise<void> {
    const file = join(this.dir, `_${key.replace(/[^a-z0-9_-]/gi, '')}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(doc));
    await fs.rename(`${file}.tmp`, file);
  }

  async close(): Promise<void> {
    await Promise.all([...this.writing.values()]);
  }
}
