/**
 * Golden flight traces (refactor safety net, Stage 0). Each scripted scenario (golden/testData.ts) is flown through the
 * shared deterministic pilot step: stepShipPhysics inside pilotJumpStep, with the real energy (drainRate 1, the guns'
 * and Tow Beam's load, the tick), exactly as the server and the pilot's prediction call it. The
 * quantised body and charge after every tick are hashed and pinned in flightTraces.golden.json, with the final state
 * written out so a failing pin says where it ended up.
 *
 * Any change to how a ship flies (flight.ts, physics.ts, strafer.ts, tow.ts, load.ts, energy.ts, circuits.ts, the
 * catalog or tuning data) moves a hash. If it was meant to, regenerate: `UPDATE_GOLDEN=1 npx vitest run <this file>`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import { createShipState } from '../state.js';
import { readShipJson, testCatalog } from '../testData.js';
import type { ShipTuning } from '../tuning.js';
import type { FlightBody, FlightControls } from '../flight.js';
import { jumpTuning, jumpBurnAt } from '../flight.js';
import { stepShipPhysics } from '../physics.js';
import { pilotJumpStep, NO_FIELDS } from '../jumpFields.js';
import { FULL_CHARGE, type Charge } from '../energy.js';
import { quantizeCargo } from '../load.js';
import { towLoad, towTuning } from '../features/tow/tow.js';
import { ReplicaMode } from '../replica.js';
import { replicaAngle, quantizeReplicaAngle } from '../../network/replication.js';
import { quantizeCursorDist, CURSOR_DIST_STEP } from '../../network/protocol.js';
import { SCENARIOS, corsair, bodyRow, chargeRow, hashRows, goldenFile, BODY_FIELDS, type Scenario } from './testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const pins = goldenFile<{ ticks: number; trace: string; charge: string; final: Record<string, number> }>(join(__dirname, 'flightTraces.golden.json'));
afterAll(() => pins.save());

/** The controls a tick flies with, as the server has them from the wire (the aim quantised to 13 bits, float32) */
function controlsOf(t: Scenario['script'][number]): FlightControls {
  return {
    forward: false, backward: false, left: false, right: false, boost: false, ...t.keys,
    targetAngle: replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(t.aim)),
    jumpDist: quantizeCursorDist(t.dist ?? 0) * CURSOR_DIST_STEP,
  };
}

const seen = new Map<string, { rows: number[][]; low: number; power: number }>();

function fly(sc: Scenario) {
  const ship = createShipState(catalog, tuning, 1, sc.ship(), 0);
  const d = ship.derived;
  const jt = jumpTuning(tuning);
  const body: FlightBody = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: sc.cargo ?? 0 };
  const towed = sc.tow ? towLoad(createShipState(catalog, tuning, 2, corsair(), 0).derived.mass, Math.max(d.mass, d.fullMass ?? d.mass), towTuning(tuning)) : 0;
  let charge: Charge = FULL_CHARGE;
  let prime = 0;
  const rows: number[][] = [], charges: number[][] = [];
  // (The lowest a strafer's buffer got, as a share of full; and the engines' lowest share of their power)
  let low = 1, power = 1;
  const strafer = d.fx?.strafe?.parts[0]?.part ?? -1;
  sc.script.forEach((t, i) => {
    const tick = i + 1;
    if (sc.tow && i >= sc.tow.from) { ship.tow = 2; body.cargo = quantizeCargo((sc.cargo ?? 0) + towed); }
    let res!: ReturnType<typeof stepShipPhysics>;
    prime = pilotJumpStep(body, prime, NO_FIELDS, tick, d.jumpCooldown || jt.cooldownTicks, jt, (rangeBoost) => {
      res = stepShipPhysics(body, controlsOf(t), d, tuning, { charge, drainRate: 1, tick }, null, rangeBoost, undefined, null);
    });
    charge = res.charge;
    rows.push(bodyRow(body));
    charges.push(chargeRow(charge));
    if (strafer >= 0 && charge.e) low = Math.min(low, charge.e.held[strafer] / d.ports.cap[strafer]);
    power = Math.min(power, res.power);
  });
  const last = rows[rows.length - 1];
  // (Not pinned: what the sanity check below reads)
  seen.set(sc.name, { rows, low, power });
  return {
    ticks: rows.length,
    trace: hashRows(rows),
    charge: hashRows(charges),
    final: Object.fromEntries(BODY_FIELDS.map((k, i) => [k, last[i]])),
  };
}

describe('golden flight traces (the shared pilot step, scripted)', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, () => {
      const a = fly(sc);
      // Deterministic within a run: flown twice, the same to the bit
      expect(fly(sc)).toEqual(a);
      expect(a).toEqual(pins.check(sc.name, a));
    });
  }

  it('the scenarios fly what they are for (dodges every way, a brownout, a tow load, cargo, a jump burn)', () => {
    // Guards against a script quietly flying nothing: the feature each is there for shows up in its trace
    const run = (name: string) => { fly(SCENARIOS.find((s) => s.name === name)!); return seen.get(name)!; };
    const col = (rows: number[][], f: (typeof BODY_FIELDS)[number]) => rows.map((r) => r[BODY_FIELDS.indexOf(f)]);
    const ways = run('strafer-every-way');
    expect(new Set(col(ways.rows, 'dodgeDir')).size).toBeGreaterThan(6);
    expect(run('strafer-energy-short').low).toBeLessThan(0.05);
    if (process.env.TRACE_POWER) for (const s of SCENARIOS) console.log(s.name, run(s.name).power);
    expect(run('plain-thrust-turn').power).toBe(1);
    expect(Math.max(...col(run('tow').rows, 'cargo'))).toBeGreaterThan(0);
    expect(col(run('heavy-cargo').rows, 'cargo').every((c) => c === 6)).toBe(true);
    const jt = jumpTuning(tuning);
    expect(Math.max(...col(run('jump-burn').rows, 'jump'))).toBeGreaterThan(jumpBurnAt(jt) + jt.burnTicks);
    // (The plain run's jump was charged and let go: cancelled, no burn)
    expect(Math.max(...col(run('plain-thrust-turn').rows, 'jump'))).toBeLessThan(jt.chargeTicks);
  });
});
