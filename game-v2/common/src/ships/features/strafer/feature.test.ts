/** The Burst Strafer as a registered part feature (index.ts): its place in the plan, the seam it flies through, its input plumbing */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import { FULL_CHARGE, powerTick } from '../../energy.js';
import { flightSignature, controlBits, flightControls, CTL } from '../../replica.js';
import { buildFlightInputs, newFlightControls } from '../../flightInputs.js';
import { stepFlight, type FlightBody, type FlightControls } from '../../flight.js';
import { INPUT_BOOLS } from '../../../network/inputFields.js';
import { Input } from '../../../ecs/components.js';
import { encodeInputBinary, decodeInputBinary, type ClientInputMessage } from '../../../network/protocol.js';
import { getPlan, compilePlan, setPlanForTests } from '../plan.js';
import { FEATURES } from '../registry.js';
import { DODGE_INPUT } from './index.js';
import { DODGE_LEFT, dodgeLoad } from './strafer.js';
import WIRE from '../features.wire.json' with { type: 'json' };

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const testStrafer = () => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev/test-strafer.json'), 'utf-8')), 0);
const RIGHT_FLANK = { uid: 60, piece: 'sq', fn: 'engine_burst_strafer', material: 'steel', x: 3, y: 0, rot: 0, flip: false, facing: 'E' };
const sparrow = (extra: object[] = []) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};
const NONE: FlightControls = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 };
const body = (o: Partial<FlightBody> = {}): FlightBody => ({ x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0, ...o });
const K = { friction: 0.98, boostFactor: 2.2, worldSize: 1e6 };

afterEach(() => setPlanForTests(null));

describe('the strafer feature (registered)', () => {
  it('is in the plan after the Tow Beam: draws by the tick as an engine, two flight hooks, the dodge input and its pinned slots', () => {
    const P = getPlan(), i = P.byId.get('strafer')!;
    expect(P.byId.get('tow')).toBe(0);
    expect(i).toBe(1);
    expect(P.burstMask & (1 << i)).not.toBe(0);
    // (Its own bits and hooks: a later feature, the Gyro's, has some of its own)
    expect(P.engineMask & (1 << i)).toBe(1 << i);
    expect(P.flightMask & (1 << i)).toBe(1 << i);
    const mine = (l: readonly { feature: number }[]) => l.filter((e) => e.feature === i).map((e) => e.feature);
    expect(mine(P.flight.thrustGate)).toEqual([i]);
    expect(mine(P.flight.impulse)).toEqual([i]);
    expect(mine(P.flight.preJump).length + mine(P.flight.steer).length + mine(P.flight.damp).length).toBe(0);
    expect(P.held).toEqual(['dodge']);
    expect(P.controls).toEqual([{ name: 'dodge', bit: CTL.dodge }]);
    expect(P.flightKeys.length).toBe(1);
    expect(P.replicate.filter((r) => r.feature === 'strafer').map((r) => `${r.where}:${r.name}:${r.slot}`).sort())
      .toEqual(['ctl:dodge:8192', 'keyframe:dodge:16', 'keyframe:dodgeDir:17', 'pilotExtra:dodge:0', 'pilotExtra:dodgeDir:1']);
  });

  it('a ship with strafers has fx.strafe (and no legacy derived.strafe); without the feature in the plan it has neither', () => {
    const d = testStrafer().derived;
    expect(d.fx?.strafe?.parts.length).toBeGreaterThan(0);
    expect('strafe' in d).toBe(false);
    setPlanForTests(compilePlan(FEATURES.filter((f) => f.id !== 'strafer')));
    const bare = testStrafer().derived;
    expect(bare.fx?.strafe).toBeUndefined();
    // (Nor do its parts draw by the tick: no feed group for them)
    expect(d.fx!.strafe!.parts.every((p) => d.power!.feedOf[p.part] >= 0)).toBe(true);
    expect(d.fx!.strafe!.parts.every((p) => bare.power!.feedOf[p.part] < 0)).toBe(true);
  });

  it('Drive Cell banks feed it as they do engines (burst: engine), and Capacitor banks never do', () => {
    const cell = { uid: 62, piece: 'sq', fn: 'power_drive_cell', material: 'steel', x: 3, y: -1, rot: 0, flip: false };
    const cap = { ...cell, fn: 'power_capacitor', material: 'composite' };
    const d = sparrow([RIGHT_FLANK, cell]).derived, c = sparrow([RIGHT_FLANK, cap]).derived;
    const part = d.fx!.strafe!.parts[0].part;
    expect(d.power!.banks[0].kind).toBe('drive');
    expect(d.power!.banks[0].feeds).toEqual([part]);
    expect(c.power!.banks[0].kind).toBe('cap');
    expect(c.power!.banks[0].feeds).toEqual([]);
  });

  it('the flight signature carries its pushes (its flight key) and its feature bit', () => {
    const d = sparrow([RIGHT_FLANK]).derived, s = d.fx!.strafe!;
    expect(flightSignature(d)).toContain(`|${s.ticks},${s.cooldown},${s.parts.map((p) => `${p.push[0]},${p.push[1]}`).join('+')}|fx${1 << getPlan().byId.get('strafer')!}`);
    expect(flightSignature(sparrow().derived).endsWith('|')).toBe(true);
  });

  it('a dodge flies through the hooks: the counter steps, the burst draws (powerTick extra) and pushes', () => {
    const ship = testStrafer(), d = ship.derived;
    const b = body();
    stepFlight(b, { ...NONE, left: true, dodge: true }, d, tuning, { charge: FULL_CHARGE, drainRate: 1 }, K);
    expect(b.dodge).toBe(1);
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(0);
    // (A ship with none winds a counter down: the hook runs for every ship)
    const plain = sparrow().derived, wound = body({ dodge: 5, dodgeDir: DODGE_LEFT });
    stepFlight(wound, NONE, plain, tuning, { charge: FULL_CHARGE, drainRate: 0 }, K);
    expect(wound.dodge).toBeUndefined();
  });

  it('powerTick: a feature\'s extra draw gets its share at its feature number; nothing asked, no extra', () => {
    const d = testStrafer().derived;
    const load = dodgeLoad(d, DODGE_LEFT)!;
    const i = getPlan().byId.get('strafer')!;
    const extra: (ArrayLike<number> | undefined)[] = [];
    extra[i] = load;
    const r = powerTick(d, FULL_CHARGE, { thrusting: false, boosting: false, extra }, tuning);
    expect(r.extra?.[i]).toBeGreaterThan(0);
    expect(r.extra?.[0]).toBeUndefined();
    expect('extra' in powerTick(d, FULL_CHARGE, { thrusting: false, boosting: false }, tuning)).toBe(false);
  });
});

describe('the dodge input, end to end (every held input of the plan)', () => {
  it('is the shared InputDef, its bit pinned in features.wire.json', () => {
    expect(DODGE_INPUT.ctlBit).toBe(CTL.dodge);
    expect(WIRE.ctl.find((c) => c.name === 'dodge')).toEqual({ name: 'dodge', feature: 'strafer', bit: CTL.dodge });
  });

  it('travels: the message (binary flag), the Input component, the controls, the replica bits and back', () => {
    const msg = {
      type: 'input', seq: 1, tick: 0, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false,
      targetAngle: 0, strafeLeft: false, strafeRight: false, helm: false, cursorDist: 0, jump: false,
    } as ClientInputMessage;
    for (const name of getPlan().held) {
      expect(INPUT_BOOLS as readonly string[]).toContain(name);
      expect((Input as unknown as Record<string, unknown>)[name]).toBeDefined();
      for (const on of [true, false]) {
        const back = decodeInputBinary(encodeInputBinary({ ...msg, [name]: on })) as unknown as Record<string, unknown>;
        expect(back[name]).toBe(on);
        const ctl = buildFlightInputs({ ...msg, [name]: on }, false, newFlightControls()) as unknown as Record<string, unknown>;
        expect(ctl[name]).toBe(on);
        const bits = controlBits(ctl as Partial<FlightControls>);
        expect((flightControls({ bits, targetAngle: 0 }, body()) as unknown as Record<string, unknown>)[name]).toBe(on);
      }
    }
    expect(newFlightControls().dodge).toBe(false);
    expect(controlBits({ dodge: true })).toBe(CTL.dodge);
  });

  it('with no feature holding it, the controls carry no dodge and the bits none', () => {
    setPlanForTests(compilePlan([]));
    expect('dodge' in newFlightControls()).toBe(false);
    expect(controlBits({ dodge: true })).toBe(0);
  });
});

describe('no strafer special cases left in the shared call sites', () => {
  it('rebuild, flight, energy, circuits and replica reach it only through the plan', () => {
    const SHIPS = join(__dirname, '../..');
    for (const f of ['rebuild.ts', 'flight.ts', 'energy.ts', 'circuits.ts', 'replica.ts', 'flightInputs.ts']) {
      const src = readFileSync(join(SHIPS, f), 'utf-8');
      expect(src.match(/\.strafe|stepDodge|dodgeLoad|strafeForce|StrafeInfo|strafer\.js'|use\.dodge|pt\.dodge|\.dodge = !!/g), f).toBeNull();
    }
  });
});
