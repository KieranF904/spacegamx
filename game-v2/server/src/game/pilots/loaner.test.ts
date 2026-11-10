/**
 * A saved ship that fails the ship rules (a data edit since it was built: persist.ts flyLoaner) is kept exactly as saved:
 * a loaner flies in its place and is never written, so the next autosave can't replace the pilot's ship with a starter.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { Blueprint, PlayerProfile, ServerMessage } from '@space-game/common';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { makeEmptyServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

const userDB = {
  checkSession: async (t: string) => {
    const id = Number(t.split(':')[1]);
    return { user: { id, username: `pilot${id}`, email: '', is_admin: false, is_owner: false, created_at: '' } };
  },
  validateSession: async () => null, cleanupExpiredSessions: async () => {}, admin: null,
};

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

function setup() {
  resetGlobals();
  const store = new MemoryProfileStore();
  const server = makeEmptyServer({
    gameData: new GameData(files), userDB: userDB as any, profileStore: store,
  });
  const join = async (id: number) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: `pilot${id}`, token: `tok:${id}` } as any);
    await flush();
    const conn = server.pilots.connOf(t.getPlayerId())!;
    return { t, got, conn, pid: t.getPlayerId() };
  };
  return { store, server, join };
}

/** The design with a copy of its first non-core part laid over the original (overlap: fails the rules) */
const broken = (bp: Blueprint): Blueprint => {
  const parts = bp.parts.map((p) => ({ ...p }));
  const twin = parts.find((p) => p.fn !== 'core')!;
  parts.push({ ...JSON.parse(JSON.stringify(twin)), uid: Math.max(...parts.map((p) => p.uid)) + 1 });
  return { ...JSON.parse(JSON.stringify(bp)), name: 'Old Faithful', parts };
};

/** Play once, then break the saved ship in the store (as a data edit would) and sign in again */
async function withBrokenSave(id: number) {
  const w = setup();
  const first = await w.join(id);
  first.t.disconnect();
  await flush();
  const doc = (await w.store.load(id)) as PlayerProfile;
  const bad = broken(doc.ship.blueprint);
  doc.ship.blueprint = bad;
  doc.hangar[doc.activeSlot] = doc.ship;
  await w.store.save(id, doc);
  expect(w.server.getShips().validate(bad, { mounting: false, devParts: true }).ok).toBe(false);
  const again = await w.join(id);
  return { ...w, ...again, bad };
}

describe('a saved ship that fails the rules', () => {
  it('is kept as saved (not overwritten by the next save) while a loaner flies, and the pilot is told', async () => {
    const { store, server, got, conn, pid, bad, t } = await withBrokenSave(3);
    const p = server.pilots.get(conn)!;
    const live = server.getShips().get(pid)!;
    expect(live.blueprint.name).not.toBe('Old Faithful');
    expect(p.hangar[p.activeSlot]!.blueprint).toEqual(bad);
    expect(got.some((m) => m.type === 'toast' && /Old Faithful no longer passes the ship rules/.test((m as any).text))).toBe(true);
    // Every save writes the saved ship, never the loaner
    server.pilots.saveNow(conn);
    await flush();
    expect(((await store.load(3)) as PlayerProfile).ship.blueprint).toEqual(bad);
    t.disconnect();
    await flush();
    const after = (await store.load(3)) as PlayerProfile;
    expect(after.ship.blueprint).toEqual(bad);
    expect(after.hangar[after.activeSlot]!.blueprint).toEqual(bad);
  });

  it('losing the loaner costs nothing, and the respawn flies another', async () => {
    const { server, conn, pid } = await withBrokenSave(4);
    const p = server.pilots.get(conn)!;
    p.cargo = [{ id: 'iron_ore', n: 5 }] as any;
    const loaner = p.ship;
    server.pilots.onDestroyed(conn, 0, 0, 0, 0, 0);
    expect(p.ship).toBe(p.hangar[p.activeSlot]);
    expect(p.cargo).toEqual([{ id: 'iron_ore', n: 5 }]);
    expect(p.wreck).toBeUndefined();
    server.pilots.onRespawn(conn);
    expect(p.ship).not.toBe(loaner);
    expect(p.ship).not.toBe(p.hangar[p.activeSlot]);
    expect(server.getShips().get(pid)!.blueprint.name).not.toBe('Old Faithful');
  });

  it("what the loaner's machines hold is saved to storage, not lost with it", async () => {
    const { server, conn } = await withBrokenSave(5);
    const p = server.pilots.get(conn)!;
    p.ship.field = { held: { iron_ore: 7 } } as any;
    const out = server.pilots.persistable(conn, p);
    expect(out.ship).toBe(p.hangar[p.activeSlot]);
    expect(out.storage.find((s) => s.id === 'iron_ore')!.n).toBe((p.storage.find((s) => s.id === 'iron_ore')?.n ?? 0) + 7);
  });

  it('a refit of the slot (a design that passes) ends the loan', async () => {
    const { server, conn } = await withBrokenSave(6);
    const p = server.pilots.get(conn)!;
    const fixed = JSON.parse(JSON.stringify(p.ship.blueprint)) as Blueprint; // (the loaner's design passes the rules)
    const errors = server.hangar.save(conn, p.activeSlot, fixed, { grantAll: true });
    expect(errors).toEqual([]);
    expect(p.ship).toBe(p.hangar[p.activeSlot]);
    expect(server.pilots.persistable(conn, p).ship).toBe(p.ship);
  });
});
