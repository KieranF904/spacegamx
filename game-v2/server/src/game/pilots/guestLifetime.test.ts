/**
 * A guest account's lifetime (pilots/guests.ts): wiped after 12 h unused; at most 3 days old however busy, then 12 h more
 * only to register, then wiped; a guest who registers is consumed once.
 */
import { describe, it, expect } from 'vitest';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { GuestKeep, GUEST_DOC, GUEST_KEEP_MS, GUEST_LIFE_MS, GUEST_GRACE_MS } from './guests.js';

const H = 60 * 60_000;

describe('a guest account\'s lifetime', () => {
  it('is wiped after 12 h unused; every use starts the 12 h again', async () => {
    expect(GUEST_KEEP_MS).toBe(12 * H);
    let now = 0;
    const keep = new GuestKeep(new MemoryProfileStore(), () => now);
    keep.put('a', 'A', { n: 1 });
    keep.put('b', 'B', { n: 2 });
    now = 11 * H + 59 * 60_000;
    expect(await keep.take('a')).not.toBeNull();
    keep.put('b', 'B', { n: 3 });
    now = 12 * H + 1;
    expect(await keep.take('a')).toBeNull();
    expect((await keep.take('b'))?.profile).toEqual({ n: 3 });
    now = 24 * H + 2;
    expect(await keep.take('b')).toBeNull();
    expect(keep.size).toBe(0);
  });

  it('a guest in play (someone connected as them) is not wiped as idle', async () => {
    let now = 0;
    const keep = new GuestKeep(new MemoryProfileStore(), () => now, (id) => id === 'a');
    keep.put('a', 'A', { n: 1 });
    keep.put('b', 'B', { n: 2 });
    now = 13 * H;
    keep.put('c', 'C', { n: 3 });
    // (b went; a, connected, stayed; but a connection joining as a guest is judged as they left: 13 h unused)
    expect(keep.size).toBe(2);
    expect(await keep.take('a')).toBeNull();
  });

  it('lasts 3 days from creation however busy, then 12 h only to register, then is wiped', async () => {
    expect(GUEST_LIFE_MS).toBe(3 * 24 * H);
    expect(GUEST_GRACE_MS).toBe(12 * H);
    let now = 0;
    const keep = new GuestKeep(new MemoryProfileStore(), () => now);
    keep.put('a', 'A', { n: 0 });
    // (Used every 10 h: never idle, so only its age counts, and a put doesn't make it any younger)
    for (let i = 1; i <= 7; i++) { now = i * 10 * H; keep.put('a', 'A', { n: i }); }
    const live = await keep.take('a');
    expect(live?.expired).toBe(false);
    expect(live?.expiresInMs).toBe(2 * H);
    now = 73 * H;
    const over = await keep.take('a');
    expect(over?.expired).toBe(true);
    expect(over?.expiresInMs).toBe(11 * H);
    expect(over?.profile).toEqual({ n: 7 });
    // (Past the grace, however recently it was used)
    now = 80 * H; keep.put('a', 'A', { n: 8 });
    expect((await keep.take('a'))?.expiresInMs).toBe(4 * H);
    now = 84 * H + 1;
    expect(await keep.take('a')).toBeNull();
  });

  it('a guest who registers is consumed: gone from the keep and the saved doc, once', async () => {
    const store = new MemoryProfileStore();
    const keep = new GuestKeep(store, () => 0);
    keep.put('a', 'A', { n: 1 });
    expect(keep.consume('a')).toBe(true);
    expect(keep.consume('a')).toBe(false);
    expect(await keep.take('a')).toBeNull();
    await keep.flush();
    expect(((await store.loadDoc(GUEST_DOC)) as { guests: unknown[] }).guests).toEqual([]);
  });

  it('the saved doc holds when the guest began; a record from before that began when last used', async () => {
    let now = 0;
    const store = new MemoryProfileStore();
    const keep = new GuestKeep(store, () => now);
    keep.put('a', 'A', { n: 1 });
    now = 5 * H; keep.put('a', 'A', { n: 2 });
    await keep.flush();
    const doc = (await store.loadDoc(GUEST_DOC)) as { guests: { id: string; created: number; at: number }[] };
    expect(doc.guests[0]).toMatchObject({ id: 'a', created: 0, at: 5 * H });
    const old = new MemoryProfileStore();
    await old.saveDoc(GUEST_DOC, { guests: [{ id: 'o', name: 'O', at: 2 * H, profile: { n: 1 } }] });
    const again = new GuestKeep(old, () => 3 * H);
    expect((await again.take('o'))?.expiresInMs).toBe(GUEST_LIFE_MS - H);
  });
});
