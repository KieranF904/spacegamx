/**
 * Client-detected hits (docs/design/confirmed-hits.md part D): a real GameServer, a pilot firing at a parked ship, and
 * three fake clients (fakeHitsClient.ts: the client's ShipStore, ShipReplicaSet, ConfirmedHits and SelfHits): the
 * shooter finding its hits itself, an observer on the old messages, and an observer finding them itself (its shells
 * come as fire events, rebuilt from the shooter's replica). After every snapshot each one's part HP must be the
 * server's as the wire carries it; by the end they've seen the same damage, fires, impacts and removed shells; the
 * server sent records only for what the finders couldn't find, and their reports agreed.
 *
 * The forced mismatch: a finder that throws away some of its hits. Its reports disagree, the server sends a hitFix,
 * and its HP is put right (the ships' HP in full with the next snapshot).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Input, InSystem, CAPS, hpWire, ReplicaMode, replicaAngle, quantizeReplicaAngle,
  type Blueprint, type ShipState, type ReplicaEnv,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from './fakeHitsClient.testkit.js';
import type { OwnHit } from '../../../../client/src/ships/hits/ConfirmedHits.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const BOTH = CAPS.HITS | CAPS.SELF_HITS;

function withGuns(bp: Blueprint, from: string, fn: string): Blueprint {
  return { ...bp, parts: bp.parts.map((p) => (p.fn === from ? { ...p, fn } : p)) };
}

interface Scenario {
  gun?: string;
  ammo?: string;
  hpScale?: number;
  shield?: number;
  behind?: boolean;
  boss?: string;
  ticks?: number;
  /** The shooter throws away its hits on these shells (a forced mismatch) */
  drop?: (h: OwnHit) => boolean;
  /** The target is pushed across the line of fire once and coasts (a moving target) */
  drift?: number;
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
    netCaps: BOTH,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'self_shooter', caps: BOTH, env, drop: sc.drop });
  const B = new FakeHitsClient(server, { name: 'legacy_obs', caps: 0, env });
  const C = new FakeHitsClient(server, { name: 'self_obs', caps: BOTH, env });
  const fakes = [A, B, C];
  const step = () => {
    server.step();
    clock.t += 1000 / 60;
    for (const f of fakes) f.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
  for (const f of fakes) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); }
  const num = InSystem.systemId[A.pid];
  const sparrow = ships.library.get('sparrow-t')!;
  ships.respawnInPlace(A.pid, sc.gun ? withGuns(sparrow, 'cannon_pip', sc.gun) : sparrow);
  if (sc.ammo) server.pilots.get(server.pilots.connOf(A.pid)!)!.cargo.push({ id: sc.ammo, n: 50 });
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(A.pid, x0, y0);
  place(B.pid, x0 - 300, y0 + 400);
  place(C.pid, x0 - 300, y0 - 400);
  const target = sc.boss ? server.bosses.spawnAt(sc.boss, num, x0 + 1500, y0) : ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  if (sc.behind) ships.spawnDummy(ships.library.get('hauler')!, x0 + 1300, y0, 0, num);
  const ship = ships.get(target)!;
  if (sc.hpScale) for (let i = 0; i < ship.hp.length; i++) ship.hp[i] *= sc.hpScale;
  const ticks = sc.ticks ?? 600;
  const off: string[] = [];
  let compared = 0, offSnapshots = 0;
  for (let t = 0; t < ticks; t++) {
    for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][A.pid] = 0;
    if (ships.has(target)) {
      // (one push across the line of fire: it coasts, as its replica does)
      if (sc.drift && !sc.boss && t === 0) Velocity.y[target] = sc.drift;
      const dx = Position.x[target] - Position.x[A.pid], dy = Position.y[target] - Position.y[A.pid];
      Input.targetAngle[A.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
      Input.cursorDist[A.pid] = Math.hypot(dx, dy);
      Input.fireLeft[A.pid] = 1; Input.fireRight[A.pid] = 1;
      if (sc.shield) ships.get(target)!.shield = sc.shield;
    }
    place(A.pid, x0, y0);
    for (const f of fakes) f.sawSnapshot = false;
    step();
    for (const f of fakes) {
      if (!f.sawSnapshot) continue;
      const conn = server.pilots.connOf(f.pid)!;
      let bad = false;
      for (const [id, s] of ships.bodies) {
        const synced = conn.shipSynced.get(id), mine = f.store.get(id);
        if (!synced || synced.ship !== s || synced.rebuilds !== s.rebuilds || !mine || !conn.shipView.has(id) || conn.debrisHeld.has(id)) continue;
        const want = s.hp.map(hpWire), got = (mine as ShipState).hp;
        for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { bad = true; if (off.length < 20) off.push(`${f === A ? 'A' : f === B ? 'B' : 'C'} tick ${server.getTick()} ship ${id} part ${i}: ${got[i]} vs ${want[i]}`); }
        compared++;
      }
      if (bad) offSnapshots++;
    }
  }
  // Let the last reports and any correction land
  for (const k of ['fireLeft', 'fireRight'] as const) Input[k][A.pid] = 0;
  for (let t = 0; t < 90; t++) step();
  const finalOff: string[] = [];
  for (const f of fakes) {
    const conn = server.pilots.connOf(f.pid)!;
    for (const [id, s] of ships.bodies) {
      const synced = conn.shipSynced.get(id), mine = f.store.get(id);
      if (!synced || synced.ship !== s || synced.rebuilds !== s.rebuilds || !mine || !conn.shipView.has(id)) continue;
      const want = s.hp.map(hpWire), got = (mine as ShipState).hp;
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) finalOff.push(`${f === A ? 'A' : f === B ? 'B' : 'C'} ship ${id} part ${i}: ${got[i]} vs ${want[i]}`);
    }
  }
  const journal = server.hits.journalStats([A, C].map((f) => server.pilots.connOf(f.pid)!));
  return { server, A, B, C, off, offSnapshots, finalOff, compared, stats: server.hits.stats, journal };
}

/** Per 100 hits the finders were owed: found by themselves, told, corrected */
function rates(r: ReturnType<typeof run>) {
  const s = r.stats, owed = s.own + s.told;
  return { owed, own: s.own, told: s.told, fixes: s.fixes, fixHits: s.fixHits, per100: owed ? +(100 * s.fixes / owed).toFixed(2) : 0, toldWhy: s.toldWhy, journal: r.journal };
}

function expectAgree(r: ReturnType<typeof run>, found = true) {
  const { A, B, C } = r;
  if (process.env.HITS_DEBUG) console.log(JSON.stringify({ rates: rates(r), off: r.off.slice(0, 5), offSnapshots: r.offSnapshots, A: A.selfHits!.stats, C: C.selfHits!.stats, hitsA: A.hits!.stats, hitsC: C.hits!.stats }));
  expect(r.compared).toBeGreaterThan(0);
  expect(r.finalOff.slice(0, 5)).toEqual([]);
  // The finders found most of their hits themselves (unless the server must tell them all), and every report agreed
  if (found) expect(r.stats.own).toBeGreaterThan(r.stats.told);
  expect(r.stats.fixes).toBe(0);
  expect(r.off.slice(0, 5)).toEqual([]);
  expect(A.hits!.stats.mismatches + C.hits!.stats.mismatches).toBe(0);
  expect(A.reports).toBeGreaterThan(0);
  // The same damage, fires, impacts, detonations and removed shells as the legacy observer
  for (const f of [A, C]) {
    const keys = new Set([...f.damage.keys(), ...B.damage.keys()]);
    const allowance = 0.051 * (f.hits!.stats.records + f.hits!.stats.own) + 0.2;
    for (const k of keys) expect(Math.abs((f.damage.get(k) ?? 0) - (B.damage.get(k) ?? 0)), k).toBeLessThanOrEqual(allowance);
    expect([...f.ignites].sort()).toEqual([...B.ignites].sort());
    expect(f.projectileHits).toBe(B.projectileHits);
    expect(f.detonations).toBe(B.detonations);
    const gone = (x: FakeHitsClient, y: FakeHitsClient) => [...x.removed].filter((id) => y.known.has(id)).sort((a, b) => a - b);
    expect(gone(f, B)).toEqual(gone(B, f));
  }
}

describe('client-detected hits: finders and a legacy client see the same fight', () => {
  it('Pips on a freighter: parts shot away, the freighter dying', () => {
    const r = run({ hpScale: 0.02, ticks: 900 });
    expectAgree(r);
  }, 120_000);

  it('railgun: shells that pierce two freighters', () => {
    const r = run({ gun: 'railgun', ammo: 'railgun_slugs', hpScale: 0.5, behind: true });
    expectAgree(r);
  }, 120_000);

  it('magma: fire and a blast (the burning target rebuilds most snapshots: told)', () => {
    const r = run({ gun: 'magma_cannon' });
    expectAgree(r, false);
    expect(r.A.ignites.length).toBeGreaterThan(0);
  }, 120_000);

  it('a shielded freighter: the shield is the server\'s to tell', () => {
    const r = run({ shield: 400 });
    expectAgree(r, false);
    expect(r.stats.told).toBeGreaterThan(0);
  }, 120_000);

  it("a target coasting across the line of fire", () => {
    const r = run({ drift: 4, ticks: 600 });
    expectAgree(r);
  }, 120_000);
});

describe('client-detected hits: a forced mismatch is put right', () => {
  it('a shooter that throws away a third of its hits gets a correction, and its HP comes right', () => {
    const r = run({ ticks: 600, drop: (h) => h.shell % 3 === 0 });
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ rates: rates(r), dropped: r.A.dropped, A: r.A.selfHits!.stats, offSnapshots: r.offSnapshots }));
    expect(r.A.dropped).toBeGreaterThan(0);
    expect(r.stats.fixes).toBeGreaterThan(0);
    expect(r.A.selfHits!.stats.fixes).toBe(r.stats.fixes);
    expect(r.A.selfHits!.stats.fixMissed).toBeGreaterThan(0);
    // The observer finding its own is unaffected; the legacy one too
    expect(r.C.selfHits!.stats.fixes).toBe(0);
    // Everyone's HP is the server's by the end
    expect(r.finalOff.slice(0, 5)).toEqual([]);
    // The missed hits were drawn from the correction: as many impacts as the legacy observer saw
    expect(r.A.projectileHits).toBe(r.B.projectileHits);
  }, 120_000);
});
