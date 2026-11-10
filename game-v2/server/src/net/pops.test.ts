/**
 * Hostile populations on the wire (pops: common world/populations.ts, Enemies' populations): a client told which
 * slots' ships are alive works out every ghost where the server would load it, and is told again only on a change.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, ghostShip, type ServerMessage, type ServerPopsMessage, type StarSystemData } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { Populations } from '../../../client/src/state/Populations.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);

function world() {
  (bitecs as unknown as { resetGlobals: () => void }).resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files), userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'ghostwatcher' } as any);
  const pid = t.getPlayerId();
  const hold = (x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const step = (n: number, x = 26000, y = 21000) => { for (let i = 0; i < n; i++) { hold(x, y); server.step(); } };
  const pops = () => got.filter((m): m is ServerPopsMessage => m.type === 'pops');
  return { server, got, pid, step, pops, sol: server.gameData.getSystemNum('sol') };
}

const factions = files.factions as any;
const solData = (files.systems as any).systems.find((s: any) => s.id === 'sol') as StarSystemData;

describe('hostile populations on the wire', () => {
  it('a client told which ships are alive draws every ghost exactly where the server would load it', () => {
    const w = world();
    w.step(60 * 3);
    expect(w.pops()[0]?.full).toBe(1);
    const client = new Populations(factions.spawns, Object.keys(factions.factions));
    for (const m of w.pops()) client.apply(m, 'sol');
    const tick = w.server.getTick();
    const drawn = client.ghosts('sol', solData, tick).map((g) => `${Math.round(g.x)},${Math.round(g.y)}`).sort();
    // The server's: each ghost slot's ships, at its ghost
    const want: string[] = [];
    for (const n of factions.spawns.sol.nests) {
      const pop = w.server.enemies.population(w.sol, n.id);
      pop?.slots.forEach((s, slot) => {
        if (s.loaded || !s.alive) return;
        const c = w.server.enemies.ghostAt(w.sol, n.id, slot, tick)!;
        for (let k = 0; k < 16; k++) if (s.alive & (1 << k)) { const at = ghostShip(c, k); want.push(`${Math.round(at.x)},${Math.round(at.y)}`); }
      });
    }
    expect(want.length).toBeGreaterThan(40);
    expect(drawn).toEqual(want.sort());
  }, 60000);

  it('is sent only when something changes: nothing while all is quiet, one row for a death', () => {
    const w = world();
    w.step(60 * 5);
    const n0 = w.pops().length;
    w.step(60 * 20);
    expect(w.pops().length).toBe(n0);
    // A loaded drone shot down: one message, its spawner's row
    const dock = w.server.enemies.population(w.sol, 'sol_dock_helios_east')!;
    const slot = dock.slots.findIndex((s) => s.loaded && s.ships.length);
    expect(slot).toBeGreaterThanOrEqual(0);
    const eid = dock.slots[slot].ships[0];
    const bridge = w.server.getShips();
    bridge.damagePartFraction(eid, bridge.get(eid)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    // (a few ticks more than its round: frames with nothing urgent wait up to COALESCE_TICKS, every client's are packed)
    w.step(10);
    const after = w.pops().slice(n0);
    expect(after.length).toBe(1);
    expect(after[0].full).toBeUndefined();
    expect(after[0].p.length).toBe(2 + dock.slots.length);
  }, 60000);
});
