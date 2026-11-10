/**
 * Dev-only parts (`exclusive: "dev"`, common/ships/devOnly.ts): they ship in the data, nobody's listing shows them, and
 * only an admin's design may hold one; a non-admin's old ship that has one still flies.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readFileSync } from 'fs';
import * as bitecs from 'bitecs';
import { Position, InSystem, Station as StationComp, parseBlueprint, isDevOnly, usesDevParts, validateBlueprint, type ServerMessage } from '@space-game/common';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { withDevData } from '../data/devData.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
/** A design with dev parts: the starter with its hull and armour in the dev material (its models keep their own) */
const dev = (() => {
  const bp = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
  return { ...bp, name: 'Dev Sparrow', parts: bp.parts.map((p) => (p.fn === 'hull' || p.fn === 'armor' ? { ...p, material: 'dev_singularity' } : p)) };
})();
const config = loadShipConfigCached(dataDir);
const { catalog, tuning } = createShipBridge(config);

function live() {
  resetGlobals();
  const server = makeServer({
    gameData: new GameData(withDevData(readGameDataFiles(dataDir), dataDir)),
    ships: createShipBridge(config),
  });
  const t = new LocalTransport(server);
  const got: ServerMessage[] = [];
  t.onMessage = (m) => got.push(m);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as never);
  const pid = t.getPlayerId();
  // (Beside a station, so the hangar is in reach)
  const world = server.getWorld();
  for (let e = 0; e < 5000; e++) {
    if (e === pid || !bitecs.entityExists(world, e) || !bitecs.hasComponent(world, StationComp, e)) continue;
    Position.x[pid] = Position.x[e] + 300; Position.y[pid] = Position.y[e];
    if ((server as never as { isDocked(p: number): boolean }).isDocked(pid)) break;
  }
  return { server, t, got, pid, conn: server.pilots.connOf(pid)! };
}
const lastEdit = (got: ServerMessage[]) => [...got].reverse().find((m) => m.type === 'shipEditResult') as { ok: boolean; errors: string[] };

describe('dev-only parts', () => {
  it('the data flags the dev material and the Rockery with one word, and a boss part is not a dev part', () => {
    expect(isDevOnly(catalog.materials.get('dev_singularity'))).toBe(true);
    expect(isDevOnly(catalog.materials.get('brood_gland'))).toBe(false);
    expect(catalog.materials.get('brood_gland')?.exclusive).toBe('boss');
    expect(usesDevParts(catalog, dev)).toBe(true);
    const files = withDevData(readGameDataFiles(dataDir), dataDir);
    expect(isDevOnly((files.systems as { systems: { id: string; exclusive?: string }[] }).systems.find((s) => s.id === 'dev_rockery'))).toBe(true);
  });

  it('validation refuses dev parts unless asked to allow them, and boss parts always', () => {
    expect(validateBlueprint(catalog, dev, tuning, null).errors.some((e) => e.code === 'exclusive')).toBe(true);
    expect(validateBlueprint(catalog, dev, tuning, null, { devParts: true }).errors.some((e) => e.code === 'exclusive')).toBe(false);
    const boss = { ...dev, parts: dev.parts.map((p) => ({ ...p, material: 'brood_gland' })) };
    expect(validateBlueprint(catalog, boss, tuning, null, { devParts: true }).errors.some((e) => e.code === 'exclusive')).toBe(true);
  });

  it('the server refuses a non-admin\'s refit with a dev part, and takes an admin\'s', () => {
    const { t, got, conn } = live();
    conn.isAdmin = false;
    t.send({ type: 'shipEdit', blueprint: dev } as never);
    expect(lastEdit(got).ok).toBe(false);
    expect(lastEdit(got).errors.join(' ')).toMatch(/isn't for pilots/);
    t.send({ type: 'slotSave', slot: 1, blueprint: dev } as never);
    expect(lastEdit(got).ok).toBe(false);
    conn.isAdmin = true;
    t.send({ type: 'shipEdit', blueprint: dev } as never);
    expect(lastEdit(got).errors).toEqual([]);
    expect(lastEdit(got).ok).toBe(true);
  });

  it('a saved ship is loaded with its dev parts allowed (it keeps flying), a new design is not', () => {
    const bridge = createShipBridge(config);
    expect(bridge.validate(dev, { mounting: false, devParts: true }).errors.filter((e) => e.code === 'exclusive')).toEqual([]);
    expect(bridge.validate(dev, { mounting: false }).errors.some((e) => e.code === 'exclusive')).toBe(true);
  });

  it('the Rockery ships in the data but a non-admin can not warp there, an admin can', () => {
    const { server, t, pid, conn } = live();
    const rock = server.gameData.getSystemNum('dev_rockery');
    expect(server.gameData.getSystem('dev_rockery')).toBeTruthy();
    conn.isAdmin = false;
    t.send({ type: 'devTeleport', systemId: 'dev_rockery' } as never);
    server.step(3);
    expect(InSystem.systemId[pid]).not.toBe(rock);
    conn.isAdmin = true;
    t.send({ type: 'devTeleport', systemId: 'dev_rockery' } as never);
    server.step(3);
    expect(InSystem.systemId[pid]).toBe(rock);
  });
});
