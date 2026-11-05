import { describe, it, expect } from 'vitest';
import { dsin, dcos, datan2, dsincos } from '../math/detTrig.js';
import {
  packIds, unpackIds, packRuns, unpackRuns, partGroups, splitPose, splitRng, debrisSpin, debrisMotion, debrisHash, deriveSplit,
  stepDebrisWorld, debrisBlueprint, DEBRIS_GRACE_TICKS, type DebrisBody,
} from './debris.js';
import { createShipState } from './state.js';
import { computeJoins, blueprintGeometry } from './index.js';
import { encodeInputBinary, decodeInputBinary } from '../network/protocol.js';
import { testCatalog, readShipJson } from './testData.js';
import type { ShipTuning, Blueprint } from './index.js';

describe('deterministic trig', () => {
  it('is within an ulp or two of Math, and sincos is sin and cos', () => {
    let seed = 7;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 20000; i++) {
      const x = (rnd() - 0.5) * 200;
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(3e-16 * Math.max(1, Math.abs(x)));
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(3e-16 * Math.max(1, Math.abs(x)));
      const [s, c] = dsincos(x);
      expect([s, c]).toEqual([dsin(x), dcos(x)]);
      const y = (rnd() - 0.5) * 2000, z = (rnd() - 0.5) * 2000;
      expect(Math.abs(datan2(y, z) - Math.atan2(y, z))).toBeLessThan(1e-15);
    }
    expect(datan2(0, -1)).toBe(Math.PI);
    expect(datan2(1, 0)).toBe(Math.PI / 2);
  });
});

describe('debris on the wire', () => {
  it('ids and part runs round trip', () => {
    const ids = [4300, 4301, 4302, 4310, 9];
    expect(unpackIds(packIds(ids))).toEqual(ids);
    const parts = [0, 1, 2, 3, 7, 8, 20, 21, 22, 23, 24, 50];
    expect(packRuns(parts)).toEqual([0, 4, 3, 2, 11, 5, 25, 1]);
    expect(unpackRuns(packRuns(parts))).toEqual(parts);
    expect(unpackRuns([])).toEqual([]);
  });

  it('acks ride on the binary input and decode exactly; an input without them is 11 bytes as before', () => {
    const base = { type: 'input', seq: 3, tick: 0, targetTick: 99, forward: true, backward: false, left: false, right: true, boost: false, fireLeft: true, fireRight: false, targetAngle: 1, cursorDist: 400 } as const;
    expect(new Uint8Array(encodeInputBinary({ ...base })).length).toBe(11);
    const acks = [5, 200, 127, 0, 128, 255, 70000, 17];
    const decoded = decodeInputBinary(new Uint8Array(encodeInputBinary({ ...base, acks })));
    expect(decoded.acks).toEqual(acks);
    expect(decoded.forward).toBe(true);
    expect(decodeInputBinary(new Uint8Array(encodeInputBinary({ ...base }))).acks).toBeUndefined();
  });
});

describe('debris both sides work out alike', () => {
  const catalog = testCatalog(), tuning: ShipTuning = readShipJson('tuning.json'), bp: Blueprint = readShipJson('blueprints/hauler.json');

  it("a client's derived pieces are the server's spawn (same steps from the same ship, tick and parts)", () => {
    // Its core lost: everything left goes as debris, in groups
    const ship = createShipState(catalog, tuning, 50, bp, 10, { kind: 'ship' });
    const joins = computeJoins(blueprintGeometry(catalog, bp));
    const hp = [...ship.maxHp];
    const core = bp.parts.findIndex((p) => p.fn === 'core');
    hp[core] = 0;
    const cut = createShipState(catalog, tuning, 50, bp, 10, { kind: 'ship', hp });
    const parts = new Set<number>();
    cut.derived.alive.forEach((a, i) => { if (!a && hp[i] > 0) parts.add(i); });
    expect(parts.size).toBeGreaterThan(0);
    const groups = partGroups(bp.parts.length, joins, parts);
    const pose = { x: 1234.567, y: -88.123, angle: 0.7, vx: 1.23456, vy: -0.5, angVel: 0.0012345 };
    const ids = groups.map((_, k) => 900 + k);
    const got = deriveSplit(catalog, tuning, ship, 50, 77, ids, parts, joins, pose, (i) => hp[i])!;
    expect(got.length).toBe(groups.length);
    // (the server's spawnDebris, step by step)
    const p = splitPose(pose.x, pose.y, pose.angle, pose.vx, pose.vy, pose.angVel);
    groups.forEach((g, k) => {
      const rng = splitRng(50, 77, k);
      const spin = debrisSpin(p.angVel, rng, tuning.debris.pushSpin);
      const piece = createShipState(catalog, tuning, ids[k], debrisBlueprint(bp, g), 77, { kind: 'debris', hp: g.map((i) => hp[i]), angVel: spin });
      const body = debrisMotion(p, ship.derived.com, piece.derived.com, tuning.cellSize, spin, rng, tuning.debris.pushSpeed);
      expect(got[k].body).toEqual(body);
      expect(got[k].hash).toBe(debrisHash(body));
    });
    // Too few or too many ids: not worked out
    expect(deriveSplit(catalog, tuning, ship, 50, 77, [...ids, 1], parts, joins, pose, (i) => hp[i])).toBeNull();
  });

  it('the world step is the same whatever order the pieces came in (pairs in id order), and pushes overlapping pieces apart', () => {
    const square: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const make = (): DebrisBody[] => [3, 1, 2].map((id) => ({ id, body: { x: id * 15, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }, mass: 4, radius: 15, com: [0, 0], pieces: [square] }));
    const k = { friction: 0.99, worldSize: 1e6, gravity: null };
    const a = make().sort((p, q) => p.id - q.id), b = make().sort((p, q) => p.id - q.id);
    for (let t = 0; t < 30; t++) { stepDebrisWorld(a, k, tuning.cellSize, 0.3); stepDebrisWorld(b, k, tuning.cellSize, 0.3); }
    expect(a.map((d) => d.body)).toEqual(b.map((d) => d.body));
    // (10-unit squares 15 apart at cell size 10: they overlapped, and were pushed apart)
    expect(a[1].body.x - a[0].body.x).toBeGreaterThan(15);
  });

  it('a piece in its grace neither knocks nor is knocked; once it ends, mid-overlap, they are pushed apart alike', () => {
    const square: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const k = { friction: 0.99, worldSize: 1e6, gravity: null };
    // (id 1 is old; id 2 spawned at tick 100, overlapping it)
    const make = (): DebrisBody[] => [1, 2].map((id) => ({ id, body: { x: id * 15, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }, mass: 4, radius: 15, com: [0, 0], pieces: [square], born: id === 2 ? 100 : 0 }));
    const a = make(), b = make();
    let t = 101;
    for (; t <= 100 + DEBRIS_GRACE_TICKS; t++) expect(stepDebrisWorld(a, k, tuning.cellSize, 0.3, t)).toEqual([]);
    // (in its grace: still overlapping, where they were)
    expect(a[1].body.x - a[0].body.x).toBe(15);
    expect(stepDebrisWorld(a, k, tuning.cellSize, 0.3, t)).toEqual([[1, 2]]);
    expect(a[1].body.x - a[0].body.x).toBeGreaterThan(15);
    // (stepped again from its spawn, as a client does: the same bits)
    for (let u = 101; u <= t; u++) stepDebrisWorld(b, k, tuning.cellSize, 0.3, u);
    expect(b.map((d) => d.body)).toEqual(a.map((d) => d.body));
  });
});
