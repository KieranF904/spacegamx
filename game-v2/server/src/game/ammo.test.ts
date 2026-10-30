import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, Position, Projectile, countOf } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

/** A world where the starter ship's guns fire from crates (an existing item stands in for the crate) */
function world() {
  resetGlobals();
  const config = loadShipConfigFromDisk(dataDir);
  for (const [k, d] of Object.entries(config.tuning.weapons!)) if (d.type === 'projectile') config.tuning.weapons![k] = { ...d, ammo: { item: 'scrap_electronics', rounds: 3 } };
  const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(config) });
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
