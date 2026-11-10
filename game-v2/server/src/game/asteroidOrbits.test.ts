import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Asteroid, InSystem, mulberry32, calcOrbitStateRaw } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { AsteroidOrbits, type OrbitShape } from './AsteroidOrbits.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = makeServer({ profileStore: new MemoryProfileStore(), clock: () => 0 });
  const w = server.getWorld();
  const ids = [...Array(8000).keys()].filter((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, Asteroid, e));
  return { server, ids, orbits: (server as any).asteroidOrbits };
}

const where = (e: number, tick: number) => {
  const o = calcOrbitStateRaw(Asteroid.orbitType[e], Asteroid.semiMajorAxis[e], Asteroid.eccentricity[e], Asteroid.argPeriapsis[e], Asteroid.meanAnomaly0[e], Asteroid.epochTick[e], tick);
  return [o.x, o.y];
};

describe('asteroid orbit timetable', () => {
  it('finds every asteroid that could be in a box, at any tick', () => {
    const { ids, orbits } = world();
    const rnd = mulberry32(99);
    let found = 0;
    for (let round = 0; round < 60; round++) {
      // Up to about five weeks of uptime
      const tick = Math.floor(rnd() * 2e8);
      for (let q = 0; q < 40; q++) {
        const e = ids[Math.floor(rnd() * ids.length)];
        const sys = InSystem.systemId[e];
        const [ax, ay] = where(e, tick);
        const x = ax + (rnd() - 0.5) * 3000, y = ay + (rnd() - 0.5) * 3000;
        const ang = rnd() * Math.PI * 2, len = rnd() < 0.5 ? 40 : 1500, pad = 120;
        const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len;
        const got = new Set<number>(orbits.query(sys, x, y, x1, y1, pad, tick));
        // Everything whose rock reaches the padded box must come back
        for (const a of ids) {
          if (InSystem.systemId[a] !== sys) continue;
          const [px, py] = where(a, tick), r = Asteroid.size[a];
          if (px + r < Math.min(x, x1) - pad || px - r > Math.max(x, x1) + pad || py + r < Math.min(y, y1) - pad || py - r > Math.max(y, y1) + pad) continue;
          expect(got.has(a), `asteroid ${a} at tick ${tick}`).toBe(true);
          found++;
        }
      }
    }
    expect(found).toBeGreaterThan(100);
  });

  it('stays exact through heavy churn: cells emptied and reused, the pools compacted', () => {
    const { ids, orbits } = world();
    const shapes = new Map<number, { system: number; shape: unknown }>(ids.map((e) => [e, orbits.orbits.get(e)]));
    const entries0 = orbits.entries;
    const rnd = mulberry32(7);
    for (let round = 0; round < 4; round++) {
      const half = ids.filter(() => rnd() < 0.5);
      for (const e of half) orbits.remove(e);
      for (const e of half) orbits.add(e, shapes.get(e)!.system, shapes.get(e)!.shape);
    }
    expect(orbits.entries).toBe(entries0);
    for (let q = 0; q < 300; q++) {
      const tick = Math.floor(rnd() * 2e8);
      const e = ids[Math.floor(rnd() * ids.length)];
      const sys = InSystem.systemId[e];
      const [x, y] = where(e, tick);
      const got = new Set<number>(orbits.query(sys, x - 400, y - 400, x + 400, y + 400, 120, tick));
      for (const a of ids) {
        if (InSystem.systemId[a] !== sys) continue;
        const [px, py] = where(a, tick), r = Asteroid.size[a];
        if (px + r < x - 520 || px - r > x + 520 || py + r < y - 520 || py - r > y + 520) continue;
        expect(got.has(a), `asteroid ${a} at tick ${tick}`).toBe(true);
      }
    }
  });

  it('filing a system late (on its first query) gives what filing at once does, order and all', () => {
    const { ids, orbits } = world();
    const sys = [...new Set(ids.map((e) => InSystem.systemId[e]))].sort((a, b) => a - b).slice(0, 2);
    const mine = ids.filter((e) => sys.includes(InSystem.systemId[e]));
    const shape = (e: number) => orbits.orbits.get(e) as { system: number; shape: OrbitShape };
    const now = new AsteroidOrbits(), late = new AsteroidOrbits();
    for (const e of mine) now.add(e, shape(e).system, shape(e).shape);
    now.fileAll();
    for (const e of mine) late.add(e, shape(e).system, shape(e).shape);
    // (The same churn on both: on `late`, before anything of the first system is filed, then after)
    const rnd = mulberry32(3);
    const churn = () => {
      const some = mine.filter(() => rnd() < 0.3);
      for (const e of some) { now.remove(e); late.remove(e); }
      for (const e of some.filter((_, i) => i % 2 === 0)) { now.add(e, shape(e).system, shape(e).shape); late.add(e, shape(e).system, shape(e).shape); }
    };
    churn();
    late.query(sys[0], 0, 0, 0, 0, 0, 0);
    churn();
    for (let q = 0; q < 400; q++) {
      const tick = Math.floor(rnd() * 2e8), e = mine[Math.floor(rnd() * mine.length)];
      const [x, y] = where(e, tick);
      const s = InSystem.systemId[e];
      expect(late.query(s, x - 900, y - 300, x + 700, y + 900, 120, tick)).toEqual(now.query(s, x - 900, y - 300, x + 700, y + 900, 120, tick));
    }
    expect(late.entries).toBe(now.entries);
  });

  it('filing in slices (the real start) gives what filing at once does, order and all, whatever happens between slices', () => {
    const { ids, orbits } = world();
    const sys = [...new Set(ids.map((e) => InSystem.systemId[e]))].sort((a, b) => a - b).slice(0, 3);
    const mine = ids.filter((e) => sys.includes(InSystem.systemId[e]));
    const shape = (e: number) => orbits.orbits.get(e) as { system: number; shape: OrbitShape };
    const now = new AsteroidOrbits(), sliced = new AsteroidOrbits();
    for (const e of mine) { now.add(e, shape(e).system, shape(e).shape); sliced.add(e, shape(e).system, shape(e).shape); }
    now.settle(); sliced.settle();
    now.fileAll();
    // (A clock that moves on a step each time it's read: a slice files a few orbits)
    let t = 0;
    const clock = () => t++;
    const rnd = mulberry32(5);
    // Between slices: rocks broken and made again (some filed already, some waiting, in a system part filed) and the second system asked about early
    let slices = 0;
    while (sliced.fileSome(9, clock)) {
      slices++;
      if (slices % 5 === 0) {
        const some = mine.filter(() => rnd() < 0.05);
        for (const e of some) { now.remove(e); sliced.remove(e); }
        for (const e of some.filter((_, i) => i % 2 === 0)) { now.add(e, shape(e).system, shape(e).shape); sliced.add(e, shape(e).system, shape(e).shape); }
      }
      if (slices === 12) sliced.query(sys[1], 0, 0, 0, 0, 0, 0);
    }
    expect(slices).toBeGreaterThan(20);
    for (let q = 0; q < 400; q++) {
      const tick = Math.floor(rnd() * 2e8), e = mine[Math.floor(rnd() * mine.length)];
      const [x, y] = where(e, tick);
      const s = InSystem.systemId[e];
      expect(sliced.query(s, x - 900, y - 300, x + 700, y + 900, 120, tick)).toEqual(now.query(s, x - 900, y - 300, x + 700, y + 900, 120, tick));
    }
    expect(sliced.entries).toBe(now.entries);
  });

  it('a broken asteroid leaves the timetable', () => {
    const { server, ids, orbits } = world();
    const e = ids[0];
    const tick = (server as any).currentTick;
    const [x, y] = where(e, tick);
    expect(orbits.query(InSystem.systemId[e], x, y, x, y, 10, tick)).toContain(e);
    Asteroid.hp[e] = 0;
    server.step();
    const [x2, y2] = where(e, tick + 1);
    expect(orbits.query(InSystem.systemId[e], x2, y2, x2, y2, 10, tick + 1)).not.toContain(e);
  });
});
