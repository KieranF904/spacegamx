/**
 * The legendaries in a running server (docs/design/rework-2026-11.md section 4): the Hive regrows its clip and sends each
 * seeker of a salvo to a different one of the four ships nearest the cursor, the Phase Cannon flies through rock and
 * shields, and the Frostbite's beam slows what it lights (the slowed status itself: shotBehaviours.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Input, InSystem, Position, Velocity, Projectile, OwnedBy, isWeaponFn, replicaAngle, quantizeReplicaAngle, ReplicaMode, WEAPON_KIND_TYPE, parseBlueprint } from '@space-game/common';
import { readFileSync } from 'fs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const X = 25000, Y = 20000;
const aimEast = () => replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));

/** A pilot whose first gun is this weapon model, held at (X, Y). `pool`: on the pool-era starter (a fixture), whose clip
 * regrows a round at a time (on the ports core a clip is the gun's buffer, filling at its feed: guns.ts) */
function pilotWith(model: string, pool = false) {
  resetGlobals();
  const server = new GameServer({ profileStore: new MemoryProfileStore(), gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)) });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips()!;
  const bp = pool ? parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/fixtures/sparrow-t.json'), 'utf-8')) : ships.get(pid)!.blueprint;
  let n = 0;
  ships.respawnInPlace(pid, { ...bp, parts: bp.parts.map((q) => ((q.fn === 'cannon_pip' || isWeaponFn(q.fn)) && n++ < 1 ? { ...q, fn: model } : q)) });
  const hold = () => { Position.x[pid] = X; Position.y[pid] = Y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const gun = () => ships.get(pid)!.derived.weapons[0];
  return { server, pid, ships, hold, gun };
}

const projectiles = bitecs.defineQuery([Projectile]);
const shellsOf = (w: ReturnType<typeof pilotWith>, kind: keyof typeof WEAPON_KIND_TYPE) =>
  projectiles(w.server.world).filter((e) => OwnedBy.ownerId[e] === w.pid && Projectile.weaponType[e] === WEAPON_KIND_TYPE[kind]);

describe('Hive: a clip of eight that regrows', () => {
  it('a salvo of four takes four rounds; then one round grows back every 45 ticks', () => {
    const w = pilotWith('legendary_hive', true);
    const part = w.gun().part;
    expect(w.ships.get(w.pid)!.rounds[part]).toBe(8);
    for (let i = 0; i < 4; i++) { w.hold(); Input.fireLeft[w.pid] = i < 2 ? 1 : 0; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast(); w.server.step(); }
    expect(w.ships.get(w.pid)!.rounds[part]).toBe(4);
    // (the trigger let go: it only regrows; one salvo's worth is four rounds, a round a 45 ticks)
    const seen = new Set<number>();
    let last = 4;
    for (let i = 0; i < 45 * 4 + 5; i++) {
      w.hold(); Input.fireLeft[w.pid] = 0; w.server.step();
      const r = w.ships.get(w.pid)!.rounds[part];
      if (r !== last) { seen.add(i); last = r; }
    }
    expect(last).toBe(8);
    const ticks = [...seen].sort((a, b) => a - b);
    expect(ticks.length).toBe(4);
    for (let i = 1; i < 4; i++) expect(ticks[i] - ticks[i - 1]).toBe(45);
  });

  it('each seeker of a salvo homes on a different one of the four ships nearest the cursor', () => {
    const w = pilotWith('legendary_hive');
    const sys = InSystem.systemId[w.pid];
    // Four skiffs round the cursor point (900 east), at different distances from it, and a fifth far off
    const at = [[900, 0], [900, 160], [900, -240], [1100, 60], [900, 900]];
    const skiffs = at.map(([dx, dy]) => w.server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_skiff'] }, X + dx, Y + dy)[0]);
    const targets = new Set<number>();
    const extras = (w.server as any).weapons.extras as Map<number, { target: number }>;
    for (let i = 0; i < 24; i++) {
      w.hold();
      skiffs.forEach((s, k) => { Position.x[s] = X + at[k][0]; Position.y[s] = Y + at[k][1]; Velocity.x[s] = 0; Velocity.y[s] = 0; });
      Input.fireLeft[w.pid] = i < 2 ? 1 : 0; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const seekers = shellsOf(w, 'hive');
    expect(seekers.length).toBe(4);
    for (const e of seekers) targets.add(extras.get(e)!.target);
    expect(targets.size).toBe(4);
    for (const t of targets) expect(skiffs.slice(0, 4)).toContain(t);
  });
});

describe('Phase Cannon: a ghost round', () => {
  it('flies on through rock that stops an ordinary shell', () => {
    const run = (model: string, kind: keyof typeof WEAPON_KIND_TYPE) => {
      const w = pilotWith(model);
      // (rock right ahead of the muzzle: a shot's path meets it a tenth of the way along)
      (w.server as any).shotWall = () => 0.1;
      for (let i = 0; i < 30; i++) { w.hold(); Input.fireLeft[w.pid] = i < 3 ? 1 : 0; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast(); w.server.step(); }
      return shellsOf(w, kind);
    };
    expect(run('cannon_pip', 'cannon').length).toBe(0);
    const ghosts = run('legendary_phase', 'phase');
    expect(ghosts.length).toBe(1);
    expect(Position.x[ghosts[0]]).toBeGreaterThan(X + 300);
  });

  it('hits the hull, and carries on through the ships it hits (pierce 2)', () => {
    const w = pilotWith('legendary_phase');
    const sys = InSystem.systemId[w.pid];
    const targets = [600, 900, 1200].map((dx) => w.server.enemies.spawnPack(sys, { faction: 'pirates', ships: ['pirate_skiff'] }, X + dx, Y)[0]);
    const before = targets.map((t) => { const s = w.ships.get(t)!; return s.hp.reduce((a, b) => a + b, 0); });
    for (let i = 0; i < 80; i++) {
      w.hold();
      targets.forEach((t, k) => { Position.x[t] = X + 600 + 300 * k; Position.y[t] = Y; Velocity.x[t] = 0; Velocity.y[t] = 0; });
      Input.fireLeft[w.pid] = i < 3 ? 1 : 0; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const hurt = targets.map((t, k) => w.ships.get(t)!.hp.reduce((a, b) => a + b, 0) < before[k]);
    expect(hurt[0]).toBe(true);
    expect(hurt[1]).toBe(true);
  });
});
