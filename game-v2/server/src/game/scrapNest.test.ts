import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Asteroid, Position, Velocity, InSystem, OrbitType, ASTEROID_SEED, asteroidParamsAt, calcAsteroidPosition, pocketAt, type ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { BossesFile } from './Bosses.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const def = (files.bosses as BossesFile).bosses.boss_scrap_mother;
const NEST = 'sol_scrap_nest';

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'nester' } as any);
  const pid = t.getPlayerId();
  const step = (n = 1) => { for (let i = 0; i < n; i++) server.step(); };
  const gd = server['gameData'];
  const num = gd.getSystemNum(NEST);
  const sys = gd.getSystem(NEST)!;
  /** Her nest's rocks (the server's), each with its belt index */
  const rocks = () => ((server as any).asteroidIdsBySystem.get(num) as number[]).map((eid) => ({ eid, index: (server as any).asteroidIndexById.get(eid) as number }));
  const at = (eid: number) => { (server as any).placeAsteroid(eid); return { x: Position.x[eid], y: Position.y[eid] }; };
  return { server, t, got, pid, step, gd, num, sys, rocks, at };
}

const place = (pid: number, num: number, x: number, y: number) => {
  InSystem.systemId[pid] = num; Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0;
};

describe("the Scrap Mother's nest", () => {
  it('is a pocket of its own, its way in out in the Drift south-west of Sol, where she lairs', () => {
    const { gd, sys } = world();
    expect(def.system).toBe(NEST);
    const e = sys.pocket!.entrance;
    expect(e.system).toBe('sol');
    const drift = gd.getSystem('sol')!.zones!.find((z) => z.id === 'drift')!;
    const r = Math.hypot(e.x, e.y);
    expect(r).toBeGreaterThan(drift.inner);
    expect(r).toBeLessThan(drift.outer);
    // South-west (west and south of the star: +y is south)
    expect(e.x).toBeLessThan(0);
    expect(e.y).toBeGreaterThan(0);
    // Not a surface, and no gate leads there
    expect(sys.surface).toBeUndefined();
    for (const s of files.systems.systems) for (const p of s.portals) expect(p.targetSystem).not.toBe(NEST);
    // Her lair is the middle of it
    expect(Math.hypot(def.lair.x, def.lair.y)).toBeLessThan(500);
  });

  it('X at the way in takes you in; flying out past its edge brings you back beside it', () => {
    const { server, got, pid, step, gd, sys, num } = world();
    const conn = server.pilots.connOf(pid)!;
    const e = sys.pocket!.entrance, sol = gd.getSystem('sol')!;
    // Too far off: nothing
    (server as any).travelTo(conn, gd.getSystemNum('sol'), e.x + e.radius + 2000, e.y, false);
    step(5);
    expect(server.surfaces.descend(conn as any, sol, Position.x[pid], Position.y[pid])).toBe(false);
    // At the way in (the client's prompt agrees it's there)
    (server as any).travelTo(conn, gd.getSystemNum('sol'), e.x + e.radius * 0.5, e.y, false);
    step(5);
    expect(pocketAt(files.systems.systems, 'sol', Position.x[pid], Position.y[pid])?.id).toBe(NEST);
    expect(server.surfaces.descend(conn as any, sol, Position.x[pid], Position.y[pid])).toBe(true);
    step(5);
    expect(InSystem.systemId[pid]).toBe(num);
    expect(Math.hypot(Position.x[pid] - sys.pocket!.landing.x, Position.y[pid] - sys.pocket!.landing.y)).toBeLessThan(1500);
    expect(got.some((m) => m.type === 'toast' && /Into the Scrap Mother's nest/.test((m as any).text ?? (m as any).message ?? ''))).toBe(true);
    // Out past the edge (to the west): back in Sol, beside the way in, on its west side, and not inside it
    place(pid, num, -sys.pocket!.radius - 300, 0);
    step(70);
    expect(InSystem.systemId[pid]).toBe(gd.getSystemNum('sol'));
    const d = Math.hypot(Position.x[pid] - e.x, Position.y[pid] - e.y);
    expect(d).toBeLessThan(e.radius + 2000);
    expect(d).toBeGreaterThan(e.radius);
    expect(Position.x[pid]).toBeLessThan(e.x);
    expect(got.some((m) => m.type === 'toast' && /Back out of the Scrap Mother's nest/.test((m as any).text ?? (m as any).message ?? ''))).toBe(true);
  });

  it('she lies dormant in the middle of it until a pilot passes her arena's barrier, then rises there', () => {
    const { server, pid, step, num, t } = world();
    place(pid, num, 0, 18000);
    step(130);
    expect(server.bosses.inSystem(num)).toEqual([]);
    // (her arena: game/arenas/bossArena.test.ts)
    place(pid, num, 0, server['gameData'].getSystem(NEST)!.arena!.radius + 260);
    t.send({ type: 'interact' } as any);
    step(2);
    const here = server.bosses.inSystem(num);
    expect(here.length).toBe(1);
    expect(Math.hypot(Position.x[here[0]] - def.lair.x, Position.y[here[0]] - def.lair.y)).toBeLessThan(1500);
    expect(server.bosses.inSystem(server['gameData'].getSystemNum('sol')).length).toBe(0);
  });

  it('its rocks keep still: where they are a while later is where they were, and where a client works out they are', () => {
    const { server, step, sys, num, rocks, at } = world();
    const all = rocks();
    expect(all.length).toBeGreaterThan(800);
    const seedTick = (server as any).asteroidSeedTickBySystem.get(num) as number;
    const before = new Map(all.map((r) => [r.eid, at(r.eid)]));
    step(600);
    for (const r of all) {
      expect(Asteroid.orbitType[r.eid]).toBe(OrbitType.Fixed);
      const now = at(r.eid), was = before.get(r.eid)!;
      expect(Math.hypot(now.x - was.x, now.y - was.y)).toBeLessThan(0.01);
      // The client: the same rock from the seed message's belt, at this tick and far later
      const p = asteroidParamsAt(NEST, r.index, ASTEROID_SEED, seedTick, sys.asteroidBelt, sys.asteroidField);
      for (const tick of [(server as any).currentTick, (server as any).currentTick + 5e6]) {
        const c = calcAsteroidPosition(p, tick);
        expect(Math.hypot(c.x - now.x, c.y - now.y)).toBeLessThan(1);
      }
    }
  });

  it('its middle is open for her fight, the field thick round it, and a lane leads in from the south', () => {
    const { sys, rocks, at } = world();
    const all = rocks().map((r) => ({ ...at(r.eid), size: Asteroid.size[r.eid] }));
    // (her moves keep her within 5000 of her lair, her hull 1365 across: nothing within 6500)
    for (const r of all) expect(Math.hypot(r.x - def.lair.x, r.y - def.lair.y) - r.size).toBeGreaterThan(6500);
    // A few rocks at the arena's edge, the most in the ring past it
    const edge = all.filter((r) => Math.hypot(r.x, r.y) < 9000).length;
    expect(edge).toBeGreaterThan(20);
    expect(all.length - edge).toBeGreaterThan(800);
    // The lane: from where you arrive to the arena, nothing within 600 of the line
    const land = sys.pocket!.landing;
    for (const r of all) {
      if (r.y < 6000 || r.y > land.y) continue;
      expect(Math.abs(r.x) - r.size, `rock at ${Math.round(r.x)}, ${Math.round(r.y)}`).toBeGreaterThan(600);
    }
    // Where you arrive is clear, and inside the edge
    for (const r of all) expect(Math.hypot(r.x - land.x, r.y - land.y) - r.size).toBeGreaterThan(800);
    expect(Math.hypot(land.x, land.y)).toBeLessThan(sys.pocket!.radius - 1000);
  });

  it('its rocks are mined, and found by shots, as anywhere', () => {
    const { server, pid, step, num, rocks, at } = world();
    place(pid, num, 0, 18000);
    step(2);
    const rock = rocks().map((r) => ({ eid: r.eid, ...at(r.eid) })).sort((a, b) => Math.hypot(a.x, a.y - 18000) - Math.hypot(b.x, b.y - 18000))[0];
    // A shot's sweep of the timetable finds it, now and much later
    for (const tick of [(server as any).currentTick, (server as any).currentTick + 1e6]) {
      expect((server as any).asteroidOrbits.query(num, rock.x - 5, rock.y - 5, rock.x + 5, rock.y + 5, 0, tick)).toContain(rock.eid);
    }
    // A mining beam from beside it, straight at it
    const hp = Asteroid.hp[rock.eid];
    const dx = rock.x, dy = rock.y - 18000, d = Math.hypot(dx, dy);
    place(pid, num, rock.x - (dx / d) * (Asteroid.size[rock.eid] + 300), rock.y - (dy / d) * (Asteroid.size[rock.eid] + 300));
    const hit = (server as any).mineBeam(pid, Position.x[pid], Position.y[pid], Math.atan2(dy, dx), 1500, 40, 'steel');
    expect(hit).toBeLessThan(1);
    expect(Asteroid.hp[rock.eid]).toBeLessThan(hp);
  });
});
