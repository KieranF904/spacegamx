import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { countOf } from '@space-game/common';
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

describe('fabrication orders', () => {
  it('short of plate, an order refines it from ore (waiting for ore if need be), then makes the thing', () => {
    resetGlobals();
    const clock = { t: 1_000_000 };
    const server = makeServer({ profileStore: new MemoryProfileStore(), clock: () => clock.t });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const conn = server.pilots.connOf(t.getPlayerId())!;
    const p = server.pilots.get(conn)!;
    p.storage = [{ id: 'iron_ore', n: 12 }, { id: 'nickel_ore', n: 6 }, { id: 'copper_ore', n: 3 }];
    const run = (secs: number) => { for (let i = 0; i < secs; i++) { clock.t += 1000; for (let k = 0; k < 60; k++) server.step(); } };
    // 3 crates of HV shells: 6 alloy plate (12 iron, 6 nickel) and 3 wire (2 copper)
    server.hangar.orderItem(conn, 'cannon_hv', 3);
    run(40);
    expect(countOf(p.storage, 'cannon_hv')).toBe(3);
    expect(p.fabOrders).toBeUndefined();
    // No ore: it waits, and goes on when the ore turns up
    server.hangar.orderItem(conn, 'cannon_hv', 1);
    run(5);
    expect(p.fabOrders?.length).toBe(1);
    server.pilots.give(conn, { iron_ore: 4, nickel_ore: 2, copper_ore: 1 }, { toStorage: true, quiet: true });
    run(30);
    expect(countOf(p.storage, 'cannon_hv')).toBe(4);
  });

  it('a component a part needs (a power coupling) is fabricated from its own inputs, not left short', () => {
    resetGlobals();
    const clock = { t: 1_000_000 };
    const server = makeServer({ profileStore: new MemoryProfileStore(), clock: () => clock.t });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const conn = server.pilots.connOf(t.getPlayerId())!;
    const p = server.pilots.get(conn)!;
    p.recipes.push('fn:core');
    // A core: 3 alloy plate, 4 wire and a power coupling; no coupling in storage, but its wire and electronics are
    p.storage = [{ id: 'alloy_plate', n: 3 }, { id: 'copper_wire', n: 10 }, { id: 'scrap_electronics', n: 3 }];
    const run = (secs: number) => { for (let i = 0; i < secs; i++) { clock.t += 1000; for (let k = 0; k < 60; k++) server.step(); } };
    server.hangar.orderItem(conn, 'part:alloy:core:sq', 1);
    // (the coupling takes a minute, the core two)
    run(200);
    expect(countOf(p.storage, 'part:alloy:core:sq')).toBe(1);
    expect(p.fabOrders).toBeUndefined();
  });
});
