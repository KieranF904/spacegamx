import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, Input, InSystem, ServerMessage, ShipReplicaSet, ReplicaMode, replicaAngle, quantizeReplicaAngle,
  rebuildVolley, Player, Projectile, createShipState, stepGuns, volleyShells, firesStraight, weaponDef, isWeaponFn,
} from '@space-game/common';
import { hasComponent } from 'bitecs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

function world() {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  });
  const join = (name: string) => {
    const t = new LocalTransport(server);
    const got: ServerMessage[] = [];
    t.onMessage = (m) => got.push(m);
    t.connect();
    t.send({ type: 'join', username: name } as any);
    return { t, got, pid: () => t.getPlayerId() };
  };
  return { server, a: join('Ash'), b: join('Bree') };
}

describe('ship replication', () => {
  it('a client rebuilds every other ship exactly from keyframes and control changes alone', () => {
    const { server, a, b } = world();
    const ships = server.getShips();
    const sys = server['gameData'].getSystemByNum(InSystem.systemId[b.pid()]);
    // (Its environment as a client's: gravity, the central body, the stillstones and the hazards, as the server steps its shadows)
    const replicas = new ShipReplicaSet(ships.tuning, (id) => ships.get(id)?.derived, () => (server as any).replicaEnv(InSystem.systemId[b.pid()]));
    // Bree watches from a distance; Ash flies about near a pack of hostiles
    Position.x[b.pid()] = 26000; Position.y[b.pid()] = 22000;
    Position.x[a.pid()] = 25000; Position.y[a.pid()] = 20000;
    server.enemies.spawnPack(InSystem.systemId[a.pid()], { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, 27000, 21000);
    let checked = 0, keyframes = 0, controls = 0;
    const mismatches: string[] = [];
    let seen = 0;
    for (let i = 0; i < 60 * 15; i++) {
      const p = a.pid();
      // Ash changes course now and then, and the aim sweeps (on the replicated grid, as a real client's is)
      Input.forward[p] = (i % 200) < 120 ? 1 : 0;
      Input.left[p] = (i % 300) > 150 ? 1 : 0;
      Input.boost[p] = (i % 400) < 60 ? 1 : 0;
      Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(i * 0.01));
      Position.x[b.pid()] = 26000; Position.y[b.pid()] = 22000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0;
      server.step();
      for (; seen < b.got.length; seen++) {
        const m = b.got[seen];
        if (m.type !== 'snapshot') continue;
        keyframes += m.ships?.length ?? 0;
        controls += m.ctl?.length ?? 0;
        replicas.apply(m.tick, m.ships, m.ctl);
        for (const id of replicas.ids()) {
          if (!ships.has(id)) { replicas.remove(id); continue; }
          const s = replicas.at(id, m.tick)!.body;
          checked++;
          if (s.x !== Position.x[id] || s.y !== Position.y[id] || s.vx !== Velocity.x[id] || s.vy !== Velocity.y[id] || s.angle !== Rotation.angle[id]) {
            mismatches.push(`ship ${id} at tick ${m.tick}: (${s.x}, ${s.y}) vs (${Position.x[id]}, ${Position.y[id]})`);
          }
        }
      }
    }
    console.log(`replication test: ${checked} ship states checked, ${keyframes} keyframes, ${controls} control rows`);
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBeGreaterThan(200);
    expect(controls).toBeGreaterThan(keyframes);
  });
});

describe('ship view', () => {
  it('a far ship costs nothing; coming into view it is sent on its own, and leaving it is forgotten', () => {
    const { server, a, b } = world();
    const snaps = () => b.got.filter((m) => m.type === 'snapshot') as any[];
    const keyed = () => snaps().flatMap((m) => (m.ships ?? []).filter((k: number[]) => k[0] === a.pid()));
    // Bree is the one who moves about (her own ship is hers to predict); Ash sits at 90 km
    const at = (x: number) => { Position.x[b.pid()] = x; Position.y[b.pid()] = 20000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0; };
    Position.x[a.pid()] = 90000; Position.y[a.pid()] = 20000;
    for (let i = 0; i < 30; i++) { at(20000); server.step(); }
    // Ash flies about out there: nothing about Ash's ship reaches Bree
    b.got.length = 0;
    for (let i = 0; i < 60; i++) { Input.forward[a.pid()] = i % 20 < 10 ? 1 : 0; at(20000); server.step(); }
    const about = (m: any, id: number) => (m.ships ?? []).some((k: number[]) => k[0] === id) || (m.ctl ?? []).some((c: number[]) => c[0] === id)
      || m.entities.some((e: any) => e.id === id);
    expect(snaps().some((m) => about(m, a.pid()))).toBe(false);
    expect(b.got.some((m) => m.type === 'shipSync' && (m as any).id === a.pid())).toBe(false);
    // Ash comes to rest; Bree flies over: one keyframe for that ship (and its status row) and that's it
    Input.forward[a.pid()] = 0; Velocity.x[a.pid()] = 0; Velocity.y[a.pid()] = 0;
    for (let i = 0; i < 30; i++) { at(20000); server.step(); }
    b.got.length = 0;
    for (let i = 0; i < 30; i++) { at(Position.x[a.pid()] - 30000); server.step(); }
    expect(keyed().length).toBe(1);
    expect(snaps().some((m) => m.entities.some((e: any) => e.id === a.pid()))).toBe(true);
    expect(b.got.some((m) => m.type === 'shipSync' && (m as any).id === a.pid())).toBe(true);
    // Bree leaves: she's told to forget it, once
    b.got.length = 0;
    for (let i = 0; i < 30; i++) { at(20000); server.step(); }
    expect(snaps().filter((m) => (m.out ?? []).includes(a.pid())).length).toBe(1);
    expect(keyed().length).toBe(0);
    // A party member is always in view
    a.t.send({ type: 'partyInvite', name: 'Bree' } as any);
    b.t.send({ type: 'partyRespond', accept: true } as any);
    b.got.length = 0;
    for (let i = 0; i < 6; i++) { at(20000); server.step(); }
    expect(keyed().length).toBe(1);
  });
});

describe('fire events', () => {
  for (const mode of ['plain', 'modded', 'ammo'] as const) it(`a client builds every shell from fire events alone, where the server has it${mode === 'modded' ? ' (guns with mods: an extra burst, tighter, faster)' : mode === 'ammo' ? ' (firing high-velocity shells)' : ''}`, () => {
    const modded = mode === 'modded';
    const { server, a, b } = world();
    const ships = server.getShips();
    if (modded) {
      for (const q of ships.get(a.pid())!.blueprint.parts) if (isWeaponFn(q.fn)) q.mods = { add: { burst: 2, pierce: 1 }, mul: { spread: -0.5, speed: 0.2, damage: -0.1 } };
    }
    if (mode === 'ammo') server.pilots.get(server.pilots.connOf(a.pid())!)!.cargo.push({ id: 'cannon_hv', n: 5 });
    let ammoShots = 0;
    const sys = server['gameData'].getSystemByNum(InSystem.systemId[b.pid()]);
    // (Its environment as a client's: gravity, the central body, the stillstones and the hazards, as the server steps its shadows)
    const replicas = new ShipReplicaSet(ships.tuning, (id) => ships.get(id)?.derived, () => (server as any).replicaEnv(InSystem.systemId[b.pid()]));
    // Bree watches; Ash fights a pack that shoots back (pilotless and pilot shots both)
    Position.x[b.pid()] = 26000; Position.y[b.pid()] = 23000;
    Position.x[a.pid()] = 25000; Position.y[a.pid()] = 20000;
    // (Their shots only: the system's own nests have ships out too, and this is about these two sides)
    const fighting = new Set([a.pid(), ...server.enemies.spawnPack(InSystem.systemId[a.pid()], { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, 26500, 20600)]);
    let built = 0, rows = 0, worst = 0;
    const misses: string[] = [];
    let seen = 0;
    for (let i = 0; i < 60 * 12; i++) {
      const p = a.pid();
      Input.forward[p] = (i % 200) < 100 ? 1 : 0;
      Input.fireLeft[p] = 1;
      Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(20600 - Position.y[p], 26500 - Position.x[p]) + Math.sin(i / 40) * 0.3));
      Position.x[b.pid()] = 26000; Position.y[b.pid()] = 23000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0;
      server.step();
      for (; seen < b.got.length; seen++) {
        const m = b.got[seen];
        if (m.type !== 'snapshot') continue;
        replicas.apply(m.tick, m.ships, m.ctl);
        rows += m.entities.filter((e) => e.type === 7).length;
        for (const [owner, ago, partAmmo, aimQ, ...ids] of m.fire ?? []) {
          if (!fighting.has(owner)) continue;
          const tick = m.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256);
          if (ammo) ammoShots++;
          const st = replicas.at(owner, tick);
          const ship = ships.get(owner);
          if (!st || !ship) { misses.push(`no pose for ${owner}`); continue; }
          const v = rebuildVolley({ owner, tick, part, aimQ, ids, ammo }, ship, st.body, ships.tuning);
          if (!v) { misses.push(`no volley for ${owner} part ${part}`); continue; }
          const moved = hasComponent(server['world'], Player, owner) ? 1 : 0;
          for (const s of v.shells) {
            // (already hit something; or gone and its id since reused for another ship's shot)
            if (!hasComponent(server['world'], Projectile, s.id) || Projectile.ownerId[s.id] !== owner) continue;
            const age = m.tick - tick + moved;
            const err = Math.max(Math.abs(s.x + s.vx * age - Position.x[s.id]), Math.abs(s.y + s.vy * age - Position.y[s.id]),
              Math.abs(s.vx - Velocity.x[s.id]) * 100, Math.abs(s.vy - Velocity.y[s.id]) * 100);
            worst = Math.max(worst, err);
            built++;
          }
        }
      }
    }
    console.log(`fire events (${mode}): ${built} shells built (${ammoShots} with ammunition), ${rows} sent as rows, worst error ${worst.toFixed(4)}`);
    if (mode === 'ammo') expect(ammoShots).toBeGreaterThan(10);
    expect(misses.slice(0, 3)).toEqual([]);
    expect(built).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.5);
  });

  it("a pilot's client fires the same shells on the same ticks as the server, from the same barrels", () => {
    const { server, a } = world();
    const ships = server.getShips();
    const p = a.pid();
    Position.x[p] = 25000; Position.y[p] = 20000;
    // The client's own copy of the ship: guns stepped by guns.ts with the inputs it sent and the pose it predicted
    const mine = createShipState(ships.catalog, ships.tuning, p, ships.get(p)!.blueprint, 0);
    let predicted = 0, matched = 0, worst = 0;
    for (let i = 0; i < 60 * 6; i++) {
      Input.forward[p] = (i % 120) < 60 ? 1 : 0;
      Input.fireLeft[p] = (i % 90) < 70 ? 1 : 0;
      Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.sin(i / 30) * 0.8 - Math.PI / 2));
      server.step();
      const tick = (server as any).currentTick as number;
      const pose = { x: Position.x[p], y: Position.y[p], angle: Rotation.angle[p] };
      const { shots } = stepGuns(mine, pose, { firing: Input.fireLeft[p] === 1, aimWorld: Input.targetAngle[p], aimDist: Input.cursorDist[p] }, tick, ships.tuning);
      // The server's shells fired this tick (they've moved once since)
      const theirs = [...Array(20000).keys()].filter((e) => hasComponent(server['world'], Projectile, e) && Projectile.ownerId[e] === p && Projectile.spawnTick[e] === tick);
      const ours = shots.filter((s) => firesStraight(weaponDef(ships.tuning, s.w.kind)))
        .flatMap(({ w, shot }) => volleyShells(p, mine, w, shot, { ...pose, vx: Velocity.x[p], vy: Velocity.y[p] }, tick, ships.tuning));
      predicted += ours.length;
      expect(ours.length, `tick ${tick}`).toBe(theirs.length);
      for (const s of ours) {
        const e = theirs.find((t) => Math.abs(Projectile.spawnX[t] - s.x) < 0.5 && Math.abs(Projectile.spawnY[t] - s.y) < 0.5 && Math.abs(Velocity.x[t] - s.vx) < 0.01);
        if (!e) continue;
        matched++;
        worst = Math.max(worst, Math.abs(Velocity.x[e] - s.vx), Math.abs(Velocity.y[e] - s.vy));
      }
    }
    expect(predicted).toBeGreaterThan(10);
    expect(matched).toBe(predicted);
    expect(worst).toBeLessThan(1e-3);
  });
});
