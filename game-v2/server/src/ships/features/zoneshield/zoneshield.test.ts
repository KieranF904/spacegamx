/**
 * Shaped shields on the server (common/src/ships/features/zoneshield for the rules): a shot that crosses a shield is caught
 * there, its damage goes to that shield and not the hull, the shield refills and breaks and returns on the bridge's tick,
 * a blast the far side of a shield is soaked by it, a shot that ignores shields goes through, and the levels reach the wire.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, InSystem, isWeaponFn, replicaAngle, quantizeReplicaAngle, ReplicaMode, Position, Velocity, Rotation, shapedOf, shieldHp, shieldUp, packShaped, shapedLevel, shipPointToWorld, parseBlueprint, type Blueprint, type Catalog } from '@space-game/common';
import { readFileSync } from 'fs';
import { GameData } from '../../../data/GameData.js';
import { readGameDataFiles } from '../../../data/loadGameDataFromDisk.js';
import { LocalTransport } from '../../../net/LocalTransport.js';
import { feedParts } from '../../../../../common/src/ships/testData.js';
import { makeServer } from '../../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../../data');

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = makeServer({ gameData: new GameData(readGameDataFiles(dataDir)), userDB: {} as any, });
  return { server, ships: server.getShips() };
}

/** The starter with shaped shields added at its left, each fed by a Cell Reactor across its in port (testData feedParts): [fn, piece, x, y, facing] */
function design(extra: [string, string, number, number, 'W' | 'N' | 'S'][], catalog: Catalog): Blueprint {
  const bp = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
  extra.forEach(([fn, piece, x, y, facing], k) => bp.parts.push({ uid: 900 + k, piece, fn, material: fn === 'shield_rampart' ? 'steel' : 'alloy', x, y, rot: 0, flip: false, facing } as never));
  return feedParts(catalog, bp, extra.map((_, k) => 900 + k));
}

const spawn = (extra: Parameters<typeof design>[0]) => {
  const w = world();
  const e = w.ships.spawnDummy(design(extra, w.ships.catalog), 0, 300000, 0, 0);
  Rotation.angle[e] = 0;
  const ship = w.ships.get(e)!;
  const cs = w.ships.tuning.cellSize;
  /** A segment along the grid's x axis at grid y `gy`, from `gx0` to `gx1`, in the world */
  const along = (gy: number, gx0: number, gx1: number): [number, number, number, number] => {
    const pose = { x: Position.x[e], y: Position.y[e], angle: 0 };
    const a = shipPointToWorld(ship, pose, [gx0, gy], cs), b = shipPointToWorld(ship, pose, [gx1, gy], cs);
    return [a[0], a[1], b[0], b[1]];
  };
  return { ...w, e, ship, along };
};

const WALL: Parameters<typeof design>[0] = [['shield_spark_wall', 'sq', -2, 0, 'W']];

describe('shaped shields (server half)', () => {
  it('a ship with one has it up and full, and the wire says so', () => {
    const { server, ships, e, ship } = spawn(WALL);
    server.step();
    expect(shapedOf(ship)).toHaveLength(1);
    expect(shieldUp(ship, 0)).toBe(true);
    expect(shieldHp(ship, 0)).toBe(40);
    expect(ship.derived.shieldMax).toBe(0);
    expect(ships.shieldFraction(e)).toBe(0);
    const features = (server as any).features;
    expect(features.status('zoneshield', e)).toBe(packShaped(ship));
    expect(shapedLevel(features.status('zoneshield', e), 0)).toBe(15);
  });

  it('a shot that crosses it is caught there, the shield takes the damage and the hull none', () => {
    const { ships, e, ship, along } = spawn(WALL);
    const [x0, y0, x1, y1] = along(0.5, -12, ship.derived.com[0]);
    const hit = ships.segmentHit(e, ship, x0, y0, x1, y1, 0, 1)!;
    expect(hit.shield).toBe(0);
    expect(hit.spill).toBe(true);
    // (without asking for shields, the hull alone: past the wall to the hull)
    const bare = ships.segmentHit(e, ship, x0, y0, x1, y1)!;
    expect(bare.shield).toBeUndefined();
    expect(bare.t).toBeGreaterThan(hit.t);
    const hull = ship.hp[hit.part];
    const dealt = ships.hurt(e, ship, hit.part, 30, -1, { shaped: { i: hit.shield!, spill: !!hit.spill } });
    expect(dealt).toBe(30);
    expect(shieldHp(ship, 0)).toBe(10);
    expect(ship.hp[hit.part]).toBe(hull);
    // (a break lets the rest on to the hull part)
    ships.hurt(e, ship, hit.part, 30, -1, { shaped: { i: 0, spill: true } });
    expect(shieldUp(ship, 0)).toBe(false);
    expect(ship.hp[hit.part]).toBeLessThan(hull);
  });

  it('a shot that misses every shield reaches the hull', () => {
    const { ships, e, ship, along } = spawn(WALL);
    // (the right of the ship, nowhere near the wall at its left)
    const [x0, y0, x1, y1] = along(0.5, 14, ship.derived.com[0]);
    const hit = ships.segmentHit(e, ship, x0, y0, x1, y1, 0, 1)!;
    expect(hit).not.toBeNull();
    expect(hit.shield).toBeUndefined();
  });

  it('a down shield stops nothing, and comes back by itself: down its delay, then at a quarter, then refilling', () => {
    const { server, ships, e, ship, along } = spawn(WALL);
    ships.hurt(e, ship, 0, 60, -1, { shaped: { i: 0, spill: false } });
    expect(shieldUp(ship, 0)).toBe(false);
    const [x0, y0, x1, y1] = along(0.5, -12, ship.derived.com[0]);
    expect(ships.segmentHit(e, ship, x0, y0, x1, y1, 0, 1)!.shield).toBeUndefined();
    for (let i = 0; i < 85; i++) server.step();
    expect(shieldUp(ship, 0)).toBe(false);
    for (let i = 0; i < 10; i++) server.step();
    expect(shieldUp(ship, 0)).toBe(true);
    expect(shieldHp(ship, 0)).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < 120; i++) server.step();
    expect(shieldHp(ship, 0)).toBeGreaterThan(10);
    expect(shapedLevel((server as any).features.status('zoneshield', e), 0)).toBeGreaterThan(0);
  });

  it('each shield has its own pool: one broken leaves the other as it was', () => {
    const { ships, e, ship } = spawn([['shield_spark_wall', 'sq', -2, 0, 'W'], ['shield_visor', 'sq', -2, -1, 'W']]);
    ships.hurt(e, ship, 0, 100, -1, { shaped: { i: 0, spill: false } });
    expect(shieldUp(ship, 0)).toBe(false);
    expect(shieldUp(ship, 1)).toBe(true);
    expect(shieldHp(ship, 1)).toBe(45);
  });

  it('a blast the far side of a shield from the part is soaked by it, once, and the part is spared', () => {
    const { ships, e, ship, along } = spawn(WALL);
    const core = ship.blueprint.parts.findIndex((p) => p.fn === 'core');
    const hull = ship.hp[core];
    // (just outside the wall, at its middle: the line to the part crosses it)
    const [bx, by] = along(0.5, -4.5, -4.5);
    ships.splashAt(0, bx, by, 160, 30, -1);
    expect(shieldHp(ship, 0)).toBeLessThan(40);
    expect(ship.hp[core]).toBe(hull);
  });

  it('a held beam stops on the shield it crosses first: the shield burns, the hull behind it does not', () => {
    const w = world();
    const t = new LocalTransport(w.server);
    t.onMessage = () => {};
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const pid = t.getPlayerId();
    const ships = w.ships, X = 25000, Y = 20000, gap = 400;
    // (the pool-era starter, its guns fed in full, one of them a Cutter)
    const mine = design([], ships.catalog);
    let n = 0;
    // (the first gun a Cutter, the other a plain hull cell so only the beam burns)
    ships.respawnInPlace(pid, { ...mine, parts: mine.parts.map((q) => (!isWeaponFn(q.fn) ? q : n++ < 1 ? { ...q, fn: 'laser_cutter' } : { ...q, fn: 'hull', facing: undefined })) });
    const e = ships.spawnDummy(design(WALL, ships.catalog), X + gap, Y, 0, InSystem.systemId[pid]);
    const target = ships.get(e)!;
    // (angle -90 degrees: its grid's west is the world's west, the wall faces the pilot; its middle is put on the beam's line)
    Rotation.angle[e] = -Math.PI / 2;
    const wall = shipPointToWorld(target, { x: Position.x[e], y: Position.y[e], angle: -Math.PI / 2 }, [-3, 0.5], ships.tuning.cellSize);
    // (and the beam is the Cutter's, from its muzzle: that line, not the ship's middle)
    const mine2 = ships.get(pid)!, gun = mine2.derived.weapons.find((q) => q.kind === 'laser')!;
    const muzzle = shipPointToWorld(mine2, { x: X, y: Y, angle: 0 }, gun.muzzle, ships.tuning.cellSize);
    // (the guns converge on the cursor's distance, on the ship's middle line: the beam slopes from its muzzle to there)
    const beamAtWall = muzzle[1] + ((Y - muzzle[1]) / gap) * (wall[0] - muzzle[0]);
    Position.y[e] += beamAtWall - wall[1];
    const ey = Position.y[e];
    const burned: { shaped: boolean; part: number }[] = [];
    const real = (ships as any).hurt.bind(ships);
    (ships as any).hurt = (eid: number, ship: unknown, part: number, amount: number, src: number, vs?: { shaped?: unknown }) => {
      if (eid === e) burned.push({ shaped: !!vs?.shaped, part });
      return real(eid, ship, part, amount, src, vs);
    };
    for (let i = 0; i < 40; i++) {
      Position.x[pid] = X; Position.y[pid] = Y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = 0;
      Position.x[e] = X + gap; Position.y[e] = ey; Velocity.x[e] = 0; Velocity.y[e] = 0; Rotation.angle[e] = -Math.PI / 2;
      Input.fireLeft[pid] = 1; Input.cursorDist[pid] = gap; Input.targetAngle[pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));
      w.server.step();
    }
    // (the shield takes the beam first; once it is spent and down the beam goes on to the hull: never the other way)
    expect(burned.length).toBeGreaterThan(0);
    expect(burned[0].shaped).toBe(true);
    const firstHull = burned.findIndex((x) => !x.shaped);
    if (firstHull >= 0) expect(burned.slice(firstHull).every((x) => !x.shaped)).toBe(true);
    expect(shieldHp(target, 0)).toBeLessThan(40);
    // (the hull took nothing while the shield held it: the first burn that was not the shield's is after it broke)
    expect(burned.slice(0, firstHull < 0 ? burned.length : firstHull).length).toBeGreaterThan(0);
  });

  it('a shot that ignores shields (a torpedo, scale 0) is not stopped, whatever the wall', () => {
    const { ships, e, ship, along } = spawn(WALL);
    const [x0, y0, x1, y1] = along(0.5, -12, ship.derived.com[0]);
    expect(ships.segmentHit(e, ship, x0, y0, x1, y1, 0, 0)!.shield).toBeUndefined();
  });
});
