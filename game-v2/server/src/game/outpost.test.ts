import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { countOf } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

describe('your station', () => {
  it('is chartered at a site, and its tracks build over real time and then work', () => {
    resetGlobals();
    const clock = { t: 5_000_000 };
    const server = makeServer({ profileStore: new MemoryProfileStore(), clock: () => clock.t });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const toasts: string[] = [];
    t.onMessage = (m: any) => { if (m.type === 'toast') toasts.push(m.text); };
    const conn = server.pilots.connOf(t.getPlayerId())!;
    const p = server.pilots.get(conn)!;
    const services = (server as any).services;
    const outpost = (server as any).outpost;
    (server as any).pilots.atStation = () => true;
    services.stationAt = () => server['gameData'].getStation('sol_station_mining');
    services.at = () => server['gameData'].getStation('sol_station_mining');
    // Too low a level
    outpost.charter(conn, 'sol_outer');
    expect(p.outpost).toBeUndefined();
    server.pilots.addXp(conn, 200_000);
    p.credits = 25_000;
    server.pilots.give(conn, { alloy_plate: 600, steel_plate: 200, coolant: 50, iron_ore: 40, nickel_ore: 20 }, { toStorage: true, quiet: true });
    outpost.charter(conn, 'sol_outer');
    expect(p.outpost?.site).toBe('sol_outer');
    expect(p.credits).toBe(5_000);
    // The refinery's first tier: materials now, the perk once it's built
    outpost.upgrade(conn, 'refinery');
    expect(p.outpost!.build?.track).toBe('refinery');
    clock.t += 9 * 60_000;
    outpost.finish(conn);
    expect(p.outpost!.tracks.refinery).toBeUndefined();
    clock.t += 2 * 60_000;
    outpost.finish(conn);
    expect(p.outpost!.tracks.refinery).toBe(1);
    // Refining is 10% quicker
    services.refine(conn, { recipe: 'alloy_plate', batches: 10 });
    const job = p.jobs.find((j: any) => j.recipe === 'refine:alloy_plate')!;
    expect(job.unitMs).toBe(1800);
    expect(countOf(p.storage, 'alloy_plate')).toBeGreaterThan(0);
  });
});

describe('your station, in its own space', () => {
  it("the site's jump point takes you to your station's own copy, with its tracks built as structures; the gate brings you back", () => {
    resetGlobals();
    const gameData = new GameData(files);
    const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData,
      userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
      scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)) });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
    const p = server.pilots.get(conn)!;
    const homes = (server as any).homes;
    const sol = gameData.getSystemNum('sol');
    // Not chartered: nothing happens
    homes.jump(conn, 'sol', 27500, 16500);
    expect(InSystemRef().systemId[pid]).toBe(sol);
    p.outpost = { site: 'sol_outer', tracks: { refinery: 2, hangar: 1 } };
    homes.jump(conn, 'sol', 27500, 16500);
    const num = InSystemRef().systemId[pid];
    expect(gameData.getSystemInstances('homestead')).toContain(num);
    const bodies = [...server.getShips().bodies.keys()].filter((e) => InSystemRef().systemId[e] === num && e !== pid);
    expect(bodies.length).toBe(2);
    // A track finishes while you're there: it goes up
    p.outpost.tracks.storage = 1;
    for (let i = 0; i < 61; i++) server.step();
    expect([...server.getShips().bodies.keys()].filter((e) => InSystemRef().systemId[e] === num && e !== pid).length).toBe(3);
    expect(homes.leave(conn, num)).toBe(true);
    expect(InSystemRef().systemId[pid]).toBe(sol);
    // Nobody there: unloaded
    for (let i = 0; i < 60 * 32; i++) server.step();
    expect([...server.getShips().bodies.keys()].filter((e) => InSystemRef().systemId[e] === num).length).toBe(0);
  });
});

import { InSystem as InSystemComp } from '@space-game/common';
import { makeServer } from '../testkits/world.testkit.js';
function InSystemRef() { return InSystemComp; }
