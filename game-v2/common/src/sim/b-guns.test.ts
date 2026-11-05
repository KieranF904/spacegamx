/**
 * Guns as events (sim foundation 1B, sim/guns.ts): the step's gun phase fires every firing model (clip, charge, beam,
 * spin, a volley) deterministically, PT against ST and re-stepped, states and fire events alike; fire events carry
 * shot ids that are the same however the step is run; and the gun aim on the one aim rule (simAim(q)) is what the
 * server's pilots already fire at (Stage 0 open question 2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState, type ShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { gunDef } from '../ships/launch.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { CTL } from '../ships/replica.js';
import { dequantizeCursorAngle, quantizeCursorAngle } from '../network/cursorState.js';
import { replicaAngle, quantizeReplicaAngle } from '../network/replication.js';
import { ReplicaMode } from '../ships/replica.js';
import {
  newSimShip, simAim, simAimQ, NO_INPUT, shotIdParts, runDeterminism, assertDeterministic, stepShipGuns, GUN_FX, ownShotWire, ownShotWireOf, isOwnShotWire,
  shotId, type SimEnv, type SimInput, type SimShipState, type HarnessScenario, type SimEvent,
} from './index.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/sparrow-t.json'), 'utf-8');
/** The cursor grid's steps (cursorState.ts AIM_BITS = 13) */
const AIM_STEPS = 8191;
const envAt = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null });

/** A Sparrow with one gun of this model where its left Pip was (fireModels.test.ts's rig) */
function armed(model: string, id: number): ShipState {
  const b = parseBlueprint(sparrowText);
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = model;
  pips[1].fn = 'hull';
  delete pips[1].facing;
  return createShipState(catalog, tuning, id, b, 0);
}

/** The first catalogue gun model of each kind the brief names */
function models(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of catalog.functions.values()) {
    if (!m.weapon || !m.fire || tuning.weapons?.[m.weapon]?.pointDefence) continue;
    const f = m.fire;
    const def = gunDef(tuning, m.weapon, { model: m.weaponMods });
    if (!out.clip && f.model === 'clip') out.clip = m.id;
    if (!out.charge && f.model === 'charge') out.charge = m.id;
    if (!out.beam && f.model === 'beam') out.beam = m.id;
    if (!out.spin && f.spin) out.spin = m.id;
    if (!out.volley && (def.burst ?? 1) > 1 && f.model === 'cycle') out.volley = m.id;
  }
  return out;
}

function ship(model: string, id: number, x: number): SimShipState {
  const s = armed(model, id);
  return newSimShip({ id, derived: s.derived, ship: s, body: { x, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: 0 }, charge: FULL_CHARGE, accounted: true });
}

/** Held in bursts, the aim sweeping, now and then let go early (a charge's release) */
const trigger = (k: number, hold = 100) => (t: number): SimInput => ({ ...NO_INPUT, bits: t % 70 < 10 ? CTL.forward : 0, q: simAimQ(-Math.PI / 2 + 0.3 * Math.sin((t + k * 13) / 25)), fire: (t + k * 7) % hold < hold * 0.75, aimDist: 400 + 10 * (t % 30) });
/** A charge gun held long and steady (it charges only while aligned), let go now and then */
const steady = (t: number): SimInput => ({ ...NO_INPUT, q: simAimQ(-Math.PI / 2), fire: t % 240 < 200 && !(t > 100 && t < 112), aimDist: 500 });

describe('guns as events (sim/guns.ts)', () => {
  const kinds = models();

  it('the catalogue has a gun of every firing model the harness runs', () => {
    expect(Object.keys(kinds).sort()).toEqual(['beam', 'charge', 'clip', 'spin', 'volley']);
  });

  it('PT and ST (and re-stepped) agree on every gun state and every fire event: clip, charge, beam, spin, volley', () => {
    const ids = Object.keys(kinds);
    const sc: HarnessScenario = {
      name: 'guns', start: 0, ticks: 600, env: envAt,
      ships: ids.map((k, i) => ({ state: ship(kinds[k], 20 + i, i * 300), input: k === 'charge' ? steady : trigger(i) })),
    };
    const r = runDeterminism(sc, { lag: 5, rollbackEvery: 17, rollbackDepth: 9 });
    assertDeterministic(r);
    // Each gun fired, and the events say what it did
    const fired = new Map<number, number>(), fx = new Map<string, number>();
    for (const evs of r.events.values()) for (const e of evs) {
      if (e.k === 'fire') {
        fired.set(e.owner, (fired.get(e.owner) ?? 0) + 1);
        const p = shotIdParts(e.shot);
        expect(p).toEqual({ tick16: e.tick, owner: e.owner, slot: e.slot, barrel: e.barrel });
      } else if (e.k === 'fx') fx.set(e.fx, (fx.get(e.fx) ?? 0) + 1);
    }
    for (const [i, k] of ids.entries()) if (k !== 'beam') expect(fired.get(20 + i) ?? 0, k).toBeGreaterThan(k === 'charge' ? 0 : 2);
    expect(fx.get(GUN_FX.beam) ?? 0).toBeGreaterThan(10);
    expect(fx.get(GUN_FX.chargeStart) ?? 0).toBeGreaterThan(0);
    // (a volley's barrels: one fire event a shell)
    const v = 20 + ids.indexOf('volley'), burst = gunDef(tuning, armed(kinds.volley, 1).derived.weapons[0].kind, { model: armed(kinds.volley, 1).derived.weapons[0].model }).burst ?? 1;
    const barrels = new Set<number>();
    for (const evs of r.events.values()) for (const e of evs) if (e.k === 'fire' && e.owner === v) barrels.add(e.barrel);
    expect(barrels.size).toBe(Math.round(burst));
  });

  it('no firing mid-jump or under an EMP; the gun state still steps', () => {
    const s = ship(kinds.clip, 5, 0);
    s.hazard.empUntil = 50;
    const ev: SimEvent[] = [];
    for (let t = 1; t < 50; t++) stepShipGuns(s, { ...NO_INPUT, fire: true, q: simAimQ(-Math.PI / 2) }, envAt(t), ev);
    expect(ev.filter((e) => e.k === 'fire')).toHaveLength(0);
    stepShipGuns(s, { ...NO_INPUT, fire: true, q: simAimQ(-Math.PI / 2) }, envAt(50), ev);
    expect(ev.filter((e) => e.k === 'fire').length).toBeGreaterThan(0);
  });

  it("own shells' wire names: the shot id without its owner, clear of entity ids, collision-free within 2^16 ticks", () => {
    const seen = new Set<number>();
    for (const t of [0, 1, 65535]) for (const slot of [0, 7, 255]) for (const b of [0, 31]) {
      const w = ownShotWire(t, slot, b);
      expect(isOwnShotWire(w)).toBe(true);
      expect(w).toBeLessThan(2 ** 31);
      expect(ownShotWireOf(shotId(12345, t, slot, b))).toBe(w);
      expect(seen.has(w)).toBe(false);
      seen.add(w);
    }
    expect(ownShotWire(65536 + 3, 1, 2)).toBe(ownShotWire(3, 1, 2));
    expect(isOwnShotWire(0x3fffffff)).toBe(false);
  });

  it('the gun aim on simAim(q) is what the server fires at: every grid aim, off the wire, is simAim(q) to the bit (open question 2)', () => {
    const f32 = new Float32Array(1);
    let n = 0;
    for (let q = 0; q <= AIM_STEPS; q++) {
      n++;
      // The server's pilot: Input.targetAngle (a Float32Array) = replicaAngle(Player, quantizeReplicaAngle(msg.targetAngle)),
      // msg.targetAngle off a compact input being fround(dequantizeCursorAngle(q)) and off a JSON one the client's dequantized aim
      for (const sent of [Math.fround(dequantizeCursorAngle(q)), dequantizeCursorAngle(q)]) {
        f32[0] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(sent));
        // (the grid's last step is 2π: the server's re-quantise wraps it to 0, so a step's q must be the server's, simAimQ of what it fires at)
        const canon = q === AIM_STEPS ? 0 : q;
        expect(f32[0]).toBe(simAim(canon));
        expect(simAimQ(f32[0])).toBe(canon);
      }
    }
    expect(n).toBe(AIM_STEPS + 1);
  });
});
