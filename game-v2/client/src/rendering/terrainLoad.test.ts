/**
 * A surface's rock is a chunk of its own (terrainData.ts): a join or system change is held at the gate (app/frameGate.ts)
 * until it's in, so the first predicted tick there already has the rock, exactly the server's; and every surface's rock
 * is fetched soon after the first join, so going to one later isn't held at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'path';
import type { ServerMessage } from '@space-game/common';
import { terrainFor, terrainHold, loadTerrain } from './terrainData';
import { FrameGate } from '../app/frameGate';
import { JumpControl, type JumpControlHost } from '../ships/jump/JumpControl';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { GameData } from '../../../server/src/data/GameData';
import { readGameDataFiles } from '../../../server/src/data/loadGameDataFromDisk';

const DATA = join(__dirname, '../../../data');
const tuning = loadShipConfigCached(DATA).tuning;

const playerState = (systemId: string) => ({ type: 'playerState', systemId, hp: 100, maxHp: 100, boostFuel: 0, maxBoostFuel: 0, xp: 0, level: 1, credits: 0 }) as unknown as ServerMessage;
const systemInfo = (systemId: string) => ({ type: 'systemInfo', systemId, name: systemId, centralBody: { type: 'none' } }) as unknown as ServerMessage;
const snapshot = { type: 'snapshot' } as unknown as ServerMessage;

/** Game's side of the gate, cut down: systemInfo sets the flight world (as ShipMessages does), a snapshot is the first tick predicted with it */
function client() {
  const jc = new JumpControl({ state: { playerId: 1, entities: new Map() }, store: { get: () => undefined } } as unknown as JumpControlHost, tuning);
  const log: string[] = [];
  const firstTick: { terrain: unknown }[] = [];
  const gate = new FrameGate(
    (msg) => {
      log.push(msg.type);
      if (msg.type === 'systemInfo') jc.onSystemInfo(msg);
      if (msg.type === 'snapshot') firstTick.push({ terrain: jc.replicaEnv().terrain });
    },
    () => log.push('end'),
    terrainHold,
  );
  const frame = (...msgs: ServerMessage[]) => { for (const m of msgs) gate.message(m); gate.end(); };
  return { jc, log, firstTick, gate, frame };
}

describe('a surface\'s rock loads before its system is handled', () => {
  it('a join to a surface: held until the rock is in, then the first predicted tick has it, the server\'s own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    expect(terrainFor('ashfall_surface')).toBeNull(); // not in yet (and not built without it)
    const c = client();
    c.frame(playerState('ashfall_surface'), systemInfo('ashfall_surface'));
    c.frame(snapshot);
    expect(c.log).toEqual([]);
    expect(c.gate.open).toBe(false);
    await loadTerrain('ashfall_surface');
    await Promise.resolve();
    // in order, as they came
    expect(c.log).toEqual(['playerState', 'systemInfo', 'end', 'snapshot', 'end']);
    const server = new GameData(readGameDataFiles(DATA)).terrain('ashfall_surface')!;
    expect(c.firstTick[0].terrain).toBe(terrainFor('ashfall_surface'));
    expect((c.firstTick[0].terrain as typeof server).pieces).toEqual(server.pieces);

    // the first join fetches every other surface's rock a moment later: going to one isn't held
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await loadTerrain('ashfall_cavern');
    await loadTerrain('sol_scrap_nest');
    c.frame(playerState('ashfall_cavern'), systemInfo('ashfall_cavern'));
    c.frame(snapshot);
    expect(c.log.slice(5)).toEqual(['playerState', 'systemInfo', 'end', 'snapshot', 'end']);
    expect(c.firstTick[1].terrain).toBe(terrainFor('ashfall_cavern'));
    expect(c.firstTick[1].terrain).not.toBeNull();
  });

  it('a system with no rock is never held', () => {
    const c = client();
    c.frame(playerState('sol'), systemInfo('sol'));
    c.frame(snapshot);
    expect(c.log).toEqual(['playerState', 'systemInfo', 'end', 'snapshot', 'end']);
    expect(c.firstTick[0].terrain).toBeNull();
    // (the gun range's walls come from systems.json: no file to wait for)
    expect(terrainHold(playerState('gun_range'))).toBeNull();
  });

  it('a dropped connection drops what it was holding', async () => {
    // (a load of its own to hold on: every rock is in by now)
    const log: string[] = [];
    let done!: () => void;
    const g = new FrameGate((m) => log.push(m.type), () => log.push('end'), (m) => (m.type === 'playerState' ? new Promise<void>((r) => (done = r)) : null));
    g.message(playerState('x'));
    g.end();
    g.drop();
    done();
    await new Promise((r) => setTimeout(r));
    expect(log).toEqual([]);
    expect(g.open).toBe(true);
    g.message(snapshot);
    expect(log).toEqual(['snapshot']);
  });
});
