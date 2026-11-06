/**
 * JsonFriendStore: friends in a JSON file (local dev), the same records as the Postgres `friend_lists` table.
 * Written like the inbox (writeFileDurable through a queue); a file that can't be read is never replaced.
 */

import fs from 'fs';
import path from 'path';
import { writeFileDurable } from '../accounts/utils.js';
import type { UserStore } from '../accounts/types.js';
import { cleanLists, emptyLists, forgetIn, isEmpty, type FriendLists, type Lists } from './lists.js';
import { Serial, type FriendStore } from './types.js';

interface StoreFile {
  version: 1;
  accounts: Record<string, FriendLists>;
}

const copy = (l: FriendLists): FriendLists => ({ status: l.status, friends: [...l.friends], in: [...l.in], out: [...l.out] });
const same = (a: FriendLists, b: FriendLists) => JSON.stringify(a) === JSON.stringify(b);

export class JsonFriendStore implements FriendStore {
  private filePath: string;
  private records = new Map<number, FriendLists>();
  private writeQueue: Promise<void> = Promise.resolve();
  private dirty = false;
  private closed = false;
  private serial = new Serial();

  /** (filePath null: in memory only, for tests) */
  constructor(filePath: string | null, private users: Pick<UserStore, 'getUserById'>) {
    this.filePath = filePath ? path.resolve(filePath) : '';
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as StoreFile;
      if (!raw || typeof raw.accounts !== 'object' || !raw.accounts) throw new Error('not a friends file');
      for (const [k, v] of Object.entries(raw.accounts)) {
        const id = Number(k);
        if (Number.isSafeInteger(id) && id > 0) this.records.set(id, cleanLists(v, id));
      }
    } catch (err) {
      throw new Error(`[Friends] ${this.filePath} can't be read (${(err as Error).message}). Refusing to start rather than lose the friends lists: fix or move it.`);
    }
  }

  private save(): void {
    if (!this.filePath || this.closed || this.dirty) return;
    this.dirty = true;
    this.writeQueue = this.writeQueue.then(() => {
      this.dirty = false;
      const data: StoreFile = { version: 1, accounts: Object.fromEntries(this.records) };
      try { writeFileDurable(this.filePath, JSON.stringify(data)); } catch (err) { console.error('[Friends] Failed to save:', err); }
    });
  }

  async get(userId: number): Promise<FriendLists | null> {
    const r = this.records.get(userId);
    return r ? copy(r) : null;
  }

  update<T>(userIds: number[], fn: (lists: Lists, had: Set<number>) => T): Promise<T> {
    return this.serial.run(async () => {
      const lists: Lists = new Map();
      const had = new Set<number>();
      for (const id of userIds) {
        const r = this.records.get(id);
        if (r) had.add(id);
        lists.set(id, r ? copy(r) : emptyLists());
      }
      const out = fn(lists, had);
      let changed = false;
      for (const [id, l] of lists) {
        const before = this.records.get(id);
        if (before ? same(before, l) : isEmpty(l)) continue;
        this.records.set(id, l);
        changed = true;
      }
      if (changed) this.save();
      return out;
    });
  }

  async names(userIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const id of new Set(userIds)) {
      const u = await this.users.getUserById(id);
      if (u) out.set(id, u.username);
    }
    return out;
  }

  forgetUser(userId: number): Promise<void> {
    return this.serial.run(async () => {
      let changed = this.records.delete(userId);
      for (const r of this.records.values()) if (forgetIn(r, userId)) changed = true;
      if (changed) this.save();
    });
  }

  async close(): Promise<void> {
    await this.serial.idle();
    await this.writeQueue;
    this.closed = true;
  }
}
