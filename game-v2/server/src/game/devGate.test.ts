/**
 * The dev message gate (gameServer/messages.ts, net/handlers/bank.ts): on a server without the dev flag, a pilot who is not an
 * admin cannot teleport, spawn, swap ships, build a station, touch the boss or the bank; an admin can, and so can anyone on a dev server.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeServer, resetGlobals, joinPilot } from '../testkits/world.testkit.js';

function rig(devTeleport: boolean) {
  resetGlobals();
  const gs = makeServer({ devTeleport });
  const { t } = joinPilot(gs, 'someone');
  const conn = gs.pilots.connOf(t.getPlayerId())!;
  gs.step(3);
  const spies = {
    travelTo: vi.spyOn(gs, 'travelTo'),
    spawnPack: vi.spyOn(gs.enemies, 'spawnPack'),
    devSwapShip: vi.spyOn(gs.pilots, 'devSwapShip'),
    devBank: vi.spyOn(gs.pilots, 'devBank'),
    bossDev: vi.spyOn(gs.bossDev, 'handle'),
  };
  const sendAll = () => {
    t.send({ type: 'devTeleport', systemId: 'sol', x: 100, y: 100 } as never);
    t.send({ type: 'devSpawn', x: 10, y: 10 } as never);
    t.send({ type: 'devShip', ship: 'prospector' } as never);
    t.send({ type: 'devStation', tier: 5 } as never);
    t.send({ type: 'devBoss', reset: true } as never);
    t.send({ type: 'bossDevTool', tool: 'x' } as never);
    t.send({ type: 'devBank', action: 'fill' } as never);
    gs.step(2);
  };
  return { gs, t, conn, spies, sendAll };
}

describe('dev message gate', () => {
  it('a plain pilot on a non-dev server moves nothing, spawns nothing, changes no ship, station or bank', () => {
    const { gs, conn, spies, sendAll } = rig(false);
    expect(conn.isAdmin).toBe(false);
    const own = gs.pilots.get(conn)!.ship.blueprint.name;
    sendAll();
    expect(spies.travelTo).not.toHaveBeenCalled();
    expect(spies.spawnPack).not.toHaveBeenCalled();
    expect(spies.devSwapShip).not.toHaveBeenCalled();
    expect(spies.devBank).not.toHaveBeenCalled();
    expect(spies.bossDev).not.toHaveBeenCalled();
    expect(gs.pilots.get(conn)!.outpost ?? null).toBeNull();
    expect(gs.pilots.get(conn)!.ship.blueprint.name).toBe(own);
  });

  it('an admin on a non-dev server gets through the gate', () => {
    const { conn, spies, sendAll } = rig(false);
    conn.isAdmin = true;
    sendAll();
    expect(spies.spawnPack).toHaveBeenCalled();
    expect(spies.devSwapShip).toHaveBeenCalled();
  });

  it('on a dev server anyone passes the gate', () => {
    const { spies, sendAll } = rig(true);
    sendAll();
    expect(spies.spawnPack).toHaveBeenCalled();
    expect(spies.devSwapShip).toHaveBeenCalled();
  });
});
