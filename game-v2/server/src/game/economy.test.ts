import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, Asteroid, Input, ServerMessage, Station as StationComp, countOf, sellPrice, buyPrice, asteroidComposition,
  saleTotal, marketShift, vendorPrice, MARKET_RECOVERY_MS, MARKET_CYCLE_MS,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world(clock = { t: 1_000_000 }) {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'miner' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const profile = () => server.pilots.get(conn)!;
  return { server, t, got, pid, conn, profile, clock, w: server.getWorld() };
}

/** Asteroids in the player's system, with their composition */
function rocks(server: GameServer, pid: number) {
  const w = server.getWorld();
  const mining = (server as any).mining;
  return [...Array(6000).keys()].filter((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, Asteroid, e)
    && (server as any).asteroidIndexById.has(e) && bitecs.getEntityComponents(w, e).length > 0 && mining.get(e))
    .map((e) => ({ eid: e, comp: mining.get(e) }));
}

/** Park the player beside a station and return it */
function atStation(server: GameServer, pid: number, id = 'sol_station_central'): number {
  const w = server.getWorld();
  const num = server['gameData'].getStationNum(id);
  const st = [...Array(6000).keys()].find((e) => bitecs.entityExists(w, e) && bitecs.hasComponent(w, StationComp, e) && StationComp.stationId[e] === num)!;
  Position.x[pid] = Position.x[st] + 300;
  Position.y[pid] = Position.y[st];
  server.step();
  return st;
}

describe('asteroid composition', () => {
  it('is deterministic and boosted by danger: deadlier belts hide rarer ore and more seams', () => {
    const table = files.mining;
    const a = asteroidComposition(table, 'asteroid_mega', 'sol:4:0', 60, 1);
    expect(asteroidComposition(table, 'asteroid_mega', 'sol:4:0', 60, 1)).toEqual(a);
    let safeCobalt = 0, deadlyCobalt = 0, safeSeams = 0, deadlySeams = 0;
    for (let i = 0; i < 400; i++) {
      const s = asteroidComposition(table, 'asteroid_mega', `x:${i}`, 60, 1);
      const d = asteroidComposition(table, 'asteroid_mega', `x:${i}`, 60, 7);
      safeCobalt += s.ores.cobalt_ore ?? 0;
      deadlyCobalt += d.ores.cobalt_ore ?? 0;
      if (s.seam) safeSeams++;
      if (d.seam) deadlySeams++;
    }
    expect(deadlyCobalt).toBeGreaterThan(safeCobalt * 2.5);
    expect(deadlySeams).toBeGreaterThan(safeSeams * 2);
  });
});

describe('mining', () => {
  it('any gun mines soft rock: ore breaks off as chunks the ship pulls into its hold', () => {
    const { server, pid, profile } = world();
    const soft = rocks(server, pid).find((r) => r.comp.hardness === 1 && r.comp.units >= 12)!;
    expect(soft).toBeDefined();
    const mining = (server as any).mining;
    mining.table = { ...files.mining, damagePerUnit: 12 }; // (the pace is mining.test.ts's business: this checks the chain from rock to hold)
    // Pretend a cannon has been chipping at it for a while, from right beside the ship (11 units: chunks break off 5 to 10 at a time)
    for (let i = 0; i < 160; i++) {
      mining.extract(soft.eid, pid, 14, files.mining.tools.fixed, Position.x[pid] + 60, Position.y[pid], -1, 0);
    }
    for (let i = 0; i < 240; i++) server.step();
    const mined = profile().cargo.reduce((t, s) => t + s.n, 0);
    expect(mined).toBeGreaterThan(0);
    for (const s of profile().cargo) expect(['mineral', 'gem', 'volatile']).toContain(server.econ.items.get(s.id)!.category);
  });

  it('firing the guns at a soft rock really mines it', () => {
    const { server, t, pid } = world();
    const rock = rocks(server, pid).find((r) => r.comp.hardness === 1)!;
    const mining = (server as any).mining;
    mining.table = { ...files.mining, damagePerUnit: 12 }; // (the pace is mining.test.ts's business)
    const units = mining.remaining(rock.eid);
    for (let i = 0; i < 240; i++) {
      // Hold station just below the rock, nose up, guns firing
      (server as any).placeAsteroid(rock.eid); // (asteroids are only placed when something needs them)
      Position.x[pid] = Position.x[rock.eid]; Position.y[pid] = Position.y[rock.eid] + Asteroid.size[rock.eid] + 260;
      Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
      t.send({ type: 'input', seq: i + 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: true, fireRight: false, targetAngle: -Math.PI / 2, helm: true } as any);
      server.step();
    }
    expect(mining.remaining(rock.eid)).toBeLessThan(units);
  });

  it('guns can\'t crack hard rock; a mining laser can, and extracts far more per hit', () => {
    const { server, pid, got } = world();
    const hard = rocks(server, pid).find((r) => r.comp.hardness === 2)!;
    const mining = (server as any).mining;
    const before = mining.remaining(hard.eid);
    mining.extract(hard.eid, pid, 500, files.mining.tools.fixed, 0, 0, 1, 0);
    expect(mining.remaining(hard.eid)).toBe(before);
    expect(got.some((m) => m.type === 'toast' && /too hard/i.test((m as any).text))).toBe(true);
    mining.extract(hard.eid, pid, 60, { yield: files.mining.tools.miner.yield, hardness: 2, grade: 1 }, 0, 0, 1, 0);
    expect(before - mining.remaining(hard.eid)).toBeGreaterThanOrEqual(Math.floor(60 * files.mining.tools.miner.yield / files.mining.damagePerUnit));
  });

  it('a ship with a mining laser mines with the right mouse button', () => {
    const { server, t, pid, profile } = world();
    // Mining laser on the nose: swap the left Pip (on the core's nose, so the core feeds it) for a miner
    const bp = JSON.parse(JSON.stringify(server.getShips().get(pid)!.blueprint));
    const cap = bp.parts.find((p: any) => p.fn === 'cannon_pip');
    Object.assign(cap, { piece: 'sq', fn: 'utility_mining_laser', material: 'alloy', facing: 'N' });
    server.pilots.give(server.pilots.connOf(pid)!, { 'part:alloy:utility_mining_laser:sq': 1 }, { toStorage: true, quiet: true });
    (server as any).shipEditAnywhere = true;
    t.send({ type: 'shipEdit', blueprint: bp });
    expect(server.getShips().get(pid)!.derived.miners.length).toBe(1);
    // Point at a soft rock just ahead and hold the right button
    const rock = rocks(server, pid).find((r) => r.comp.hardness === 1 && r.comp.units >= 8)!;
    const freeze = () => {
      (server as any).placeAsteroid(rock.eid); // (asteroids are only placed when something needs them)
      Position.x[pid] = Position.x[rock.eid]; Position.y[pid] = Position.y[rock.eid] + Asteroid.size[rock.eid] + 120;
      Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = -Math.PI / 2;
    };
    (server as any).mining.table = { ...files.mining, damagePerUnit: 12 }; // (the pace is mining.test.ts's business)
    const units = (server as any).mining.remaining(rock.eid);
    for (let i = 0; i < 120; i++) {
      freeze();
      t.send({ type: 'input', seq: i + 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: true, targetAngle: -Math.PI / 2, helm: true } as any);
      server.step();
    }
    expect(server.getShips().beamState(pid).on).toBe(true);
    expect((server as any).mining.remaining(rock.eid)).toBeLessThan(units);
    for (let i = 0; i < 120; i++) { freeze(); Input.fireRight[pid] = 0; server.step(); }
    expect(profile().cargo.length).toBeGreaterThan(0);
  });

  it('a broken asteroid grows back, and everyone in the system is told', () => {
    const { server, got } = world();
    (server as any).mining.table = { ...files.mining, respawnSeconds: 3 }; // (5 minutes in play)
    const r = rocks(server, 0)[0];
    Asteroid.hp[r.eid] = 0;
    server.step();
    for (let i = 0; i < 3 * 60 + 5; i++) server.step();
    const spawn = got.find((m) => m.type === 'asteroidSpawn') as any;
    expect(spawn).toBeDefined();
    expect(spawn.asteroids[0].index).toBe((server as any).asteroidIndexById.get(spawn.asteroids[0].id));
  });
});

describe('station services', () => {
  it('the refinery turns ore into plate, into storage, over time', () => {
    const { server, t, pid, profile, clock } = world();
    atStation(server, pid);
    const iron = countOf(profile().storage, 'iron_ore'), plate = countOf(profile().storage, 'alloy_plate');
    t.send({ type: 'refine', recipe: 'alloy_plate', batches: 5 });
    // The ore goes in now; the plate comes out batch by batch
    expect(countOf(profile().storage, 'iron_ore')).toBe(iron - 10);
    expect(countOf(profile().storage, 'alloy_plate')).toBe(plate);
    const job = profile().jobs.find((j) => j.recipe === 'refine:alloy_plate')!;
    expect(job.count).toBe(5);
    clock.t = job.startedAt + job.unitMs * 2 + 1;
    for (let i = 0; i < 61; i++) server.step();
    expect(countOf(profile().storage, 'alloy_plate')).toBe(plate + 2);
    clock.t = job.readyAt + 1;
    for (let i = 0; i < 61; i++) server.step();
    expect(countOf(profile().storage, 'alloy_plate')).toBe(plate + 5);
    // Too many batches: nothing happens
    t.send({ type: 'refine', recipe: 'alloy_plate', batches: 500 });
    expect(profile().jobs.length).toBe(0);
  });

  it('small modules fabricate at once, big ones queue; structure isn\'t fabricated at all', () => {
    const { server, t, pid, profile, clock } = world();
    atStation(server, pid);
    server.pilots.give(server.pilots.connOf(pid)!, { alloy_plate: 30, copper_wire: 20, fuel_injector: 1, thrust_nozzle: 1 }, { toStorage: true, quiet: true });
    t.send({ type: 'craft', recipe: 'part:alloy:engine_ion_drive:sq', n: 2 });
    expect(countOf(profile().storage, 'part:alloy:engine_ion_drive:sq')).toBe(2);
    // (A Torch: a level-8 model, and a big one)
    profile().level = 8;
    t.send({ type: 'craft', recipe: 'part:alloy:engine_torch:rect2', n: 1 });
    expect(profile().jobs.length).toBe(1);
    expect(countOf(profile().storage, 'part:alloy:engine_torch:rect2')).toBe(0);
    clock.t += profile().jobs[0].readyAt - clock.t + 1;
    for (let i = 0; i < 61; i++) server.step();
    expect(profile().jobs.length).toBe(0);
    expect(countOf(profile().storage, 'part:alloy:engine_torch:rect2')).toBe(1);
    // Hull is paid in plate when it's placed: the fabricator doesn't make it
    t.send({ type: 'craft', recipe: 'part:alloy:hull:sq', n: 1 });
    expect(countOf(profile().storage, 'part:alloy:hull:sq')).toBe(0);
    // Short of refined materials: refine them first (nothing taken)
    const plate = countOf(profile().storage, 'alloy_plate');
    t.send({ type: 'craft', recipe: 'part:alloy:engine_ion_drive:sq', n: 99 });
    expect(countOf(profile().storage, 'alloy_plate')).toBe(plate);
  });

  it("everything opens at its level and not before; a job's kit needs its job too", () => {
    const { server, t, pid, profile, got } = world();
    atStation(server, pid);
    server.pilots.give(server.pilots.connOf(pid)!, { steel_plate: 10, alloy_plate: 20, crystal_lens: 5, copper_wire: 10, power_coupling: 2, coolant: 2, nickel_ore: 4 }, { toStorage: true, quiet: true });
    // A steel core needs steel's level (5), whatever licence you hold; a Scanner its level (5); frag flak its (6)
    profile().recipes.push('fn:core', 'material:steel', 'fn:scanner', 'flak_frag');
    t.send({ type: 'craft', recipe: 'part:steel:core:sq', n: 1 });
    t.send({ type: 'craft', recipe: 'part:alloy:utility_scanner:sq', n: 1 });
    t.send({ type: 'craft', recipe: 'flak_frag', n: 1 });
    expect(countOf(profile().storage, 'part:steel:core:sq')).toBe(0);
    expect(countOf(profile().storage, 'part:alloy:utility_scanner:sq')).toBe(0);
    expect(profile().jobs.length).toBe(0);
    expect(got.filter((m) => m.type === 'toast' && /know how/i.test((m as any).text)).length).toBe(3);
    // At 5: the steel core and the Scanner; frag flak at 6, nobody teaching it
    profile().level = 5;
    profile().recipes = ['fn:core'];
    t.send({ type: 'craft', recipe: 'part:steel:core:sq', n: 1 });
    t.send({ type: 'craft', recipe: 'part:alloy:utility_scanner:sq', n: 1 });
    expect(profile().jobs.length + countOf(profile().storage, 'part:steel:core:sq')).toBe(1);
    expect(countOf(profile().storage, 'part:alloy:utility_scanner:sq')).toBe(1);
    const jobs = profile().jobs.length;
    t.send({ type: 'craft', recipe: 'flak_frag', n: 1 });
    expect(profile().jobs.length).toBe(jobs);
    profile().level = 6;
    t.send({ type: 'craft', recipe: 'flak_frag', n: 1 });
    expect(profile().jobs.length).toBe(jobs + 1);
    // A job's kit: its level, and its job teaching it (Cleared for Departure's buoy parts)
    profile().level = 50;
    t.send({ type: 'craft', recipe: 'buoy_frame', n: 1 });
    expect(countOf(profile().storage, 'buoy_frame')).toBe(0);
    profile().recipes.push('buoy_frame');
    t.send({ type: 'craft', recipe: 'buoy_frame', n: 1 });
    expect(countOf(profile().storage, 'buoy_frame')).toBe(1);
  });

  it("Quench Slugs need both Forgemaster Hale's job and your own station's armoury (its Quench line)", () => {
    const { server, t, pid, profile, got } = world();
    atStation(server, pid);
    server.pilots.give(server.pilots.connOf(pid)!, { steel_plate: 10, copper_wire: 5, cryogen: 5 }, { toStorage: true, quiet: true });
    profile().level = 30;
    const made = () => countOf(profile().storage, 'railgun_quench') + profile().jobs.filter((j) => j.recipe === 'railgun_quench').length;
    // Level alone: nothing (its job teaches it)
    t.send({ type: 'craft', recipe: 'railgun_quench', n: 1 });
    expect(made()).toBe(0);
    // Taught, but no station of your own: still nothing, and it says where they're pressed
    profile().recipes.push('railgun_quench');
    t.send({ type: 'craft', recipe: 'railgun_quench', n: 1 });
    expect(made()).toBe(0);
    expect(got.some((m) => m.type === 'toast' && /armoury/i.test((m as any).text) && /Quench line/.test((m as any).text))).toBe(true);
    // A station whose armoury stops short of the Quench line, then one built to it
    profile().outpost = { site: 'sol_outer', tracks: { armoury: 2 } };
    t.send({ type: 'craft', recipe: 'railgun_quench', n: 1 });
    expect(made()).toBe(0);
    profile().outpost.tracks.armoury = 3;
    t.send({ type: 'craft', recipe: 'railgun_quench', n: 1 });
    expect(made()).toBe(1);
    // (the armoury presses only what you've learned: the line without the job is nothing)
    profile().recipes = profile().recipes.filter((r) => r !== 'railgun_quench');
    t.send({ type: 'craft', recipe: 'railgun_quench', n: 1 });
    expect(made()).toBe(1);
  });

  it('the market buys at its demand price and sells only what it stocks', () => {
    const { server, t, pid, profile } = world();
    atStation(server, pid, 'sol_station_trade');
    server.pilots.give(server.pilots.connOf(pid)!, { ruby: 2 });
    const credits = profile().credits;
    const station = files.stations.stations.find((s: any) => s.id === 'sol_station_trade')!;
    const demand = server.market.demand(station as any, 'ruby');
    t.send({ type: 'marketSell', id: 'ruby', n: 2 });
    expect(profile().credits).toBe(credits + saleTotal(server.econ.items, 'ruby', 2, demand, 0));
    expect(sellPrice(server.econ.items, 'ruby', (station as any).market.demand)).toBeGreaterThan(sellPrice(server.econ.items, 'ruby'));
    const c2 = profile().credits;
    t.send({ type: 'marketBuy', id: 'pack_hull', n: 1 });
    expect(profile().credits).toBe(c2 - buyPrice(server.econ.items, 'pack_hull'));
    t.send({ type: 'marketBuy', id: 'quantum_core', n: 1 });
    expect(countOf(profile().storage, 'quantum_core')).toBe(0);
  });

  it('services need a station offering them', () => {
    const { server, t, pid, profile } = world();
    Position.x[pid] = 90000; Position.y[pid] = 90000;
    const iron = countOf(profile().storage, 'iron_ore');
    t.send({ type: 'refine', recipe: 'alloy_plate', batches: 1 });
    expect(countOf(profile().storage, 'iron_ore')).toBe(iron);
    atStation(server, pid, 'sol_station_trade'); // a market, but no refinery
    t.send({ type: 'refine', recipe: 'alloy_plate', batches: 1 });
    expect(countOf(profile().storage, 'iron_ore')).toBe(iron);
  });
});

describe('moving markets', () => {
  it('selling a lot of one thing drives its price down here, and the market recovers', () => {
    const { server, t, pid, profile, clock } = world();
    atStation(server, pid, 'sol_station_central');
    const st = server['gameData'].getStation('sol_station_central')!;
    const fresh = server.market.price(st, 'titanium_ore');
    server.pilots.give(server.pilots.connOf(pid)!, { titanium_ore: 600 });
    const before = profile().credits;
    t.send({ type: 'marketSell', id: 'titanium_ore', n: 600 });
    const got = profile().credits - before;
    expect(got).toBeLessThan(600 * fresh);
    expect(server.market.price(st, 'titanium_ore')).toBeLessThan(fresh);
    // Another station's price is untouched
    const other = server['gameData'].getStation('sol_station_mining')!;
    expect(server.market.saturation(other.id, 'titanium_ore')).toBe(0);
    // Two hours on (same cycle), most of it has recovered
    clock.t += 2 * 60 * 60 * 1000;
    expect(server.market.saturation(st.id, 'titanium_ore')).toBeLessThan(600 * Math.pow(0.5, (2 * 60 * 60 * 1000) / MARKET_RECOVERY_MS) + 1);
  });

  it('each cycle, a station wants a few things (paying more) and is glutted with others', () => {
    const { server } = world();
    const items = server.econ.items;
    const a = marketShift('sol_station_trade', 1_000_000, items);
    const b = marketShift('sol_station_trade', 1_000_000 + MARKET_CYCLE_MS, items);
    expect(Object.keys(a.wanted)).toHaveLength(3);
    expect(Object.keys(a.glut)).toHaveLength(2);
    for (const k of Object.values(a.wanted)) expect(k).toBeGreaterThan(1.3);
    for (const k of Object.values(a.glut)) expect(k).toBeLessThan(0.8);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(JSON.stringify(marketShift('sol_station_trade', 1_000_000, items))).toBe(JSON.stringify(a));
  });

  it('a quartermaster sells by rank, cheaper the better they know you', () => {
    const { server, t, pid, profile, got } = world() as any;
    atStation(server, pid, 'sol_station_sentinel');
    profile().credits = 100_000;
    t.send({ type: 'vendorOpen' });
    const v = [...got].reverse().find((m: any) => m.type === 'vendors').vendors.find((x: any) => x.faction === 'sol_patrol');
    // (No schematics on sale any more: nothing opens early)
    expect(v.stock.some((s: any) => s.item.startsWith('schematic_'))).toBe(false);
    expect(v.stock.find((s: any) => s.item === 'pack_optics').locked).toBe(true);
    t.send({ type: 'vendorBuy', faction: 'sol_patrol', item: 'pack_optics', n: 1 });
    expect(countOf(profile().storage, 'pack_optics')).toBe(0);
    profile().reputation.sol_patrol = 40; // Trusted
    const c = profile().credits;
    t.send({ type: 'vendorBuy', faction: 'sol_patrol', item: 'pack_optics', n: 1 });
    expect(countOf(profile().storage, 'pack_optics')).toBe(1);
    expect(c - profile().credits).toBe(vendorPrice(server.econ.items, 'pack_optics', 3));
    expect(vendorPrice(server.econ.items, 'pack_optics', 3)).toBeLessThan(buyPrice(server.econ.items, 'pack_optics'));
  });
});
