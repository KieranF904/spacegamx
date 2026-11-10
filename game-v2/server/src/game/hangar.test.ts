import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, ServerMessage, Station as StationComp, Blueprint, countOf, partItemId, migrateProfile, ghostBill, planOrders,
  addTo, orderRanking, buildableGhosts,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world(clock = { t: 1_000_000 }) {
  resetGlobals();
  const server = makeServer({ clock: () => clock.t });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'builder' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const profile = () => server.pilots.get(conn)!;
  profile().recipes.push('fn:core'); // the first story job teaches these
  profile().plans.push('prospector');
  const ships = server.getShips();
  const last = <T extends ServerMessage['type']>(type: T) => [...got].reverse().find((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  return { server, t, got, pid, conn, profile, ships, clock, last };
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

const prospector = (server: GameServer): Blueprint => JSON.parse(JSON.stringify(server.getShips().library.get('prospector')!));

/** Everything a design takes to build: its modules, and its structure's materials */
const bill = (server: GameServer, bp: Blueprint) => ghostBill(server.econ, bp, bp.parts.map((p) => p.uid));

/** Empty storage of everything but what's listed */
function emptyStorage(server: GameServer, pid: number, keep: Record<string, number> = {}) {
  const p = server.pilots.get(server.pilots.connOf(pid)!)!;
  p.storage = Object.entries(keep).map(([id, n]) => ({ id, n }));
  p.cargo = [];
}

describe('hangar slots', () => {
  it('a new pilot has five slots: the Sparrow they fly and four empty', () => {
    const { profile, last } = world();
    expect(profile().hangar.length).toBe(5);
    expect(profile().hangar[0]).toBe(profile().ship);
    expect(profile().hangar[1]).toBeNull();
    const h = last('hangar')!;
    expect(h.active).toBe(0);
    expect(h.slots[0]!.blueprint.name).toBe('Sparrow T');
  });

  it('old saves come back with their ship in slot 1', () => {
    const { server } = world();
    const old = { version: 1, credits: 5, ship: { blueprint: server.getShips().library.get('arrow'), hp: { 3: 0 } }, roster: [] };
    const p = migrateProfile(old, (server as any).starterKit());
    expect(p.hangar.length).toBe(5);
    expect(p.hangar[0]).toBe(p.ship);
    expect(p.ship.blueprint.name).toBe('Arrow');
    expect(p.ship.ghosts).toEqual([]);
  });

  it("a design can use parts you don't have yet: they're ghosts until made", () => {
    const { server, t, pid, profile, ships, last } = world();
    dock(server, pid);
    emptyStorage(server, pid);
    const bp = prospector(server);
    t.send({ type: 'slotSave', slot: 1, blueprint: bp, plan: 'prospector' } as any);
    expect(last('shipEditResult')!.ok).toBe(true);
    const rec = profile().hangar[1]!;
    expect(rec.plan).toBe('prospector');
    expect(rec.ghosts!.length).toBe(bp.parts.length); // nothing owned, not even a core
    // The ship you fly didn't change
    expect(ships.get(pid)!.blueprint.name).toBe('Sparrow T');
    expect(last('hangar')!.slots[1]!.ghosts.length).toBe(bp.parts.length);
  });

  it('a part joined to nothing saves as a placeholder and is never fitted, however much you hold; joined, it goes in', () => {
    const { server, t, pid, profile, ships, last } = world();
    dock(server, pid);
    const bp = prospector(server);
    const uid = Math.max(...bp.parts.map((p) => p.uid)) + 1;
    const hull = (x: number, y: number) => ({ uid, piece: 'sq', fn: 'hull', material: 'alloy', x, y, rot: 0, flip: false });
    const far = { ...bp, parts: [...bp.parts, hull(60, 60)] } as Blueprint;
    expect(ships.validate(far).ok).toBe(true);
    expect(ships.validate(far).unreachable).toEqual([uid]);
    emptyStorage(server, pid, bill(server, far));
    t.send({ type: 'slotSave', slot: 1, blueprint: far } as any);
    expect(last('shipEditResult')!.ok).toBe(true);
    for (let i = 0; i < 70; i++) server.step();
    // Everything joined was fitted; the far hull waits as a placeholder (and its materials stay in storage)
    expect(profile().hangar[1]!.ghosts).toEqual([uid]);
    expect(profile().hangar[1]!.blueprint.parts.some((p) => p.uid === uid)).toBe(true);
    // (Nothing to put on order: the only ghost left can't be built)
    expect(buildableGhosts(ships.catalog, far, [uid])).toEqual([]);
    expect(orderRanking(profile().hangar, ships.catalog)).toEqual([]);
    // Moved next to the ship (joined): fitted
    let near: Blueprint | null = null;
    for (let x = -12; x <= 12 && !near; x++) for (let y = -12; y <= 12 && !near; y++) {
      const c = { ...bp, parts: [...bp.parts, hull(x, y)] } as Blueprint;
      const v = ships.validate(c);
      if (v.ok && !v.unreachable.length) near = c;
    }
    expect(near).toBeTruthy();
    t.send({ type: 'slotSave', slot: 1, blueprint: near } as any);
    for (let i = 0; i < 70; i++) server.step();
    expect(profile().hangar[1]!.ghosts ?? []).toEqual([]);
  });

  it('wires are gone: a design sent with old saved wires costs no spools, and is kept without them', () => {
    const { server, t, pid, profile, last } = world();
    dock(server, pid);
    const bp = prospector(server);
    emptyStorage(server, pid, bill(server, bp));
    const wires = [[0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 2, 1]];
    t.send({ type: 'slotSave', slot: 1, blueprint: { ...bp, wires }, plan: 'prospector' } as any);
    expect(last('shipEditResult')!.ok).toBe(true);
    expect(countOf(profile().storage, 'wire_spool')).toBe(0);
    expect((profile().hangar[1]!.blueprint as { wires?: unknown }).wires).toBeUndefined();
  });

  it('parts reaching storage fit themselves, from the core outwards, never leaving any loose', () => {
    const { server, t, pid, profile } = world();
    dock(server, pid);
    emptyStorage(server, pid);
    const bp = prospector(server);
    t.send({ type: 'slotSave', slot: 1, blueprint: bp } as any);
    // Every module and all the structure's materials, but not the core: nothing can go in yet
    const parts = bill(server, bp);
    const coreId = partItemId(bp.parts.find((p) => p.fn === 'core')!);
    const noCore = { ...parts, [coreId]: parts[coreId] - 1 };
    server.pilots.give(server.pilots.connOf(pid)!, noCore, { toStorage: true, quiet: true });
    for (let i = 0; i < 70; i++) server.step();
    expect(profile().hangar[1]!.ghosts!.length).toBe(bp.parts.length);
    // The core arrives: everything goes in
    server.pilots.give(server.pilots.connOf(pid)!, { [coreId]: 1 }, { toStorage: true, quiet: true });
    for (let i = 0; i < 70; i++) server.step();
    expect(profile().hangar[1]!.ghosts).toEqual([]);
    for (const id of Object.keys(parts)) expect(countOf(profile().storage, id)).toBe(0);
  });

  it('Build puts a ship on order: refining, fabricating and fitting until it\'s whole; then you fly it', () => {
    const { server, t, pid, profile, ships, clock, conn } = world();
    dock(server, pid);
    emptyStorage(server, pid, { iron_ore: 200, nickel_ore: 100, copper_ore: 40, power_coupling: 1 });
    const bp = prospector(server);
    t.send({ type: 'slotSave', slot: 2, blueprint: bp, plan: 'prospector' } as any);
    t.send({ type: 'slotBuild', slot: 2 } as any);
    // Refining starts at once (the ore goes in); nothing fits until the core is there
    expect(profile().hangar[2]!.auto).toBe(true);
    expect(profile().jobs.some((j) => j.recipe.startsWith('refine:'))).toBe(true);
    expect(countOf(profile().storage, 'iron_ore')).toBeLessThan(200);
    for (let i = 0; i < 70; i++) server.step();
    expect(profile().hangar[2]!.ghosts!.length).toBe(bp.parts.length);
    // Can't fly it without a core
    t.send({ type: 'slotFly', slot: 2 } as any);
    expect(profile().activeSlot).toBe(0);
    // Refining, then fabricating, then fitting: a step at a time as the jobs finish
    for (let k = 0; k < 12 && profile().hangar[2]!.ghosts!.length; k++) {
      clock.t += 10 * 60 * 1000;
      for (let i = 0; i < 130; i++) dock(server, pid);
    }
    expect(profile().jobs.length).toBe(0);
    expect(profile().hangar[2]!.ghosts).toEqual([]);
    expect(profile().hangar[2]!.auto).toBeFalsy();
    t.send({ type: 'slotFly', slot: 2 } as any);
    expect(profile().activeSlot).toBe(2);
    expect(profile().ship).toBe(profile().hangar[2]);
    expect(ships.get(pid)!.blueprint.name).toBe('Prospector');
    expect(ships.get(pid)!.derived.cargoCapacity).toBeGreaterThan(60);
    expect(server.pilots.cargoCapacity(conn)).toBeGreaterThan(60);
    // The Sparrow waits in slot 1
    expect(profile().hangar[0]!.blueprint.name).toBe('Sparrow T');
  });

  it('orders show what they need down to ore, and can be held, resumed, put first or called off', () => {
    const { server, t, pid, profile, clock } = world();
    dock(server, pid);
    emptyStorage(server, pid);
    t.send({ type: 'slotSave', slot: 1, blueprint: prospector(server), plan: 'prospector' } as any);
    t.send({ type: 'slotSave', slot: 2, blueprint: prospector(server), plan: 'prospector' } as any);
    // Nothing in storage: the bill goes all the way down to ore to gather
    const plan = () => planOrders(server.econ, profile());
    const bare = plan().find((o) => o.slot === 1)!;
    expect(bare.gather.iron_ore).toBeGreaterThan(0);
    expect(bare.lines.some((l) => l.stage === 'part' && l.waiting > 0 && l.blocked === 'inputs')).toBe(true);
    expect(bare.lines.some((l) => l.stage === 'material' && l.for.includes('structure'))).toBe(true);
    expect(bare.lines.some((l) => l.stage === 'ore' && l.short > 0)).toBe(true);

    // Both on order: the first takes the ore first
    server.pilots.give(server.pilots.connOf(pid)!, { iron_ore: 200, nickel_ore: 100, copper_ore: 40 }, { toStorage: true, quiet: true });
    t.send({ type: 'slotBuild', slot: 1 } as any);
    t.send({ type: 'slotBuild', slot: 2 } as any);
    expect(plan().map((o) => o.slot)).toEqual([1, 2]);
    const mine = () => profile().jobs.filter((j) => j.slot === 1 && j.for === 'Prospector');
    expect(mine().length).toBeGreaterThan(0);
    // Do slot 2 first
    t.send({ type: 'slotOrder', slot: 2, action: 'top' } as any);
    expect(plan().map((o) => o.slot)).toEqual([2, 1]);

    // Hold slot 1: its jobs stop (keeping their progress) and nothing comes in
    const job = mine()[0];
    clock.t += job.unitMs / 2;
    t.send({ type: 'slotOrder', slot: 1, action: 'pause' } as any);
    expect(profile().hangar[1]!.paused).toBe(true);
    expect(mine().every((j) => j.paused)).toBe(true);
    const doneBefore = job.done;
    clock.t += job.unitMs * 50;
    for (let i = 0; i < 70; i++) server.step();
    expect(profile().jobs.find((j) => j.id === job.id)!.done).toBe(doneBefore);
    // Resume: the run carries on from halfway
    t.send({ type: 'slotOrder', slot: 1, action: 'resume' } as any);
    expect(profile().hangar[1]!.paused).toBe(false);
    clock.t += job.unitMs * 0.6;
    for (let i = 0; i < 70; i++) server.step();
    const after = profile().jobs.find((j) => j.id === job.id);
    expect(after ? after.done : job.count).toBeGreaterThan(doneBefore);

    // Calling off one of its jobs refunds it and holds the order (it would only queue it again)
    const next = mine().find((j) => j.done < j.count);
    if (next) {
      const ore = countOf(profile().storage, 'iron_ore');
      t.send({ type: 'job', id: next.id, action: 'cancel' } as any);
      expect(profile().jobs.some((j) => j.id === next.id)).toBe(false);
      expect(countOf(profile().storage, 'iron_ore')).toBeGreaterThan(ore);
      expect(profile().hangar[1]!.paused).toBe(true);
    }
    // Calling off the order: off order, its jobs gone and refunded
    t.send({ type: 'slotOrder', slot: 1, action: 'cancel' } as any);
    expect(profile().hangar[1]!.auto).toBeFalsy();
    expect(mine().length).toBe(0);
    expect(profile().hangar[2]!.auto).toBe(true);
  });

  it('a held job lets the rest of its queue move up', () => {
    const { server, t, pid, profile, clock } = world();
    dock(server, pid);
    emptyStorage(server, pid, { iron_ore: 40, nickel_ore: 40 });
    const ids = [...server.econ.recipes.refining.values()].filter((r) => Object.keys(r.inputs).every((k) => k === 'iron_ore' || k === 'nickel_ore')).map((r) => r.id).slice(0, 2);
    expect(ids.length).toBe(2);
    t.send({ type: 'refine', recipe: ids[0], batches: 3 } as any);
    t.send({ type: 'refine', recipe: ids[1], batches: 1 } as any);
    const [a, b] = profile().jobs;
    expect(b.startedAt).toBe(a.readyAt);
    t.send({ type: 'job', id: a.id, action: 'pause' } as any);
    expect(b.startedAt).toBe(clock.t);
    // Resumed, back in its place at the front: b waits again
    t.send({ type: 'job', id: a.id, action: 'resume' } as any);
    expect(b.startedAt).toBe(a.readyAt);
    // Move b to the front
    t.send({ type: 'job', id: b.id, action: 'top' } as any);
    expect(profile().jobs[0].id).toBe(b.id);
    expect(a.startedAt).toBe(b.readyAt);
  });

  it('ghosts on the ship you fly are simply absent, and station repairs never build them for free', () => {
    const { server, t, pid, profile, ships } = world();
    dock(server, pid);
    emptyStorage(server, pid);
    const bp = JSON.parse(JSON.stringify(ships.get(pid)!.blueprint)) as Blueprint;
    // Bolt an extra hull square onto the back of the core's neighbour... anywhere it joins
    const core = bp.parts.find((p) => p.fn === 'core')!;
    let added = false;
    for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1], [0, -2], [-2, 0], [2, 0], [0, 2]]) {
      const cand = { uid: 200, piece: 'sq', fn: 'hull', material: 'alloy', x: core.x + dx, y: core.y + dy, rot: 0, flip: false };
      const test = { ...bp, parts: [...bp.parts, cand] };
      if (ships.validate(test as Blueprint).ok) { bp.parts.push(cand as any); added = true; break; }
    }
    if (!added) bp.parts.push({ uid: 200, piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 6, rot: 0, flip: false } as any);
    t.send({ type: 'slotSave', slot: 0, blueprint: bp } as any);
    expect(profile().ship.ghosts).toEqual([200]);
    dock(server, pid); // (the ship is rebuilt at the next tick's rebuild point)
    const ship = ships.get(pid)!;
    const gi = ship.blueprint.parts.findIndex((p) => p.uid === 200);
    expect(ship.derived.alive[gi]).toBe(false);
    profile().level = 1; // free rebuilds: still mustn't build ghosts
    for (let i = 0; i < 60 * 10; i++) dock(server, pid);
    expect(ships.get(pid)!.derived.alive[gi]).toBe(false);
    // Give it the plate it's made of: it goes in
    server.pilots.give(server.pilots.connOf(pid)!, { alloy_plate: 1 }, { toStorage: true, quiet: true });
    for (let i = 0; i < 70; i++) dock(server, pid);
    expect(profile().ship.ghosts).toEqual([]);
    expect(ships.get(pid)!.derived.alive[gi]).toBe(true);
  });

  it('scrapping a slot breaks its built parts down: most of the ore back, every component in full', () => {
    const { server, t, pid, profile } = world();
    dock(server, pid);
    const bp = prospector(server);
    const parts = bill(server, bp);
    emptyStorage(server, pid, parts);
    t.send({ type: 'slotSave', slot: 1, blueprint: bp } as any);
    expect(profile().hangar[1]!.ghosts).toEqual([]);
    for (const id of Object.keys(parts)) expect(countOf(profile().storage, id)).toBe(0);
    t.send({ type: 'slotClear', slot: 1 } as any);
    expect(profile().hangar[1]).toBeNull();
    // Ore, not plate; the core's power coupling comes back
    expect(countOf(profile().storage, 'iron_ore')).toBeGreaterThan(0);
    expect(countOf(profile().storage, 'alloy_plate')).toBe(0);
    expect(countOf(profile().storage, 'power_coupling')).toBeGreaterThan(0);
  });

  it('structure never sits in storage as items: it arrives as its materials', () => {
    const { server, pid, profile } = world();
    emptyStorage(server, pid);
    server.pilots.give(server.pilots.connOf(pid)!, { 'part:steel:armor:rect2': 2, 'part:alloy:engine_ion_drive:sq': 1 }, { toStorage: true, quiet: true });
    expect(countOf(profile().storage, 'part:steel:armor:rect2')).toBe(0);
    expect(countOf(profile().storage, 'steel_plate')).toBe(2 * server.econ.recipes.partInputs({ material: 'steel', fn: 'armor', piece: 'rect2' }).steel_plate);
    expect(countOf(profile().storage, 'part:alloy:engine_ion_drive:sq')).toBe(1);
  });

  it('modules scrap to salvage at a station: ore back, not plate', () => {
    const { server, t, pid, profile } = world();
    dock(server, pid);
    emptyStorage(server, pid, { 'part:alloy:power_cell_reactor:sq': 2 });
    t.send({ type: 'scrapItem', id: 'part:alloy:power_cell_reactor:sq', n: 1 } as any);
    expect(countOf(profile().storage, 'part:alloy:power_cell_reactor:sq')).toBe(1);
    expect(countOf(profile().storage, 'iron_ore')).toBeGreaterThan(0);
    expect(countOf(profile().storage, 'alloy_plate')).toBe(0);
  });

  it('taking parts out of a design loses nothing: modules to storage, structure back to its materials', () => {
    const { server, t, pid, profile } = world();
    dock(server, pid);
    const bp = prospector(server);
    emptyStorage(server, pid, bill(server, bp));
    t.send({ type: 'slotSave', slot: 1, blueprint: bp } as any);
    // (Not the plate the mining laser sits on: the old conduit, hull now, holds it on)
    const hull = bp.parts.filter((p) => p.fn === 'hull' && p.piece === 'sq' && p.y > 0);
    const module = bp.parts.find((p) => p.fn === 'engine_ion_drive')!;
    const cut = { ...bp, parts: bp.parts.filter((p) => p !== module && !hull.includes(p)) };
    t.send({ type: 'slotSave', slot: 1, blueprint: cut } as any);
    expect(countOf(profile().storage, partItemId(module))).toBe(1);
    expect(countOf(profile().storage, 'alloy_plate')).toBeGreaterThanOrEqual(hull.length);
  });

  it('fabricator jobs deliver each part as it finishes, wherever you are', () => {
    const { server, t, pid, profile, clock } = world();
    dock(server, pid);
    // (Torches take a while to make: at their level, as everything opens)
    emptyStorage(server, pid, { alloy_plate: 50, copper_wire: 50, fuel_injector: 3, thrust_nozzle: 3 });
    profile().level = Math.max(profile().level, server.econ.ships.functions.get('engine_torch')!.unlock!.level);
    t.send({ type: 'craft', recipe: 'part:alloy:engine_torch:rect2', n: 3 } as any);
    const job = profile().jobs[0];
    expect(job.count).toBe(3);
    Position.x[pid] = 40000; Position.y[pid] = 40000;
    clock.t += job.unitMs + 10;
    for (let i = 0; i < 70; i++) server.step();
    expect(countOf(profile().storage, 'part:alloy:engine_torch:rect2')).toBe(1);
    clock.t += job.unitMs * 2;
    for (let i = 0; i < 70; i++) server.step();
    expect(countOf(profile().storage, 'part:alloy:engine_torch:rect2')).toBe(3);
    expect(profile().jobs.length).toBe(0);
  });

  it('Sell all ore empties the hold of raw minerals', () => {
    const { server, t, pid, profile, conn } = world();
    dock(server, pid);
    server.pilots.give(conn, { iron_ore: 10, crystal: 2, pack_hull: 1 }, { quiet: true });
    const credits = profile().credits;
    t.send({ type: 'marketSellAll' } as any);
    expect(countOf(profile().cargo, 'iron_ore')).toBe(0);
    expect(countOf(profile().cargo, 'pack_hull')).toBe(1);
    expect(profile().credits).toBeGreaterThan(credits);
  });
});

describe('the quick bar', () => {
  it('has no repair kits any more, and remembers items per slot (one slot per item)', () => {
    const { t, profile, last } = world();
    expect(profile().quickbar).not.toContain('repair_kit');
    expect(profile().quickbar[0]).toBe('boost_cell');
    t.send({ type: 'quickbarSet', slot: 3, id: 'boost_cell' } as any);
    expect(profile().quickbar[3]).toBe('boost_cell');
    expect(profile().quickbar[0]).toBeNull();
    t.send({ type: 'quickbarSet', slot: 3, id: null } as any);
    expect(profile().quickbar[3]).toBeNull();
    expect(last('profile')!.quickbar.length).toBe(5);
  });

});
