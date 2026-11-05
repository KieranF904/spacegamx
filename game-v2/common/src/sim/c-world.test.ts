/**
 * Stage 1C: the contact pairs found once per tick (ContactPairCache) and pulls applied in the step (PullSource), PT
 * against ST through the determinism harness, and the pair cache's count: each tick's pairs found once, the same on
 * a "server" stepping in place and a "client" re-stepping from its ring.
 */

import { describe, it, expect } from 'vitest';
import { createShipState } from '../ships/state.js';
import { testCatalog, readShipJson } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { CTL } from '../ships/replica.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { corsair } from '../ships/golden/testData.js';
import { dhypot, datan2 } from '../math/detTrig.js';
import type { ContactEntry } from '../ships/contactPass.js';
import {
  newSimShip, simAimQ, NO_INPUT, runDeterminism, assertDeterministic, stepShip, StateRing, cloneSimShip, shipHash,
  type SimEnv, type SimShipState, type HarnessScenario, type HarnessTick, type SimInput,
} from './index.js';
import { ContactPairCache, contactPairs, type ContactPair } from './c-contactCache.js';
import { PullLog, PullFields, pullSources, starPull } from './c-pulls.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');

const N = 14;
const CENTRE = { x: 0, y: 0 };

function ship(id: number): SimShipState {
  const s = createShipState(catalog, tuning, id, corsair(), 0);
  // (A ring round the centre, each flying in: they meet and push each other about)
  const a = (id / N) * Math.PI * 2;
  const r = 600 + (id % 3) * 90;
  return newSimShip({ id, derived: s.derived, ship: s, body: { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, angle: a + Math.PI, angVel: 0, jump: 0, cargo: 0 }, charge: FULL_CHARGE });
}

/** Thrust toward the centre for a while, then coast and turn */
function input(id: number): (t: number) => SimInput {
  const s = ship(id);
  const aim = datan2(CENTRE.y - s.body.y, CENTRE.x - s.body.x);
  return (t) => (t < 70 ? { ...NO_INPUT, bits: CTL.forward, q: simAimQ(aim) } : { ...NO_INPUT, q: simAimQ(aim + t / 40) });
}

/** A pulls source both runs read alike: a star held at a point for a while, and a puller's logged tugs on two ships */
function pulls(): { log: PullLog; fields: PullFields } {
  const log = new PullLog();
  for (let t = 20; t < 160; t += 3) { log.add(t, 2, 99, 0.031, -0.017); log.add(t, 2, 50, -0.002, 0.004); log.add(t, 5, 99, -0.02, 0.01); }
  const fields = new PullFields();
  for (let t = 40; t <= 140; t++) fields.set(t, [{ from: 77, x: 300, y: -250, radius: 900, strength: 0.05 }]);
  return { log, fields };
}

/** The bodies a contact pass takes (sorted by id) */
function entries(states: ReadonlyMap<number, SimShipState>): ContactEntry[] {
  return [...states.values()].sort((a, b) => a.id - b.id).map((s) => ({ id: s.id, x: s.body.x, y: s.body.y, r: s.structure.derived.radius }));
}

/** A stand-in pair resolution (circles: push apart, swap the closing speed): deterministic in what it's given */
function resolve(pairs: readonly ContactPair[], states: Map<number, SimShipState>): number {
  let touched = 0;
  for (const [a, b] of pairs) {
    const A = states.get(a)!.body, B = states.get(b)!.body;
    const ra = states.get(a)!.structure.derived.radius, rb = states.get(b)!.structure.derived.radius;
    const dx = B.x - A.x, dy = B.y - A.y, d = dhypot(dx, dy), over = ra + rb - d;
    if (over <= 0 || d < 1e-6) continue;
    touched++;
    const nx = dx / d, ny = dy / d;
    A.x -= nx * over * 0.5; A.y -= ny * over * 0.5; B.x += nx * over * 0.5; B.y += ny * over * 0.5;
    const closing = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny;
    if (closing > 0) { A.vx -= nx * closing; A.vy -= ny * closing; B.vx += nx * closing; B.vy += ny * closing; }
  }
  return touched;
}

describe('contact pairs and pulls in the shared step (Stage 1C)', () => {
  it('PT and ST agree to the bit with a contact phase on cached pairs and pulls from a log and a field', () => {
    const { log, fields } = pulls();
    const src = pullSources(log, fields);
    const env = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null, pulls: src });
    let touched = 0;
    const sc: HarnessScenario = {
      name: 'c-world', start: 0, ticks: 200, env,
      ships: Array.from({ length: N }, (_, i) => ({ state: ship(i + 1), input: input(i + 1) })),
      phases: {
        contacts: (c: HarnessTick) => { touched += resolve(contactPairs(entries(c.states)), c.states); },
      },
    };
    const r = runDeterminism(sc, { lag: 5, rollbackEvery: 6, rollbackDepth: 7 });
    assertDeterministic(r);
    const evs = [...r.events.values()].flat();
    // (Pulls acted, from both sources, and as events; the ships met)
    expect(evs.filter((e) => e.k === 'pull' && e.from === 99).length).toBeGreaterThan(40);
    expect(evs.filter((e) => e.k === 'pull' && e.from === 77).length).toBeGreaterThan(20);
    expect(touched).toBeGreaterThan(20);
  });

  it('a ship\'s pulls come by puller id, a puller\'s own in the order made; a star pulls by where the ship is', () => {
    const { log, fields } = pulls();
    expect(log.on(2, 20, CENTRE).map((p) => p[0])).toEqual([50, 99]);
    const at = { x: 100, y: 0 };
    expect(fields.on(1, 50, at)).toEqual([[77, ...starPull({ from: 77, x: 300, y: -250, radius: 900, strength: 0.05 }, at.x, at.y)!]]);
    expect(pullSources(log, fields).on(2, 41, at).map((p) => p[0])).toEqual([50, 77, 99]);
    expect(fields.on(77, 50, at)).toEqual([]);
  });

  it('each tick\'s pairs are found once, read by every reader of the tick, and are the server\'s', () => {
    // The "server": every ship stepped in place, the pass's pairs found once a tick
    const serverStates = new Map(Array.from({ length: N }, (_, i) => [i + 1, ship(i + 1)] as const));
    const inputs = new Map(Array.from({ length: N }, (_, i) => [i + 1, input(i + 1)] as const));
    const env = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null });
    let serverNow = serverStates;
    const server = new ContactPairCache(() => contactPairs(entries(serverNow)));
    const serverPairs = new Map<number, string>();
    // The "client": steps each tick from its ring, re-steps the last few now and then (a late row), as a tick layer does
    const ring = new StateRing(64);
    for (const s of serverStates.values()) ring.put(0, s);
    let clientNow = new Map<number, SimShipState>();
    const client = new ContactPairCache(() => contactPairs(entries(clientNow)));
    const clientTick = (t: number) => {
      clientNow = new Map();
      for (const id of inputs.keys()) clientNow.set(id, stepShip(ring.get(id, t - 1)!, inputs.get(id)!(t), env(t)).state);
      // (Two readers of the tick: the pass, and a ship's causes asking whether it took part)
      const pairs = client.pairs(t);
      client.pairs(t).some(([a]) => a === 1);
      resolve(pairs, clientNow);
      for (const s of clientNow.values()) ring.put(t, s);
      return pairs;
    };
    let restepped = 0;
    for (let t = 1; t <= 180; t++) {
      for (const [id, s] of serverStates) stepShip(s, inputs.get(id)!(t), env(t), s);
      serverNow = serverStates;
      const sp = server.pairs(t);
      resolve(sp, serverStates);
      serverPairs.set(t, JSON.stringify(sp));
      expect(JSON.stringify(clientTick(t))).toBe(serverPairs.get(t));
      if (t % 9 === 0) {
        // (Stepped again from t - 4: those ticks' pairs dropped and found again, the same)
        const from = t - 4;
        for (const id of inputs.keys()) ring.dropFrom(id, from);
        client.dropFrom(from);
        for (let u = from; u <= t; u++) { expect(JSON.stringify(clientTick(u))).toBe(serverPairs.get(u)); restepped++; }
      }
    }
    // Server: once a tick. Client: once a tick, plus once more for each tick it stepped again, and never otherwise
    expect([...server.finds.values()].every((n) => n === 1)).toBe(true);
    expect(server.stats.found).toBe(180);
    expect(client.stats.found).toBe(180 + restepped);
    expect(client.stats.read).toBe(180 + restepped);
    const twice = [...client.finds.values()].filter((n) => n === 2).length;
    expect(twice).toBe(restepped);
    // (They met: there were pairs to find, and both ends stepped the same ships)
    expect([...serverPairs.values()].some((p) => p !== '[]')).toBe(true);
    for (const [id, s] of serverStates) expect(shipHash(ring.get(id, 180)!)).toBe(shipHash(cloneSimShip(s)));
  });
});
