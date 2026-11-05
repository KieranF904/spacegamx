/**
 * The accounts deleted lately, handed to every game server on its heartbeat so each can delete that pilot's
 * profile (the lobby can't reach the game servers' data: they may be on other machines, and on the VPS
 * the lobby may only write its own folder). Ids are never reused (see JsonUserStore), so a late server
 * can't delete a new pilot's save; an entry goes after RETAIN_MS, long past any server's downtime.
 */

import fs from 'fs';
import path from 'path';
import { writeFileDurable } from './utils.js';

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry { id: number; at: number }

export class DeletedAccounts {
  private entries: Entry[] = [];

  constructor(private file: string | null, private now: () => number = Date.now) {
    if (!file) return;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      return; // none yet
    }
    try {
      const raw = JSON.parse(text);
      if (!Array.isArray(raw)) throw new Error('not a list');
      this.entries = raw.filter((e) => Number.isInteger(e?.id) && Number.isFinite(e?.at));
    } catch (err) {
      // Kept aside, not lost: the next deletion rewrites the file (the game servers then miss these ids)
      const aside = `${file}.corrupt-${this.now()}`;
      try { fs.copyFileSync(file, aside); } catch { /* (logged below either way) */ }
      console.error(`[Accounts] the deleted-accounts list ${file} can't be read (${(err as Error).message}); a copy is at ${aside}`);
    }
  }

  add(id: number): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.entries.push({ id, at: this.now() });
    this.persist();
  }

  /** The ids still worth telling servers about */
  recent(): number[] {
    const cutoff = this.now() - RETAIN_MS;
    return this.entries.filter((e) => e.at >= cutoff).map((e) => e.id);
  }

  private persist(): void {
    if (!this.file) return;
    const cutoff = this.now() - RETAIN_MS;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileDurable(this.file, JSON.stringify(this.entries));
    } catch (err) {
      console.error('[Accounts] could not save the deleted-accounts list:', err);
    }
  }
}
