import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');

describe('ships in and out of view', () => {
  it('a ship that left your view comes back with its structure: kept while away, or synced afresh (never an invisible hull)', () => {
    (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
    const server = makeServer();
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: 'salvager' } as any);
    const pid = t.getPlayerId();
    // A derelict in Sol
    const wreck = (server as any).derelicts.find((d: any) => d.eid >= 0 && InSystem.systemId[d.eid] === InSystem.systemId[pid]);
    expect(wreck).toBeTruthy();
    const at = (x: number, y: number, ticks: number) => { for (let i = 0; i < ticks; i++) { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = Velocity.y[pid] = 0; server.step(); } };
    const synced = () => got.some((m) => m.type === 'shipSync' && (m as any).id === wreck.eid);
    const wx = Position.x[wreck.eid], wy = Position.y[wreck.eid];
    at(wx + 3000, wy, 30);
    expect(synced()).toBe(true);
    // Far out of view: it leaves the client's focus cells, and the client is told it keeps it (net/cells/AwayNet.ts: a
    // `cells` message, k), its structure and HP with it
    got.length = 0;
    at(wx + 120000, wy, 30);
    const kept = got.some((m) => m.type === 'cells' && ((m as any).k ?? []).includes(wreck.eid));
    got.length = 0;
    // Back beside it: held again, with the structure it kept, or synced afresh if it wasn't kept
    at(wx + 3000, wy, 30);
    const conn = (server as any).pilots.connOf(pid);
    expect(conn.shipView.has(wreck.eid)).toBe(true);
    expect(kept || synced()).toBe(true);
    if (kept) expect(got.some((m) => m.type === 'cells' && ((m as any).b ?? []).includes(wreck.eid))).toBe(true);
  });
});
