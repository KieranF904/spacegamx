/**
 * The accounts deleted lately, handed to every game server on its heartbeat so each can delete that pilot's
 * profile (the lobby can't reach the game servers' data: they may be on other machines, and on the VPS
 * the lobby may only write its own folder). Ids are never reused (see JsonUserStore), so a late server
 * can't delete a new pilot's save; an entry goes after RETAIN_MS, long past any server's downtime.
 */

import fs from 'fs';
import path from 'path';

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry { id: number; at: number }

export class DeletedAccounts {
  private entries: Entry[] = [];

  constructor(private file: string | null, private now: () => number = Date.now) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(raw)) this.entries = raw.filter((e) => Number.isInteger(e?.id) && Number.isFinite(e?.at));
    } catch { /* none yet */ }
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
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[Accounts] could not save the deleted-accounts list:', err);
    }
  }
}
