/**
 * The hold (game/pilots/cargo.ts): cargo never exceeds capacity. give() takes only what fits and hands back the rest;
 * moving from storage clips to the room left; only toStorage (storage has no capacity) skips the check.
 */
import { describe, it, expect } from 'vitest';
import { Position, Velocity, Station as StationComp } from '@space-game/common';
import * as bitecs from 'bitecs';
import { joinPilot, makeServer, resetGlobals, stepServer } from '../../testkits/world.testkit.js';
import { cargoCapacity, cargoUsed, cargoFree } from './cargo.js';

function rig() {
  resetGlobals();
  const server = makeServer();
  const p = joinPilot(server, 'Hauler');
  const conn = server.pilots.connOf(p.pid)!;
  const profile = () => server.pilots.get(conn)!;
  const used = () => cargoUsed(server.pilots, profile());
  const cap = () => cargoCapacity(server.pilots, conn);
  return { server, p, conn, profile, used, cap };
}

describe('cargo capacity', () => {
  it('give() takes only what fits and returns the rest, so the hold never goes over', () => {
    const { server, conn, profile, used, cap } = rig();
    expect(cap()).toBeGreaterThan(0);
    const vol = server.econ.items.volume('steel_plate');
    const want = Math.ceil(cap() / vol) * 3;
    const left = server.pilots.give(conn, { steel_plate: want }, { quiet: true });
    expect(used()).toBeLessThanOrEqual(cap() + 1e-6);
    const got = profile().cargo.find((s) => s.id === 'steel_plate')!.n;
    expect(got + (left.steel_plate ?? 0)).toBe(want);
    expect(left.steel_plate).toBeGreaterThan(0);
    // (Full: another stack of anything fits nothing, and is all handed back)
    expect(cargoFree(server.pilots, conn)).toBeLessThan(vol);
    expect(server.pilots.give(conn, { steel_plate: 5 }, { quiet: true })).toEqual({ steel_plate: 5 });
    expect(used()).toBeLessThanOrEqual(cap() + 1e-6);
  });

  it('toStorage is the only way past it: the hold is untouched', () => {
    const { server, conn, profile, used, cap } = rig();
    const vol = server.econ.items.volume('steel_plate');
    const want = Math.ceil(cap() / vol) * 3;
    expect(server.pilots.give(conn, { steel_plate: want }, { toStorage: true, quiet: true })).toEqual({});
    expect(used()).toBe(0);
    expect(profile().storage.find((s) => s.id === 'steel_plate')!.n).toBe(want);
  });

  it('moving from storage to the hold clips to the room left', () => {
    const { server, p, conn, profile, used, cap } = rig();
    const vol = server.econ.items.volume('steel_plate');
    const want = Math.ceil(cap() / vol) * 3;
    server.pilots.give(conn, { steel_plate: want }, { toStorage: true, quiet: true });
    // (Beside a station, where storage can be reached)
    const w = server.getWorld();
    const num = server['gameData'].getStationNum('sol_station_central');
    const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
    Position.x[p.pid] = Position.x[st] + 300; Position.y[p.pid] = Position.y[st];
    Velocity.x[p.pid] = 0; Velocity.y[p.pid] = 0;
    stepServer(server, 1);
    server.pilots.handleMove(conn, { id: 'steel_plate', n: want, to: 'cargo' });
    expect(used()).toBeLessThanOrEqual(cap() + 1e-6);
    const inHold = profile().cargo.find((s) => s.id === 'steel_plate')!.n;
    expect(inHold).toBe(Math.floor(cap() / vol + 1e-9));
    expect(profile().storage.find((s) => s.id === 'steel_plate')!.n).toBe(want - inHold);
  });
});
