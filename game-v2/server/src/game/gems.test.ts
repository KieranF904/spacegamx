import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { countOf, isWeaponFn, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)), clock: () => clock.t });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const profile = () => server.pilots.get(conn)!;
  (server as any).pilots.atStation = () => true;
  return { server, t, pid, conn, profile, clock, got };
}

/** Make the ship you fly's guns Mk III, Stingers (two sockets on a big one, one on a small one, from level 42) */
function titaniumGuns(w: ReturnType<typeof world>): number {
  const p = w.profile();
  for (const q of p.ship.blueprint.parts) if (isWeaponFn(q.fn)) Object.assign(q, { fn: 'autocannon_stinger', material: 'titanium' });
  w.server.pilots.reapplyShip(w.conn);
  return p.ship.blueprint.parts.find((q) => isWeaponFn(q.fn))!.uid;
}

describe('gems', () => {
  it('a gem goes into a socket and changes how that gun fires; out again, it breaks', () => {
    const w = titaniumGunsWorld();
    const { server, conn, profile } = w.w;
    profile().storage.push({ id: 'gem_scatter_1', n: 1 }, { id: 'gem_sight_1', n: 1 });
    // Too low a level: titanium's sockets open at 42
    server.hangar.socketGem(conn, 0, w.uid, 'gem_scatter_1');
    expect(countOf(profile().storage, 'gem_scatter_1')).toBe(1);
    server.pilots.addXp(conn, 2_000_000);
    server.hangar.socketGem(conn, 0, w.uid, 'gem_scatter_1');
    expect(countOf(profile().storage, 'gem_scatter_1')).toBe(0);
    const part = () => profile().ship.blueprint.parts.find((q) => q.uid === w.uid)!;
    expect(part().gems).toEqual(['gem_scatter_1']);
    expect(part().mods?.add?.burst).toBe(1);
    // The ship flying has it too
    expect(server.getShips().get(w.w.pid)!.blueprint.parts.find((q) => q.uid === w.uid)!.mods?.add?.burst).toBe(1);
    // A design saved over it can't forge gems, and keeps the ones it has
    const forged = JSON.parse(JSON.stringify(profile().ship.blueprint));
    for (const q of forged.parts) if (q.uid === w.uid) { q.gems = ['gem_scatter_2', 'gem_scatter_2']; q.mods = { add: { burst: 9 } }; }
    server.hangar.save(conn, 0, forged, { grantAll: true });
    expect(part().gems).toEqual(['gem_scatter_1']);
    expect(part().mods?.add?.burst).toBe(1);
    server.hangar.unsocketGem(conn, 0, w.uid, 0);
    expect(part().gems).toBeUndefined();
    expect(part().mods).toBeUndefined();
    expect(countOf(profile().storage, 'gem_scatter_1')).toBe(0);
  });

  it('a gem is lost with its part', () => {
    const w = titaniumGunsWorld();
    const { server, conn, profile, pid } = w.w;
    server.pilots.addXp(conn, 2_000_000);
    profile().storage.push({ id: 'gem_keel_1', n: 1 });
    server.hangar.socketGem(conn, 0, w.uid, 'gem_keel_1');
    const ships = server.getShips();
    const idx = ships.get(pid)!.blueprint.parts.findIndex((q) => q.uid === w.uid);
    ships.damagePartFraction(pid, idx, 1);
    server.step();
    expect(profile().ship.blueprint.parts.find((q) => q.uid === w.uid)!.gems).toBeUndefined();
  });

  it('cutting takes its stone and time, then the gem is in storage', () => {
    const { w } = titaniumGunsWorld();
    const p = w.profile();
    p.storage.push({ id: 'crystal', n: 3 }, { id: 'coolant', n: 1 });
    (w.server as any).services.at = () => ({ id: 'sol_station_central', services: ['fabricator'] });
    w.server['services'].cutGem(w.conn, { gem: 'frost', level: 1 });
    expect(countOf(p.storage, 'crystal')).toBe(0);
    w.clock.t += 301_000;
    w.server['services'].deliver(w.conn);
    expect(countOf(p.storage, 'gem_frost_1')).toBe(1);
  });
});

function titaniumGunsWorld() {
  const w = world();
  return { w, uid: titaniumGuns(w) };
}
