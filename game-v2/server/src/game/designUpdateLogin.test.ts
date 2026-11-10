/**
 * The design update at login (Pilots.login -> migrateProfile with the game's mapping, data/ships/designUpdate.json):
 * a save below v5 that the deploy's bulk run missed is swapped by its account's name, not wiped.
 * (The saves are made up, shaped like the mapped ones: the names and part counts its `was` checks.)
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { ServerMessage, type Blueprint, type ShipRecord } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const shipConfig = loadShipConfigCached(dataDir);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** A saved ship named `name` with `n` parts (a library design cut down or padded with copies of one of its parts) */
function custom(name: string, n: number, from: string): ShipRecord {
  const bp: Blueprint = clone(shipConfig.library![from]);
  bp.name = name;
  const pad = bp.parts[bp.parts.length - 1];
  let uid = Math.max(...bp.parts.map((q) => q.uid)) + 1;
  while (bp.parts.length < n) bp.parts.push({ ...clone(pad), uid: uid++, x: 40 + bp.parts.length, y: 40 });
  bp.parts = bp.parts.slice(0, n);
  return { blueprint: bp, hp: {}, ghosts: [], plan: from };
}

/** A v4 save on account 9 (a Sparrow T of 24 parts, a stock Prospector flown, the Pooper design), signed in as `username` */
async function login(username: string) {
  resetGlobals();
  const store = new MemoryProfileStore();
  const server = makeServer({ profileStore: store, clock: () => 1_000_000 });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const conn = server.pilots.connOf(t.getPlayerId())!;
  const base = clone(server.pilots.get(conn)!) as any;
  const hangar = [custom('Sparrow T', 24, 'sparrow-t'), custom('Prospector', 17, 'prospector'), null, null, null];
  await store.save(9, {
    ...base, version: 4, xp: 3000, credits: 1234, skillPoints: 2, hangar, ship: hangar[1], activeSlot: 1,
    designs: [custom('Pooper', 30, 'prospector').blueprint], plans: ['sparrow-t', 'prospector', 'drum'],
  });
  (conn as any).userId = 9;
  (conn as any).username = username;
  await server.pilots.login(conn, 9);
  return { server, got, profile: server.pilots.get(conn)! };
}

describe('the design update at login', () => {
  it('the game loads the mapping and its remakes (blueprints/remakes), apart from the plan library', () => {
    expect(shipConfig.designUpdate?.accounts.Pig_Benis).toBeDefined();
    const ids = Object.keys(shipConfig.designUpdate!.blueprints);
    expect(ids).toContain('remakes/player-pigbenis-pooper');
    for (const id of ids.filter((x) => x.startsWith('remakes/'))) expect(shipConfig.library![id.slice(8)], id).toBeUndefined();
  });

  it("a mapped account's save below v5 is swapped by its username: remakes in place, progress kept, a one-time notice", async () => {
    const { got, profile: p } = await login('Pig_Benis');
    const bps = shipConfig.designUpdate!.blueprints;
    expect(p.version).toBe(6);
    expect(p.hangar[0]!.blueprint).toEqual(bps['remakes/player-pigbenis-sparrow']);
    expect(p.hangar[1]!.blueprint).toEqual(shipConfig.library!.prospector);
    expect(p.activeSlot).toBe(1);
    expect(p.designs).toEqual([bps['remakes/player-pigbenis-pooper']]);
    expect(p.xp).toBe(3000);
    expect(p.credits).toBe(1234);
    // (Never fewer: a login tops them up to what the level owes, as it always has: refundRetiredSkills)
    expect(p.skillPoints).toBeGreaterThanOrEqual(2);
    expect(p.plans).toEqual(['sparrow-t', 'prospector', 'drum']);
    // The notice, shown once and gone from the save
    expect(got.some((m) => m.type === 'toast' && /^Your ships have been rebuilt for the new power system/.test((m as any).text))).toBe(true);
    expect(got.some((m) => m.type === 'toast' && /reset/.test((m as any).text))).toBe(false);
    expect(p.notices).toBeUndefined();
  });

  it('an account not in the mapping is wiped (a fresh starter, the wipe notice)', async () => {
    const { got, profile: p } = await login('someone_else');
    expect(p.version).toBe(6);
    expect(p.hangar.slice(1).every((s) => s === null)).toBe(true);
    expect(p.ship.plan).toBe('sparrow-t');
    expect(p.xp).toBe(3000);
    expect(got.some((m) => m.type === 'toast' && /hangar has been reset/.test((m as any).text))).toBe(true);
  });
});
