import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import type { ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { devGuestShips } from '../data/devData.js';
import { readFileSync } from 'fs';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const env = process.env.NODE_ENV;

/** A guest's authResult on a server started with or without guestAdmin */
function guestJoin(guestAdmin: boolean): boolean | undefined {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({ guestAdmin });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'visitor' } as any);
  return (got.find((m) => m.type === 'authResult') as { isAdmin?: boolean } | undefined)?.isAdmin;
}

describe('guest admins (dev server only)', () => {
  afterEach(() => { process.env.NODE_ENV = env; });

  it('guests are admins on a dev server, and not otherwise', () => {
    process.env.NODE_ENV = 'development';
    expect(guestJoin(true)).toBe(true);
    expect(guestJoin(false)).toBe(false);
  });

  it('never under production, even if a production server were started with it', () => {
    process.env.NODE_ENV = 'production';
    expect(guestJoin(true)).toBe(false);
  });
});

/** The hangar a guest is given on a server started with these guest designs */
function guestHangar(guestShips: unknown[]): (string | null)[] {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({ guestShips: guestShips as any });
  const t = new LocalTransport(server);
  t.onMessage = () => {};
  t.connect();
  t.send({ type: 'join', username: 'visitor' } as any);
  const s = [...(server as any).pilots.sessions.values()][0];
  return s.profile.hangar.map((r: { blueprint: { name: string } } | null) => r?.blueprint.name ?? null);
}

describe('guest ships (dev server only)', () => {
  afterEach(() => { process.env.NODE_ENV = env; });

  it("guests on a dev server find the dev guest designs in their hangar's free bays (none bundled now: they get the ports starter)", () => {
    process.env.NODE_ENV = 'development';
    // (The pool-era guest Sparrow is gone: no data/ships/blueprints/dev/guest-*.json, so a guest has the starter alone)
    expect(devGuestShips(dataDir)).toEqual([]);
    expect(guestHangar([]).filter(Boolean)).toHaveLength(1);
    // (A guest design dropped into dev/ still lands in the free bays)
    const ships = [{ ...JSON.parse(readFileSync(join(dataDir, 'ships/blueprints/dev/ports-wren.json'), 'utf-8')), name: 'Guest Wren' }];
    const hangar = guestHangar(ships);
    expect(hangar.slice(1, 1 + ships.length)).toEqual(ships.map((b) => (b as { name: string }).name));
    expect(hangar[0]).not.toBeNull();
  });

  it('never under production', () => {
    process.env.NODE_ENV = 'production';
    expect(guestHangar([JSON.parse(readFileSync(join(dataDir, 'ships/blueprints/dev/ports-wren.json'), 'utf-8'))]).filter(Boolean)).toHaveLength(1);
  });
});
