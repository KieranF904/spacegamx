/**
 * The repair bank on the server (game/RepairBank.ts, Pilots, bridge/rebuild.ts repairStep, net/handlers/bank.ts):
 * docs/design/field-fabrication.md sections 2.4 and 6.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, ServerMessage, Station as StationComp, BANK, countOf, bankCap, freeWhole, refillBank, newBank, jobTicks, fabWork, attachWork,
  computeJoins, blueprintGeometry, depositable, type PlayerProfile, type ShipRecord,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world(opts: { dev?: boolean } = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => clock.t,
    ...(opts.dev ? { shipEditAnywhere: true } : {}),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'banker' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const profile = (): PlayerProfile => server.pilots.get(conn)!;
  const ships = server.getShips();
  const last = <T extends ServerMessage['type']>(type: T) => [...got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  return { server, t, got, pid, conn, profile, ships, clock, last, bank: server.pilots.bank };
}

/** Park beside Sol Central (a station with every service) */
function dock(server: GameServer, pid: number): void {
  const w = server.getWorld();
  const num = server['gameData'].getStationNum('sol_station_central');
  const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
  Position.x[pid] = Position.x[st] + 300; Position.y[pid] = Position.y[st];
  Velocity.x[pid] = 0; Velocity.y[pid] = 0;
  server.step();
}
const steps = (server: GameServer, n: number) => { for (let i = 0; i < n; i++) server.step(); };
const park = (pid: number, x = 40000, y = 40000) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
const total = (b: Record<string, number>) => Object.values(b).reduce((a, n) => a + n, 0);

/** The standing parts of a record are all joined to its core (a structure that holds) */
function holds(w: ReturnType<typeof world>, rec: ShipRecord): boolean {
  const parts = rec.blueprint.parts;
  const ghost = new Set(rec.ghosts ?? []);
  const joins = computeJoins(blueprintGeometry(w.server.econ.ships, rec.blueprint));
  const root = parts.findIndex((q) => q.fn === 'core');
  const seen = new Set([root]);
  for (let moved = true; moved;) {
    moved = false;
    for (const [a, b] of joins) {
      if (ghost.has(parts[a].uid) || ghost.has(parts[b].uid)) continue;
      if (seen.has(a) !== seen.has(b)) { seen.add(a); seen.add(b); moved = true; }
    }
  }
  return parts.every((q, i) => ghost.has(q.uid) || seen.has(i));
}

describe('the free part', () => {
  it('is full at a first login and sent to the client', () => {
    const w = world();
    expect(w.profile().bank).toBeDefined();
    expect(freeWhole(w.profile().bank!)).toEqual(w.bank.cap);
    expect(w.bank.cap).toEqual(bankCap(w.server.econ, w.profile().ship.blueprint));
    const m = w.last('repairBank')!;
    expect(m.free).toEqual(m.cap);
    expect(m.fullIn).toBe(0);
    expect(m.deposits).toEqual({});
    expect(total(m.spare)).toBeGreaterThan(0);
  });

  it('refills by the wall clock, each item at its own cap\'s pace, and the client is told at most once a minute', () => {
    const w = world();
    const p = w.profile();
    const cap = w.bank.cap;
    p.bank!.free = {};
    p.bank!.at = w.clock.t;
    w.bank.ensure(p, w.clock.t + (BANK.refillSeconds * 1000) / 2);
    for (const [id, c] of Object.entries(cap)) expect(p.bank!.free[id]).toBeCloseTo(c / 2, 6);
    w.bank.ensure(p, w.clock.t + BANK.refillSeconds * 1000 * 2);
    expect(freeWhole(p.bank!)).toEqual(cap);
    // The server sends while it refills: not more than once a minute
    p.bank!.free = {};
    const n = () => w.got.filter((m) => m.type === 'repairBank').length;
    w.clock.t += 61_000;
    steps(w.server, 15);
    const a = n();
    w.clock.t += 5_000;
    steps(w.server, 30);
    expect(n()).toBe(a);
    w.clock.t += 61_000;
    steps(w.server, 15);
    expect(n()).toBeGreaterThan(a);
  });

  it('refillBank is the rules\' own (common): a profile with no bank gets a full one', () => {
    const w = world();
    const p = w.profile();
    delete (p as any).bank;
    expect(w.bank.ensure(p, 5)).toBe(true);
    expect(p.bank).toEqual(newBank(w.bank.cap, 5));
    expect(refillBank(p.bank!, w.bank.cap, 6)).toBe(false);
  });
});

describe('a death', () => {
  it('puts the same design back with no loaner: the free part pays core outward, the rest is owed, and a bare bank means a bare core', () => {
    const w = world();
    const p = w.profile();
    const design = JSON.stringify(p.ship.blueprint);
    const cargoBefore = JSON.stringify(p.storage);
    // A starter ship is exactly what a full free part pays
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    expect(JSON.stringify(w.profile().ship.blueprint)).toBe(design);
    expect(w.profile().ship.loaner).toBeUndefined();
    expect(w.profile().ship.ghosts).toEqual([]);
    expect(w.profile().ship.lost).toBeUndefined();
    expect(JSON.stringify(w.profile().storage)).toBe(cargoBefore);
    expect(total(freeWhole(w.profile().bank!))).toBe(0);
    // Again, at once: the free part is empty, so a bare core
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    const rec = w.profile().ship;
    const core = rec.blueprint.parts.find((q) => q.fn === 'core')!;
    expect(rec.ghosts).toEqual(rec.blueprint.parts.filter((q) => q !== core).map((q) => q.uid));
    expect(rec.owed).toEqual(rec.ghosts);
    expect(w.profile().hangar.some((r) => r?.loaner)).toBe(false);
    // The live ship is the bare core
    w.server.pilots.reapplyShip(w.conn);
    w.server.step();
    const live = w.ships.get(w.pid)!;
    expect(live.blueprint.parts.filter((_, i) => live.derived.alive[i]).map((q) => q.fn)).toEqual(['core']);
    // The pilot is told what happened
    expect(w.got.some((m) => m.type === 'toast' && /bare core/.test((m as any).text))).toBe(true);
    expect(w.last('repairBank')!.rebuilding).toBe(rec.owed!.length);
  });

  it('pays core outward: what the free part rebuilds is always a structure joined to the core', () => {
    const w = world();
    const p = w.profile();
    // About a third of a ship\'s worth
    p.bank!.free = Object.fromEntries(Object.entries(w.bank.cap).map(([id, n]) => [id, Math.floor(n / 3)]));
    const r = w.bank.respawn(p, p.ship);
    expect(r.paid).toBeGreaterThan(0);
    expect(r.owed).toBeGreaterThan(0);
    expect(holds(w, p.ship)).toBe(true);
    // And it only spent what it paid
    const paid = p.ship.blueprint.parts.filter((q) => q.fn !== 'core' && !p.ship.ghosts!.includes(q.uid));
    const spent: Record<string, number> = {};
    for (const q of paid) for (const [id, n] of Object.entries(w.server.econ.recipes.partInputs(q))) spent[id] = (spent[id] ?? 0) + n;
    for (const [id, n] of Object.entries(spent)) expect(p.bank!.free[id]).toBeCloseTo(Math.floor(w.bank.cap[id] / 3) - n, 6);
  });

  it('planned parts that were never built are not owed: the bank only rebuilds the ship\'s own design', () => {
    const w = world();
    const p = w.profile();
    const planned = p.ship.blueprint.parts.filter((q) => q.fn === 'hull').slice(0, 2).map((q) => q.uid);
    p.ship.ghosts = [...planned];
    w.server.pilots.reapplyShip(w.conn);
    p.bank!.free = {};
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    const rec = w.profile().ship;
    for (const u of planned) { expect(rec.ghosts).toContain(u); expect(rec.owed).not.toContain(u); }
    expect(rec.owed!.length).toBe(rec.ghosts!.length - planned.length);
  });

  it('the wreck gets the cargo and 70% of the ship\'s minerals (all of them in safe space); nothing goes to storage', () => {
    const w = world();
    const p = w.profile();
    w.server.pilots.give(w.conn, { iron_ore: 30, nickel_ore: 12 }, { quiet: true });
    p.cargo = [{ id: 'iron_ore', n: 30 }, { id: 'nickel_ore', n: 12 }, { id: 'silicate', n: 12 }, { id: 'copper_ore', n: 12 }];
    const storage = JSON.stringify(p.storage);
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    expect(JSON.stringify(w.profile().storage)).toBe(storage);
    const pods = (w.server as any).pods;
    const wreck = [...pods.contents.keys()].find((e: number) => Math.hypot(Position.x[e] - 90000, Position.y[e] - 90000) < 50);
    expect(wreck).toBeDefined();
    expect(total(pods.get(wreck))).toBeGreaterThan(0);
  });

  it('deposits do not pay at a respawn, and an empty bank with no deposits stays bare', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 40, copper_wire: 40 };
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    // (still all owed: the deposits rebuild over time, anywhere)
    expect(w.profile().ship.owed!.length).toBe(w.profile().ship.blueprint.parts.length - 1);
    expect(w.profile().bank!.deposits).toEqual({ alloy_plate: 40, copper_wire: 40 });
  });
});

describe('deposits rebuild over time', () => {
  it('a part at a time at a fabricator\'s pace (fabricate + attach), core outward, never instantly', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 200, copper_wire: 200, steel_plate: 200, composite_sheet: 200 };
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    const rec = w.profile().ship;
    const owed0 = rec.owed!.length;
    expect(owed0).toBeGreaterThan(3);
    const first = (): number => {
      const ghosts = new Set(rec.ghosts);
      return rec.blueprint.parts.findIndex((q) => ghosts.has(q.uid));
    };
    void first;
    // None for the first tick
    expect(w.bank.stepDeposits(p, rec, 1)).toBeNull();
    // The first part takes its job's ticks, no sooner
    let ticks = 1, got: number | null = null;
    while (got === null && ticks < 100000) { got = w.bank.stepDeposits(p, rec, 1); ticks++; }
    expect(got).not.toBeNull();
    const part = rec.blueprint.parts.find((q) => q.uid === got)!;
    expect(ticks).toBe(jobTicks(fabWork(w.server.econ, part) + attachWork(w.server.econ.ships, part), BANK.respawnSpeed));
    expect(rec.owed!.length).toBe(owed0 - 1);
    expect(rec.ghosts).not.toContain(got);
    expect(holds(w, rec)).toBe(true);
    // The inputs came out of the deposits
    const used = w.server.econ.recipes.partInputs(part);
    expect(total(p.bank!.deposits)).toBe(200 * 4 - total(used));
    // And they keep coming, one at a time, until the ship is whole or the deposits can't pay
    let more = 0;
    for (let i = 0; i < 200000 && (rec.owed?.length ?? 0) > 0; i++) if (w.bank.stepDeposits(p, rec, 15) !== null) more++;
    expect(more).toBeGreaterThan(0);
    expect(holds(w, rec)).toBe(true);
  });

  it('is slower than nothing and stops when the deposits cannot pay a part; claimed parts are left to the machine', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = {};
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    const rec = w.profile().ship;
    for (let i = 0; i < 5000; i++) expect(w.bank.stepDeposits(p, rec, 60)).toBeNull();
    p.bank!.deposits = { alloy_plate: 200, copper_wire: 200, steel_plate: 200, composite_sheet: 200 };
    // Every uid claimed by a machine: nothing is built by the bank
    for (let i = 0; i < 5000; i++) expect(w.bank.stepDeposits(p, rec, 60, () => true)).toBeNull();
    expect(total(p.bank!.deposits)).toBe(800);
  });

  it('in the live game: parts come back on the ship over time as the bank pays, and the pilot is told', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 200, copper_wire: 200, steel_plate: 200, composite_sheet: 200 };
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    w.server.pilots.reapplyShip(w.conn);
    w.server.step();
    const alive = () => w.ships.get(w.pid)!.derived.alive.filter(Boolean).length;
    expect(alive()).toBe(1);
    park(w.pid);
    steps(w.server, 60);
    expect(alive()).toBe(1); // a second in: nothing yet
    let n = 1;
    for (let i = 0; i < 60 * 60 * 5 && alive() < w.ships.get(w.pid)!.blueprint.parts.length; i++) { park(w.pid); w.server.step(); if (alive() > n) n = alive(); }
    expect(alive()).toBeGreaterThan(1);
    expect(w.profile().bank!.deposits.alloy_plate).toBeLessThan(200);
  }, 120_000);

  it('the free part rebuilds owed parts as it refills', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    w.server.pilots.reapplyShip(w.conn);
    expect(w.profile().ship.owed!.length).toBeGreaterThan(0);
    park(w.pid);
    w.clock.t += BANK.refillSeconds * 1000 + 1000;
    steps(w.server, 30);
    expect(w.profile().ship.owed).toBeUndefined();
    expect(w.profile().ship.ghosts).toEqual([]);
    const live = w.ships.get(w.pid)!;
    expect(live.derived.alive.every(Boolean)).toBe(true);
  });

  it('the hangar view follows: parts built in while the pilot flies are sent again, not left missing', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    w.server.pilots.reapplyShip(w.conn);
    park(w.pid);
    w.server.hangar.send(w.conn as any); // (the pilot has the hangar as the death left it)
    const ghostsSent = () => {
      const h = [...w.got].reverse().find((m) => m.type === 'hangar') as Extract<ServerMessage, { type: 'hangar' }> | undefined;
      return h?.slots[w.profile().activeSlot]?.ghosts ?? [];
    };
    expect(w.profile().ship.owed!.length).toBeGreaterThan(0);
    expect(ghostsSent().length).toBeGreaterThan(0);
    // (the free part refills and pays the owed parts: the view must drop them from the missing list)
    w.clock.t += BANK.refillSeconds * 1000 + 1000;
    steps(w.server, 30);
    expect(w.profile().ship.ghosts).toEqual([]);
    expect(ghostsSent()).toEqual([]);
  });

  it('the same for parts the deposits build', () => {
    const w = world();
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 400, copper_wire: 400, iron_plate: 400 };
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    w.server.pilots.reapplyShip(w.conn);
    park(w.pid);
    w.server.hangar.send(w.conn as any); // (the pilot has the hangar as the death left it)
    const ghostsSent = () => {
      const h = [...w.got].reverse().find((m) => m.type === 'hangar') as Extract<ServerMessage, { type: 'hangar' }> | undefined;
      return h?.slots[w.profile().activeSlot]?.ghosts ?? [];
    };
    const n0 = w.profile().ship.owed!.length;
    let ticks = 0;
    while (w.profile().ship.owed && w.profile().ship.owed!.length === n0 && ticks++ < 4000) steps(w.server, 15);
    const owedNow = w.profile().ship.owed?.length ?? 0;
    expect(owedNow).toBeLessThan(n0);
    expect(ghostsSent().length).toBe(w.profile().ship.ghosts!.length);
  }, 120_000);
});

describe('passing a station', () => {
  const hurt = (w: ReturnType<typeof world>) => {
    const ship = w.ships.get(w.pid)!;
    const gun = ship.blueprint.parts.findIndex((q) => q.fn === 'cannon_pip');
    w.ships.damagePartFraction(w.pid, gun, 0.6);
    return gun;
  };
  const run = (w: ReturnType<typeof world>, ticks: number) => { for (let i = 0; i < ticks; i++) { dockSpot(w); w.server.step(); } };
  const dockSpot = (w: ReturnType<typeof world>) => {
    const sw = w.server.getWorld();
    const num = w.server['gameData'].getStationNum('sol_station_central');
    const st = [...Array(8000).keys()].find((e) => bitecs.entityExists(sw, e) && bitecs.hasComponent(sw, StationComp, e) && StationComp.stationId[e] === num)!;
    Position.x[w.pid] = Position.x[st] + 600; Position.y[w.pid] = Position.y[st]; Velocity.x[w.pid] = 0; Velocity.y[w.pid] = 0;
  };

  it('deposits heal damaged parts, paid once for the part, at 10% of its HP a second', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 20, copper_wire: 20 };
    const gun = hurt(w);
    const ship = w.ships.get(w.pid)!;
    const before = total(p.bank!.deposits);
    run(w, 2);
    const hp0 = ship.hp[gun];
    expect(hp0).toBeLessThan(ship.maxHp[gun] * 0.5);
    run(w, 60);
    expect(ship.hp[gun] - hp0).toBeGreaterThan(ship.maxHp[gun] * (BANK.stationHealPerSecond - 0.04));
    expect(ship.hp[gun] - hp0).toBeLessThan(ship.maxHp[gun] * (BANK.stationHealPerSecond + 0.04));
    run(w, 60 * 12);
    expect(ship.hp[gun]).toBeCloseTo(ship.maxHp[gun], 3);
    // Paid once for the part (half its inputs by the HP gone, at least a unit), from the deposits
    expect(total(p.bank!.deposits)).toBeLessThan(before);
    expect(total(p.bank!.deposits)).toBeGreaterThan(before - 8);
  }, 120_000);

  it('a hit pauses the repair', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 20, copper_wire: 20 };
    const ship = w.ships.get(w.pid)!;
    const gun = ship.blueprint.parts.findIndex((q) => q.fn === 'cannon_pip');
    w.ships.hurt(w.pid, ship, gun, ship.maxHp[gun] * 0.5, -1);
    const hp = ship.hp[gun];
    run(w, w.ships.tuning.repair!.combatPauseTicks - 40);
    expect(ship.hp[gun]).toBeLessThanOrEqual(hp);
    expect(total(p.bank!.deposits)).toBe(40);
    run(w, 40 + 120);
    expect(ship.hp[gun]).toBeGreaterThan(hp);
  }, 120_000);

  it('rebuilds a missing part every couple of seconds, nearest the core first, paid with its recipe inputs', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 40, copper_wire: 40 };
    const ship = w.ships.get(w.pid)!;
    const hull = ship.blueprint.parts.findIndex((q) => q.fn === 'hull' && q.piece === 'tri');
    w.ships.damagePartFraction(w.pid, hull, 1);
    w.server.step();
    expect(ship.derived.alive[hull]).toBe(false);
    run(w, w.ships.tuning.repair!.combatPauseTicks + BANK.stationPartSeconds * 60 + 120);
    expect(w.ships.get(w.pid)!.derived.alive[hull]).toBe(true);
    expect(total(p.bank!.deposits)).toBeLessThan(80);
  }, 120_000);

  it('there is no free station repair: an empty bank mends nothing, and the legacy credit and mineral bills are gone', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = {};
    p.credits = 5000;
    const gun = hurt(w);
    const ship = w.ships.get(w.pid)!;
    const hp = ship.hp[gun];
    const credits = p.credits, storage = JSON.stringify(p.storage), debt = p.debt;
    run(w, w.ships.tuning.repair!.combatPauseTicks + 60 * 20);
    expect(ship.hp[gun]).toBe(hp);
    expect(p.credits).toBe(credits);
    expect(JSON.stringify(p.storage)).toBe(storage);
    expect(p.debt).toBe(debt);
  }, 120_000);

  it('the free part\'s spare (the top quarter) pays repairs when there are no deposits, never below it', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    expect(total(w.bank.spare(p))).toBeGreaterThan(0);
    const gun = hurt(w);
    const ship = w.ships.get(w.pid)!;
    run(w, w.ships.tuning.repair!.combatPauseTicks + 60 * 20);
    expect(ship.hp[gun]).toBeCloseTo(ship.maxHp[gun], 3);
    for (const [id, c] of Object.entries(w.bank.cap)) expect(p.bank!.free[id]).toBeGreaterThanOrEqual(0.75 * c - 1e-6);
  }, 120_000);

  it('away from a station nothing is mended', () => {
    const w = world();
    const p = w.profile();
    p.bank!.deposits = { alloy_plate: 20, copper_wire: 20 };
    const gun = hurt(w);
    const ship = w.ships.get(w.pid)!;
    const hp = ship.hp[gun];
    for (let i = 0; i < w.ships.tuning.repair!.combatPauseTicks + 300; i++) { park(w.pid); w.server.step(); }
    expect(ship.hp[gun]).toBeLessThanOrEqual(hp);
    expect(p.bank!.deposits).toEqual({ alloy_plate: 20, copper_wire: 20 });
  }, 120_000);
});

describe('bankDeposit', () => {
  it('is refused away from a station', () => {
    const w = world();
    park(w.pid, 90000, 90000);
    w.server.step();
    w.server.pilots.give(w.conn, { pack_hull: 3 }, { quiet: true });
    w.t.send({ type: 'bankDeposit', items: { pack_hull: 3 } } as any);
    expect(w.profile().bank!.deposits).toEqual({});
    expect(countOf(w.profile().cargo, 'pack_hull')).toBe(3);
    expect(w.got.some((m) => m.type === 'toast' && /at a station/.test((m as any).text))).toBe(true);
  });

  it('at a station takes packs and refined materials from the hold or storage, and refuses ore, parts and the rest', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    expect(depositable(w.server.econ, 'pack_hull')).toBe(true);
    expect(depositable(w.server.econ, 'iron_ore')).toBe(false);
    p.cargo = [{ id: 'pack_hull', n: 2 }, { id: 'iron_ore', n: 5 }];
    p.storage = [{ id: 'alloy_plate', n: 9 }, { id: 'part:alloy:cannon_pip:sq', n: 1 }];
    w.t.send({ type: 'bankDeposit', items: { pack_hull: 2, iron_ore: 5, alloy_plate: 4, 'part:alloy:cannon_pip:sq': 1, nonsense: 3 } } as any);
    expect(p.bank!.deposits).toEqual({ pack_hull: 2, alloy_plate: 4 });
    expect(countOf(p.cargo, 'pack_hull')).toBe(0);
    expect(countOf(p.cargo, 'iron_ore')).toBe(5);
    expect(countOf(p.storage, 'alloy_plate')).toBe(5);
    expect(countOf(p.storage, 'part:alloy:cannon_pip:sq')).toBe(1);
    expect(w.last('repairBank')!.deposits).toEqual({ pack_hull: 2, alloy_plate: 4 });
    // From one place only
    w.t.send({ type: 'bankDeposit', items: { alloy_plate: 100 }, from: 'cargo' } as any);
    expect(p.bank!.deposits.alloy_plate).toBe(4);
    w.t.send({ type: 'bankDeposit', items: { alloy_plate: 100 }, from: 'storage' } as any);
    expect(p.bank!.deposits.alloy_plate).toBe(9);
    // Junk
    w.t.send({ type: 'bankDeposit', items: 'all' } as any);
    w.t.send({ type: 'bankDeposit', items: { alloy_plate: -5, pack_hull: 1.5, copper_wire: NaN } } as any);
    expect(p.bank!.deposits).toEqual({ pack_hull: 2, alloy_plate: 9 });
  });

  it('a deposit is never withdrawn: there is no message for it', () => {
    const w = world();
    dock(w.server, w.pid);
    w.profile().bank!.deposits = { alloy_plate: 3 };
    w.t.send({ type: 'bankWithdraw', bankSlot: 0, count: 3 } as any);
    expect(w.profile().bank!.deposits).toEqual({ alloy_plate: 3 });
    expect(countOf(w.profile().cargo, 'alloy_plate')).toBe(0);
  });
});

describe('devBank', () => {
  it('is refused on a server that is not a dev server', () => {
    const w = world();
    const p = w.profile();
    w.t.send({ type: 'devBank', action: 'grant', items: { pack_hull: 5 } } as any);
    w.t.send({ type: 'devBank', action: 'empty' } as any);
    expect(p.bank!.deposits).toEqual({});
    expect(total(freeWhole(p.bank!))).toBeGreaterThan(0);
    expect(w.got.some((m) => m.type === 'toast' && /dev server/.test((m as any).text))).toBe(true);
  });

  it('on a dev server: fill, empty, clear deposits, grant (only what a bank takes)', () => {
    const w = world({ dev: true });
    const p = w.profile();
    w.t.send({ type: 'devBank', action: 'empty' } as any);
    expect(total(freeWhole(p.bank!))).toBe(0);
    w.t.send({ type: 'devBank', action: 'grant', items: { pack_hull: 5, iron_ore: 9 } } as any);
    expect(p.bank!.deposits).toEqual({ pack_hull: 5 });
    w.t.send({ type: 'devBank', action: 'clearDeposits' } as any);
    expect(p.bank!.deposits).toEqual({});
    w.t.send({ type: 'devBank', action: 'fill' } as any);
    expect(freeWhole(p.bank!)).toEqual(w.bank.cap);
    expect(w.last('repairBank')!.free).toEqual(w.bank.cap);
  });
});

describe('losing the old things', () => {
  it('has no repair kits, no insurance bonds, and the new pilot\'s storage holds Hull Packs instead', () => {
    const w = world();
    const p = w.profile();
    expect(countOf(p.storage, 'pack_hull')).toBe(2);
    expect(p.storage.some((s) => s.id === 'repair_kit' || s.id === 'insurance_bond')).toBe(false);
    expect(w.server.econ.items.has('repair_kit')).toBe(false);
    expect(w.server.econ.items.has('insurance_bond')).toBe(false);
    w.t.send({ type: 'itemUse', id: 'pack_hull' } as any);
    expect(countOf(p.cargo, 'pack_hull') + countOf(p.storage, 'pack_hull')).toBe(2);
  });
});
