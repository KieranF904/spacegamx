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

function fight(caps: number, extra = 0, dropAt = -1, hurtEvery = 45) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: 4095 | CAPS.STRUCTS | CAPS.CONTACTS,
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
  // Only this fight's ships in the system: the world's are taken away as they come. (A Helios Drone at the docks the
  // clients started by, the client's target there and so in its view however far, grinding on a packmate out of view:
  // a contact it can't work out, so a keyframe, whatever structures it keeps. Sol's docks have had more of them since
  // the custom enemies' rework, 2026-11-05)
  const ours = new Set([A.pid, B.pid, ...dummies, hauler]);
  const clearAbout = () => {
    for (const [eid, s] of ships.bodies) if (!ours.has(eid) && s.kind === 'ship' && InSystem.systemId[eid] === sys) ships.removeShip(eid);
  };
  clearAbout();
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
  const pairs = { compared: 0, with: 0, differ: 0, ticks: 0, once: 0, found: 0 };
  const pairsSeen = new Set<number>();
  for (let i = 0; i < 900; i++) {
    const t = server.getTick();
    if (i === 120) measuring = true;
    // (the packs keep pressing in: their autopilots aim past each other)
    if (t % 90 === 0) for (const [k, d] of dummies.entries()) if (ships.has(d)) ships.setAutopilot(d, { x: x0 + 930 + (k % 2 ? 300 : -300) * Math.sign(Math.sin(t / 90)), y: y0, arriveRadius: 10 });
    if (t % hurtEvery === 0 && ships.has(hauler)) {
      const sp = ships.get(hauler)!;
      const parts = sp.blueprint.parts.map((_, k) => k).filter((k) => sp.derived.alive[k] && sp.blueprint.parts[k].fn !== 'core');
      if (parts.length > 3) ships.damagePartFraction(hauler, parts[(t / hurtEvery) % parts.length], hurtEvery < 45 ? 0.2 : 1);
    }
    clearAbout();
    server.step();
    clock.t += 1000 / 60;
    record();
    const chk = A.own?.takeCheck(true, server.getTick());
    if (chk) checks.check(server.pilots.connOf(A.pid), chk);
    // (Finding its own pairs: each tick's as the server's pass had them, among the ships it took; sim/c-contactCache.ts)
    if (measuring && A.contacts?.on) for (let t = server.getTick() - 30; t <= server.getTick(); t++) {
      if (pairsSeen.has(t)) continue;
      const mine = A.contacts.passAt(t), theirs = ships.contactLog.at(t, sys);
      if (!mine || !theirs) continue;
      pairsSeen.add(t);
      const took = new Set(mine.ids), want: number[] = [];
      for (let k = 0; k < theirs.pairs.length; k += 2) if (took.has(theirs.pairs[k]) && took.has(theirs.pairs[k + 1])) want.push(theirs.pairs[k], theirs.pairs[k + 1]);
      pairs.compared++;
      pairs.with += mine.pairs.length ? 1 : 0;
      if (JSON.stringify(mine.pairs.flat()) !== JSON.stringify(want)) pairs.differ++;
    }
  }
  const finds = A.contacts ? [...A.contacts.cache.finds.values()] : [];
  pairs.ticks = finds.length;
  pairs.once = finds.filter((n) => n === 1).length;
  pairs.found = finds.reduce((s, n) => s + n, 0);
  const rep = server.replication as unknown as { causeStats: { worked: number; rows: number; stateless: number; unworkable: number; failed: Record<string, number> }; contactStats: Record<string, number> };
  return { a, b, checks: { ...checks.stats }, stats: rep.causeStats, contacts: rep.contactStats, client: A.causes?.stats, own: A.own?.stats, world: A.contacts?.stats, fx: A.contactFx.length, fxMsgs: A.contactMsgs, pairs };
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
    // (Only what it couldn't work out: a ship that touched one rebuilt twice in a window, the structure between not had.
    // Stage 3: 50x -> 40x: the fight itself moved with the Stage 1 merge (A's aim rule for AI ships); 17 vs 777 and
    // every tick still exact)
    expect(a.keyframes * 40).toBeLessThan(b.keyframes);
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
    expect(a.keyframes * 40).toBeLessThan(b.keyframes);
  }, 120_000);

  it('a client that misses some causes is caught by its check and put right: every ship it holds again', () => {
    const { a, checks } = fight(BASE, CAPS.CAUSES, 400);
    expect(a.offTicks).toBeGreaterThan(0);
    expect(checks.bodyOff).toBeGreaterThan(0);
    // (off only until the check's keyframes came: none in the last 300 ticks)
    expect(a.lastOff).toBeLessThan(600);
    expect(checks.agreed).toBeGreaterThan(10);
  }, 120_000);

  it('rebuilt twice in a window: a client keeping each structure (CAPS.STRUCTS) works it out; without, a keyframe', () => {
    // (the hauler hurt every other tick: a rebuild each time, two or more in every snapshot window)
    const kept = fight(BASE, CAPS.CAUSES | CAPS.STRUCTS, -1, 2);
    expect(kept.stats.failed).toEqual({});
    expect(kept.client?.failed).toBe(0);
    expect(kept.a.offTicks).toBe(0);
    expect(kept.checks.bodyOff).toBe(0);
    const plain = fight(BASE, CAPS.CAUSES, -1, 2);
    expect(plain.a.offTicks).toBe(0);
    // (every window's causes worked out with the structures kept; without them, those windows' ships keyframed)
    expect(kept.stats.unworkable).toBe(0);
    expect(plain.stats.unworkable).toBeGreaterThan(5);
    expect(kept.a.keyframes).toBeLessThan(plain.a.keyframes);
  }, 240_000);

  it('finding contact pairs itself (CAPS.CONTACTS): the same ships exactly, with the pairs between ships it holds as no record', () => {
    const told = fight(BASE, CAPS.CAUSES | CAPS.STRUCTS);
    const found = fight(BASE, CAPS.CAUSES | CAPS.STRUCTS | CAPS.CONTACTS);
    if (process.env.CONTACTS_DEBUG) console.log('CONTACTS', JSON.stringify({ told: { a: told.a, stats: told.stats }, found: { a: found.a, stats: found.stats, contacts: found.contacts, world: found.world, client: found.client, own: found.own, fx: found.fx, fxMsgs: found.fxMsgs } }));
    expect(found.client?.failed).toBe(0);
    expect(found.own?.failed ?? 0).toBe(0);
    expect(found.checks.bodyOff).toBe(0);
    expect(found.checks.agreed).toBeGreaterThan(10);
    expect(found.a.checked).toBeGreaterThan(5000);
    expect(found.a.offTicks).toBe(0);
    // (the pairs it found: most of the fight's, none told, their sparks its own)
    expect(found.contacts.found).toBeGreaterThan(50);
    expect(found.world?.reentry).toBe(0);
    expect(found.fx).toBeGreaterThan(0);
    expect(found.a.records * 2).toBeLessThan(told.a.records);
    expect(found.a.keyframes).toBeLessThanOrEqual(told.a.keyframes);
    // (Its pairs each tick are the server's pass's among the ships it took, found once a tick but for ticks stepped
    // again: sim/c-contactCache.ts)
    expect(found.pairs.compared).toBeGreaterThan(500);
    expect(found.pairs.with).toBeGreaterThan(50);
    expect(found.pairs.differ).toBe(0);
    expect(found.pairs.once).toBeGreaterThan(found.pairs.ticks * 0.9);
    expect(found.pairs.found).toBeLessThan(found.pairs.ticks * 1.2);
  }, 240_000);

  it('without the cap, the same client is keyframed as before', () => {
    const { a } = fight(BASE);
    expect(a.records).toBe(0);
    expect(a.keyframes).toBeGreaterThan(20);
    expect(a.off).toBe(0);
  }, 120_000);
});
