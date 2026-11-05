import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');

describe('dev ship swap', () => {
  it('flies a library ship at once, and what is saved is always the real ship', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, devTeleport: true, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'swapper' } as any);
    const pid = t.getPlayerId();
    const conn = server.pilots.connOf(pid)!;
    const bridge = server.getShips();
    const own = server.pilots.get(conn)!.ship.blueprint.name;
    server.step(5);

    t.send({ type: 'devShip', ship: 'prospector' } as any);
    server.step(2);
    expect(bridge.get(pid)!.blueprint.name).toBe('Prospector');
    expect(bridge.get(pid)!.derived.miners.length).toBe(1);
    // (What would be written to disk is the real ship, whatever is flown)
    const saved = (server.pilots as any).persistable(conn, server.pilots.get(conn)!);
    expect(saved.ship.blueprint.name).toBe(own);
    expect(saved.hangar[saved.activeSlot].blueprint.name).toBe(own);

    // Another one, then back
    t.send({ type: 'devShip', ship: 'wisp' } as any);
    server.step(2);
    expect(bridge.get(pid)!.blueprint.name).toBe('Wisp');
    expect((server.pilots as any).persistable(conn, server.pilots.get(conn)!).ship.blueprint.name).toBe(own);
    t.send({ type: 'devShip' } as any);
    server.step(2);
    expect(bridge.get(pid)!.blueprint.name).toBe(own);
    expect(server.pilots.get(conn)!.ship.blueprint.name).toBe(own);

    // A name that isn't in the library changes nothing
    t.send({ type: 'devShip', ship: 'nope' } as any);
    server.step(2);
    expect(bridge.get(pid)!.blueprint.name).toBe(own);

    // A dev test ship (blueprints/dev: never in the plan library), its guns hitting as hard as its material says
    expect(bridge.library.has('annihilator')).toBe(false);
    t.send({ type: 'devShip', ship: 'annihilator' } as any);
    server.step(2);
    expect(bridge.get(pid)!.blueprint.name).toBe('Dev Annihilator');
    expect(bridge.get(pid)!.derived.weapons.length).toBe(8);
  });

  it('losing a borrowed ship gives your own back: nothing salvaged, nothing on order, no wreck', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, devTeleport: true, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'crasher' } as any);
    const pid = t.getPlayerId();
    const conn = server.pilots.connOf(pid)!;
    const p = server.pilots.get(conn)!;
    const own = p.ship.blueprint.name, slots = p.hangar.length;
    const storage = JSON.stringify(p.storage);
    server.step(5);
    t.send({ type: 'devShip', ship: 'sunspear' } as any);
    server.step(2);
    expect(server.getShips().get(pid)!.blueprint.name).not.toBe(own);
    server.pilots.onDestroyed(conn, 0, 0, 0, 0, 0);
    const after = server.pilots.get(conn)!;
    expect(after.ship.blueprint.name).toBe(own);
    expect(after.ship.loaner).toBeFalsy();
    expect(after.hangar.length).toBe(slots);
    expect(JSON.stringify(after.storage)).toBe(storage);
    expect(after.wreck).toBeUndefined();
  });

  it('is refused on a server that is not a dev server', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = new GameServer({
      gameData: new GameData(readGameDataFiles(dataDir)), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'cheat' } as any);
    const pid = t.getPlayerId();
    const own = server.getShips().get(pid)!.blueprint.name;
    server.step(5);
    t.send({ type: 'devShip', ship: 'sunspear' } as any);
    server.step(2);
    expect(server.getShips().get(pid)!.blueprint.name).toBe(own);
  });
});
