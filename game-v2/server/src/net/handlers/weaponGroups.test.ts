/**
 * The field overlay's weapon groups message (net/handlers/weaponGroups.ts): it changes which groups the live ship's
 * weapons are in, free, on the live blueprint and the saved record together; the ship is refitted so its design hash
 * changes and the pilots near it get the new design (and so step its guns on the new groups). Weapons only.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, packGroupSel, partWeaponGroups, loadCatalog, type Blueprint, type PlacedPart, type Rot, type ServerMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { LocalTransport } from '../LocalTransport.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const config = loadShipConfigCached(dataDir);
const catalog = loadCatalog(config.catalog);

const part = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });

/** A 2x1 core with two Pips on top and a hull under it */
const design = (): Blueprint => ({
  name: 'Groups test', catalogVersion: catalog.version, power: 'ports',
  parts: [part(0, 'rect2', 'core', 0, 0), part(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' }), part(2, 'sq', 'cannon_pip', 1, -1, { facing: 'N' }), part(3, 'sq', 'hull', 0, 1)],
});

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(config),
    clock: () => 1_000_000,
  });
  const join = (name: string, x: number) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const pid = t.getPlayerId();
    Position.x[pid] = x; Position.y[pid] = 40000; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
    return { t, got, pid, conn: server.pilots.connOf(pid)! };
  };
  const a = join('wright', 40000);
  const prof = server.pilots.get(a.conn)!;
  prof.ship.blueprint = JSON.parse(JSON.stringify(design()));
  prof.ship.hp = {}; prof.ship.ghosts = [];
  server.pilots.reapplyShip(a.conn);
  const b = join('onlooker', 40300);
  const ships = server.getShips()!;
  const run = (n: number) => { for (let k = 0; k < n; k++) server.step(); };
  run(3);
  return { server, a, b, prof, ships, run, ship: () => ships.get(a.pid)! };
}

describe('weaponGroups (the field overlay)', () => {
  it('puts a weapon in a group on the live blueprint and the saved record, and others get the new design', () => {
    const w = world();
    const before = w.ship();
    expect(before.blueprint.parts.map((p) => partWeaponGroups(p))).toEqual([1, 1, 1, 1]);
    w.b.got.length = 0;
    w.a.t.send({ type: 'weaponGroups', groups: { 1: 0b0110, 2: 0b0001 } } as any);
    w.run(60);
    const after = w.ship();
    expect(after).not.toBe(before);
    expect(partWeaponGroups(after.blueprint.parts[after.blueprint.parts.findIndex((p) => p.uid === 1)])).toBe(0b0110);
    expect(partWeaponGroups(after.blueprint.parts[after.blueprint.parts.findIndex((p) => p.uid === 2)])).toBe(1);
    expect(w.prof.ship.blueprint.parts.find((p) => p.uid === 1)?.wg).toBe(0b0110);
    expect(w.prof.ship.blueprint.parts.find((p) => p.uid === 2)?.wg).toBeUndefined();
    // (The pilot nearby is sent the new design: a new ship sync for it)
    const sync = w.b.got.find((m) => m.type === 'shipSync' && (m as { id: number }).id === w.a.pid) as { blueprint?: Blueprint; design?: string } | undefined;
    expect(sync).toBeDefined();
    expect(sync!.blueprint?.parts.find((p) => p.uid === 1)?.wg).toBe(0b0110);
  });

  it('ignores parts that are not weapons, junk masks and over-long messages; a weapon is never in no group', () => {
    const w = world();
    const was = w.ship();
    w.a.t.send({ type: 'weaponGroups', groups: { 0: 2, 3: 4, 99: 2, 1: 99, 2: -1 } } as any);
    w.run(2);
    expect(w.ship()).toBe(was);
    // (a mask of 0 means the default: group 1)
    w.a.t.send({ type: 'weaponGroups', groups: { 1: 4 } } as any);
    w.run(2);
    w.a.t.send({ type: 'weaponGroups', groups: { 1: 0 } } as any);
    w.run(2);
    expect(partWeaponGroups(w.ship().blueprint.parts.find((p) => p.uid === 1))).toBe(1);
    expect(w.ship().blueprint.parts.find((p) => p.uid === 1)?.wg).toBeUndefined();
  });

  it('is free: nothing leaves the hold, and the selection byte is untouched', () => {
    const w = world();
    const cargo = JSON.stringify(w.prof.cargo);
    w.a.t.send({ type: 'weaponGroups', groups: { 1: 2 } } as any);
    w.run(2);
    expect(JSON.stringify(w.prof.cargo)).toBe(cargo);
    expect(packGroupSel(0, 0)).toBe(0);
  });
});
