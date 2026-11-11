/**
 * The repair bank on the server (game/RepairBank.ts, Pilots, bridge/rebuild.ts repairStep, net/handlers/bank.ts):
 * docs/design/death-rework-2026-11.md (it mends a ship that survived, near a station, only what was built).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, ServerMessage, Station as StationComp, BANK, countOf, bankCap, freeWhole, refillBank, newBank, bankRepairBill, freePays,
  depositable, type PlayerProfile,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world(opts: { dev?: boolean } = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t, ...(opts.dev ? { shipEditAnywhere: true } : {}) });
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
  it('the bank pays nothing at a respawn: the free part and the deposits are as they were', () => {
    const w = world();
    const p = w.profile();
    p.bank!.deposits = { alloy_plate: 40, copper_wire: 40 };
    const free = JSON.stringify(p.bank!.free);
    w.server.pilots.onDestroyed(w.conn, 0, 90000, 90000, 0, 0);
    w.server.pilots.onRespawn(w.conn);
    expect(JSON.stringify(w.profile().bank!.free)).toBe(free);
    expect(w.profile().bank!.deposits).toEqual({ alloy_plate: 40, copper_wire: 40 });
  });
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

  it('the core is mended near a station like any part, free: an empty bank and no deposits still heal it', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = {};
    const ship = w.ships.get(w.pid)!;
    const core = ship.blueprint.parts.findIndex((q) => q.fn === 'core');
    w.ships.damagePartFraction(w.pid, core, 0.5);
    run(w, 2);
    const hp0 = ship.hp[core];
    expect(hp0).toBeLessThan(ship.maxHp[core] * 0.6);
    run(w, w.ships.tuning.repair!.combatPauseTicks + 60 * 12);
    expect(ship.hp[core]).toBeCloseTo(ship.maxHp[core], 3);
    expect(total(p.bank!.deposits)).toBe(0);
    expect(total(freeWhole(p.bank!))).toBe(0);
  }, 120_000);

  it('a whole damaged starter ship is mended near a station, every part of its design, core included', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.free = {};
    p.bank!.deposits = { alloy_plate: 400, copper_wire: 400 };
    const ship = w.ships.get(w.pid)!;
    ship.blueprint.parts.forEach((_, i) => w.ships.damagePartFraction(w.pid, i, 0.4));
    run(w, 2);
    expect(ship.hp.some((h, i) => h < ship.maxHp[i] - 1e-6)).toBe(true);
    run(w, w.ships.tuning.repair!.combatPauseTicks + 60 * 40);
    const live = w.ships.get(w.pid)!;
    expect(live.blueprint.parts.length).toBeGreaterThan(1);
    live.blueprint.parts.forEach((q, i) => {
      expect(live.derived.alive[i], q.fn).toBe(true);
      expect(live.hp[i], q.fn).toBeCloseTo(live.maxHp[i], 3);
    });
  }, 180_000);

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

  it('rebuilds a destroyed part every couple of seconds, nearest the core first, paid with half its recipe inputs', () => {
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
    const bill = bankRepairBill(w.server.econ, ship.blueprint.parts[hull], 1);
    expect(total(bill)).toBe(Math.round(total(w.server.econ.recipes.partInputs(ship.blueprint.parts[hull])) * BANK.repairShare));
    expect(total(p.bank!.deposits)).toBe(80 - total(bill));
  }, 120_000);

  it('never makes a part that was never built (planned in the build view): that needs fabricating', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    p.bank!.deposits = { alloy_plate: 40, copper_wire: 40 };
    const ship = w.ships.get(w.pid)!;
    const hull = ship.blueprint.parts.findIndex((q) => q.fn === 'hull' && q.piece === 'tri');
    w.ships.damagePartFraction(w.pid, hull, 1);
    w.server.step();
    p.ship.unbuilt = [ship.blueprint.parts[hull].uid];
    run(w, w.ships.tuning.repair!.combatPauseTicks + BANK.stationPartSeconds * 60 * 3);
    expect(w.ships.get(w.pid)!.derived.alive[hull]).toBe(false);
    expect(total(p.bank!.deposits)).toBe(80);
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

  it('the free part pays repairs of level 0 parts when there are no deposits; anything else needs deposits', () => {
    const w = world();
    dock(w.server, w.pid);
    const p = w.profile();
    const free0 = total(freeWhole(p.bank!));
    const gun = hurt(w);
    const ship = w.ships.get(w.pid)!;
    run(w, w.ships.tuning.repair!.combatPauseTicks + 60 * 20);
    expect(ship.hp[gun]).toBeCloseTo(ship.maxHp[gun], 3);
    expect(total(freeWhole(p.bank!))).toBeLessThan(free0);
    // (A steel hull opens at level 5: the free part won't pay for it, the deposits may)
    const steel = { ...ship.blueprint.parts.find((q) => q.fn === 'hull')!, material: 'steel' };
    expect(freePays(ship.blueprint.parts[gun])).toBe(true);
    expect(freePays(steel)).toBe(false);
    p.bank!.deposits = {};
    expect(w.bank.payRepair(p, steel, 0.5)).toBe(false);
    p.bank!.deposits = { steel_plate: 10 };
    expect(w.bank.payRepair(p, steel, 0.5)).toBe(true);
    expect(p.bank!.deposits.steel_plate).toBeLessThan(10);
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
