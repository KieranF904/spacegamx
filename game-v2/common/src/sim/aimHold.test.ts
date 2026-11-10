/**
 * The held aim angle (sim/aimHold.ts): a pilot stepped on its raw aims, the same pilot with the rule working out its
 * applied aims beside them, and a copy flown on those applied aims alone (what every replica, shadow and gun lane
 * flies) go exactly the same way, bit for bit: pose, velocity, jump, stores, gun state and every fire event. Idle
 * turrets' look is the one thing a copy may draw otherwise (drawing only: the lanes' hash leaves it out too).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState, type ShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { cloneCharge } from './state.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { CTL } from '../ships/replica.js';
import { gunDef } from '../ships/launch.js';
import { stepFlight, type FlightBody, type FlightControls } from '../ships/flight.js';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';
import { newSimShip, simAim, simAimQ, NO_INPUT, stepShip, appliedAimQ, type SimEnv, type SimInput, type SimShipState, type SimEvent } from './index.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const fixture = (n: string) => readFileSync(join(SHIP_DATA_DIR, `blueprints/${n}.json`), 'utf-8');
const envAt = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null });
const K = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };

/** A Sparrow with one gun of this model where its left Pip was (b-guns.test.ts's rig) */
function armed(model: string): () => ShipState {
  return () => {
    const b = parseBlueprint(fixture('sparrow-t'));
    const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
    pips[0].fn = model;
    pips[1].fn = 'hull';
    delete pips[1].facing;
    return createShipState(catalog, tuning, 7, b, 0);
  };
}
const plain = (name: string) => () => createShipState(catalog, tuning, 7, parseBlueprint(fixture(name)), 0);

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
    if (!out.semi && f.semi) out.semi = m.id;
    if (!out.volley && (def.burst ?? 1) > 1 && f.model === 'cycle') out.volley = m.id;
  }
  return out;
}

function sim(make: () => ShipState): SimShipState {
  const s = make();
  return newSimShip({ id: 7, derived: s.derived, ship: s, body: { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, cargo: 0 }, charge: FULL_CHARGE, accounted: true });
}

/** What a tick did, as compared: the body, the stores, the gun state (idle aims left out where asked), the events */
function dump(s: SimShipState, ev: readonly SimEvent[], idleAims: boolean): string {
  const g = s.guns;
  const guns = { ...g, aim: idleAims || g.triggerHeld ? g.aim : undefined };
  return JSON.stringify({ body: s.body, charge: s.charge, jumpPrime: s.jumpPrime, guns, bits: s.ctl.bits, ev });
}

interface Run { held: number; moved: number; ticks: number }

/**
 * The three runs over `ticks` ticks of `script`: raw (no rule), the rule (its applied aims), and a copy flown on the
 * applied aims alone. Everything compared every tick
 */
function trio(make: () => ShipState, script: (t: number) => SimInput, ticks = 600): Run {
  const raw = sim(make), rule = sim(make), copy = sim(make);
  let held = 0, moved = 0, last: number | undefined;
  for (let t = 1; t <= ticks; t++) {
    const input = script(t);
    const er: SimEvent[] = [], eh: SimEvent[] = [], ec: SimEvent[] = [];
    stepShip(raw, input, envAt(t), raw, er);
    stepShip(rule, { ...input, heldQ: last }, envAt(t), rule, eh);
    const applied = rule.ctl.q;
    if (last !== undefined && input.q !== last) { moved++; if (applied === last) held++; }
    // (Taken, it's the raw aim; held, the last one)
    expect(applied === input.q || applied === last, `tick ${t}`).toBe(true);
    last = applied;
    stepShip(copy, { ...input, q: applied }, envAt(t), copy, ec);
    // The rule flies the raw aim; the copy on the applied aims goes exactly where it did
    expect(dump(rule, eh, true), `rule, tick ${t}`).toBe(dump(raw, er, true));
    expect(dump(copy, ec, false), `copy, tick ${t}`).toBe(dump(raw, er, false));
  }
  return { held, moved, ticks };
}

const sweep = (rate: number, from = -Math.PI / 2) => (t: number) => simAimQ(from + rate * t);
/** A mouse that jumps to a new mark every 90 ticks and jitters about it */
const marks = (t: number) => simAimQ([0.3, 2.4, -1.2, 1.0, -2.8, 0.1][Math.floor(t / 90) % 6] + 0.004 * Math.sin(t * 1.7));

describe('the held aim angle (sim/aimHold.ts)', () => {
  const kinds = models();

  it('flight: flat-out turns, spin-up and braking, the ease-in, helm, boost and thrust: the copy flies the raw path', () => {
    const scripts: [string, (t: number) => SimInput, number][] = [
      // (the mouse swinging round faster than the ship can follow (its spin tops out at 0.1 a tick): flat out the whole way)
      ['flat out', (t) => ({ ...NO_INPUT, q: sweep(0.15)(t), bits: t % 50 < 30 ? CTL.forward : 0 }), 0.8],
      // (a little slower than its top spin: it catches up and tracks, eased in, the aim read every tick)
      ['tracking', (t) => ({ ...NO_INPUT, q: sweep(0.09)(t) }), 0],
      // (marks: spin up, brake, ease in, settle, jitter)
      ['marks', (t) => ({ ...NO_INPUT, q: marks(t), bits: t % 120 < 60 ? CTL.forward | CTL.boost : CTL.left }), 0.15],
      // (at the helm the aim steers nothing: every move held)
      ['helm', (t) => ({ ...NO_INPUT, q: sweep(0.05)(t), bits: CTL.helm | (t % 80 < 40 ? CTL.right : CTL.forward) }), 0.999],
      // (the nose frame: both strafes held, thrust along the nose)
      ['nose frame', (t) => ({ ...NO_INPUT, q: sweep(0.03)(t), bits: CTL.strafeLeft | CTL.strafeRight | CTL.forward }), 0],
      // (nobody flying: the heading held whatever the aim)
      ['hold', (t) => ({ ...NO_INPUT, q: sweep(0.05)(t), bits: CTL.hold }), 0.999],
    ];
    for (const make of [plain('sparrow-t'), plain('bulwark'), plain('ark-tender')]) for (const [name, script, share] of scripts) {
      const r = trio(make, script);
      expect(r.moved, name).toBeGreaterThan(100);
      expect(r.held / r.moved, name).toBeGreaterThanOrEqual(share);
    }
  });

  it('jumps: the charge waiting on the nose, the burn along the aim, the cooldown: the copy jumps exactly as the raw ship', () => {
    const make = plain('sparrow-t');
    // (the aim drifting near the nose and away while it charges, then the burn and cooldown, then another)
    const r = trio(make, (t) => ({ ...NO_INPUT, q: simAimQ(-Math.PI / 2 + 0.04 * Math.sin(t / 9) + (t > 400 ? 1.5 : 0)), bits: (t % 400) < 300 ? CTL.jump : 0, jumpDist: 2500 }), 900);
    expect(r.moved).toBeGreaterThan(100);
    const s = sim(make);
    let burned = false;
    for (let t = 1; t <= 300; t++) { stepShip(s, { ...NO_INPUT, q: simAimQ(-Math.PI / 2), bits: CTL.jump, jumpDist: 2500 }, envAt(t), s, []); if ((s.body.jump ?? 0) > 200) burned = true; }
    expect(burned, 'the rig jumps').toBe(true);
  });

  it('guns: turrets slewing and pointed, fixed guns\' gimbals, every firing model, clicks: every shot and the gun state the same', () => {
    const fire = (t: number) => (t % 110 < 70) && !(t % 37 === 0);
    const rigs: [string, () => ShipState][] = [['bulwark', plain('bulwark')], ['sparrow', plain('sparrow-t')], ['ark-tender', plain('ark-tender')], ...Object.entries(kinds).map(([k, m]) => [k, armed(m)] as [string, () => ShipState])];
    for (const [name, make] of rigs) {
      for (const q of [sweep(0.02), sweep(0.2), marks]) {
        const r = trio(make, (t) => ({ ...NO_INPUT, q: q(t), bits: t % 90 < 45 ? CTL.forward : CTL.helm | CTL.right, fire: name === 'semi' ? t % 23 < 2 : fire(t), aimDist: 300 + 5 * (t % 60) }));
        expect(r.moved, name).toBeGreaterThan(50);
      }
    }
    expect(Object.keys(kinds).sort()).toEqual(['beam', 'charge', 'clip', 'semi', 'spin', 'volley']);
  });

  it('the applied aim: the held one only where the step would do the same on it', () => {
    expect(appliedAimQ(10, 9, true, true)).toBe(9);
    expect(appliedAimQ(10, 9, false, true)).toBe(10);
    expect(appliedAimQ(10, 9, true, false)).toBe(10);
    expect(appliedAimQ(10, undefined, true, true)).toBe(10);
  });

  it('stepFlight: heldAngle changes nothing it does, and says whether flying it would have', () => {
    const s = createShipState(catalog, tuning, 1, parseBlueprint(fixture('sparrow-t')), 0);
    let agree = 0, n = 0;
    for (let i = 0; i < 400; i++) {
      const a = Math.sin(i * 12.9898) * 3, h = a + Math.sin(i * 78.233) * (i % 4 === 0 ? 0.002 : 1.5);
      const body = (): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: Math.sin(i * 3.1) * 3, angVel: Math.sin(i * 1.3) * 0.08, jump: 0 });
      const c = (angle: number, held?: number): FlightControls => ({ forward: i % 3 === 0, backward: false, left: false, right: false, boost: false, targetAngle: simAim(simAimQ(angle)), heldAngle: held === undefined ? undefined : simAim(simAimQ(held)) });
      const b1 = body(), b2 = body(), b3 = body();
      const r1 = stepFlight(b1, c(a), s.derived, tuning, { charge: cloneCharge(FULL_CHARGE), drainRate: 0 }, K);
      const r2 = stepFlight(b2, c(a, h), s.derived, tuning, { charge: cloneCharge(FULL_CHARGE), drainRate: 0 }, K);
      stepFlight(b3, c(h), s.derived, tuning, { charge: cloneCharge(FULL_CHARGE), drainRate: 0 }, K);
      expect(b2).toEqual(b1);
      expect(r1.aimHeld).toBe(true);
      n++;
      if (r2.aimHeld) { agree++; expect(b3).toEqual(b1); }
    }
    expect(agree).toBeGreaterThan(n * 0.1);
    expect(agree).toBeLessThan(n);
  });
});
