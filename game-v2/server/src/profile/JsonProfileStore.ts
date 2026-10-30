/**
 * JsonProfileStore: one JSON file per account under a directory.
 *
 * Writes go to a temp file first, flushed to disk and renamed into place
 * (durableWrite.ts), so a crash, a power cut or a full disk never leaves a
 * corrupt or empty profile: a failed write leaves the last good one as it was.
 * Saves for the same account are serialised (the newest one wins), and close()
 * waits for any in flight.
 *
 * Backups: the first save of an account each day copies the file it's about to
 * replace to backups/<id>/<yyyy-mm-dd>.json, keeping the last BACKUP_DAYS. A
 * profile that can't be parsed is moved aside (<id>.json.broken-<time>) and the
 * newest backup that parses is loaded instead; only with none does the pilot
 * start afresh. A file that can't be read for any other reason (permissions,
 * too many open files) is an error, never an empty profile.
 */
import { promises as fs, mkdirSync } from 'fs';
import { join } from 'path';
import type { ProfileStore } from './ProfileStore.js';
import { writeFileDurable } from './durableWrite.js';

/** Daily copies kept of each profile */
export const BACKUP_DAYS = 7;

export class JsonProfileStore implements ProfileStore {
  private writing = new Map<number, Promise<void>>();
  private pending = new Map<number, string>();
  /** The day each account was last backed up (this run) */
  private backedUp = new Map<number, string>();

  constructor(private dir: string, private now: () => number = () => Date.now()) {
    mkdirSync(dir, { recursive: true });
  }

  private file(userId: number): string {
    return join(this.dir, `${Math.floor(userId)}.json`);
  }

  private backupDir(userId: number): string {
    return join(this.dir, 'backups', `${Math.floor(userId)}`);
  }

  async load(userId: number): Promise<unknown | null> {
    await this.writing.get(userId);
    let text: string;
    try {
      text = await fs.readFile(this.file(userId), 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.fromBackup(userId, false);
      throw e; // (The caller won't start them afresh over a save it couldn't read)
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      // A broken file shouldn't lock anyone out: keep it aside and load the last good copy
      console.error(`[ProfileStore] unreadable profile ${userId}, moving it aside:`, e);
      await fs.rename(this.file(userId), `${this.file(userId)}.broken-${this.now()}`).catch(() => {});
      return this.fromBackup(userId, true);
    }
  }

  /** The newest backup that parses (after a broken file: else nothing, as before backups) */
  private async fromBackup(userId: number, broken: boolean): Promise<unknown | null> {
    if (!broken) return null;
    const names = await fs.readdir(this.backupDir(userId)).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
      try {
        const doc = JSON.parse(await fs.readFile(join(this.backupDir(userId), name), 'utf-8'));
        console.error(`[ProfileStore] profile ${userId} restored from backup ${name}`);
        return doc;
      } catch { /* try an older one */ }
    }
    return null;
  }

  save(userId: number, profile: unknown): Promise<void> {
    this.pending.set(userId, JSON.stringify(profile, null, 1));
    const prev = this.writing.get(userId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const json = this.pending.get(userId);
      if (json === undefined) return; // a later save already wrote this
      this.pending.delete(userId);
      await this.backup(userId);
      await writeFileDurable(this.file(userId), json);
    });
    // (The queue carries on past a failed write; the caller hears about it and saves again later)
    const next = run.catch((e) => { console.error(`[ProfileStore] save ${userId} failed:`, e); });
    this.writing.set(userId, next);
    void next.then(() => { if (this.writing.get(userId) === next) this.writing.delete(userId); });
    return run;
  }

  /** Once a day per account: copy the save about to be replaced, and drop the oldest copies */
  private async backup(userId: number): Promise<void> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.backedUp.get(userId) === day) return;
    this.backedUp.set(userId, day);
    try {
      const dir = this.backupDir(userId);
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(this.file(userId), join(dir, `${day}.json`));
      const old = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort().slice(0, -BACKUP_DAYS);
      for (const n of old) await fs.rm(join(dir, n), { force: true });
    } catch (e) {
      // (No save yet to copy: nothing to back up. Any other failure mustn't stop the save itself)
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[ProfileStore] backup of ${userId} failed:`, e);
    }
  }

  /** Drops a queued save, waits for one in flight, then removes the file (and its backups: the account is gone) */
  async delete(userId: number): Promise<void> {
    this.pending.delete(userId);
    await this.writing.get(userId);
    await fs.rm(this.file(userId), { force: true });
    await fs.rm(this.backupDir(userId), { recursive: true, force: true });
    this.backedUp.delete(userId);
  }

  /** Game-wide documents live beside the profiles as _<key>.json */
  async loadDoc(key: string): Promise<unknown | null> {
    const file = join(this.dir, `_${key.replace(/[^a-z0-9_-]/gi, '')}.json`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      // Kept aside, so the fresh one saved next doesn't replace the only copy
      console.error(`[ProfileStore] unreadable ${file}, moving it aside:`, e);
      await fs.rename(file, `${file}.broken-${this.now()}`).catch(() => {});
      return null;
    }
  }

  async saveDoc(key: string, doc: unknown): Promise<void> {
    await writeFileDurable(join(this.dir, `_${key.replace(/[^a-z0-9_-]/gi, '')}.json`), JSON.stringify(doc));
  }

  async close(): Promise<void> {
    await Promise.all([...this.writing.values()]);
  }
}
