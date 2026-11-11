/**
 * The dev message gate (gameServer/messages.ts, net/handlers/bank.ts): on a server without the dev flag, a pilot who is not an
 * owner cannot teleport, spawn, swap ships, build a station, touch the boss or the bank (an ordinary admin cannot either: SEC-17);
 * the owner can, and so can anyone on a dev server.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeEmptyServer, resetGlobals, joinPilot } from '../testkits/world.testkit.js';

function rig(devTeleport: boolean) {
  resetGlobals();
  const gs = makeEmptyServer({ devTeleport });
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

  it('an admin who is not the owner on a non-dev server is refused; the owner gets through', () => {
    const adm = rig(false);
    adm.conn.isAdmin = true;
    adm.sendAll();
    expect(adm.spies.travelTo).not.toHaveBeenCalled();
    expect(adm.spies.spawnPack).not.toHaveBeenCalled();
    expect(adm.spies.devSwapShip).not.toHaveBeenCalled();
    expect(adm.spies.bossDev).not.toHaveBeenCalled();
    expect(adm.gs.pilots.get(adm.conn)!.outpost ?? null).toBeNull();
    const { conn, spies, sendAll } = rig(false);
    conn.isAdmin = true;
    conn.isOwner = true;
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

  it("a plain pilot's devBoss never even looks for a boss, and devStation builds nothing", () => {
    const { gs, t, conn } = rig(false);
    const look = vi.spyOn(gs.bosses, 'inSystem'), toast = vi.spyOn(gs.pilots, 'toast');
    t.send({ type: 'devBoss', wear: 0.3 } as never);
    t.send({ type: 'devStation', tier: 5 } as never);
    gs.step(2);
    expect(look).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(gs.pilots.get(conn)!.outpost ?? null).toBeNull();
  });

  it('the owner: devStation clamps the tier to 0-5; devBoss in a system with no boss only says so', () => {
    const { gs, t, conn } = rig(false);
    conn.isAdmin = true; conn.isOwner = true;
    const toast = vi.spyOn(gs.pilots, 'toast');
    for (const [tier, want] of [[99, 5], [-4, 0]] as const) {
      t.send({ type: 'devStation', tier } as never);
      gs.step(1);
      const tracks = Object.values(gs.pilots.get(conn)!.outpost!.tracks);
      expect(tracks.length).toBeGreaterThan(0);
      expect(new Set(tracks)).toEqual(new Set([want]));
    }
    vi.spyOn(gs.bosses, 'inSystem').mockReturnValue([]);
    t.send({ type: 'devBoss', reset: true } as never);
    gs.step(1);
    expect(toast).toHaveBeenCalledWith(conn, 'No boss in this system', 'warn');
  });

  it('devSpawn refuses a spot that is not a finite point, even for the owner', () => {
    const { gs, t, conn, spies } = rig(false);
    conn.isAdmin = true; conn.isOwner = true;
    t.send({ type: 'devSpawn', x: Number.NaN, y: 5 } as never);
    t.send({ type: 'devSpawn', x: 5, y: Infinity } as never);
    gs.step(2);
    expect(spies.spawnPack).not.toHaveBeenCalled();
  });

  it('feedSwitch says so when the ship has no Selector, and does nothing at all without ports power', () => {
    const { gs, t, conn } = rig(false);
    const toast = vi.spyOn(gs.pilots, 'toast');
    toast.mockClear();
    t.send({ type: 'feedSwitch' } as never);
    gs.step(1);
    expect(toast).toHaveBeenCalledWith(conn, 'No Selector fitted. Nothing to switch.', 'warn');
    toast.mockClear();
    (gs.ships.get(conn.playerId)!.derived as { ports?: unknown }).ports = undefined;
    t.send({ type: 'feedSwitch' } as never);
    gs.step(1);
    expect(toast).not.toHaveBeenCalled();
  });
});
