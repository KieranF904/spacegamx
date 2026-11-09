import { describe, it, expect } from 'vitest';
import { PostgresProfileStore } from './PostgresProfileStore.js';
import { FakePgPool } from './fakePg.js';
import { LocalLeases, LEASE_MS, serverIdFromEnv } from './lease.js';

describe('postgres profile lease (two servers, one database)', () => {
  async function two() {
    const db = new FakePgPool();
    return { db, a: await PostgresProfileStore.setup(db), b: await PostgresProfileStore.setup(db) };
  }

  it('gives an account to one server at a time and says who has it', async () => {
    const { a, b } = await two();
    expect(await a.claimLease(7, 'paris')).toEqual({ ok: true });
    expect(await b.claimLease(7, 'sydney')).toEqual({ ok: false, holder: 'paris' });
    expect(await b.claimLease(8, 'sydney')).toEqual({ ok: true }); // other accounts are free
  });

  it('lets the holder claim again, and lets another take it once released', async () => {
    const { a, b } = await two();
    await a.claimLease(7, 'paris');
    expect(await a.claimLease(7, 'paris')).toEqual({ ok: true });
    await b.releaseLease(7, 'sydney'); // not the holder: nothing happens
    expect((await b.claimLease(7, 'sydney')).ok).toBe(false);
    await a.releaseLease(7, 'paris');
    expect(await b.claimLease(7, 'sydney')).toEqual({ ok: true });
  });

  it('frees a stale lease after it runs out, and renewing keeps one alive', async () => {
    const { db, a, b } = await two();
    await a.claimLease(7, 'paris');
    await a.claimLease(9, 'paris');
    db.clock += LEASE_MS - 1000;
    expect(await a.renewLeases([7], 'paris')).toEqual([7]);
    db.clock += 5000;
    expect((await b.claimLease(7, 'sydney')).ok).toBe(false); // renewed
    expect(await b.claimLease(9, 'sydney')).toEqual({ ok: true }); // crashed server's, expired
    expect(await a.renewLeases([9], 'paris')).toEqual([]); // paris learns it lost 9
  });

  it('refuses nothing when two claims race for a free account, but only one wins', async () => {
    const { a, b } = await two();
    const [x, y] = await Promise.all([a.claimLease(5, 'paris'), b.claimLease(5, 'sydney')]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
  });
});

describe('in-process lease and server id', () => {
  it('behaves the same without a database', async () => {
    let t = 0;
    const l = new LocalLeases(() => t);
    expect((await l.claimLease(1, 'a')).ok).toBe(true);
    expect((await l.claimLease(1, 'b')).ok).toBe(false);
    t += LEASE_MS + 1;
    expect((await l.claimLease(1, 'b')).ok).toBe(true);
  });

  it('takes the server id from SERVER_ID, else hostname:port', () => {
    expect(serverIdFromEnv({ SERVER_ID: ' fra ' })).toBe('fra');
    expect(serverIdFromEnv({ PORT: '4000' })).toMatch(/:4000$/);
  });
});
