import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, Position, Projectile, InSystem, countOf } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

/** A world where the starter ship's guns fire from crates (an existing item stands in for the crate) */
function world() {
  resetGlobals();
  const config = loadShipConfigFromDisk(dataDir);
  for (const [k, d] of Object.entries(config.tuning.weapons!)) if (d.type === 'projectile') config.tuning.weapons![k] = { ...d, ammo: { item: 'scrap_electronics', rounds: 3 } };
  const server = makeServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    ships: createShipBridge(config) });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  return { server, t, pid, conn, profile: () => server.pilots.get(conn)! };
}

/** Fire until `n` new shells are out; their damage */
function fire(w: ReturnType<typeof world>, volleys: number): number[] {
  const seen = new Set<number>(), dmg: number[] = [];
  for (let i = 0; i < 60 * 30 && dmg.length < volleys; i++) {
    Position.x[w.pid] = 60000; Position.y[w.pid] = 60000;
    Input.fireLeft[w.pid] = 1;
    w.server.step();
    for (let e = 0; e < 20000; e++) {
      if (seen.has(e) || !bitecs.entityExists(w.server.getWorld(), e) || !bitecs.hasComponent(w.server.getWorld(), Projectile, e) || Projectile.ownerId[e] !== w.pid) continue;
      seen.add(e);
      if (Projectile.spawnTick[e] === (w.server as any).currentTick) dmg.push(Projectile.damage[e]);
    }
  }
  Input.fireLeft[w.pid] = 0;
  return dmg;
}

describe('ammunition', () => {
  it('a volley spends a round from the open crate, opens the next from the hold, and fires plain rounds once it is all gone', () => {
    const w = world();
    w.profile().cargo = [{ id: 'scrap_electronics', n: 1 }];
    const shots = fire(w, 40);
    expect(countOf(w.profile().cargo, 'scrap_electronics')).toBe(0);
    const full = Math.max(...shots), first = shots.findIndex((d) => d < full * 0.5);
    // Three rounds of full shells, then only plain ones, at 40%
    expect(first).toBeGreaterThan(0);
    expect(shots.slice(first).every((d) => Math.abs(d - full * 0.4) < 1e-3)).toBe(true);
  });

  it('docking tops the hold up from storage to the ship loadout (the standard crate, two of them, until it says otherwise)', () => {
    const w = world();
    const p = w.profile();
    p.cargo = [{ id: 'scrap_electronics', n: 1 }];
    p.storage = [{ id: 'scrap_electronics', n: 10 }];
    w.conn.docked = { station: 0, ox: 0, oy: 0 } as any;
    const ammo = (w.server as any).ammo;
    ammo.restock(w.conn);
    expect(countOf(p.cargo, 'scrap_electronics')).toBe(2);
    p.ship.ammo = { load: { scrap_electronics: 4 } };
    ammo.restock(w.conn);
    expect(countOf(p.cargo, 'scrap_electronics')).toBe(4);
    expect(countOf(p.storage, 'scrap_electronics')).toBe(7);
  });
});

describe('ammunition made for one enemy', () => {
  /** A world as the game has it (crates as data says), a Cult ship and a pirate side by side, and Quench Slugs' mods */
  function sides() {
    resetGlobals();
    const server = makeServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
      ships: createShipBridge(loadShipConfigFromDisk(dataDir)) });
    const t = new LocalTransport(server);
    t.connect();
    t.send({ type: 'join', username: 'pilot' } as any);
    const pid = t.getPlayerId(), sys = InSystem.systemId[pid];
    const [cult] = server.enemies.spawnPack(sys, { faction: 'cinder', ships: ['cinder_zealot'] }, 90000, 89000);
    const [pirate] = server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_raider'] }, 90000, 91000);
    const mods = server.econ.items.get('railgun_quench')!.ammoFor!.mods!;
    return { server, pid, cult, pirate, mods, ships: server.getShips(), weapons: (server as any).weapons };
  }
  /** A shell's damage to a ship's sturdiest part, its shield down, as the shell would deal it */
  const dealt = (w: ReturnType<typeof sides>, eid: number, proj: number) => {
    const ship = w.ships.get(eid)!;
    ship.shield = 0;
    const part = ship.maxHp.indexOf(Math.max(...ship.maxHp));
    return w.ships.hurt(eid, ship, part, 10, w.pid, w.weapons.vsOf(proj));
  };

  it('Quench Slugs are poor slugs (30% less damage) that hit Cinder Cult ships two and a half times as hard', () => {
    const w = sides();
    const quench = w.weapons.spawn(w.pid, 'railgun', 0, 0, 0, 1, { speedScale: 1, sizeScale: 1, turret: false, ammoMods: w.mods });
    const plain = w.weapons.spawn(w.pid, 'railgun', 0, 0, 0, 1, { speedScale: 1, sizeScale: 1, turret: false });
    expect(Projectile.damage[quench]).toBeCloseTo(Projectile.damage[plain] * 0.7, 5);
    expect(w.weapons.vsOf(quench).bane).toEqual({ faction: 'cinder', damage: 2.5 });
    expect(w.weapons.vsOf(plain).bane).toBeUndefined();
    // The same blow: two and a half times on the Cult, as ever on a pirate
    expect(dealt(w, w.cult, quench)).toBeCloseTo(dealt(w, w.cult, plain) * 2.5, 5);
    expect(dealt(w, w.pirate, quench)).toBeCloseTo(dealt(w, w.pirate, plain), 5);
  });

  it("out of crates the gun fires plain rounds with none of it; and the Cult's bosses don't take it", () => {
    const w = sides();
    const dry = w.weapons.spawn(w.pid, 'railgun', 0, 0, 0, 1, { speedScale: 1, sizeScale: 1, turret: false, ammoMods: w.mods, dry: true });
    expect(w.weapons.vsOf(dry).bane).toBeUndefined();
    expect((w.server as any).ships.host.baneFaction(w.cult)).toBe('cinder');
    // (a boss of the Cult's, as Bosses enrols one)
    w.server.enemies.addBoss(w.pirate, 'boss_cinder_warden', 'cinder', InSystem.systemId[w.pid], { x: 90000, y: 91000 }, files.factions.factions.cinder.behaviour);
    expect((w.server as any).ships.host.baneFaction(w.pirate)).toBeUndefined();
  });
});
