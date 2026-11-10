/**
 * The shared shot behaviours (common/src/ships/features/weaponry) in a running server, one per weapon role:
 * endAtAim (Burst, Cloudmaker, Prism, Blackout), walk (Quake), guided (Hammerhead), mark (Searchlight), slow (Frostbite),
 * and the projectile row's end tick (data[9]) as a pilot's client receives it.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Input, InSystem, Position, Velocity, Projectile, OwnedBy, isWeaponFn, ServerMessage, replicaAngle, quantizeReplicaAngle, ReplicaMode,
  CTL, MARK_TAKEN, STATUS_MARKED, STATUS_SLOWED, EntityType, WEAPON_KIND_TYPE, pilotExtras, unpackHits,
} from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeServer } from '../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const X = 25000, Y = 20000;
const aimEast = () => replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(0));

/** A pilot whose every gun is this weapon model, held at (X, Y), and what its client is sent */
function pilotWith(model: string, cargo?: { id: string; n: number }, guns = 2) {
  resetGlobals();
  const server = makeServer({ profileStore: new MemoryProfileStore() });
  const t = new LocalTransport(server);
  const got: { tick: number; m: ServerMessage }[] = [];
  t.onMessage = (m) => got.push({ tick: server.getTick(), m });
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId(), conn = server.pilots.connOf(pid)!;
  const p = server.pilots.get(conn)!;
  // (The starter's guns are Pips, swapped in place as the parity harness does: its mounting rules aren't the point here)
  const ships = server.getShips()!;
  const bp = ships.get(pid)!.blueprint;
  let n = 0;
  ships.respawnInPlace(pid, { ...bp, parts: bp.parts.map((q) => ((q.fn === 'cannon_pip' || isWeaponFn(q.fn)) && n++ < guns ? { ...q, fn: model } : q)) });
  if (cargo) p.cargo.push(cargo);
  const hold = () => { Position.x[pid] = X; Position.y[pid] = Y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  const detonations = (kind: string) => got.filter((g) => g.m.type === 'detonation' && (g.m as any).kind === kind).map((g) => ({ tick: g.tick, ...(g.m as any) }));
  return { server, t, got, pid, ships, hold, detonations };
}

/** Projectile rows the pilot's client was sent (unpacked: data[9] is the end tick) */
function projectileRows(got: { m: ServerMessage }[]): any[] {
  const out: any[] = [];
  for (const g of got) {
    const ms = g.m.type === 'batch' ? (g.m as any).m : [g.m];
    for (const m of ms) if (m.type === 'snapshot') for (const e of m.entities ?? []) if (e.type === EntityType.Projectile) out.push(e);
  }
  return out;
}

describe('weaponry endAtAim: bursts at the aim distance', () => {
  it('Cloudmaker: its shells burst where the cursor is, and the client is told the tick they end (data[9])', () => {
    const w = pilotWith('flak_cloudmaker');
    for (let i = 0; i < 60 * 3 && !w.detonations('flak').length; i++) {
      w.hold();
      Input.fireLeft[w.pid] = i < 5 ? 1 : 0; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const boom = w.detonations('flak')[0];
    expect(boom).toBeTruthy();
    const d = Math.hypot(boom.x - X, boom.y - Y);
    expect(d).toBeGreaterThan(750);
    expect(d).toBeLessThan(1050);
    // Each row its client got: an end tick after it was fired, and the straight line run to it lands on a burst (each
    // gun's shell has its own spread, so its own end tick: which burst is whose is by place, not by the order sent)
    const booms = w.detonations('flak');
    const rows = projectileRows(w.got).filter((e) => e.data[0] === WEAPON_KIND_TYPE.flak && e.data[6] === w.pid);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const [spawnTick, sx, sy, end] = [r.data[3], r.data[4], r.data[5], r.data[9]];
      expect(end).toBeGreaterThan(spawnTick);
      const ex = sx + r.vx * (end - spawnTick), ey = sy + r.vy * (end - spawnTick);
      expect(Math.min(...booms.map((b) => Math.hypot(ex - b.x, ey - b.y)))).toBeLessThan(40);
    }
  });

  it('Burst bursts at the aim distance too, and its row tells the client the tick it ends (data[9])', () => {
    const w = pilotWith('flak_burst', { id: 'flak_canisters', n: 4 });
    for (let i = 0; i < 60 * 2 && !w.detonations('flak').length; i++) {
      w.hold();
      Input.fireLeft[w.pid] = i < 5 ? 1 : 0; Input.cursorDist[w.pid] = 600; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const boom = w.detonations('flak')[0];
    expect(boom).toBeTruthy();
    const d = Math.hypot(boom.x - X, boom.y - Y);
    expect(d).toBeGreaterThan(500);
    expect(d).toBeLessThan(750);
    // (keeps its own, smaller, burst: the detonation says the damage radius the fragments are drawn out to)
    expect(boom.radius).toBe(170);
    const booms = w.detonations('flak');
    const rows = projectileRows(w.got).filter((e) => e.data[0] === WEAPON_KIND_TYPE.flak && e.data[6] === w.pid);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const [spawnTick, sx, sy, end] = [r.data[3], r.data[4], r.data[5], r.data[9]];
      expect(end).toBeGreaterThan(spawnTick);
      const ex = sx + r.vx * (end - spawnTick), ey = sy + r.vy * (end - spawnTick);
      expect(Math.min(...booms.map((b) => Math.hypot(ex - b.x, ey - b.y)))).toBeLessThan(40);
    }
  });

  it('Burst and Cloudmaker still burst sooner when a shell passes near a target (the fuse), and no later than the aim', () => {
    for (const model of ['flak_burst', 'flak_cloudmaker']) {
      const w = pilotWith(model, { id: 'flak_canisters', n: 4 });
      const [skiff] = w.server.enemies.spawnPack(InSystem.systemId[w.pid], { faction: 'pirates', ships: ['pirate_skiff'] }, X + 700, Y);
      const place = () => { w.hold(); Position.x[skiff] = X + 700; Position.y[skiff] = Y; Velocity.x[skiff] = 0; Velocity.y[skiff] = 0; };
      for (let i = 0; i < 60 * 2 && !w.detonations('flak').length; i++) {
        place();
        // (the cursor well past the skiff: only the fuse can burst it there)
        Input.fireLeft[w.pid] = i < 5 ? 1 : 0; Input.cursorDist[w.pid] = 1500; Input.targetAngle[w.pid] = aimEast();
        w.server.step();
      }
      const boom = w.detonations('flak')[0];
      expect(boom, model).toBeTruthy();
      const d = Math.hypot(boom.x - X, boom.y - Y);
      expect(d, model).toBeLessThan(700);
      expect(d, model).toBeGreaterThan(300);
    }
  });

  it('Prism: the bolt splits into its fan of shards at the aim distance', () => {
    const w = pilotWith('legendary_prism');
    let shards = 0;
    const q = bitecs.defineQuery([Projectile]);
    for (let i = 0; i < 60 * 2 && !w.detonations('prism').length; i++) {
      w.hold();
      Input.fireLeft[w.pid] = i < 5 ? 1 : 0; Input.cursorDist[w.pid] = 800; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    for (const e of q(w.server.world)) if (Projectile.weaponType[e] === WEAPON_KIND_TYPE.prism_shard && OwnedBy.ownerId[e] === w.pid) shards++;
    const boom = w.detonations('prism')[0];
    expect(boom).toBeTruthy();
    const d = Math.hypot(boom.x - X, boom.y - Y);
    expect(d).toBeGreaterThan(650);
    expect(d).toBeLessThan(950);
    expect(shards).toBeGreaterThanOrEqual(5);
  });

  it('Blackout: the charged orb bursts at the aim distance', () => {
    const w = pilotWith('emp_blackout');
    for (let i = 0; i < 60 * 5 && !w.detonations('emp').length; i++) {
      w.hold();
      Input.fireLeft[w.pid] = 1; Input.cursorDist[w.pid] = 1200; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const boom = w.detonations('emp')[0];
    expect(boom).toBeTruthy();
    const d = Math.hypot(boom.x - X, boom.y - Y);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1350);
  });
});

describe('weaponry walk: a salvo landing along the aim', () => {
  it('Quake: three shells, launched a quarter second apart, land at 70%, 100% and 130% of the aim distance', () => {
    // (One Quake, so its salvo's shells are the only ones)
    const w = pilotWith('mortar_quake', { id: 'mortar_shells', n: 1 }, 1);
    for (let i = 0; i < 60 * 5 && w.detonations('mortar').length < 3; i++) {
      w.hold();
      Input.fireLeft[w.pid] = i < 3 ? 1 : 0; Input.cursorDist[w.pid] = 1000; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const booms = w.detonations('mortar');
    expect(booms.length).toBe(3);
    const ds = booms.map((b) => Math.hypot(b.x - X, b.y - Y));
    for (const [k, want] of [[0, 700], [1, 1000], [2, 1300]]) {
      expect(ds[k]).toBeGreaterThan(want - 120);
      expect(ds[k]).toBeLessThan(want + 120);
    }
    // (in turn: each later than the one before)
    expect(booms[1].tick).toBeGreaterThan(booms[0].tick);
    expect(booms[2].tick).toBeGreaterThan(booms[1].tick);
    // Every shell's row told its client where it ends
    const rows = projectileRows(w.got).filter((e) => e.data[0] === WEAPON_KIND_TYPE.mortar && e.data[6] === w.pid);
    const spawns = [...new Set(rows.map((r) => r.data[3]))].sort((a, b) => a - b);
    expect(spawns.length).toBe(3);
    expect(spawns[1] - spawns[0]).toBe(15);
    expect(spawns[2] - spawns[1]).toBe(15);
    for (const r of rows) expect(r.data[9]).toBeGreaterThan(r.data[3]);
  });
});

describe('weaponry guided: steered to the cursor while the trigger is held', () => {
  it('Hammerhead: held, it turns toward the cursor; let go, it flies straight', () => {
    const w = pilotWith('missile_hammerhead', { id: 'missile_crate', n: 1 });
    const q = bitecs.defineQuery([Projectile]);
    let missile = -1;
    for (let i = 0; i < 30 && missile < 0; i++) {
      w.hold();
      Input.fireLeft[w.pid] = 1; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(-Math.PI / 2));
      w.server.step();
      for (const e of q(w.server.world)) if (OwnedBy.ownerId[e] === w.pid && Projectile.weaponType[e] === WEAPON_KIND_TYPE.missile) missile = e;
    }
    expect(missile).toBeGreaterThanOrEqual(0);
    const heading = () => Math.atan2(Velocity.y[missile], Velocity.x[missile]);
    const before = heading();
    // Held, the cursor swung due east of the ship: the missile turns that way, tick by tick
    for (let i = 0; i < 20; i++) {
      w.hold();
      Input.fireLeft[w.pid] = 1; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
    }
    const turned = heading();
    expect(turned).toBeGreaterThan(before + 0.3);
    // Let go: it flies straight on
    Input.fireLeft[w.pid] = 0;
    w.hold(); w.server.step();
    const released = heading();
    for (let i = 0; i < 15; i++) { w.hold(); Input.targetAngle[w.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.PI)); w.server.step(); }
    expect(heading()).toBeCloseTo(released, 6);
  });
});

/** A pilot with this beam and a pirate skiff held 500 east of it, the beam on it for `ticks` */
function beamOnSkiff(model: string, ticks: number) {
  const w = pilotWith(model);
  const [skiff] = w.server.enemies.spawnPack(InSystem.systemId[w.pid], { faction: 'pirates', ships: ['pirate_skiff'] }, X + 500, Y);
  const place = () => { w.hold(); Position.x[skiff] = X + 500; Position.y[skiff] = Y; Velocity.x[skiff] = 0; Velocity.y[skiff] = 0; };
  // (The control bits the skiff's flight records for its replicas: Replication clears them at the end of each tick)
  let skiffBits = 0;
  const ctl = w.ships.replicaCtl, set = ctl.set.bind(ctl);
  ctl.set = (k, v) => { if (k === skiff) skiffBits = v.bits; return set(k, v); };
  for (let i = 0; i < ticks; i++) {
    place();
    Input.fireLeft[w.pid] = 1; Input.cursorDist[w.pid] = 500; Input.targetAngle[w.pid] = aimEast();
    w.server.step();
  }
  return { ...w, skiff, place, bits: () => skiffBits };
}

describe('weaponry mark: what a Searchlight lights takes more from everyone', () => {
  it('lit, the target is marked (and shows it in the status row), for 2 s after the beam leaves it', () => {
    const w = beamOnSkiff('laser_searchlight', 60);
    expect(w.ships.markedTicksLeft(w.skiff)).toBeGreaterThan(110);
    expect(w.server.features.status('weaponry', w.skiff) & STATUS_MARKED).toBe(STATUS_MARKED);
    // Off it: still marked for a while, then not
    for (let i = 0; i < 100; i++) { w.place(); Input.fireLeft[w.pid] = 0; w.server.step(); }
    expect(w.ships.markedTicksLeft(w.skiff)).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) { w.place(); Input.fireLeft[w.pid] = 0; w.server.step(); }
    expect(w.ships.markedTicksLeft(w.skiff)).toBe(0);
    expect(w.server.features.status('weaponry', w.skiff)).toBe(0);
  });

  it('a marked ship takes MARK_TAKEN × every hit, from any source', () => {
    const w = pilotWith('cannon_pip');
    const [skiff] = w.server.enemies.spawnPack(InSystem.systemId[w.pid], { faction: 'pirates', ships: ['pirate_skiff'] }, X + 3000, Y);
    const ship = w.ships.get(skiff)!;
    ship.shield = 0;
    const part = ship.hp.findIndex((h, i) => h > 50 && ship.blueprint.parts[i].fn !== 'core');
    const plain = w.ships.hurt(skiff, ship, part, 5, -1);
    w.ships.mark(skiff, 120);
    ship.shield = 0;
    const marked = w.ships.hurt(skiff, ship, part, 5, -1);
    expect(plain).toBeGreaterThan(0);
    expect(marked / plain).toBeCloseTo(MARK_TAKEN, 6);
  });
});

describe('weaponry slow: what a Frostbite lights flies slowed', () => {
  it('lit, the target is slowed (its replicas told by CTL.slowed, everyone by the status row), 0.7 s after; no chill', () => {
    const w = beamOnSkiff('legendary_frostbite', 60);
    expect(w.ships.slowedTicksLeft(w.skiff)).toBeGreaterThan(30);
    expect(w.bits() & CTL.slowed).toBe(CTL.slowed);
    expect(w.server.features.status('weaponry', w.skiff) & STATUS_SLOWED).toBe(STATUS_SLOWED);
    // The beam no longer takes its warmth
    expect(w.ships.warmthOf(w.skiff)).toBe(1);
    // Off it: slowed for 0.7 s more, then not
    for (let i = 0; i < 30; i++) { w.place(); Input.fireLeft[w.pid] = 0; w.server.step(); }
    expect(w.ships.slowedTicksLeft(w.skiff)).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) { w.place(); Input.fireLeft[w.pid] = 0; w.server.step(); }
    expect(w.ships.slowedTicksLeft(w.skiff)).toBe(0);
    expect(w.bits() & CTL.slowed).toBe(0);
  });

  it('a slowed pilot is told the ticks left in its own row (its prediction flies it slowed)', () => {
    const w = pilotWith('cannon_pip');
    for (let i = 0; i < 10; i++) { w.hold(); w.server.step(); }
    const before = w.got.length;
    w.ships.slow(w.pid, 42);
    for (let i = 0; i < 6; i++) { w.hold(); w.server.step(); }
    w.got.splice(0, before);
    const rows: any[] = [];
    for (const g of w.got) {
      const ms = g.m.type === 'batch' ? (g.m as any).m : [g.m];
      for (const m of ms) if (m.type === 'snapshot') for (const e of m.entities ?? []) if (e.id === w.pid && e.type === EntityType.Player && e.data) rows.push(e);
    }
    expect(rows.length).toBeGreaterThan(0);
    // (its row went again when the slowing began: the self row's key carries when it ends)
    expect(pilotExtras(rows[rows.length - 1].data).slowed).toBeGreaterThan(30);
    expect(pilotExtras(rows[rows.length - 1].data).marked).toBe(0);
  });
});

describe('ordnance: the Swarm ripples, the Leviathan arms late', () => {
  it('Swarm: each salvo is two rockets 5 ticks apart, and held it keeps going every 45 ticks', () => {
    const w = pilotWith('missile_swarm', { id: 'missile_crate', n: 1 }, 1);
    const q = bitecs.defineQuery([Projectile]);
    const seen = new Map<number, number>();
    for (let i = 0; i < 50; i++) {
      w.hold();
      Input.fireLeft[w.pid] = 1; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
      for (const e of q(w.server.world)) if (OwnedBy.ownerId[e] === w.pid && Projectile.weaponType[e] === WEAPON_KIND_TYPE.missile && !seen.has(e)) seen.set(e, Projectile.spawnTick[e]);
    }
    const ticks = [...seen.values()].sort((a, b) => a - b);
    // (Held for 50 ticks: the first pair, then the next pair's first rocket 45 ticks on)
    expect(ticks.length).toBe(3);
    expect(ticks[1] - ticks[0]).toBe(5);
    expect(ticks[2] - ticks[0]).toBe(45);
  });

  it('Leviathan: unarmed for 30 ticks (it flies through a ship in its way), then it goes off on one', () => {
    const w = pilotWith('torpedo_leviathan', { id: 'torpedo_crate', n: 1 }, 1);
    const q = bitecs.defineQuery([Projectile]);
    const [skiff] = w.server.enemies.spawnPack(InSystem.systemId[w.pid], { faction: 'pirates', ships: ['pirate_skiff'] }, X + 2000, Y);
    let torp = -1, born = 0, early = 0;
    // Its detonation as its client has it: told as one (the old way), or worked out from the hit record that spends it
    // (the hit that breaks one of the skiff's parts is a record since the hit is worked out on the skiff as it was
    // before that rebuild, HitLedger.before: the client makes the burst itself, ConfirmedHits hitEndFx)
    const boomsOf = () => [
      ...w.detonations('torpedo'),
      ...w.got.filter((g) => g.m.type === 'hits').flatMap((g) => unpackHits((g.m as { h: number[] }).h).filter((r) => r.shell === torp && r.gone).map((r) => ({ tick: g.tick - r.ago }))),
    ];
    // (the skiff sits right on the torpedo's nose every tick)
    const onNose = () => {
      const sp = Math.hypot(Velocity.x[torp], Velocity.y[torp]) || 1;
      Position.x[skiff] = Position.x[torp] + (Velocity.x[torp] / sp) * 12; Position.y[skiff] = Position.y[torp] + (Velocity.y[torp] / sp) * 12;
      Velocity.x[skiff] = Velocity.x[torp]; Velocity.y[skiff] = Velocity.y[torp];
    };
    for (let i = 0; i < 160; i++) {
      w.hold();
      Input.fireLeft[w.pid] = i < 2 ? 1 : 0; Input.cursorDist[w.pid] = 900; Input.targetAngle[w.pid] = aimEast();
      if (torp >= 0 && bitecs.entityExists(w.server.world, torp)) onNose();
      w.server.step();
      if (torp < 0) for (const e of q(w.server.world)) if (OwnedBy.ownerId[e] === w.pid && Projectile.weaponType[e] === WEAPON_KIND_TYPE.torpedo) { torp = e; born = w.server.getTick(); }
      if (torp >= 0 && w.server.getTick() - born < 25) early += boomsOf().length;
    }
    expect(torp).toBeGreaterThanOrEqual(0);
    expect(early).toBe(0);
    const booms = boomsOf();
    expect(booms.length).toBeGreaterThan(0);
    expect(booms[0].tick - born).toBeGreaterThanOrEqual(28);
  });
});

describe('weaponry hold: the Singularity orb parks at the cursor', () => {
  it('flies to the aim distance, stops there, and collapses there after its pull', () => {
    const w = pilotWith('legendary_singularity', undefined, 1);
    const q = bitecs.defineQuery([Projectile]);
    const orb = () => q(w.server.world).find((e) => OwnedBy.ownerId[e] === w.pid && Projectile.weaponType[e] === WEAPON_KIND_TYPE.singularity);
    let parkedAt = -1, px = 0;
    for (let i = 0; i < 60 * 12 && !w.detonations('singularity').length; i++) {
      w.hold();
      Input.fireLeft[w.pid] = i < 5 ? 1 : 0; Input.cursorDist[w.pid] = 700; Input.targetAngle[w.pid] = aimEast();
      w.server.step();
      const e = orb();
      if (e !== undefined && Velocity.x[e] === 0 && Velocity.y[e] === 0 && parkedAt < 0) { parkedAt = i; px = Position.x[e]; }
      if (e !== undefined && parkedAt >= 0) expect(Position.x[e]).toBe(px);
    }
    expect(parkedAt).toBeGreaterThan(0);
    expect(Math.abs(px - (X + 700))).toBeLessThan(80);
    const boom = w.detonations('singularity')[0];
    expect(boom).toBeTruthy();
    expect(Math.abs(boom.x - px)).toBeLessThan(5);
  });
});
