import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, InSystem, ServerMessage, Station as StationComp, countOf, migrateProfile, crateOrder, type StarterKit } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

/** A pilot in the starter Sparrow (a cannon: free shells, and HV slugs are its only crate) */
function liveServer() {
  resetGlobals();
  const userDB: any = { validateSession: async () => null, cleanupExpiredSessions: async () => {} };
  const server = new GameServer({
    gameData: new GameData(files), userDB, scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  return { server, t, got, pid, conn, profile: () => server.pilots.get(conn)! };
}

/** Beside Sol Central, in its system */
function parkAtSol(server: GameServer, pid: number): void {
  const gd = (server as any).gameData as GameData;
  const world = server.getWorld();
  const num = gd.getStationNum('sol_station_central');
  const st = [...Array(5000).keys()].find((e) => bitecs.entityExists(world, e) && bitecs.hasComponent(world, StationComp, e) && StationComp.stationId[e] === num)!;
  InSystem.systemId[pid] = InSystem.systemId[st];
  Position.x[pid] = Position.x[st] + 300;
  Position.y[pid] = Position.y[st];
}

const toasts = (got: ServerMessage[]) => got.filter((m) => m.type === 'toast').map((m) => (m as any).text as string);

describe('ammunition loadouts', () => {
  it('a slot loadout is validated: only crates its guns take, whole counts, capped', () => {
    const { t, profile } = liveServer();
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: 3.7, railgun_sabot: 5, iron_ore: 9 }, first: { cannon: 'cannon_hv', railgun: 'railgun_sabot' } } as any);
    expect(profile().ship.ammo).toEqual({ load: { cannon_hv: 3 }, first: { cannon: 'cannon_hv' } });
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: 500 } } as any);
    expect(profile().ship.ammo!.load.cannon_hv).toBe(20);
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: -4 } } as any);
    expect(profile().ship.ammo!.load.cannon_hv).toBe(0);
  });

  it('docking tops the hold up to the loadout from storage, and never deposits it', () => {
    const { server, t, got, pid, profile } = liveServer();
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: 3 } } as any);
    const p = profile();
    p.cargo = [{ id: 'cannon_hv', n: 1 }, { id: 'iron_ore', n: 5 }];
    p.storage = [{ id: 'cannon_hv', n: 10 }];
    parkAtSol(server, pid);
    t.send({ type: 'dock' } as any);
    expect((got.filter((m) => m.type === 'dockResult').pop() as any).ok).toBe(true);
    expect(countOf(p.cargo, 'cannon_hv')).toBe(3);
    expect(countOf(p.storage, 'cannon_hv')).toBe(8);
    expect(toasts(got).some((x) => /Loadout restocked from storage: 2 × /.test(x))).toBe(true);
    // The safe store keeps it aboard
    t.send({ type: 'itemStore', what: 'safe' } as any);
    expect(countOf(p.cargo, 'cannon_hv')).toBe(3);
    expect(countOf(p.cargo, 'iron_ore')).toBe(0);
    // Docking again changes nothing
    t.send({ type: 'undock' } as any);
    t.send({ type: 'dock' } as any);
    expect(countOf(p.cargo, 'cannon_hv')).toBe(3);
    expect(countOf(p.storage, 'cannon_hv')).toBe(8);
  });

  it('launching tops up to the loadout from storage and says what is short', () => {
    const { server, t, got, pid, profile } = liveServer();
    const p = profile();
    parkAtSol(server, pid);
    t.send({ type: 'dock' } as any);
    p.cargo = [];
    p.storage = [{ id: 'cannon_hv', n: 2 }];
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: 4 } } as any);
    // Changing the loadout while docked loads what there is at once
    expect(countOf(p.cargo, 'cannon_hv')).toBe(2);
    expect(toasts(got).pop()).toMatch(/Short of your loadout: 2 × .*fabricator/);
    p.storage = [{ id: 'cannon_hv', n: 5 }];
    got.length = 0;
    t.send({ type: 'undock' } as any);
    expect(countOf(p.cargo, 'cannon_hv')).toBe(4);
    expect(countOf(p.storage, 'cannon_hv')).toBe(3);
    expect(toasts(got).some((x) => /Short/.test(x))).toBe(false);
  });

  it('the loadout survives refitting the ship and is reported to the client', () => {
    const { t, got, profile } = liveServer();
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: 2 } } as any);
    // (A full profile once, then only what changed: the loadout rides in a delta's `o`)
    const prof = got.filter((m) => m.type === 'profile' || m.type === 'profileDelta').reduce((acc: any, m: any) => (m.type === 'profile' ? m : { ...acc, ...m.o }), {}) as any;
    expect(prof.loadout).toEqual({ cannon_hv: 2 });
    const hangar = got.filter((m) => m.type === 'hangar').pop() as any;
    expect(hangar.slots[0].loadout).toEqual({ cannon_hv: 2 });
    t.send({ type: 'slotSave', slot: 0, blueprint: JSON.parse(JSON.stringify(profile().ship.blueprint)) } as any);
    expect(profile().ship.ammo?.load.cannon_hv).toBe(2);
  });

  it('opens the loadout crates first, then its first pick among them', () => {
    const crates = ['railgun_slugs', 'railgun_sabot', 'railgun_tungsten'];
    expect(crateOrder(crates, { railgun_tungsten: 2 })).toEqual(['railgun_tungsten', 'railgun_slugs', 'railgun_sabot']);
    expect(crateOrder(crates, {})).toEqual(crates);
  });
});

describe('quick storage controls', () => {
  const HOLD = ['iron_ore', 'ruby', 'helium3', 'alloy_plate', 'scrap_electronics', 'ancient_relic', 'gem_frost_1', 'frost_heart',
    'boost_cell', 'railgun_slugs', 'cannon_hv', 'fractured_plating'];
  const sweep = (what: string) => {
    const { server, t, pid, profile } = liveServer();
    t.send({ type: 'slotLoadout', slot: 0, load: { cannon_hv: 2 } } as any);
    const p = profile();
    parkAtSol(server, pid);
    p.cargo = HOLD.map((id) => ({ id, n: 2 }));
    p.storage = [];
    t.send({ type: 'itemStore', what } as any);
    return { stored: p.storage.map((s) => s.id).sort(), kept: p.cargo.map((s) => s.id).sort() };
  };

  it('ores: ore, gems, volatiles and refined materials only', () => {
    expect(sweep('ores').stored).toEqual(['alloy_plate', 'helium3', 'iron_ore', 'ruby']);
  });

  it('loot: components, artefacts, cut gems', () => {
    expect(sweep('loot').stored).toEqual(['ancient_relic', 'frost_heart', 'gem_frost_1', 'scrap_electronics']);
  });

  it('safe: everything but ammunition, the loadout, utility and job items', () => {
    expect(sweep('safe').kept).toEqual(['boost_cell', 'cannon_hv', 'fractured_plating', 'railgun_slugs']);
  });

  it('all: the whole hold', () => {
    expect(sweep('all').kept).toEqual([]);
  });

  it('a quick bar item counts as utility; nothing moves for an unknown control, or away from a station', () => {
    const { server, t, pid, profile } = liveServer();
    const p = profile();
    p.quickbar = ['scrap_electronics', null, null, null, null];
    p.cargo = [{ id: 'scrap_electronics', n: 3 }, { id: 'iron_ore', n: 3 }];
    Position.x[pid] = 60000; Position.y[pid] = 60000;
    t.send({ type: 'itemStore', what: 'all' } as any);
    expect(p.cargo.length).toBe(2);
    parkAtSol(server, pid);
    t.send({ type: 'itemStore', what: 'everything!' } as any);
    expect(p.cargo.length).toBe(2);
    t.send({ type: 'itemStore', what: 'safe' } as any);
    expect(p.cargo).toEqual([{ id: 'scrap_electronics', n: 3 }]);
  });
});

describe('loadouts in the save', () => {
  it('a ship\'s loadout and the open crates come back as saved', () => {
    const { server } = liveServer();
    const kit = (server as any).starterKit() as StarterKit;
    const ship = { blueprint: kit.blueprint, hp: {}, ghosts: [], ammo: { load: { cannon_hv: 3 }, first: { cannon: 'cannon_hv' } } };
    const raw = { version: 6, xp: 0, ship, hangar: [ship, null], activeSlot: 0, ammo: { open: { cannon_hv: 40 }, load: {} } };
    const p = migrateProfile(JSON.parse(JSON.stringify(raw)), kit);
    expect(p.ship.ammo).toEqual({ load: { cannon_hv: 3 }, first: { cannon: 'cannon_hv' } });
    expect(p.hangar[0]).toBe(p.ship);
    expect(p.ammo).toEqual({ open: { cannon_hv: 40 } });
    // Saved and loaded again: unchanged (a zero is kept: it means none)
    p.ship.ammo!.load.cannon_hv = 0;
    const again = migrateProfile(JSON.parse(JSON.stringify(p)), kit);
    expect(again.ship.ammo).toEqual({ load: { cannon_hv: 0 }, first: { cannon: 'cannon_hv' } });
    expect(again.ammo).toEqual({ open: { cannon_hv: 40 } });
  });

  it('a save without ammunition gets none, and other slots keep the default', () => {
    const { server } = liveServer();
    const kit = (server as any).starterKit() as StarterKit;
    const ship = { blueprint: kit.blueprint, hp: {} };
    const p = migrateProfile({ version: 6, ship, hangar: [ship, { blueprint: kit.blueprint, hp: {} }] }, kit);
    expect(p.ship.ammo).toBeUndefined();
    expect(p.hangar[1]?.ammo).toBeUndefined();
  });
});
