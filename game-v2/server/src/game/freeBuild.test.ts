import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Station as StationComp, partItemId, type Blueprint, type ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const env = process.env.NODE_ENV;
const files = readGameDataFiles(dataDir);

/** A guest docked at Sol Central on a server started with (or without) free build; `admin` makes them one */
function world(opts: { freeBuild?: boolean; admin?: boolean }) {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({ freeBuild: opts.freeBuild });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'builder' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)! as unknown as { isAdmin: boolean };
  conn.isAdmin = !!opts.admin;
  const w = server.getWorld();
  const num = server['gameData'].getStationNum('sol_station_central');
  const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
  Position.x[pid] = Position.x[st] + 300; Position.y[pid] = Position.y[st];
  Velocity.x[pid] = 0; Velocity.y[pid] = 0;
  server.step();
  const profile = () => server.pilots.get(server.pilots.connOf(pid)!)!;
  const last = <T extends ServerMessage['type']>(type: T) => [...got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  // The starter with a Stinger (a level 24 autocannon) for a gun, and nothing in storage or the hold
  const stinger = (): Blueprint => {
    const bp: Blueprint = JSON.parse(JSON.stringify(server.getShips().library.get('sparrow-t')!));
    const gun = bp.parts.find((q) => q.fn === 'cannon_pip')!;
    gun.fn = 'autocannon_stinger';
    gun.material = 'titanium';
    profile().storage = [];
    profile().cargo = [];
    return bp;
  };
  return { server, t, pid, profile, last, stinger };
}

describe('free build (dev servers only)', () => {
  afterEach(() => { process.env.NODE_ENV = env; });

  it('is refused on a server that doesn\'t allow it, and a refit still needs the parts and their licence', () => {
    process.env.NODE_ENV = 'development';
    const { t, last, stinger } = world({ admin: true });
    t.send({ type: 'admin', cmd: 'freebuild', args: { on: true } } as any);
    expect(last('adminResult')).toMatchObject({ ok: false, text: expect.stringMatching(/only on dev servers/) });
    expect(last('hangar')!.freeBuild).toBeUndefined();
    t.send({ type: 'admin', cmd: 'info', args: {} } as any);
    expect((last('adminInfo') as { freeBuild?: boolean }).freeBuild).toBe(false);
    t.send({ type: 'slotSave', slot: 1, blueprint: stinger() } as any);
    expect(last('shipEditResult')).toMatchObject({ ok: false, errors: [expect.stringMatching(/licensed/)] });
  });

  it('is refused under production, even on a server started with it', () => {
    process.env.NODE_ENV = 'production';
    const { t, last, stinger, profile } = world({ freeBuild: true, admin: true });
    t.send({ type: 'admin', cmd: 'freebuild', args: { on: true } } as any);
    expect(last('adminResult')!.ok).toBe(false);
    t.send({ type: 'slotSave', slot: 1, blueprint: stinger() } as any);
    expect(last('shipEditResult')!.ok).toBe(false);
    expect(profile().hangar[1]).toBeNull();
  });

  it('is for admins only', () => {
    process.env.NODE_ENV = 'development';
    const { t, last, stinger } = world({ freeBuild: true });
    t.send({ type: 'admin', cmd: 'freebuild', args: { on: true } } as any);
    expect(last('adminResult')).toMatchObject({ ok: false, text: 'Admins only' });
    t.send({ type: 'slotSave', slot: 1, blueprint: stinger() } as any);
    expect(last('shipEditResult')!.ok).toBe(false);
  });

  it('on a dev server, an admin who switches it on places any part, and the save takes nothing', () => {
    process.env.NODE_ENV = 'development';
    const { t, last, stinger, profile } = world({ freeBuild: true, admin: true });
    t.send({ type: 'admin', cmd: 'info', args: {} } as any);
    expect((last('adminInfo') as { freeBuild?: boolean }).freeBuild).toBe(true);
    t.send({ type: 'admin', cmd: 'freebuild', args: { on: true } } as any);
    expect(last('adminResult')!.ok).toBe(true);
    expect(last('hangar')!.freeBuild).toBe(true);
    const bp = stinger();
    t.send({ type: 'slotSave', slot: 1, blueprint: bp } as any);
    expect(last('shipEditResult')).toMatchObject({ ok: true });
    const rec = profile().hangar[1]!;
    expect(rec.ghosts).toEqual([]);
    expect(rec.blueprint.parts.map(partItemId)).toContain('part:titanium:autocannon_stinger:sq');
    expect(profile().storage).toEqual([]);
    // Off again: back to the rules
    t.send({ type: 'admin', cmd: 'freebuild', args: { on: false } } as any);
    expect(last('hangar')!.freeBuild).toBeUndefined();
    t.send({ type: 'slotSave', slot: 2, blueprint: stinger() } as any);
    expect(last('shipEditResult')!.ok).toBe(false);
  });
});

describe('refits', () => {
  it('take modules from your hold as well as storage', () => {
    process.env.NODE_ENV = 'development';
    const { t, last, profile } = world({});
    profile().level = 30;
    const refit = () => {
      const bp: Blueprint = JSON.parse(JSON.stringify(profile().ship.blueprint));
      const gun = bp.parts.find((q) => q.fn === 'cannon_pip')!;
      gun.fn = 'autocannon_rattler';
      return { bp, uid: gun.uid };
    };
    profile().storage = [];
    profile().cargo = [{ id: 'part:alloy:autocannon_rattler:sq', n: 1 }];
    const { bp, uid } = refit();
    t.send({ type: 'slotSave', slot: profile().activeSlot, blueprint: bp } as any);
    expect(last('shipEditResult')!.ok).toBe(true);
    expect(profile().ship.ghosts ?? []).not.toContain(uid);
    expect(profile().cargo.find((s) => s.id === 'part:alloy:autocannon_rattler:sq')).toBeUndefined();
    // (the Pip it replaced went to storage)
    expect(profile().storage.find((s) => s.id === 'part:alloy:cannon_pip:sq')?.n).toBe(1);
  });
});
