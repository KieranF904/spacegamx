/**
 * Other ships' causes (CAPS.CAUSES; common network/causes.ts, server net/causes/shadowCauses.ts, client
 * ships/causes/ShipCauses.ts). Ships near a client grind against each other and lose parts; a client taking causes is
 * sent each contact once for both ships and each rebuild, works them out on its tick layer, and holds every ship
 * exactly as the server has it on every tick, with no keyframe of a ship it already holds. A legacy client watching
 * the same fight gets keyframes, as before.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { readFileSync } from 'fs';
import { Position, Velocity, Rotation, InSystem, CAPS, type ReplicaEnv, type ServerSnapshotMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const BASE = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.INPUTS | CAPS.BODIES;

interface Seen { held: number; keyframes: number; entries: number; records: number; checked: number; off: number; offTicks: number; lastOff: number }

function fight(caps: number, extra = 0, dropAt = -1) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: 4095,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'causes', caps: caps | extra, env });
  const B = new FakeHitsClient(server, { name: 'legacy', caps: 0, env });
  for (let i = 0; i < 30; i++) { server.step(); clock.t += 1000 / 60; }
  const sys = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  for (const p of [A.pid, B.pid]) { Position.x[p] = x0; Position.y[p] = y0 + (p === B.pid ? 600 : 0); Velocity.x[p] = 0; Velocity.y[p] = 0; }
  const bp = (n: string) => ships.library.get(n) ?? JSON.parse(readFileSync(join(dataDir, 'ships/blueprints', n + '.json'), 'utf8'));
  // Two packs pushed into each other by their autopilots, and a hauler losing parts now and then
  const dummies: number[] = [];
  for (let i = 0; i < 6; i++) {
    const d = ships.spawnDummy(bp('sparrow-t'), x0 + 900 + (i % 3) * 30, y0 - 200 + Math.floor(i / 3) * 400, i * 0.9, sys);
    ships.setAutopilot(d, { x: x0 + 930, y: y0, arriveRadius: 10 });
    dummies.push(d);
  }
  const hauler = ships.spawnDummy(bp('hauler'), x0 - 1200, y0, 0.3, sys);
  // The server's ships every tick (what each held replica must be)
  const truth = new Map<number, Map<number, number[]>>();
  const record = () => {
    const m = new Map<number, number[]>();
    for (const [eid] of ships.bodies) m.set(eid, [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid]]);
    truth.set(server.getTick(), m);
    truth.delete(server.getTick() - 64);
  };
  const watch = (f: FakeHitsClient, seen: Seen, on: () => boolean) => {
    const fa = f as unknown as { snapshot(s: ServerSnapshotMessage): void };
    const o = fa.snapshot.bind(f);
    let last = -1;
    fa.snapshot = (s) => {
      // (The forced miss: this client loses one snapshot's causes)
      if (f === A && dropAt >= 0 && s.tick >= dropAt && s.causes?.length) { s = { ...s, causes: undefined }; dropAt = -1; }
      const held = new Set<number>(f.reps.ids());
      if (on()) for (const k of s.ships ?? []) if (k[0] !== f.pid) { if (held.has(k[0])) seen.keyframes++; else seen.entries++; }
      if (on()) seen.records += s.causes?.length ?? 0;
      o(s);
      if (!on()) { last = s.tick; return; }
      const keyed = new Set((s.ships ?? []).map((k) => k[0]));
      for (const id of f.reps.ids()) {
        if (id === f.pid || ships.get(id)?.kind === 'debris' || keyed.has(id)) continue;
        seen.held++;
        for (let t = Math.max(last + 1, s.tick - 8); t <= s.tick; t++) {
          const st = f.reps.at(id, t)?.body, r = truth.get(t)?.get(id);
          if (!st || !r) continue;
          seen.checked++;
          if (st.x !== r[0] || st.y !== r[1] || st.vx !== r[2] || st.vy !== r[3] || st.angle !== r[4]) { seen.offTicks++; seen.lastOff = s.tick; if (t === s.tick) seen.off++; }
        }
      }
      last = s.tick;
    };
  };
  let measuring = false;
  const a: Seen = { held: 0, keyframes: 0, entries: 0, records: 0, checked: 0, off: 0, offTicks: 0, lastOff: -1 };
  const b: Seen = { held: 0, keyframes: 0, entries: 0, records: 0, checked: 0, off: 0, offTicks: 0, lastOff: -1 };
  // Its own check (with every ship it holds, CAPS.CAUSES) as each input would carry it
  const checks = (server as unknown as { ownChecks: { check(c: unknown, k: unknown): void; stats: { agreed: number; bodyOff: number } } }).ownChecks;
  watch(A, a, () => measuring);
  watch(B, b, () => measuring);
  for (let i = 0; i < 900; i++) {
    const t = server.getTick();
    if (i === 120) measuring = true;
    // (the packs keep pressing in: their autopilots aim past each other)
    if (t % 90 === 0) for (const [k, d] of dummies.entries()) if (ships.has(d)) ships.setAutopilot(d, { x: x0 + 930 + (k % 2 ? 300 : -300) * Math.sign(Math.sin(t / 90)), y: y0, arriveRadius: 10 });
    if (t % 45 === 0 && ships.has(hauler)) {
      const sp = ships.get(hauler)!;
      const parts = sp.blueprint.parts.map((_, k) => k).filter((k) => sp.derived.alive[k] && sp.blueprint.parts[k].fn !== 'core');
      if (parts.length > 3) ships.damagePartFraction(hauler, parts[(t / 45) % parts.length], 1);
    }
    server.step();
    clock.t += 1000 / 60;
    record();
    const chk = A.own?.takeCheck(true, server.getTick());
    if (chk) checks.check(server.pilots.connOf(A.pid), chk);
  }
  return { a, b, checks: { ...checks.stats }, stats: (server.replication as unknown as { causeStats: { worked: number; rows: number; stateless: number; unworkable: number; failed: Record<string, number> } }).causeStats, client: A.causes?.stats };
}

describe('other ships\' causes (CAPS.CAUSES)', () => {
  it('a client taking them holds every ship exactly, every tick, with no keyframe of one it holds; a legacy one is keyframed', () => {
    const { a, b, stats, client, checks } = fight(BASE, CAPS.CAUSES);
    expect(checks.bodyOff).toBe(0);
    expect(checks.agreed).toBeGreaterThan(10);
    // (the fight had contacts and rebuilds to tell)
    expect(stats.worked).toBeGreaterThan(50);
    expect(a.records).toBeGreaterThan(20);
    expect(client?.failed).toBe(0);
    expect(a.checked).toBeGreaterThan(5000);
    expect(a.offTicks).toBe(0);
    // (Only what it couldn't work out: a ship that touched one rebuilt twice in a window, the structure between not had)
    expect(a.keyframes * 50).toBeLessThan(b.keyframes);
    // The legacy observer: keyframes for what the causes moved, and none of the records
    expect(b.records).toBe(0);
    expect(b.keyframes).toBeGreaterThan(20);
  }, 120_000);

  it('the same through encode-once blocks and the focus grid (the dev server caps)', () => {
    const { a, b, client } = fight(BASE | CAPS.BLOCKS | CAPS.FOCUS, CAPS.CAUSES);
    expect(a.records).toBeGreaterThan(20);
    expect(client?.failed).toBe(0);
    expect(a.checked).toBeGreaterThan(5000);
    expect(a.offTicks).toBe(0);
    expect(a.keyframes * 50).toBeLessThan(b.keyframes);
  }, 120_000);

  it('a client that misses some causes is caught by its check and put right: every ship it holds again', () => {
    const { a, checks } = fight(BASE, CAPS.CAUSES, 400);
    expect(a.offTicks).toBeGreaterThan(0);
    expect(checks.bodyOff).toBeGreaterThan(0);
    // (off only until the check's keyframes came: none in the last 300 ticks)
    expect(a.lastOff).toBeLessThan(600);
    expect(checks.agreed).toBeGreaterThan(10);
  }, 120_000);

  it('without the cap, the same client is keyframed as before', () => {
    const { a } = fight(BASE);
    expect(a.records).toBe(0);
    expect(a.keyframes).toBeGreaterThan(20);
    expect(a.off).toBe(0);
  }, 120_000);
});
