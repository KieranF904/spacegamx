/**
 * The PT layer's contact pass (client predict/contacts.ts RealContacts, C3) against the server's: a pack of dummies
 * pushed into each other by their autopilots, a client (FakeHitsClient: the game client's tick layer) holding them.
 * A PT layer started from the client's ST and then stepped on its own, every ship with the controls it really flew
 * (perfect inputs: the PT step with nothing mispredicted), must hold every ship exactly as the server does through
 * every contact; the same layer without contacts can't. The tick's pairs are found once a tick.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { readFileSync } from 'fs';
import { Position, Velocity, Rotation, InSystem, type ReplicaEnv, type ReplicaState } from '@space-game/common';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { PtStLayer } from '../../../../client/src/predict/ptst.js';
import { ReplicaPtWorld, type PtHost } from '../../../../client/src/predict/world.js';
import { makeEmptyServer } from '../../testkits/world.testkit.js';

/** The shared config is frozen: this test changes the collision tuning, so it gets its own copy of that part */
const withTuning = (cfg: ReturnType<typeof loadShipConfigCached>) => ({ ...cfg, tuning: { ...cfg.tuning } });

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

function pack() {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeEmptyServer({
    gameData: new GameData(files),
    ships: createShipBridge(withTuning(loadShipConfigCached(dataDir))),
    clock: () => clock.t,
  });
  const ships = server.getShips();
  // (No contact damage: a part lost is a rebuild, which the PT layer doesn't predict; the push is what's tested)
  ships.tuning.collision = { ...ships.tuning.collision, minDamageSpeed: Infinity };
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'pt', env });
  for (let i = 0; i < 30; i++) { server.step(); clock.t += 1000 / 60; }
  const sys = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  const bp = (n: string) => ships.library.get(n) ?? JSON.parse(readFileSync(join(dataDir, 'ships/blueprints', n + '.json'), 'utf8'));
  const dummies: number[] = [];
  for (let i = 0; i < 6; i++) {
    const d = ships.spawnDummy(bp('sparrow-t'), x0 + 900 + (i % 3) * 30, y0 - 200 + Math.floor(i / 3) * 400, i * 0.9, sys);
    ships.setAutopilot(d, { x: x0 + 930, y: y0, arriveRadius: 10 });
    dummies.push(d);
  }
  const ours = new Set([A.pid, ...dummies]);
  const clearAbout = () => { for (const [eid, s] of ships.bodies) if (!ours.has(eid) && s.kind === 'ship' && InSystem.systemId[eid] === sys) ships.removeShip(eid); };
  clearAbout();
  const truth = new Map<number, Map<number, number[]>>();
  const record = () => {
    const m = new Map<number, number[]>();
    for (const [eid] of ships.bodies) m.set(eid, [Position.x[eid], Position.y[eid], Velocity.x[eid], Velocity.y[eid], Rotation.angle[eid]]);
    truth.set(server.getTick(), m);
    truth.delete(server.getTick() - 64);
  };
  const host: PtHost = {
    reps: A.reps, store: A.store, bodies: A.bodies, tuning: A.store.tuning,
    self: () => A.pid, confirmed: () => A.snapTick, predicted: () => A.snapTick, candidates: () => A.reps.ids(),
  };
  // (Perfect inputs: each ship stepped with the controls it flew on that tick, as the client's ST has them)
  const perfect = (w: ReplicaPtWorld) => {
    w.step = (id: number, prev: ReplicaState, t: number) => { const s = A.reps.at(id, t); return s ? A.reps.stepAlone(id, prev, t, s.bits, s.q) : null; };
    return w;
  };
  const withC = perfect(new ReplicaPtWorld(host)), without = perfect(new ReplicaPtWorld(host));
  (without as { contacts?: unknown }).contacts = undefined;
  const layers = [new PtStLayer(withC, { touch: true, now: () => 0 }), new PtStLayer(without, { touch: true, now: () => 0 })];
  const seen = layers.map(() => ({ checked: 0, off: 0, offTicks: new Set<number>() }));
  const done = layers.map(() => -Infinity);
  for (let i = 0; i < 600; i++) {
    const t = server.getTick();
    if (t % 90 === 0) for (const [k, d] of dummies.entries()) if (ships.has(d)) ships.setAutopilot(d, { x: x0 + 930 + (k % 2 ? 300 : -300) * Math.sign(Math.sin(t / 90)), y: y0, arriveRadius: 10 });
    clearAbout();
    server.step();
    clock.t += 1000 / 60;
    record();
    if (i < 120 || A.snapTick <= 0) continue;
    layers.forEach((l, j) => {
      // (Started from ST once, then on its own: never checked against ST, so never re-stepped from it)
      if (l.confirmed === -Infinity) { l.confirm(A.snapTick); done[j] = A.snapTick; }
      l.advance(A.snapTick);
      for (let k = done[j] + 1; k <= l.head; k++) {
        for (const id of dummies) {
          const s = l.ring.get(id, k)?.body, r = truth.get(k)?.get(id);
          if (!s || !r) continue;
          seen[j].checked++;
          if (s.x !== r[0] || s.y !== r[1] || s.vx !== r[2] || s.vy !== r[3] || s.angle !== r[4]) { if (process.env.CONTACTS_DEBUG && j === 0 && seen[j].off < 3) console.log('OFF', k, id, [s.x - r[0], s.y - r[1], s.vx - r[2], s.vy - r[3], s.angle - r[4]], 'st', A.reps.at(id, k)?.body.x === r[0], 'hp', ships.get(id)?.rebuilds, 'evs', JSON.stringify(l['register'].get(k))); seen[j].off++; seen[j].offTicks.add(k); }
        }
      }
      done[j] = l.head;
    });
  }
  const finds = [...withC.contacts.cache.finds.values()];
  return { seen, stats: layers.map((l) => ({ ...l.stats })), pass: { ...withC.contacts.stats }, finds };
}

describe('PT contacts (C3) against the server\'s', () => {
  it('perfect inputs and the real contact pass: every ship exactly the server\'s through every contact; pairs found once a tick', () => {
    const { seen, stats, pass, finds } = pack();
    if (process.env.CONTACTS_DEBUG) console.log('PTCONTACTS', JSON.stringify({ seen: seen.map((s) => ({ ...s, offTicks: [...s.offTicks].slice(0, 10) })), stats, pass }));
    // (The pack ground together: many contacts on the PT layer)
    expect(stats[0].contacts).toBeGreaterThan(100);
    expect(seen[0].checked).toBeGreaterThan(2000);
    expect(seen[0].off).toBe(0);
    // Without the pass the same layer drifts off at the first contact: the test has teeth
    expect(seen[1].off).toBeGreaterThan(100);
    // (Each tick's pairs worked out once: the PT layer never re-stepped here)
    expect(finds.length).toBeGreaterThan(300);
    expect(finds.every((n) => n === 1)).toBe(true);
    expect(pass.touched).toBe(stats[0].contacts);
  }, 120_000);
});
