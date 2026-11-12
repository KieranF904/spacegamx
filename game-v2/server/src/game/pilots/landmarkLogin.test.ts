/**
 * Logging out by a moving landmark and coming back by it (common world/landmarks.ts, pilots/persist.ts capture and
 * applyProfile; docs/design/landmark-tracking-2026-11.md): the save carries the landmark and the pilot's offset from it
 * beside the absolute spot; the next login, on the same server later or on a restarted one whose ticks start over,
 * puts them at that offset from wherever the landmark is then. Open space, an older save without the field and a
 * landmark that is gone all load at the saved spot, as before.
 */
import { describe, it, expect } from 'vitest';
import { Position, Velocity, InSystem, Station, landmarkPosition, type PlayerProfile } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import { LocalTransport } from '../../net/LocalTransport.js';
import { MemoryProfileStore } from '../../profile/ProfileStore.js';
import { stationQuery } from '../Docking.js';
import { makeServer, resetGlobals, stepServer } from '../../testkits/world.testkit.js';

const CENTRAL = 'station:sol_station_central';
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const userDB = {
  validateSession: async (t: string) => (t === 'tok' ? { id: 1, username: 'pilot', email: '', is_admin: false, created_at: '' } : null),
  cleanupExpiredSessions: async () => {},
};

/** A sector-world server on `store` (a fresh one is a restart: its ticks start over) and "pilot" signing in to it */
function serverOn(store: MemoryProfileStore) {
  resetGlobals();
  const server = makeServer({ userDB: userDB as never, profileStore: store });
  const join = async () => {
    const t = new LocalTransport(server);
    t.onMessage = () => {};
    t.connect();
    t.send({ type: 'join', username: 'pilot', token: 'tok' } as never);
    await flush();
    const conn = () => [...(server as unknown as { clients: Map<unknown, { ws: unknown }> }).clients.values()].find((c) => c.ws === (t as unknown as { socket: unknown }).socket)!;
    return { t, pid: t.getPlayerId(), conn };
  };
  return { server, join };
}

function central(server: GameServer) {
  const num = server.gameData.getStationNum('sol_station_central');
  const eid = [...stationQuery(server.world)].find((st) => Station.stationId[st] === num)!;
  const sys = InSystem.systemId[eid], set = server.replicaEnv(sys).landmarks!, li = set.findIndex((l) => l.id === CENTRAL);
  return { eid, sys, set, li, at: () => landmarkPosition(set, li, server.getTick()) };
}

const put = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
const saved = async (store: MemoryProfileStore) => (await store.load(1)) as PlayerProfile;

describe('logging out by a landmark, logging back in by it', () => {
  it('in a station\'s zone: the save names it and the offset; a later login on the same server lands at that offset from where it is now', async () => {
    const store = new MemoryProfileStore();
    const a = serverOn(store);
    const first = await a.join();
    stepServer(a.server, 30);
    const c = central(a.server), at0 = c.at();
    put(first.pid, at0.x + 1500, at0.y - 700);
    // (Parked there a while: carried with it, so still 1500, -700 from it)
    stepServer(a.server, 600);
    const at1 = c.at();
    expect(Math.hypot(at1.x - at0.x, at1.y - at0.y)).toBeGreaterThan(500);
    expect(Math.abs(Position.x[first.pid] - at1.x - 1500)).toBeLessThan(0.02);
    expect(Math.abs(Position.y[first.pid] - at1.y + 700)).toBeLessThan(0.02);
    await a.server.pilots.detach(first.conn() as never);
    const p = await saved(store);
    expect(p.position.system).toBe('sol');
    expect(p.position.at).toEqual({ id: CENTRAL, dx: 1500, dy: -700 });
    // (The absolute spot is still saved, as ever)
    expect(Math.abs(p.position.x - (at1.x + 1500))).toBeLessThanOrEqual(2);
    expect(Math.abs(p.position.y - (at1.y - 700))).toBeLessThanOrEqual(2);

    // Away for a while: the station moves on
    stepServer(a.server, 2400);
    const at2 = c.at();
    expect(Math.hypot(at2.x - at1.x, at2.y - at1.y)).toBeGreaterThan(2000);
    const back = await a.join();
    expect(InSystem.systemId[back.pid]).toBe(c.sys);
    expect(Math.abs(Position.x[back.pid] - (at2.x + 1500))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(Position.y[back.pid] - (at2.y - 700))).toBeLessThanOrEqual(1.5);
    // (Not where the save's absolute spot says: that is where the station was)
    expect(Math.hypot(Position.x[back.pid] - p.position.x, Position.y[back.pid] - p.position.y)).toBeGreaterThan(2000);
  }, 180_000);

  it('a restarted server (its ticks start over, the station back where tick 0 has it): still at the same offset from it; the fade band counts', async () => {
    const store = new MemoryProfileStore();
    const a = serverOn(store);
    const first = await a.join();
    stepServer(a.server, 3000);
    const c = central(a.server), at = c.at(), zone = c.set[c.li];
    // (In the fade band, past the inner radius)
    const off = Math.round(zone.inner + (zone.outer - zone.inner) * 0.3);
    put(first.pid, at.x - off, at.y + 40);
    await a.server.pilots.detach(first.conn() as never);
    const p = await saved(store);
    expect(p.position.at).toEqual({ id: CENTRAL, dx: -off, dy: 40 });

    const b = serverOn(store);
    const cb = central(b.server);
    const back = await b.join();
    const now = cb.at();
    expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeGreaterThan(2500);
    expect(Math.abs(Position.x[back.pid] - (now.x - off))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(Position.y[back.pid] - (now.y + 40))).toBeLessThanOrEqual(1.5);
  }, 180_000);

  it('open space: no landmark in the save, and the login is at the saved spot', async () => {
    const store = new MemoryProfileStore();
    const a = serverOn(store);
    const first = await a.join();
    stepServer(a.server, 30);
    put(first.pid, 120000, -130000);
    stepServer(a.server, 60);
    await a.server.pilots.detach(first.conn() as never);
    const p = await saved(store);
    expect(p.position).toEqual({ system: 'sol', x: 120000, y: -130000 });
    expect('at' in p.position).toBe(false);
    const b = serverOn(store);
    const back = await b.join();
    expect([Position.x[back.pid], Position.y[back.pid]]).toEqual([120000, -130000]);
  }, 180_000);

  it('a save from before the field, and one whose landmark is gone: both load at the saved spot, as before', async () => {
    const store = new MemoryProfileStore();
    const a = serverOn(store);
    const first = await a.join();
    stepServer(a.server, 30);
    const c = central(a.server), at = c.at();
    // (Saved inside the station's zone as it was then, by a build without the field)
    put(first.pid, at.x + 900, at.y + 900);
    await a.server.pilots.detach(first.conn() as never);
    const old = await saved(store);
    const spot = { x: old.position.x, y: old.position.y };
    delete old.position.at;
    await store.save(1, old);

    const b = serverOn(store);
    stepServer(b.server, 1800);
    const back = await b.join();
    expect([Position.x[back.pid], Position.y[back.pid]]).toEqual([spot.x, spot.y]);
    await b.server.pilots.detach(back.conn() as never);

    // A landmark the data no longer has
    const gone = await saved(store);
    gone.position = { system: 'sol', x: 120000, y: 90000, at: { id: 'station:long_gone', dx: 10, dy: 10 } };
    await store.save(1, gone);
    const d = serverOn(store);
    const again = await d.join();
    expect([Position.x[again.pid], Position.y[again.pid]]).toEqual([120000, 90000]);
  }, 180_000);
});
