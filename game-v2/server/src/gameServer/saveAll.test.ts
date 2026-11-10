/**
 * Shutdown (gameServer/session.ts saveAll): every live signed-in pilot is written to the store exactly once, a guest is
 * never written with the accounts, and one store failing is reported after the others were still saved.
 */
import { describe, it, expect, vi } from 'vitest';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { makeServer, resetGlobals } from '../testkits/world.testkit.js';

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A store that counts the saves of each account */
class CountingStore extends MemoryProfileStore {
  saves = new Map<number, number>();
  override async save(userId: number, profile: unknown): Promise<void> {
    this.saves.set(userId, (this.saves.get(userId) ?? 0) + 1);
    return super.save(userId, profile);
  }
}

function lobby(store: MemoryProfileStore) {
  resetGlobals();
  const userDB = {
    validateSession: async (t: string) => (t.startsWith('tok:') ? { id: Number(t.slice(4)), username: `acct${t.slice(4)}`, email: '', is_admin: false, is_owner: false, created_at: '' } : null),
    cleanupExpiredSessions: async () => {},
  } as never;
  const server = makeServer({ userDB, profileStore: store });
  const join = async (username: string, token?: string) => {
    const t = new LocalTransport(server);
    t.onMessage = () => {};
    t.connect();
    t.send({ type: 'join', username, ...(token ? { token } : {}) } as never);
    await flush();
    return t;
  };
  return { server, join };
}

describe('saveAll', () => {
  it('saves every live signed-in pilot once, and never a guest with the accounts', async () => {
    const store = new CountingStore();
    const { server, join } = lobby(store);
    await join('a', 'tok:1');
    await join('b', 'tok:2');
    await join('Guest_9');
    store.saves.clear();
    await server.saveAll();
    expect([...store.saves.entries()].sort()).toEqual([[1, 1], [2, 1]]);
    expect(await store.load(1)).not.toBeNull();
    expect(await store.load(2)).not.toBeNull();
  });

  it('a store failing is reported after the others were still saved', async () => {
    const store = new CountingStore();
    const { server, join } = lobby(store);
    await join('a', 'tok:1');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      (server.social as unknown as { save: () => Promise<void> }).save = async () => { throw new Error('disk full'); };
      store.saves.clear();
      await expect(server.saveAll()).rejects.toThrow('1 store(s) failed to save');
      expect(store.saves.get(1)).toBe(1);
    } finally { err.mockRestore(); }
  });
});
