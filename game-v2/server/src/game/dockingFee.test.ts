import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, InSystem, ServerMessage, Station as StationComp, DOCK_FEE_LEVEL } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

function liveServer() {
  resetGlobals();
  const userDB: any = { validateSession: async () => null, cleanupExpiredSessions: async () => {} };
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)), userDB, scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const profile = server.pilots.get(server.pilots.connOf(pid)!)!;
  return { server, t, got, pid, profile };
}

/** Put the player beside a station (by id), in its system */
function parkAt(server: GameServer, pid: number, id: string): void {
  const gd = (server as any).gameData as GameData;
  const world = server.getWorld();
  const num = gd.getStationNum(id);
  const st = [...Array(5000).keys()].find((e) => bitecs.entityExists(world, e) && bitecs.hasComponent(world, StationComp, e) && StationComp.stationId[e] === num)!;
  expect(st).toBeDefined();
  InSystem.systemId[pid] = InSystem.systemId[st];
  Position.x[pid] = Position.x[st] + 300;
  Position.y[pid] = Position.y[st];
}

const dock = (t: LocalTransport, got: ServerMessage[]) => {
  t.send({ type: 'dock' } as any);
  return got.filter((m) => m.type === 'dockResult').pop() as any;
};
const toasts = (got: ServerMessage[]) => got.filter((m) => m.type === 'toast').map((m) => (m as any).text as string);

describe('outer-ring docking fees', () => {
  it('only outer-ring stations charge one', () => {
    const gd = new GameData(readGameDataFiles(dataDir));
    const fees = gd.getAllStations().filter((s) => s.dockingFee).map((s) => s.id).sort();
    expect(fees).toEqual(['cinder_station_forge', 'maw_station_watch', 'nebula_research_station', 'void_station_lantern']);
    expect(gd.getStation('sol_station_central')?.dockingFee).toBeUndefined();
  });

  it('is free below the level, charged once a visit from it', () => {
    const { server, t, got, pid, profile } = liveServer();
    const fee = (server as any).gameData.getStation('nebula_research_station').dockingFee as number;
    parkAt(server, pid, 'nebula_research_station');
    profile.level = DOCK_FEE_LEVEL - 1;
    profile.credits = 1000;
    expect(dock(t, got).ok).toBe(true);
    expect(profile.credits).toBe(1000);
    t.send({ type: 'undock' } as any);

    profile.level = DOCK_FEE_LEVEL;
    expect(dock(t, got).ok).toBe(true);
    expect(profile.credits).toBe(1000 - fee);
    expect(toasts(got).pop()).toMatch(new RegExp(`Docking fee: ${fee} cr`));
    // Back out and in again: already paid this visit
    t.send({ type: 'undock' } as any);
    expect(dock(t, got).ok).toBe(true);
    expect(profile.credits).toBe(1000 - fee);
  });

  it('a pilot who cannot pay still docks: the shortfall goes on their station loan', () => {
    const { server, t, got, pid, profile } = liveServer();
    const fee = (server as any).gameData.getStation('void_station_lantern').dockingFee as number;
    parkAt(server, pid, 'void_station_lantern');
    profile.level = DOCK_FEE_LEVEL + 5;
    profile.credits = 30;
    profile.debt = undefined;
    expect(dock(t, got).ok).toBe(true);
    expect(profile.credits).toBe(0);
    expect(profile.debt).toBe(fee - 30);
    expect(toasts(got).pop()).toMatch(/station loan/);
  });

  it('core stations stay free at any level', () => {
    const { server, t, got, pid, profile } = liveServer();
    parkAt(server, pid, 'sol_station_central');
    profile.level = 60;
    // (its level ribbons already paid: docking counts as a stat, and ribbons pay out on any)
    profile.stats["ach:level_10"] = 1; profile.stats["ach:level_25"] = 1;
    profile.credits = 500;
    expect(dock(t, got).ok).toBe(true);
    expect(profile.credits).toBe(500);
  });
});
