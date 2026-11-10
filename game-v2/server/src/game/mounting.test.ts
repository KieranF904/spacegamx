/**
 * Weapon mounting rules on the server (common/src/ships/mounting.ts): a saved ship fitted before a rule still loads
 * and flies as it is (not swapped for the starter); a refit or slot save that breaks a rule is refused.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { ServerMessage, type Blueprint } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = makeEmptyServer({ profileStore: new MemoryProfileStore(), shipEditAnywhere: true });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
  return { server, t, got, pid, conn };
}

/**
 * The starter with a third Pip added beside its right Pip, over the cell its right reactor held: that Pip is held only
 * by its side (breaks 'back'), but is still connected. (The reactor at (2,0) is dropped to open the cell behind it.)
 */
const broken = (bp: Blueprint): Blueprint => {
  const pip = bp.parts.find((p) => p.uid === 3)!;
  const parts = bp.parts.filter((p) => p.uid !== 13).map((p) => ({ ...p }));
  parts.push({ ...JSON.parse(JSON.stringify(pip)), uid: 14, x: pip.x + 1 });
  return { ...JSON.parse(JSON.stringify(bp)), parts };
};

describe('mounting rules on the server', () => {
  it("a saved ship that breaks a rule still loads and flies as it is; the rule is reported, the ship isn't reset", () => {
    const { server, pid, conn } = world();
    const ships = server.getShips();
    const p = server.pilots.get(conn)!;
    const bad = broken(p.ship.blueprint);
    expect(ships.validate(bad).errors.map((e) => e.code)).toEqual(['badMounting']);
    expect(ships.validate(bad, { mounting: false }).ok).toBe(true);
    p.ship.blueprint = bad;
    server.pilots.reapplyShip(conn);
    // Still the broken design (not the starter), both Pips firing
    const live = ships.get(pid)!;
    expect(live.blueprint.parts.map((q) => q.uid).sort((a, b) => a - b)).toEqual(bad.parts.map((q) => q.uid).sort((a, b) => a - b));
    expect(live.derived.weapons.map((w) => w.uid).sort((a, b) => a - b)).toEqual([2, 3, 14]);
  });

  it('a refit that breaks a rule is refused with the reason; one that keeps them goes in', () => {
    const { server, t, got, conn } = world();
    const p = server.pilots.get(conn)!;
    const start = JSON.parse(JSON.stringify(p.ship.blueprint)) as Blueprint;
    t.send({ type: 'shipEdit', blueprint: broken(start) } as any);
    const no = got.filter((m) => m.type === 'shipEditResult').pop() as any;
    expect(no.ok).toBe(false);
    expect(no.errors.join(' ')).toMatch(/bolts on from behind only/);
    t.send({ type: 'slotSave', slot: 1, blueprint: broken(start) } as any);
    expect((got.filter((m) => m.type === 'shipEditResult').pop() as any).ok).toBe(false);
    // The starter as it is: fine
    t.send({ type: 'shipEdit', blueprint: start } as any);
    expect((got.filter((m) => m.type === 'shipEditResult').pop() as any).ok).toBe(true);
  });
});
