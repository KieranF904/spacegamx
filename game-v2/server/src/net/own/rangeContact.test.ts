/**
 * Its own ship flown into a pinned giant (Enemies.spawnTarget, 100+ parts, then pinned here as the old weapons range's
 * dummies were; siege structures, nests, caches and fixed bosses still are),
 * with its inputs going ahead of the snapshots as a real client's do (it predicts LEAD ticks past the newest one).
 *
 * A pinned ship's first shipSync says so (`pinned`, client ShipStore.pinned), so the client's own contact pass takes it
 * as the server's does (it doesn't give), worked out on the tick layer with the real part geometry: no records. Past the
 * newest snapshot (the prediction, what is drawn) nothing was told yet: the own layer predicts the contact itself
 * (OwnTick.predictAhead), from the same contact maths against the other's last known state (a pinned one's however
 * old: it stays put), so the ship drawn stops at the hull instead of sinking into it until the snapshot comes. Where it
 * predicts right, the snapshot confirms it to the bit: against a pinned hull, from the very first touch.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, encodeMessage, decodeMessage, type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** Ticks its inputs go ahead of the server's (its prediction's lead) */
const LEAD = 8;

function ram(o: { giant: string; own: string; angle: number; offset: number; moving?: boolean }) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'range', env });
  const truth = new Map<number, number[]>();
  const got = { checked: 0, off: 0, keyframes: 0 };
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void };
  const oSnap = fa.snapshot.bind(A);
  fa.snapshot = (s) => {
    oSnap(s);
    if (s.ships?.some((k) => k[0] === A.pid)) got.keyframes++;
    // (Held against the server's ship once that tick's truth is noted: a snapshot can come inside the step that ends it)
    const st = A.reps.at(A.pid, s.tick)?.body;
    if (A.own.on && st) snaps.push([s.tick, st.x, st.y, st.vx, st.vy]);
  };
  const snaps: number[][] = [];
  const held = () => {
    for (const [t, x, y, vx, vy] of snaps) {
      const r = truth.get(t);
      if (!r) continue;
      got.checked++;
      if (x !== r[0] || y !== r[1] || vx !== r[2] || vy !== r[3]) got.off++;
    }
  };
  let seq = 1, fwd = false;
  let chk: ReturnType<FakeHitsClient['own']['takeCheck']>;
  /** Its predicted ship at each tick, as it was when first drawn */
  const drawn = new Map<number, number[]>();
  const step = () => {
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + LEAD, forward: fwd, backward: false, left: false, right: false, boost: false,
      fireLeft: false, fireRight: false, targetAngle: 0, cursorDist: 700, ...(chk ? { ownCheck: chk } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
    server.step();
    truth.set(server.getTick(), [Position.x[A.pid], Position.y[A.pid], Velocity.x[A.pid], Velocity.y[A.pid], Rotation.angle[A.pid]]);
    clock.t += 1000 / 60;
    chk = A.own.takeCheck(true, server.getTick());
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    // (Drawn: its ship stepped as far as its inputs go)
    const p = server.getTick() + LEAD - 1, b = A.reps.at(A.pid, p)?.body;
    if (b && !drawn.has(p)) drawn.set(p, [b.x, b.y]);
  };
  for (let i = 0; i < 20; i++) step();
  { const c = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get(o.own)!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  const en = server.enemies as unknown as { spawnTarget(n: number, t: object, x: number, y: number, a: number): number };
  // (Straight ahead of it: it flies north, the dummy's hull turned by `angle`)
  const g = en.spawnTarget(num, { ship: o.giant, faction: 'pirates' }, x0 + o.offset, y0 - 750, o.angle);
  // (Pinned, or let fly: a slow sweep across its spot)
  if (o.moving) ships.setAutopilot(g, { x: x0 + o.offset + 300, y: y0 - 750, arriveRadius: 60 });
  else ships.pin(g);
  for (let i = 0; i < 40; i++) step();
  fwd = true;
  // How far its drawn ship was from where the server had it on that tick, and how deep into the hull
  let worst = 0, missed = 0, compared = 0;
  const from = server.getTick() + LEAD;
  for (let i = 0; i < 360; i++) step();
  for (const [t, d] of drawn) {
    const r = truth.get(t);
    if (t < from || !r) continue;
    compared++;
    const e = Math.hypot(d[0] - r[0], d[1] - r[1]);
    if (e > 0.01) missed++;
    worst = Math.max(worst, e);
  }
  held();
  return { server, A, got, worst, missed, compared, touched: server.replication.ownStats.contact, dist: Math.hypot(Position.x[g] - Position.x[A.pid], Position.y[g] - Position.y[A.pid]) };
}

describe('its own ship against a pinned range dummy (the weapons range)', () => {
  for (const [giant, angle, offset] of [['giant_mammoth', 0.3, 0], ['giant_ironmonger', 1.1, -120], ['giant_pilgrim', 2.2, 150], ['giant_rimeback', -0.7, 0]] as const) {
    it(`${giant}: the tick layer exact, and its drawn ship stops at the hull (predicted from the real parts)`, () => {
      const r = ram({ giant, own: 'sparrow-t', angle, offset });
      if (process.env.OWN_DEBUG) console.log(giant, JSON.stringify({ got: r.got, worst: r.worst, missed: r.missed, compared: r.compared, touched: r.touched, dist: r.dist }));
      expect(r.touched).toBeGreaterThan(50);
      // (the tick layer: the server's ship to the bit at every snapshot, no keyframe of it past its first)
      expect(r.got.checked).toBeGreaterThan(50);
      expect(r.got.off).toBe(0);
      // (the prediction: pressing on into the hull, its ship drawn where the server then had it on every tick, the first
      // touch included: it knows the dummy is pinned from its sync. Without it, drawn as far as 50-130 units into the
      // hull, most ticks off; learning it at the first touch, that touch off by up to 11)
      expect(r.compared).toBeGreaterThan(300);
      expect(r.missed).toBe(0);
      expect(r.worst).toBe(0);
    }, 120_000);
  }

  it('a big ship of its own (the Hauler, 105 parts) into a giant, and into one sweeping (moving targets, not pinned)', () => {
    for (const moving of [false, true]) {
      const r = ram({ giant: 'giant_mammoth', own: 'hauler', angle: 0.3, offset: 0, moving });
      if (process.env.OWN_DEBUG) console.log('hauler', moving, JSON.stringify({ got: r.got, worst: r.worst, missed: r.missed, compared: r.compared, touched: r.touched, dist: r.dist }));
      expect(r.touched).toBeGreaterThan(20);
      expect(r.got.off).toBe(0);
      expect(r.worst).toBeLessThan(moving ? 15 : 6);
    }
  }, 240_000);
});
