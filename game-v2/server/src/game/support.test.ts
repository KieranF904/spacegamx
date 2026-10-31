/**
 * The Repair Beam and the Point Defence Turret in the full server (common/src/ships/support.ts): a beam held on a
 * damaged wingmate mends it (not an enemy, not its own ship, not a destroyed part) and counts as support for rewards;
 * point defence shoots down hostile missiles and torpedoes on its own, but not a boss's nova or a friend's shots.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, Dead, ServerMessage, parseBlueprint, type Blueprint } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { Support, SUPPORT_WINDOW_TICKS } from './Support.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const sparrow: Blueprint = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
/** The Sparrow with a Repair Beam above its right gun and a Point Defence Turret in place of its left one */
const warden: Blueprint = {
  ...sparrow,
  parts: [
    ...sparrow.parts.filter((p) => p.uid !== 2),
    { uid: 2, piece: 'sq', fn: 'point_defence_turret', material: 'steel', x: -1, y: 0, rot: 0, flip: false, facing: 'N' },
    { uid: 50, piece: 'rect2', fn: 'utility_repair_beam', material: 'steel', x: 2, y: -1, rot: 0, flip: false, facing: 'N' },
  ],
};

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => 1_000_000,
  });
  const join = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    const pid = t.getPlayerId();
    let seq = 1;
    const input = (i: Record<string, unknown>) => t.send({ type: 'input', seq: seq++, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2, ...i } as any);
    return { t, pid, got, input };
  };
  const place = (eid: number, x: number, y: number) => { Position.x[eid] = x; Position.y[eid] = y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; Rotation.angle[eid] = -Math.PI / 2; };
  const run = (n: number) => { for (let k = 0; k < n; k++) server.step(); };
  return { server, join, place, run, ships: server.getShips()! };
}

const total = (hp: number[]) => hp.reduce((a, b) => a + b, 0);

describe('Repair Beam', () => {
  it('held on a damaged wingmate, it mends the parts nearest where it lands; never its own ship or a destroyed part', () => {
    const w = world();
    const a = w.join('warden'), b = w.join('wing');
    w.ships.respawnInPlace(a.pid, warden);
    w.place(a.pid, 40000, 40000);
    w.place(b.pid, 40000 + 2 * 24 + 12, 40000 - 300);
    w.run(2);
    const sa = w.ships.get(a.pid)!, sb = w.ships.get(b.pid)!;
    expect(sa.derived.weapons.some((x) => x.kind === 'repair')).toBe(true);
    // Hurt both: the wingmate's hull and guns, and the warden's own
    for (const i of [0, 1, 2, 3, 4, 7, 8]) w.ships.damagePartFraction(b.pid, i, 0.5);
    w.ships.damagePartFraction(b.pid, 9, 1);
    for (const i of [1, 4, 7]) w.ships.damagePartFraction(a.pid, i, 0.5);
    w.run(1);
    const before = total(sb.hp), mine = total(sa.hp);
    expect(sb.hp[9]).toBe(0);
    for (let k = 0; k < 120; k++) { a.input({ fireLeft: true, targetAngle: -Math.PI / 2, cursorDist: 300 }); b.input({}); w.run(1); }
    const after = total(sb.hp);
    // About a second of mending at its rate (a Mk II steel beam: 42 HP/s × its strength, at its power)
    expect(after - before).toBeGreaterThan(20);
    expect(after - before).toBeLessThan(42 * 2 * 3);
    expect(sb.hp[9]).toBe(0);
    expect(total(sa.hp)).toBeCloseTo(mine, 6);
    // It counts as support: the wingmate's kills pay the warden as the wingmate's party would
    expect(w.server.support.supporters(b.pid, (w.server as any).currentTick)).toEqual([a.pid]);
  });

  it('passes through an enemy without mending or hurting it', () => {
    const w = world();
    const a = w.join('warden');
    w.ships.respawnInPlace(a.pid, warden);
    w.place(a.pid, 40000, 40000);
    const foe = w.ships.spawnDummy(sparrow, 40000 + 2 * 24 + 12, 40000 - 300, -Math.PI / 2, 0);
    w.run(2);
    const sf = w.ships.get(foe)!;
    for (const i of [0, 1, 4]) w.ships.damagePartFraction(foe, i, 0.5);
    const before = total(sf.hp);
    // (Only the beam: the warden's pip and point defence have nothing to do with it)
    for (let k = 0; k < 90; k++) { a.input({ fireLeft: true, targetAngle: -Math.PI / 2, cursorDist: 300 }); w.run(1); }
    expect(total(sf.hp)).toBeLessThanOrEqual(before + 1e-6);
    expect(w.server.support.supporters(foe, (w.server as any).currentTick)).toEqual([]);
  });

  it('a pilot in a PvP zone mends only their own party (canHeal)', () => {
    const w = world();
    const a = w.join('warden'), b = w.join('stranger');
    expect(w.server.canHeal(a.pid, b.pid)).toBe(true);
    expect(w.server.canHeal(a.pid, a.pid)).toBe(false);
    (w.server as any).inPvpZone = () => true;
    expect(w.server.canHeal(a.pid, b.pid)).toBe(false);
  });
});

describe('Point Defence Turret', () => {
  const setup = () => {
    const w = world();
    const a = w.join('picket');
    w.ships.respawnInPlace(a.pid, warden);
    w.place(a.pid, 40000, 40000);
    const foe = w.ships.spawnDummy(sparrow, 40000, 38000, Math.PI / 2, 0);
    w.run(2);
    const weapons = (w.server as any).weapons;
    /** A shot from `owner` 420 units north of the picket, flying at it */
    const shoot = (owner: number, kind: string, opts: Record<string, unknown> = {}) =>
      weapons.spawn(owner, kind, 40000, 40000 - 420, Math.PI / 2, 1, { speedScale: 1, sizeScale: 1, turret: false, noBurst: true, target: a.pid, ...opts }) as number;
    return { ...w, a, foe, shoot, weapons };
  };
  const intercepts = (got: ServerMessage[], proj: number) => got.filter((m) => m.type === 'intercept' && m.proj === proj) as Extract<ServerMessage, { type: 'intercept' }>[];

  it("shoots down a hostile's missile on its own, without the trigger, before it lands", () => {
    const w = setup();
    const hull = total(w.ships.get(w.a.pid)!.hp);
    const m = w.shoot(w.foe, 'missile');
    for (let k = 0; k < 40; k++) { w.a.input({}); w.run(1); }
    const hits = intercepts(w.a.got, m);
    expect(hits.length).toBe(1);
    expect(hits[0].down).toBe(true);
    expect(hits[0].bodyId).toBe(w.a.pid);
    expect(bitecs.hasComponent(w.server.world, Dead, m) || !bitecs.entityExists(w.server.world, m)).toBe(true);
    expect(total(w.ships.get(w.a.pid)!.hp)).toBeCloseTo(hull, 6);
  });

  it('a torpedo takes three hits', () => {
    const w = setup();
    const m = w.shoot(w.foe, 'torpedo');
    for (let k = 0; k < 90; k++) { w.a.input({}); w.run(1); }
    const hits = intercepts(w.a.got, m);
    expect(hits.length).toBe(3);
    expect(hits.map((h) => h.down)).toEqual([false, false, true]);
  });

  it("leaves a boss nova's shots, a plain shell and a friend's missile alone", () => {
    const w = setup();
    const nova = w.shoot(w.foe, 'missile', { intercept: false });
    const shell = w.shoot(w.foe, 'autocannon');
    const b = w.join('friend');
    w.place(b.pid, 40300, 40000);
    const mine = w.shoot(b.pid, 'missile', { target: w.foe });
    for (let k = 0; k < 30; k++) { w.a.input({}); w.run(1); }
    for (const p of [nova, shell, mine]) expect(intercepts(w.a.got, p)).toEqual([]);
  });

  it('is quiet while EMPed', () => {
    const w = setup();
    w.ships.empAt(0, 40000, 40000, 300, 600, w.foe);
    const m = w.shoot(w.foe, 'missile');
    for (let k = 0; k < 20; k++) { w.a.input({}); w.run(1); }
    expect(intercepts(w.a.got, m)).toEqual([]);
  });
});

describe('Support ledger', () => {
  it('counts mending in a window, past a little HP, most first; forgets the gone', () => {
    const s = new Support();
    s.note(1, 9, 30, 100);
    s.note(2, 9, 5, 100);
    s.note(3, 9, 80, 100);
    s.note(9, 9, 50, 100);
    expect(s.supporters(9, 150)).toEqual([3, 1]);
    expect(s.supporters(9, 100 + SUPPORT_WINDOW_TICKS + 1)).toEqual([]);
    s.note(1, 9, 30, 2000);
    s.forget(1);
    expect(s.supporters(9, 2001)).toEqual([]);
    expect(s.mended(1)).toBe(0);
  });
});
