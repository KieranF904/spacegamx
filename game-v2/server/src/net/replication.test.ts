import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, Input, InSystem, ServerMessage, ShipReplicaSet, ReplicaMode, replicaAngle, quantizeReplicaAngle,
  rebuildVolley, Player, Projectile, otherShotWireOf, isOtherShotWire, createShipState, stepGuns, volleyShells, firesStraight, weaponDef, isWeaponFn,
  parseBlueprint, stackMods, TELL_CHARGE_START, TELL_CHARGE_CANCEL, type Blueprint, type Charge, type PortsState, type ReplicaEnv, type ServerSnapshotMessage,
} from '@space-game/common';
import { readFileSync } from 'fs';
import { hasComponent } from 'bitecs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from './LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';
import { FakeHitsClient } from './hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);

/** A copy of a charge as it is now (a ports ship's state is changed in place: golden/parity.test.ts snapCharge) */
function snapCharge(c: Charge): Charge {
  const e = c.e as PortsState | undefined;
  if (!e) return { ...c };
  return { ...c, e: { ...e, held: e.held.slice(), flags: e.flags.slice(), amt: e.amt.slice(), mat: e.mat.slice(), closed: e.closed.slice(), aug: e.aug.slice(), sat: e.sat.slice() } };
}

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

/**
 * A watcher with the client's whole tick layer (FakeHitsClient: keyframes, control rows, causes, contact pairs, bodies),
 * as every client is now: what it holds of each ship, against the server's own state of that ship at the snapshot's tick
 */
function watcher(server: GameServer, name: string, after?: (s: ServerSnapshotMessage, w: FakeHitsClient) => void) {
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const w = new FakeHitsClient(server, { name, env });
  // (each tick's state as the step left it: a frame may wait a few ticks, coalesced)
  const truth = new Map<number, Map<number, number[]>>();
  const stats = { checked: 0, keyframes: 0, controls: 0, causes: 0, mismatches: [] as string[] };
  const step = server.step.bind(server);
  server.step = () => {
    step();
    const m = new Map<number, number[]>();
    for (const [eid] of server.getShips().bodies) m.set(eid, [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid]]);
    truth.set(server.getTick(), m);
    truth.delete(server.getTick() - 64);
    w.flushUp();
  };
  const fw = w as unknown as { snapshot(s: ServerSnapshotMessage): void };
  const oSnap = fw.snapshot.bind(w);
  fw.snapshot = (s) => {
    oSnap(s);
    after?.(s, w);
    stats.keyframes += s.ships?.length ?? 0;
    stats.controls += s.ctl?.length ?? 0;
    stats.causes += s.causes?.length ?? 0;
    const tr = truth.get(s.tick);
    if (!tr) return;
    for (const id of w.reps.ids()) {
      if (id === w.pid) continue;
      const st = w.reps.at(id, s.tick)?.body, r = tr.get(id);
      if (!st || !r) continue;
      stats.checked++;
      if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) stats.mismatches.push(`ship ${id} at tick ${s.tick}: (${st.x}, ${st.y}) vs (${r[0]}, ${r[1]})`);
    }
  };
  return { w, stats, pid: () => w.pid };
}

describe('ship replication', () => {
  it('a client rebuilds every other ship exactly from keyframes, control changes and causes, against the server\'s state', () => {
    const { server, a } = world();
    // (Bree: the client's whole tick layer, checked against the server's own state at every snapshot's tick)
    const { stats, pid } = watcher(server, 'Bree_watch');
    const b = { pid };
    // Bree watches from a distance; Ash flies about near a pack of hostiles
    Position.x[b.pid()] = 26000; Position.y[b.pid()] = 22000;
    Position.x[a.pid()] = 25000; Position.y[a.pid()] = 20000;
    server.enemies.spawnPack(InSystem.systemId[a.pid()], { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, 27000, 21000);
    for (let i = 0; i < 60 * 15; i++) {
      const p = a.pid();
      // Ash changes course now and then, and the aim sweeps (on the replicated grid, as a real client's is)
      Input.forward[p] = (i % 200) < 120 ? 1 : 0;
      Input.left[p] = (i % 300) > 150 ? 1 : 0;
      Input.boost[p] = (i % 400) < 60 ? 1 : 0;
      Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(i * 0.01));
      Position.x[b.pid()] = 26000; Position.y[b.pid()] = 22000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0;
      server.step();
    }
    console.log(`replication test: ${stats.checked} ship states checked, ${stats.keyframes} keyframes, ${stats.controls} control rows, ${stats.causes} cause rows`);
    expect(stats.mismatches.slice(0, 5)).toEqual([]);
    expect(stats.checked).toBeGreaterThan(200);
    expect(stats.controls).toBeGreaterThan(stats.keyframes);
  });
});

describe('ship view (the focus grid: net/cells/FocusCells.ts)', () => {
  it('a far ship costs nothing; coming into its focus cells it is sent on its own, and leaving it is told once', () => {
    const { server, a, b } = world();
    const snaps = () => b.got.filter((m) => m.type === 'snapshot') as any[];
    const keyed = () => snaps().flatMap((m) => (m.ships ?? []).filter((k: number[]) => k[0] === a.pid()));
    // Bree is the one who moves about (her own ship is hers to predict); Ash sits at 72 km (inside inner Sol: the packs out past it leave it be)
    const at = (x: number) => { Position.x[b.pid()] = x; Position.y[b.pid()] = 20000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0; };
    Position.x[a.pid()] = 72000; Position.y[a.pid()] = 20000;
    for (let i = 0; i < 30; i++) { at(20000); server.step(); }
    // Ash flies about out there: nothing about Ash's ship reaches Bree
    b.got.length = 0;
    for (let i = 0; i < 60; i++) { Input.forward[a.pid()] = i % 20 < 10 ? 1 : 0; at(20000); server.step(); }
    const about = (m: any, id: number) => (m.ships ?? []).some((k: number[]) => k[0] === id) || (m.ctl ?? []).some((c: number[]) => c[0] === id)
      || m.entities.some((e: any) => e.id === id);
    expect(snaps().some((m) => about(m, a.pid()))).toBe(false);
    expect(b.got.some((m) => m.type === 'shipSync' && (m as any).id === a.pid())).toBe(false);
    // Ash comes to rest; Bree flies over (5 km off: inside its focus cells): one keyframe for that ship (and its status row) and that's it
    Input.forward[a.pid()] = 0; Velocity.x[a.pid()] = 0; Velocity.y[a.pid()] = 0;
    for (let i = 0; i < 30; i++) { at(20000); server.step(); }
    b.got.length = 0;
    for (let i = 0; i < 30; i++) { at(Position.x[a.pid()] - 5000); server.step(); }
    expect(keyed().length).toBe(1);
    expect(snaps().some((m) => m.entities.some((e: any) => e.id === a.pid()))).toBe(true);
    expect(b.got.some((m) => m.type === 'shipSync' && (m as any).id === a.pid())).toBe(true);
    // Bree leaves: it's out of her view, told once (she keeps it away: net/cells/AwayNet.ts), and nothing more of it comes
    b.got.length = 0;
    for (let i = 0; i < 30; i++) { at(20000); server.step(); }
    expect(snaps().filter((m) => (m.out ?? []).includes(a.pid())).length).toBe(1);
    expect(keyed().length).toBe(0);
    // (A party member out of the focus is a ghost now, not held: the 40 km circle's "always in view" went with it)
  });
});

describe('fire events', () => {
  for (const mode of ['plain', 'modded', 'ammo'] as const) it(`a client builds every shell from fire events alone, where the server has it${mode === 'modded' ? ' (guns with mods: an extra burst, tighter, faster)' : mode === 'ammo' ? ' (firing high-velocity shells)' : ''}`, () => {
    const modded = mode === 'modded';
    const { server, a } = world();
    const ships = server.getShips();
    if (modded) {
      for (const q of ships.get(a.pid())!.blueprint.parts) if (isWeaponFn(q.fn)) q.mods = { add: { burst: 2, pierce: 1 }, mul: { spread: -0.5, speed: 0.2, damage: -0.1 } };
    }
    if (mode === 'ammo') server.pilots.get(server.pilots.connOf(a.pid())!)!.cargo.push({ id: 'cannon_hv', n: 5 });
    let ammoShots = 0;
    let built = 0, rows = 0, worst = 0, derived = 0;
    const misses: string[] = [];
    // (Their shots only: the system's own nests have ships out too, and this is about these two sides)
    const fighting = new Set<number>();
    // (A shell the watcher builds from another ship's gun lane is named by its shot id, common sim/otherGuns.ts: the
    // server's shell with that shot, by its fire record as it goes in)
    const byShot = new Map<number, number>();
    const fired = ships.fired, push = fired.push.bind(fired);
    fired.push = (...fs) => { for (const f of fs) f.ids.forEach((eid, k) => byShot.set(otherShotWireOf(f.owner, f.tick, f.part, k), eid)); return push(...fs); };
    // Bree watches with the client's tick layer (its replicas as the server's, causes and all): each fire event's
    // shells rebuilt from the firing ship's replica as the shot left it, against the server's own shells
    const b = watcher(server, 'Bree_watch', (m, w) => {
      rows += m.entities.filter((e) => e.type === 7).length;
      for (const [owner, ago, partAmmo, aimQ, ...ids] of m.fire ?? []) {
        if (!fighting.has(owner)) continue;
        const tick = m.tick - ago, part = partAmmo % 256, ammo = Math.floor(partAmmo / 256);
        if (ammo) ammoShots++;
        const body = w.reps.preAt(owner, tick);
        // (the structure it fired with: a gun shot away later in the window is still on it then, as the client keeps
        // each structure by its rebuild tick, ShipStore.derivedAt)
        const now = ships.get(owner), was = now && w.store.derivedAt(owner, tick);
        const ship = now && was ? Object.assign(Object.create(now), { derived: was }) : now;
        if (!body || !ship) { misses.push(`no pose for ${owner}`); continue; }
        const v = rebuildVolley({ owner, tick, part, aimQ, ids, ammo }, ship, body, ships.tuning);
        if (!v) { misses.push(`no volley for ${owner} part ${part}`); continue; }
        const moved = hasComponent(server['world'], Player, owner) ? 1 : 0;
        for (const s of v.shells) {
          const id = isOtherShotWire(s.id) ? byShot.get(s.id) ?? -1 : s.id;
          if (isOtherShotWire(s.id)) derived++;
          // (already hit something; or gone and its id since reused for another ship's shot)
          if (id < 0 || !hasComponent(server['world'], Projectile, id) || Projectile.ownerId[id] !== owner) continue;
          // (the shell now, the server's step since the snapshot's tick: a frame may wait, coalesced)
          const age = server.getTick() - tick + moved;
          const err = Math.max(Math.abs(s.x + s.vx * age - Position.x[id]), Math.abs(s.y + s.vy * age - Position.y[id]),
            Math.abs(s.vx - Velocity.x[id]) * 100, Math.abs(s.vy - Velocity.y[id]) * 100);
          worst = Math.max(worst, err);
          built++;
        }
      }
    });
    // Ash fights a pack that shoots back (pilotless and pilot shots both)
    Position.x[b.pid()] = 26000; Position.y[b.pid()] = 23000;
    Position.x[a.pid()] = 25000; Position.y[a.pid()] = 20000;
    for (const id of [a.pid(), ...server.enemies.spawnPack(InSystem.systemId[a.pid()], { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, 26500, 20600)]) fighting.add(id);
    for (let i = 0; i < 60 * 12; i++) {
      const p = a.pid();
      Input.forward[p] = (i % 200) < 100 ? 1 : 0;
      Input.fireLeft[p] = 1;
      Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(20600 - Position.y[p], 26500 - Position.x[p]) + Math.sin(i / 40) * 0.3));
      Position.x[b.pid()] = 26000; Position.y[b.pid()] = 23000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0;
      server.step();
    }
    console.log(`fire events (${mode}): ${built} shells built (${derived} from gun lanes, ${ammoShots} with ammunition), ${rows} sent as rows, worst error ${worst.toFixed(4)}`);
    // (most from the other ships' gun lanes now: their fire records go only where the server's state alone decided)
    expect(derived).toBeGreaterThan(20);
    if (mode === 'ammo') expect(ammoShots).toBeGreaterThan(10);
    expect(misses.slice(0, 3)).toEqual([]);
    expect(built).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.5);
  });

  /** A Sparrow armed with these two models where its Pips were */
  const armed = (left: string, right: string): Blueprint => {
    const b = parseBlueprint(readFileSync(join(dataDir, 'ships/blueprints/sparrow-t.json'), 'utf-8'));
    const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
    pips[0].fn = left;
    pips[1].fn = right;
    return b;
  };

  for (const guns of [null, ['railgun_rail_driver', 'cannon_longbarrel'], ['autocannon_stinger', 'autocannon_chainsaw'], ['flak_cloudmaker', 'emp_blackout']] as const) it(`a pilot's client fires the same shells on the same ticks as the server, from the same barrels${guns ? ` (firing models: ${guns.join(', ')})` : ''}`, () => {
    const { server, a } = world();
    const ships = server.getShips();
    const p = a.pid();
    if (guns) ships.respawnInPlace(p, armed(guns[0], guns[1]));
    // (The watcher steps Ash's guns itself (common sim/otherGuns.ts): a charge's tells are its lane's records, the
    // fire rows it builds at each snapshot, or the server's where it told them)
    const tells: number[][] = [];
    const b = watcher(server, 'Bree_watch', (m) => { for (const f of m.fire ?? []) tells.push(f); });
    // (Charge tells reach the watcher as shell-less fire events. Fixed guns fire along the nose: the aim sweeps a little)
    Position.x[b.pid()] = 26000; Position.y[b.pid()] = 21000;
    let starts = 0, cancels = 0;
    Position.x[p] = 25000; Position.y[p] = 20000;
    // The client's own copy of the ship: guns stepped by guns.ts with the inputs it sent and the pose it predicted
    const mine = createShipState(ships.catalog, ships.tuning, p, ships.get(p)!.blueprint, 0);
    // (A ports ship's guns fire from their buffers, which its client keeps in its charge, stepped in the flight step as the
    // server's is: golden/parity.test.ts checks that chain tick by tick. Here the client's guns are given the charge the
    // server's guns had this tick, so they are judged on their own state with the same buffers, as the client's are)
    let theirCharge: Charge | undefined;
    const fire0 = (ships as any).fireWeapons as (eid: number, ...rest: any[]) => void;
    (ships as any).fireWeapons = function (this: unknown, eid: number, ...rest: any[]) {
      const energy = rest[5] as { charge: Charge } | undefined;
      if (eid === p && energy) theirCharge = snapCharge(energy.charge);
      return fire0.call(this, eid, ...rest);
    };
    let predicted = 0, matched = 0, worst = 0;
    for (let i = 0; i < 60 * 6; i++) {
      Input.forward[p] = (i % 120) < 60 ? 1 : 0;
      Input.fireLeft[p] = (i % 90) < 70 && (guns?.[0] !== 'railgun_rail_driver' || i % 4 < 2) ? 1 : 0;
      Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.sin(i / 30) * (guns ? 0.03 : 0.8) - Math.PI / 2));
      Position.x[b.pid()] = 26000; Position.y[b.pid()] = 21000; Velocity.x[b.pid()] = 0; Velocity.y[b.pid()] = 0;
      server.step();
      const tick = (server as any).currentTick as number;
      const pose = { x: Position.x[p], y: Position.y[p], angle: Rotation.angle[p] };
      const energy = theirCharge && { charge: theirCharge };
      theirCharge = undefined;
      const { shots } = stepGuns(mine, pose, { firing: Input.fireLeft[p] === 1, aimWorld: Input.targetAngle[p], aimDist: Input.cursorDist[p], energy }, tick, ships.tuning);
      for (const [owner, , partAmmo, , ...ids] of tells.splice(0)) {
        if (owner !== p) continue;
        const code = Math.floor(partAmmo / 256);
        if (code === TELL_CHARGE_START) { starts++; expect(ids).toEqual([]); }
        if (code === TELL_CHARGE_CANCEL) { cancels++; expect(ids).toEqual([]); }
      }
      // The server's shells fired this tick (they've moved once since)
      const theirs = [...Array(20000).keys()].filter((e) => hasComponent(server['world'], Projectile, e) && Projectile.ownerId[e] === p && Projectile.spawnTick[e] === tick);
      const ours = shots.filter((s) => firesStraight(weaponDef(ships.tuning, s.w.kind)))
        // (A ports shot made augmented by its material carries its augment's mods, as the client's predictGuns gives them)
        .flatMap(({ w, shot, aug }) => volleyShells(p, mine, w, shot, { ...pose, vx: Velocity.x[p], vy: Velocity.y[p] }, tick, ships.tuning, stackMods(undefined, aug)));
      predicted += ours.length;
      expect(ours.length, `tick ${tick}`).toBe(theirs.length);
      for (const s of ours) {
        const e = theirs.find((t) => Math.abs(Projectile.spawnX[t] - s.x) < 0.5 && Math.abs(Projectile.spawnY[t] - s.y) < 0.5 && Math.abs(Velocity.x[t] - s.vx) < 0.01);
        if (!e) continue;
        matched++;
        worst = Math.max(worst, Math.abs(Velocity.x[e] - s.vx), Math.abs(Velocity.y[e] - s.vy));
      }
    }
    // (Slow guns: a 4-shell clip with a long reload and a charged orb fire less in the six seconds)
    // (On the ports Sparrow each gun has one Cell Reactor behind it: the Cloudmaker fires one clip of four in the six seconds, and the
    // Blackout's 90-tick charge never fills in a 70-tick hold, so only its tells go)
    expect(predicted).toBeGreaterThan(guns ? 3 : 10);
    expect(matched).toBe(predicted);
    expect(worst).toBeLessThan(1e-3);
    // (A charge gun's every charge is told, and the ones let go too: fire is let go 20 ticks in every 90)
    if (guns?.some((g) => g === 'cannon_longbarrel' || g === 'emp_blackout')) { expect(starts).toBeGreaterThan(2); expect(cancels).toBeGreaterThan(0); }
  });
});
