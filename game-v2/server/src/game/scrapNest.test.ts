import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Asteroid, Position, Velocity, InSystem, OrbitType, ASTEROID_SEED, asteroidParamsAt, calcAsteroidPosition, pocketAt, rayTerrain, insideTerrain, type ServerMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import type { BossesFile } from './Bosses.js';
import { liveTracks, ghostTracks, summarise } from '../bench/nestRoam.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const def = (files.bosses as BossesFile).bosses.boss_scrap_mother;
const NEST = 'sol_scrap_nest';

function world() {
  resetGlobals();
  const server = makeServer();
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

  it('she lies dormant in the middle of it until a pilot passes the barrier of her arena, then rises there', () => {
    const { server, pid, step, num, t } = world();
    place(pid, num, 0, 20000);
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
    expect(all.length).toBeGreaterThanOrEqual(220);
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

  it('the Nest Rock: chambers open and walled off from each other, tunnels 3,000 wide or more, a mouth from the south', () => {
    const { server, num, sys } = world();
    const rock = server.terrainOf(num)!;
    const clear = (x0: number, y0: number, x1: number, y1: number) => rayTerrain(rock, x0, y0, x1, y1) >= 1;
    // (the chambers: the Heart at her lair, the Gullet, the Sorting Floor, the Smelter, the Wreck Gallery)
    const chambers: [number, number, number][] = [[0, 0, 5400], [0, 12500, 3000], [-13500, 5500, 3800], [13500, 4500, 3800], [0, -14000, 3200]];
    for (const [x, y, r] of chambers) for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      expect(clear(x, y, x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85), `chamber at ${x}, ${y}`).toBe(true);
    }
    // (rock between them: nothing crosses from the Heart to a side chamber but by the tunnels)
    for (const [x, y] of [[-13500, 5500], [13500, 4500], [0, -14000]]) expect(clear(0, 0, x, y)).toBe(false);
    // Tunnels: across each, rock no closer than 1,500 either side of its line (the barrier aside)
    const across: [number, number, number][] = [[0, 8000, 0], [0, 17500, 0], [-7000, 11600, 0.48], [7000, 11400, -0.5], [-14000, -5000, 1.57], [14000, -5000, 1.57], [-10000, -10600, 2.4], [10000, -10600, 0.75]];
    for (const [x, y, a] of across) {
      const nx = Math.cos(a + Math.PI / 2), ny = Math.sin(a + Math.PI / 2);
      for (const s of [-1, 1]) expect(rayTerrain(rock, x, y, x + nx * s * 3000, y + ny * s * 3000) * 3000, `tunnel at ${x}, ${y}`).toBeGreaterThan(1450);
    }
    // The Mouth: from where you arrive, straight in to the Gullet
    const land = sys.pocket!.landing;
    expect(clear(land.x, land.y, 0, 12500)).toBe(true);
    expect(Math.hypot(land.x, land.y)).toBeLessThan(sys.pocket!.radius - 1000);
    // Her barrier closes the Throat: the only way into the Heart
    expect(clear(0, 7500, 0, 4000)).toBe(false);
  });

  it('its rocks: junk drifting round the rock, clear of the way in, and six rich lodes (three in the Smelter, three on the east face)', () => {
    const { server, sys, rocks, at, num } = world();
    const all = rocks().map((r) => ({ ...at(r.eid), size: Asteroid.size[r.eid], index: r.index }));
    const rock = server.terrainOf(num)!;
    const lodes = all.filter((r) => asteroidParamsAt(NEST, r.index, ASTEROID_SEED, 0, sys.asteroidBelt, sys.asteroidField).definitionId === 'scrap_seam_rich');
    expect(lodes.length).toBe(6);
    expect(lodes.filter((r) => Math.hypot(r.x - 13500, r.y - 4500) < 3000).length).toBe(3);
    // (no rich rock anywhere else: the old high-value field is gone)
    // (no rich rock anywhere else: the old high-value field is gone; the junk is plain metal, slag and fuel)
    const kinds = new Set(all.filter((r) => !lodes.includes(r)).map((r) => asteroidParamsAt(NEST, r.index, ASTEROID_SEED, 0, sys.asteroidBelt, sys.asteroidField).definitionId));
    for (const k of kinds) expect(['asteroid_metal', 'rock_slag', 'asteroid_fuel']).toContain(k);
    // (a lode is about twice a junk rock)
    const mean = all.filter((r) => !lodes.includes(r)).reduce((a, r) => a + r.size, 0) / (all.length - lodes.length);
    for (const l of lodes) { expect(l.size).toBeGreaterThan(mean * 1.4); expect(l.size).toBeLessThan(mean * 2.4); }
    for (const r of all) {
      if (lodes.includes(r)) continue;
      // Junk: outside the rock, and not in the way in from the south
      expect(Math.hypot(r.x, r.y - 800), `rock at ${Math.round(r.x)}, ${Math.round(r.y)}`).toBeGreaterThan(21000);
      if (r.y > 15000) expect(Math.abs(r.x) - r.size).toBeGreaterThan(1500);
    }
    // Nothing sits in the rock itself
    for (const r of all) expect(insideTerrain(rock, r.x, r.y)).toBe(false);
  });

  it('its den: scrapborn heaps in its chambers and off its faces launch crawlers, sowers and darters; none comes into the Heart', () => {
    const { server, pid, step, num } = world();
    server.bosses.unhurt.add(pid);
    place(pid, num, 0, 20000);
    const seen = new Map<string, number>();
    let inHeart = 0;
    for (let i = 0; i < 60 * 40; i++) {
      step();
      if (i % 30) continue;
      place(pid, num, 0, 20000);
      for (const [eid, e] of (server.enemies as any).enemies as Map<number, { type: string; faction: string; boss?: string; behaviour?: { aggro: number } }>) {
        if (InSystem.systemId[eid] !== num || e.boss) continue;
        seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
        if (Math.hypot(Position.x[eid], Position.y[eid]) < 5600) inHeart++;
        // (a den's packs are keener than the Drift's)
        expect(e.behaviour?.aggro).toBe(2600);
      }
    }
    for (const t of ['scrap_crawler', 'rivet_sower', 'scrap_darter']) expect(seen.get(t) ?? 0, t).toBeGreaterThan(0);
    expect(inHeart).toBe(0);
  }, 120_000);

  it("its chambers' packs roam their own chamber's open floor, spread out, never pressed on the walls; their ghosts are never in the rock", () => {
    // (Kieran's playtest: they gathered in a corner and stuck there. The heaps are piled against the walls, so their
    // patrols centred on the heap had half their points in the rock: bench/nestRoam.ts measures it)
    // (a pilot held where every heap is in reach to load, nobody going for it: they only patrol)
    const { tracks, rock } = liveTracks(-8000, 0, 60 * 120, 30, true);
    const s = summarise(tracks.values(), rock);
    const own: Record<string, string> = { nest_gullet: 'gullet', nest_sorting: 'sorting', nest_smelter: 'smelter', nest_gallery: 'gallery' };
    const ships: Record<string, number> = { nest_gullet: 4, nest_sorting: 6, nest_smelter: 5, nest_gallery: 7 };
    for (const [nest, chamber] of Object.entries(own)) {
      const h = s[nest];
      expect(h?.ships, nest).toBeGreaterThanOrEqual(ships[nest]);
      // In its own chamber, all over its floor, the pack not bunched up
      expect(h.areas[chamber], nest).toBeGreaterThan(95);
      expect(h.cells, nest).toBeGreaterThan(12);
      expect(h.spread, nest).toBeGreaterThan(500);
      // Never on the rock
      expect(h.walled, nest).toBeLessThan(3);
      expect(h.stuck, nest).toBe(0);
    }
    // Off its faces they keep out of the rock too
    for (const nest of ['nest_rim_w', 'nest_rim_n', 'nest_seam']) expect(s[nest].stuck, nest).toBeLessThan(2);
    // Their ghosts (nobody there), over half an hour, where a ship would load: always out in the open
    const g = summarise(ghostTracks(60 * 60 * 30).tracks.values(), rock);
    for (const [nest, h] of Object.entries(g)) {
      expect(h.areas.rock ?? 0, nest).toBe(0);
      if (own[nest]) expect(h.areas[own[nest]], nest).toBe(100);
    }
  }, 300_000);

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
