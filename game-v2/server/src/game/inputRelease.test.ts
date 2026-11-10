/**
 * Letting go of the controls (GameServer.releaseControls, inputFields.ts INPUT_HELD): docking and quitting mid-fight
 * (the linger) release every held key, the Burst Strafer's dodge included, and leave helm (a mode) and the aim alone.
 * A dodge left held would fire once its block ended (a jump's spool or burn) with nobody flying.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, InSystem, Position, Station as StationComp, INPUT_HELD, type ClientSocket } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

function setup() {
  resetGlobals();
  const server = makeServer();
  let open = true;
  const socket: ClientSocket = { isOpen: () => open, send: () => {}, close: () => { open = false; } };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: 'pilot' } as any);
  const conn = [...(server as any).clients.values()][0];
  const pid = conn.playerId as number;
  // Every key held, flying at the helm, aiming somewhere (written straight in, as the tick's input drain does)
  (server as any).applyInputToEntity(conn, {
    type: 'input', seq: 1, tick: 0, forward: true, backward: true, left: true, right: true, boost: true,
    fireLeft: true, fireRight: true, targetAngle: 1, strafeLeft: true, strafeRight: true, helm: true, cursorDist: 400,
    jump: true, dodge: true,
  } as any);
  for (const k of INPUT_HELD) expect(Input[k][pid], k).toBe(1);
  return { server, link, conn, pid, close: () => { open = false; link.close(); } };
}

function expectReleased(pid: number, aim: number) {
  for (const k of INPUT_HELD) expect(Input[k][pid], k).toBe(0);
  expect(Input.helm[pid]).toBe(1);
  expect(Input.targetAngle[pid]).toBe(aim);
}

describe('releasing the controls', () => {
  it('docking lets go of every held key, dodge included', () => {
    const { server, link, pid } = setup();
    const gd = (server as any).gameData as GameData;
    const world = server.getWorld();
    const num = gd.getStationNum('sol_station_central');
    const st = [...Array(5000).keys()].find((e) => bitecs.entityExists(world, e) && bitecs.hasComponent(world, StationComp, e) && StationComp.stationId[e] === num)!;
    InSystem.systemId[pid] = InSystem.systemId[st];
    Position.x[pid] = Position.x[st] + 300;
    Position.y[pid] = Position.y[st];
    const aim = Input.targetAngle[pid];
    link.receive({ type: 'dock' } as any);
    expect((server as any).dockedShips.has(pid)).toBe(true);
    expectReleased(pid, aim);
  });

  it('quitting mid-fight (the ship lingers) lets go of every held key, dodge included', () => {
    const { server, conn, pid, close } = setup();
    conn.userId = 'u1';
    (server as any).ships.lastDamagedTick = () => (server as any).currentTick;
    const aim = Input.targetAngle[pid];
    close();
    expect((server as any).lingering.has(pid)).toBe(true);
    expectReleased(pid, aim);
  });
});
