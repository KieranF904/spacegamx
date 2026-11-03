/**
 * Confirmed hits parity (docs/design/confirmed-hits.md part C): a real GameServer with two fake clients side by
 * side, one taking confirmed hits (it announces CAPS.HITS and works each hit out with the client's ConfirmedHits on
 * the client's ShipStore), one on the old messages. A pilot fires at a ship; for the same hits both clients must end
 * up with the same part HP (the server's own, as the wire carries it, after every snapshot), the same damage numbers,
 * the same fires and the same shells removed, and the capable client's HP checks must all agree.
 *
 * Scenarios: Pips on a freighter (plain hits, parts shot away, the freighter dying), railgun pierce, magma (fire and a
 * blast), Cinder Bloom (fire), the Phase Cannon (a pierce that keeps its damage: its flash), a shielded freighter,
 * and a staged boss (its cover).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Input, InSystem, CAPS, hpWire, decodeServerFrame, ReplicaMode, replicaAngle, quantizeReplicaAngle,
  type Blueprint, type ClientMessage, type ClientSocket, type ServerMessage, type ServerSnapshotMessage, type ShipState,
} from '@space-game/common';
import { ShipStore } from '../../../../client/src/ships/ShipStore.js';
import { ConfirmedHits, type HitShell } from '../../../../client/src/ships/hits/ConfirmedHits.js';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** One fake client: the client's ship store, its shells, and what it was shown */
interface Fake {
  pid: number;
  store: ShipStore;
  hits: ConfirmedHits | null;
  shells: Map<number, HitShell>;
  snapTick: number;
  /** Damage shown, summed per target and source */
  damage: Map<string, number>;
  /** Hits whose damage the capable client worked out itself (for the rounding allowance) */
  derivedHits: number;
  ignites: string[];
  removed: Set<number>;
  /** Every shell it was told of */
  known: Set<number>;
  projectileHits: number;
  detonations: number;
  sawSnapshot: boolean;
  link: { receive(msg: ClientMessage): void } | null;
}

function makeFake(server: GameServer, name: string, caps: number): Fake {
  const ships = server.getShips();
  const f: Fake = {
    pid: -1, store: new ShipStore(ships.catalog, ships.tuning), hits: null, shells: new Map(), snapTick: 0,
    damage: new Map(), derivedHits: 0, ignites: [], removed: new Set(), known: new Set(), projectileHits: 0, detonations: 0, sawSnapshot: false, link: null,
  };
  if (caps) {
    f.hits = new ConfirmedHits({
      store: f.store,
      shell: (id) => f.shells.get(id) ?? null,
      pose: () => null,
      send: (m) => f.link?.receive(m),
    });
  }
  const handle = (m: ServerMessage): void => {
    switch (m.type) {
      case 'shipSync': f.store.onSync(m); break;
      case 'shipHps': f.store.onHps(m); break;
      case 'snapshot': {
        const s = m as ServerSnapshotMessage;
        f.snapTick = s.tick;
        f.sawSnapshot = true;
        for (const e of s.entities) {
          const d = e.data;
          if (e.type === 7) f.known.add(e.id);
          if (e.type === 7 && d && (d[10] ?? -1) >= 0) f.shells.set(e.id, { owner: d[6], gun: d[10], spawnTick: d[3], x: d[4], y: d[5], vx: e.vx ?? 0, vy: e.vy ?? 0 });
        }
        // (fire events: the shells' gun, as ShipClient.preSnapshot keeps it; their line doesn't matter here)
        for (const [owner, , partAmmo, , ...ids] of s.fire ?? []) {
          for (const id of ids) { f.known.add(id); f.shells.set(id, { owner, gun: partAmmo, spawnTick: s.tick, x: 0, y: 0, vx: 0, vy: 0 }); }
        }
        for (const id of s.removed) { if (f.known.has(id)) f.removed.add(id); f.shells.delete(id); f.store.remove(id); }
        f.hits?.forget(s.removed);
        break;
      }
      case 'hits': {
        const r = f.hits!.expand(m, f.snapTick);
        for (const x of r.msgs) handle(x);
        for (const id of r.gone) { f.removed.add(id); f.shells.delete(id); }
        break;
      }
      case 'hpCheck': f.hits!.check(m); break;
      case 'damage': {
        const k = `${m.targetId},${m.sourceId}`;
        f.damage.set(k, (f.damage.get(k) ?? 0) + m.amount);
        break;
      }
      case 'ignite': f.ignites.push(`${m.bodyId}:${m.part}:${m.ticks}`); break;
      case 'projectileHit': f.projectileHits++; break;
      case 'detonation': f.detonations++; break;
    }
  };
  const socket: ClientSocket = {
    isOpen: () => true,
    send: (data) => { for (const m of decodeServerFrame(data as Uint8Array)) handle(m); },
  };
  const link = server.connect(socket);
  f.link = link;
  link.receive({ type: 'join', username: name, ...(caps ? { caps } : {}) } as ClientMessage);
  f.pid = server.getPlayerId(socket);
  return f;
}

/** A blueprint with every gun of `from` swapped for `fn` */
function withGuns(bp: Blueprint, from: string, fn: string): Blueprint {
  return { ...bp, parts: bp.parts.map((p) => (p.fn === from ? { ...p, fn } : p)) };
}

interface Scenario {
  name: string;
  /** The shooter's guns (a function id put in place of the Sparrow's Pips) */
  gun?: string;
  /** The target: a freighter (default), or a boss */
  boss?: string;
  /** Its parts' HP × this at the start (so parts go, and it dies) */
  hpScale?: number;
  /** A shield on the target, renewed every tick */
  shield?: number;
  /** Ammunition in the shooter's hold (else a gun that takes it fires plain rounds) */
  ammo?: string;
  /** A second freighter behind the first (a piercing shell's next pass) */
  behind?: boolean;
  /** The capable client's switch turned off at this tick and on again 200 later (the admin's `hits` command) */
  toggleAt?: number;
  ticks?: number;
}

function run(sc: Scenario) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: CAPS.HITS,
  });
  const ships = server.getShips();
  const step = () => { server.step(); clock.t += 1000 / 60; };
  const A = makeFake(server, 'hits_capable', CAPS.HITS);
  const B = makeFake(server, 'hits_legacy', 0);
  for (let i = 0; i < 20; i++) step();
  // (Both pilots out of harm's way: a client whose ship is gone is told nothing, the old way or the new)
  for (const f of [A, B]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); }
  const num = InSystem.systemId[A.pid];
  const sparrow = ships.library.get('sparrow-t')!;
  ships.respawnInPlace(A.pid, sc.gun ? withGuns(sparrow, 'cannon_pip', sc.gun) : sparrow);
  if (sc.ammo) server.pilots.get(server.pilots.connOf(A.pid)!)!.cargo.push({ id: sc.ammo, n: 50 });
  // Out in open space: the shooter, the observer beside it, the target ahead
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(A.pid, x0, y0);
  place(B.pid, x0 - 300, y0 + 400);
  const target = sc.boss ? server.bosses.spawnAt(sc.boss, num, x0 + 1500, y0) : ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  if (sc.behind) ships.spawnDummy(ships.library.get('hauler')!, x0 + 1300, y0, 0, num);
  const ship = ships.get(target)!;
  if (sc.hpScale) for (let i = 0; i < ship.hp.length; i++) ship.hp[i] *= sc.hpScale;
  const ticks = sc.ticks ?? 600;
  const hpChecks: string[] = [];
  let compared = 0;
  for (let t = 0; t < ticks; t++) {
    for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][A.pid] = 0;
    if (ships.has(target)) {
      const dx = Position.x[target] - Position.x[A.pid], dy = Position.y[target] - Position.y[A.pid];
      Input.targetAngle[A.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
      Input.cursorDist[A.pid] = Math.hypot(dx, dy);
      Input.fireLeft[A.pid] = 1; Input.fireRight[A.pid] = 1;
      if (sc.shield) ships.get(target)!.shield = sc.shield;
    }
    place(A.pid, x0, y0);
    if (sc.toggleAt !== undefined && (t === sc.toggleAt || t === sc.toggleAt + 200)) server.pilots.connOf(A.pid)!.capsNext = t === sc.toggleAt ? 0 : CAPS.HITS;
    A.sawSnapshot = B.sawSnapshot = false;
    step();
    // After each snapshot: both clients' part HP is the server's, as the wire carries it
    for (const f of [A, B]) {
      if (!f.sawSnapshot) continue;
      const conn = server.pilots.connOf(f.pid)!;
      for (const [id, s] of ships.bodies) {
        const synced = conn.shipSynced.get(id), mine = f.store.get(id);
        if (!synced || synced.ship !== s || synced.rebuilds !== s.rebuilds || !mine || !conn.shipView.has(id) || conn.debrisHeld.has(id)) continue;
        const want = s.hp.map(hpWire), got = (mine as ShipState).hp;
        for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) hpChecks.push(`${f === A ? 'A' : 'B'} tick ${server.getTick()} ship ${id} part ${i}: ${got[i]} vs ${want[i]}`);
        compared++;
      }
    }
  }
  return { server, A, B, target, hpChecks, compared, stats: server.hits.stats, died: !ships.has(target) };
}

function expectParity(r: ReturnType<typeof run>) {
  const { A, B } = r;
  if (process.env.HITS_DEBUG) console.log(JSON.stringify({ stats: r.stats, client: A.hits!.stats, compared: r.compared, died: r.died, dmgA: [...A.damage].slice(0, 6), dmgB: [...B.damage].slice(0, 6), ignA: A.ignites.length, ignB: B.ignites.length, phA: A.projectileHits, detA: A.detonations, remA: A.removed.size, remB: B.removed.size }));
  expect(r.hpChecks.slice(0, 5)).toEqual([]);
  expect(r.compared).toBeGreaterThan(0);
  // The capable client got records, and worked every one out
  expect(r.stats.records).toBeGreaterThan(0);
  expect(A.hits!.stats.missed).toBe(0);
  expect(A.hits!.stats.mismatches).toBe(0);
  // The same damage per target and source (a record's own number is to a tenth: a little rounding allowed)
  const keys = new Set([...A.damage.keys(), ...B.damage.keys()]);
  const allowance = 0.051 * A.hits!.stats.records + 0.2;
  if (process.env.HITS_DEBUG) for (const k of keys) if (Math.abs((A.damage.get(k) ?? 0) - (B.damage.get(k) ?? 0)) > 0.01) console.log('DMGDIFF', k, A.damage.get(k), B.damage.get(k), r.server.getShips().get(Number(k.split(',')[0]))?.blueprint.name, r.server.getShips().get(Number(k.split(',')[1]))?.blueprint.name);
  for (const k of keys) expect(Math.abs((A.damage.get(k) ?? 0) - (B.damage.get(k) ?? 0)), k).toBeLessThanOrEqual(allowance);
  // The same fires, the same impacts, the same shells gone
  expect([...A.ignites].sort()).toEqual([...B.ignites].sort());
  expect(A.projectileHits).toBe(B.projectileHits);
  expect(A.detonations).toBe(B.detonations);
  // (shells both were told of: each removed for both, or for neither)
  const gone = (f: Fake, g: Fake) => [...f.removed].filter((id) => g.known.has(id)).sort((a, b) => a - b);
  expect(gone(A, B).length).toBeGreaterThan(0);
  expect(gone(A, B)).toEqual(gone(B, A));
}

describe('confirmed hits: a capable client and a legacy one see the same fight', () => {
  it('Pips on a freighter: plain hits, parts shot away, the freighter dying', () => {
    const r = run({ hpScale: 0.02, ticks: 900 });
    expectParity(r);
    expect(r.died).toBe(true);
  }, 120_000);

  it('railgun: shells that pierce', () => {
    const r = run({ gun: 'railgun', ammo: 'railgun_slugs', hpScale: 0.5, behind: true });
    expectParity(r);
  }, 120_000);

  it('railgun out of slugs: plain rounds, told the old way (their end is not what the gun says)', () => {
    const r = run({ gun: 'railgun', hpScale: 0.5 });
    expect(r.hpChecks.slice(0, 5)).toEqual([]);
    expect(r.stats.records).toBe(0);
    expect(r.stats.why.fx).toBeGreaterThan(0);
  }, 120_000);

  it('magma: fire and a blast', () => {
    const r = run({ gun: 'magma_cannon' });
    expectParity(r);
    expect(r.A.ignites.length).toBeGreaterThan(0);
  }, 120_000);

  it('Cinder Bloom: fire', () => {
    const r = run({ gun: 'cinder_bloom' });
    expectParity(r);
    expect(r.A.ignites.length).toBeGreaterThan(0);
  }, 120_000);

  it('Phase Cannon: a pierce that keeps its damage, and its flash', () => {
    const r = run({ gun: 'phase', behind: true });
    expectParity(r);
  }, 120_000);

  it('a shielded freighter: the shield takes it, the HP follows in shipHps', () => {
    const r = run({ shield: 400 });
    expectParity(r);
    expect(r.stats.s).toBeGreaterThan(0);
  }, 120_000);

  it('switched off and on again mid-fight', () => {
    const r = run({ ticks: 700, toggleAt: 200 });
    expectParity(r);
    // (while it was off its hits went the old way: more impacts than records)
    expect(r.A.projectileHits).toBeGreaterThan(r.stats.records);
  }, 120_000);

  it('a staged boss: its cover', () => {
    const r = run({ boss: 'boss_scrap_mother', ticks: 600 });
    expectParity(r);
  }, 120_000);
});
