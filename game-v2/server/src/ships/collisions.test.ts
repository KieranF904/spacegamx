/**
 * Hits land on real geometry (docs/audits/collisions.md): shells, beams,
 * splash, EMP and fuses against a boss's parts, never its bounding circle.
 * The checks are made against an independent oracle: points sampled along
 * the line, tested against each standing part's convex pieces.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import {
  Position, Rotation, Velocity, InSystem, parseBlueprint, pointInConvex, standing, stageOf, currentStage, deciding,
  shipPointToWorld, localToWorldDir, partWeaponDef, seededRng, type Blueprint, type Vec2, type ShipState,
} from '@space-game/common';
import { createLocalServer } from '../createLocalServer.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from './loadShipConfig.js';
import { STAGE_COVER, type ShipBridge } from './ShipBridge.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const shipsCfg = loadShipConfigCached(dataDir);
const sparrow: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));

function setup(design: string, angle = 0.4) {
  resetGlobals();
  const server = createLocalServer({ files, ships: shipsCfg, autoStart: false });
  const t = new LocalTransport(server);
  t.onMessage = () => {};
  t.connect();
  t.send({ type: 'join', username: 'tester' } as never);
  const pid = t.getPlayerId();
  const bridge = server.getShips()!;
  const sys = InSystem.systemId[pid];
  Position.x[pid] = 0; Position.y[pid] = 20000;
  const boss = bridge.spawnDummy(bridge.enemyDesigns[design], 0, 0, angle, sys);
  const ship = () => bridge.get(boss)!;
  ship().shield = 0;
  const weapons = (server as any).weapons;
  const step = (n = 1) => { for (let i = 0; i < n; i++) { server.step(); Position.x[boss] = 0; Position.y[boss] = 0; Velocity.x[boss] = 0; Velocity.y[boss] = 0; Rotation.angle[boss] = angle; } };
  return { server, bridge, pid, boss, ship, sys, weapons, step, angle };
}

/** The standing part (if any) under a world point, by the oracle */
function partUnder(bridge: ShipBridge, eid: number, s: ShipState, x: number, y: number): number {
  const [gx, gy] = bridge.worldToGrid(eid, s, x, y);
  const geoms = bridge.geometry(s);
  for (let i = 0; i < geoms.length; i++) {
    const b = geoms[i].bbox;
    if (gx < b.minX || gx > b.maxX || gy < b.minY || gy > b.maxY || !standing(bridge.catalog, s, i)) continue;
    if (geoms[i].convex.some((c) => pointInConvex(c, gx, gy))) return i;
  }
  return -1;
}

/** First standing part along a world segment, sampled every `step` units (oracle) */
function oracleFirst(bridge: ShipBridge, eid: number, x0: number, y0: number, x1: number, y1: number, step = 0.5): { part: number; d: number } | null {
  const s = bridge.get(eid)!, len = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(len / step);
  for (let k = 0; k <= n; k++) {
    const part = partUnder(bridge, eid, s, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
    if (part >= 0) return { part, d: (len * k) / n };
  }
  return null;
}

/** Distance from a world point to a part's outline (oracle: its convex pieces' edges, in world units) */
function outlineDistance(bridge: ShipBridge, eid: number, s: ShipState, part: number, x: number, y: number): number {
  const cs = bridge.tuning.cellSize, [gx, gy] = bridge.worldToGrid(eid, s, x, y);
  let best = Infinity;
  for (const c of bridge.geometry(s)[part].convex) {
    if (pointInConvex(c, gx, gy)) return 0;
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length], ex = b[0] - a[0], ey = b[1] - a[1];
      const u = Math.max(0, Math.min(1, ((gx - a[0]) * ex + (gy - a[1]) * ey) / (ex * ex + ey * ey || 1)));
      best = Math.min(best, Math.hypot(gx - a[0] - ex * u, gy - a[1] - ey * u) * cs);
    }
  }
  return best;
}

/** The closest any standing part's outline comes to a segment (sampled every 2 units) */
function clearance(bridge: ShipBridge, eid: number, x0: number, y0: number, x1: number, y1: number): number {
  const s = bridge.get(eid)!, n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2), parts = bridge.geometry(s).map((_, i) => i).filter((i) => standing(bridge.catalog, s, i));
  let best = Infinity;
  for (let k = 0; k <= n; k++) for (const i of parts) best = Math.min(best, outlineDistance(bridge, eid, s, i, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
  return best;
}

const hurtParts = (before: number[], after: number[]) => after.flatMap((h, i) => (h < before[i] ? [i] : []));
/** A part a hit lands on as it is (a later stage's part passes its hit to the current stage's: stages.ts) */
const takesItsOwn = (bridge: ShipBridge, s: ShipState, part: number) => { const st = stageOf(bridge.catalog, s, part); return !st || st === currentStage(bridge.catalog, s); };

for (const design of ['scrap_mother', 'giant_mammoth']) {
  describe(`collisions against ${design}'s real geometry`, () => {
    it('a line through its bounding circle that misses every part hits nothing, and a shell flown along it does no damage', () => {
      const w = setup(design);
      const s = w.ship(), R = s.derived.radius, rng = seededRng(3);
      let misses = 0, hits = 0;
      for (let k = 0; k < 400 && (misses < 6 || hits < 6); k++) {
        // A long line whose closest approach to the centre is well inside the bounding circle
        const h = rng() * Math.PI * 2, off = R * (0.35 + 0.6 * rng());
        const nx = -Math.sin(h), ny = Math.cos(h);
        const x0 = nx * off - Math.cos(h) * (R + 200), y0 = ny * off - Math.sin(h) * (R + 200);
        const x1 = nx * off + Math.cos(h) * (R + 200), y1 = ny * off + Math.sin(h) * (R + 200);
        const want = oracleFirst(w.bridge, w.boss, x0, y0, x1, y1);
        const got = w.bridge.segmentHit(w.boss, w.ship(), x0, y0, x1, y1);
        // (A line that grazes a corner by less than the oracle's step proves nothing either way)
        if (!want && clearance(w.bridge, w.boss, x0, y0, x1, y1) < 2.5) continue;
        if (!want) {
          misses++;
          expect(got).toBeNull();
          if (misses === 1) {
            // A real shell along it, start to end: nothing on the boss is touched
            const before = s.hp.slice();
            w.weapons.spawn(w.pid, 'cannon', x0, y0, h, 1, { speedScale: 1, sizeScale: 1, turret: false });
            w.step(90);
            expect(hurtParts(before, w.ship().hp)).toEqual([]);
          }
        } else {
          hits++;
          expect(got).not.toBeNull();
          // The same part (or one touching it at the same spot), at the same place along it
          const len = Math.hypot(x1 - x0, y1 - y0);
          expect(Math.abs(got!.t * len - want.d)).toBeLessThan(1.5);
        }
      }
      expect(misses).toBeGreaterThan(0);
      expect(hits).toBeGreaterThan(0);
    });

    it("a shell fired at its back damages the back part it strikes (or, a later stage's, the current stage's part nearest that spot)", () => {
      const w = setup(design);
      const s = w.ship(), R = s.derived.radius, rng = seededRng(11), cat = w.bridge.catalog;
      const [fx, fy] = localToWorldDir([0, -1], w.angle); // its nose
      const sides = new Set<number>();
      let tried = 0;
      for (let k = 0; k < 80 && tried < 6; k++) {
        // From behind it, at a point of it a little off its middle
        const sx = -fx * (R + 150) + (rng() - 0.5) * R * 0.6, sy = -fy * (R + 150) + (rng() - 0.5) * R * 0.6;
        const tx = (rng() - 0.5) * R * 0.5, ty = (rng() - 0.5) * R * 0.5;
        const h = Math.atan2(ty - sy, tx - sx);
        const want = oracleFirst(w.bridge, w.boss, sx, sy, sx + Math.cos(h) * 3 * R, sy + Math.sin(h) * 3 * R);
        if (!want) continue;
        const ix = sx + Math.cos(h) * want.d, iy = sy + Math.sin(h) * want.d;
        // (struck on its back half)
        if (ix * fx + iy * fy >= 0) continue;
        tried++;
        // What should take it: the part itself, or (a later stage's) the current stage's deciding part nearest the impact, by outline
        const cur = w.ship(), first = currentStage(cat, cur);
        let expected = want.part;
        if (!takesItsOwn(w.bridge, cur, want.part)) {
          const cand = w.bridge.geometry(cur).map((_, i) => i).filter((i) => stageOf(cat, cur, i) === first && standing(cat, cur, i) && deciding(cat, cur, i));
          const d = cand.map((i) => outlineDistance(w.bridge, w.boss, cur, i, ix, iy));
          expected = cand[d.indexOf(Math.min(...d))];
        }
        cur.shield = 0;
        const before = cur.hp.slice();
        // (Launched a little short of where it meets the hull: well within a shell's reach)
        const back = Math.max(0, want.d - 150);
        w.weapons.spawn(w.pid, 'cannon', sx + Math.cos(h) * back, sy + Math.sin(h) * back, h, 1, { speedScale: 1, sizeScale: 1, turret: false });
        for (let i = 0; i < 120 && hurtParts(before, w.ship().hp).length === 0; i++) w.step();
        expect(hurtParts(before, w.ship().hp)).toEqual([expected]);
        // (which side of its spine the damage went)
        const [px, py] = shipPointToWorld(w.ship(), { x: 0, y: 0, angle: w.angle }, w.bridge.geometry(w.ship())[expected].centroid, w.bridge.tuning.cellSize);
        sides.add(Math.sign(px * -fy + py * fx));
      }
      expect(tried).toBe(6);
      // Not all piled on one part: both sides of its back take hits
      expect(sides.size).toBe(2);
    });

    it('a beam held on it from behind burns the first part along it', () => {
      const w = setup(design);
      const laser: Blueprint = JSON.parse(JSON.stringify(sparrow));
      for (const p of laser.parts) if (p.fn === 'cannon_pip') Object.assign(p, { fn: 'laser', material: 'alloy' });
      w.bridge.respawnInPlace(w.pid, laser);
      const me = w.bridge.get(w.pid)!, gun = me.derived.weapons[0], def = partWeaponDef(w.bridge.tuning, gun.kind, me.blueprint.parts[gun.part], gun);
      me.aim[gun.part] = 0;
      const R = w.ship().derived.radius, [fx, fy] = localToWorldDir([0, -1], w.angle), rng = seededRng(5);
      let tried = 0;
      for (let k = 0; k < 60 && tried < 3; k++) {
        const side = (rng() - 0.5) * R * 0.6;
        // The pilot behind it, facing it (its beam goes out along its heading)
        Position.x[w.pid] = -fx * (R + 300) - fy * side; Position.y[w.pid] = -fy * (R + 300) + fx * side;
        Rotation.angle[w.pid] = Math.atan2(fy, fx);
        const pose = { x: Position.x[w.pid], y: Position.y[w.pid], angle: Rotation.angle[w.pid] };
        const [mx, my] = shipPointToWorld(me, pose, gun.muzzle, w.bridge.tuning.cellSize);
        const [dx, dy] = localToWorldDir(gun.dir as Vec2, pose.angle);
        const want = oracleFirst(w.bridge, w.boss, mx, my, mx + dx * (def.range ?? 800), my + dy * (def.range ?? 800));
        if (!want || !takesItsOwn(w.bridge, w.ship(), want.part)) continue;
        tried++;
        w.ship().shield = 0;
        const before = w.ship().hp.slice();
        (w.bridge as any).fireBeam(w.pid, me, gun, def, { damage: 5, width: 0 });
        expect(hurtParts(before, w.ship().hp)).toEqual([want.part]);
      }
      expect(tried).toBe(3);
    });

    it("splash reaches a part by the distance to its outline (a great plate struck at its edge, far from its middle), and nothing past its radius", () => {
      const w = setup(design);
      const s = w.ship(), cs = w.bridge.tuning.cellSize, geoms = w.bridge.geometry(s), pose = { x: 0, y: 0, angle: w.angle };
      const radius = 40;
      // The biggest parts first: their middles are furthest from their edges
      const order = geoms.map((g, i) => i).filter((i) => standing(w.bridge.catalog, s, i) && takesItsOwn(w.bridge, s, i)).sort((a, b) => geoms[b].area - geoms[a].area);
      let found = false;
      for (const i of order.slice(0, 12)) {
        const c = geoms[i].centroid;
        for (const v of geoms[i].polygon) {
          // Just outside the corner, pushed away from its middle
          const [vx, vy] = shipPointToWorld(s, pose, v, cs), [cx, cy] = shipPointToWorld(s, pose, c, cs);
          const ux = (vx - cx) / Math.hypot(vx - cx, vy - cy), uy = (vy - cy) / Math.hypot(vx - cx, vy - cy);
          const x = vx + ux * 25, y = vy + uy * 25;
          if (partUnder(w.bridge, w.boss, s, x, y) >= 0 || Math.hypot(x - cx, y - cy) < radius * 1.2) continue;
          const dists = geoms.map((_, j) => (standing(w.bridge.catalog, s, j) ? outlineDistance(w.bridge, w.boss, s, j, x, y) : Infinity));
          const nearest = dists.indexOf(Math.min(...dists));
          if (nearest !== i || dists[i] > 30) continue;
          const before = w.ship().hp.slice();
          w.bridge.splashAt(w.sys, x, y, radius, 40, -1);
          expect(hurtParts(before, w.ship().hp)).toContain(i);
          found = true;
          break;
        }
        if (found) break;
      }
      expect(found).toBe(true);
      // Out past the radius from every outline (though well inside its bounding circle): no harm, and no EMP either
      const R = s.derived.radius;
      for (let k = 0; k < 2000; k++) {
        const a = k * 2.399, r = R * (0.2 + 0.8 * ((k * 0.618) % 1));
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        const dists = geoms.map((_, j) => (standing(w.bridge.catalog, s, j) ? outlineDistance(w.bridge, w.boss, s, j, x, y) : Infinity));
        if (Math.min(...dists) < radius + 15) continue;
        const before = w.ship().hp.slice();
        w.bridge.splashAt(w.sys, x, y, radius, 40, -1);
        expect(hurtParts(before, w.ship().hp)).toEqual([]);
        expect(w.bridge.empAt(w.sys, x, y, radius, 60, -1)).not.toContain(w.boss);
        expect(w.bridge.hullDistance(w.boss, x, y)).toBeCloseTo(Math.min(...dists), 1);
        return;
      }
      throw new Error('no open point inside its bounding circle');
    });
  });
}

describe('the stage cover', () => {
  /** Scrap Mother at her first stage: a later stage's standing part, and a current-stage plate that decides it */
  const parts = (w: ReturnType<typeof setup>) => {
    const s = w.ship(), cat = w.bridge.catalog, first = currentStage(cat, s);
    const all = w.bridge.geometry(s).map((_, i) => i).filter((i) => standing(cat, s, i));
    const later = all.find((i) => stageOf(cat, s, i) > first)!;
    const plate = all.find((i) => stageOf(cat, s, i) === first && deciding(cat, s, i))!;
    expect(later).toBeDefined();
    expect(plate).toBeDefined();
    return { s, later, plate };
  };
  const total = (before: number[], after: number[]) => before.reduce((a, h, i) => a + (h - after[i]), 0);

  it("a hit on a later stage's part passes to a current-stage plate at the stage-cover share: beams, shells and splash alike", () => {
    expect(STAGE_COVER).toBeGreaterThanOrEqual(0.35);
    expect(STAGE_COVER).toBeLessThanOrEqual(0.5);
    const w = setup('scrap_mother');
    const { s, later, plate } = parts(w);
    // A beam (no impact point): its full damage on a plate it strikes, a share of it through the plates over a later stage
    expect(w.bridge.damagePartBy(w.boss, plate, 10, -1)).toBeCloseTo(10, 5);
    let before = s.hp.slice();
    expect(w.bridge.damagePartBy(w.boss, later, 10, -1)).toBeCloseTo(10 * STAGE_COVER, 5);
    expect(s.hp[later]).toBe(before[later]);
    expect(hurtParts(before, s.hp).every((i) => stageOf(w.bridge.catalog, s, i) === currentStage(w.bridge.catalog, s))).toBe(true);
    // A shell (struck where it lands)
    before = s.hp.slice();
    expect(w.bridge.hurt(w.boss, s, later, 10, -1, { at: w.bridge.geometry(s)[later].centroid })).toBeCloseTo(10 * STAGE_COVER, 5);
    expect(s.hp[later]).toBe(before[later]);
    // Splash in the middle of the later part: less than the same blast does with the cover passing all of it
    const [x, y] = shipPointToWorld(s, { x: 0, y: 0, angle: w.angle }, w.bridge.geometry(s)[later].centroid, w.bridge.tuning.cellSize);
    const blast = (share: number) => {
      const v = setup('scrap_mother');
      (v.bridge as any).host.stageCover = () => share;
      const b = v.ship().hp.slice();
      v.bridge.splashAt(v.sys, x, y, 60, 30, -1);
      return total(b, v.ship().hp);
    };
    const full = blast(1), covered = blast(STAGE_COVER);
    expect(full).toBeGreaterThan(0);
    expect(covered).toBeLessThan(full);
    expect(covered).toBeGreaterThanOrEqual(full * STAGE_COVER - 1e-6);
  });

  it("a boss's own share (bosses.json stageCover) overrides the default", () => {
    const w = setup('scrap_mother');
    const { later } = parts(w);
    (w.bridge as any).host.stageCover = () => 0.5;
    expect(w.bridge.damagePartBy(w.boss, later, 10, -1)).toBeCloseTo(5, 5);
    (w.bridge as any).host.stageCover = () => undefined;
    expect(w.bridge.damagePartBy(w.boss, later, 10, -1)).toBeCloseTo(10 * STAGE_COVER, 5);
  });
});

describe('wide hits', () => {
  it("a beam's width catches a hull its centre line just misses (and no further)", () => {
    const w = setup('giant_mammoth');
    const s = w.ship(), R = s.derived.radius;
    // A line that just misses: slide a vertical line in from outside until it first touches the hull
    let x = R + 50;
    while (x > -R && !w.bridge.segmentHit(w.boss, s, x, -R - 100, x, R + 100)) x -= 1;
    expect(x).toBeGreaterThan(-R);
    const miss = x + 3;
    expect(w.bridge.segmentHit(w.boss, s, miss, -R - 100, miss, R + 100)).toBeNull();
    expect(w.bridge.segmentHit(w.boss, s, miss, -R - 100, miss, R + 100, 4)).not.toBeNull();
    expect(w.bridge.segmentHit(w.boss, s, miss + 10, -R - 100, miss + 10, R + 100, 4)).toBeNull();
  });
});

describe('beams and the broadphase', () => {
  it('a beam is tried against every ship its line comes near, found through the spatial grid, not by trying them all', () => {
    const w = setup('giant_mammoth');
    const small = Object.values(w.bridge.enemyDesigns).filter((bp) => bp.parts.length >= 4 && bp.parts.length <= 40);
    const rng = seededRng(11);
    const ships: number[] = [w.boss];
    for (let i = 0; i < 120; i++) ships.push(w.bridge.spawnDummy(small[i % small.length], (rng() - 0.5) * 16000, (rng() - 0.5) * 16000, rng() * 6.28, w.sys));
    // (The grid is the tick's: filed as it begins)
    w.step(1);
    let near = 0;
    for (let k = 0; k < 200; k++) {
      const x0 = (rng() - 0.5) * 16000, y0 = (rng() - 0.5) * 16000, a = rng() * Math.PI * 2, len = 800 + rng() * 3000, half = rng() < 0.5 ? 0 : 12;
      const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
      const found = new Set((w.bridge as any).alongBeam(w.sys, x0, y0, x1, y1, half) as Iterable<number>);
      for (const e of ships) {
        if (!(w.bridge as any).nearSegment(e, w.bridge.get(e)!, x0, y0, x1, y1, half)) continue;
        near++;
        expect(found.has(e)).toBe(true);
      }
      // (and far fewer than all of them)
      expect(found.size).toBeLessThan(ships.length / 2);
    }
    expect(near).toBeGreaterThan(20);
  });
});

describe('overhead blasts (a shell lobbed to a point inside a hull)', () => {
  it('a blast aimed at a buried part is mostly spent on what covers it; one on the outside is unchanged', () => {
    const probe = setup('scrap_mother');
    const geoms = probe.bridge.geometry(probe.ship());
    const centre = (w: ReturnType<typeof setup>, i: number) => shipPointToWorld(w.ship(), { x: 0, y: 0, angle: w.angle }, w.bridge.geometry(w.ship())[i].centroid, w.bridge.tuning.cellSize);
    const hurtBy = (i: number, overhead: boolean) => {
      const w = setup('scrap_mother');
      const [x, y] = centre(w, i);
      const b = w.ship().hp.slice();
      w.bridge.splashAt(w.sys, x, y, 60, 30, -1, undefined, overhead ? [x + 6000, y] : undefined);
      return b.reduce((a, h, k) => a + (h - w.ship().hp[k]), 0);
    };
    let lessSomewhere = false;
    for (let i = 0; i < geoms.length; i += Math.max(1, Math.floor(geoms.length / 25))) {
      const flat = hurtBy(i, false), over = hurtBy(i, true);
      expect(over).toBeLessThanOrEqual(flat + 1e-6);
      if (over < flat - 1e-6) lessSomewhere = true;
    }
    expect(lessSomewhere).toBe(true);
  });
});
