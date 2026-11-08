/**
 * Prediction parity harness (refactor safety net, Stage 0). The same scripted pilot (common/src/ships/golden/
 * testData.ts) is flown three ways, and the quantised bodies must agree tick by tick:
 *
 *   server   a full GameServer: inputs through LocalTransport (the real encode/decode and input handler), the
 *            server's tick (ShipBridge's flight step, Towing, cargo, energy), read back from the ECS and the ShipState
 *   client   the pilot's own ship on its tick layer: its whole step (common sim/ownStep.ts stepOwnShip, what
 *            client OwnTick.step runs for every tick, guns included), the input as Game.ts builds it (the aim
 *            quantised and dequantised, the cursor distance in steps), from the server's starting state and charge,
 *            told the hold's mass, the tow and the slowed ticks as the server tells them
 *   replica  replicaStep on the control bits (the server's shadow, what clients replay), keyframed through
 *            packKeyframe/unpackKeyframe; where it leaves the real path (full charge, no tick, cargo changes, a jump's
 *            distance) it is re-keyframed, and those ticks are pinned in parity.golden.json
 *
 * Plus snapshot replays: a client reconciling from the server's state mid-scenario (mid-burst for the strafer
 * scripts) and a replica keyframed there both land on the server's states to the end. And the correction: a client
 * whose guns went wrong (a lost input) finds it by the full-state hash (sim/headHash.ts ownStateHash) and is put right
 * exactly by the server's ownSync, stepping on from it on the server's numbers.
 *
 * Regenerate the keyframe pins deliberately with `UPDATE_GOLDEN=1 npx vitest run server/src/golden/parity.test.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, createShipState, flightSignature, controlBits, replicaStep, ReplicaMode, CTL,
  quantizeCursorAngle, dequantizeCursorAngle, quantizeCursorDist, CURSOR_DIST_STEP, jumpTuning, packKeyframe, unpackKeyframe,
  packGunState, CHARGE_GROUPS_AT, PILOT_ROW, SNAPSHOT_RATE, TICK_RATE, simAimQ, buildFlightInputs, stepOwnShip, ownStructure, seedOwnExtras,
  ownStateHash, packOwnSync, unpackOwnSync, cloneOwnExtras,
  type FlightBody, type Charge, type ShipState, type ShipTuning, type ReplicaEnv, type ClientInputMessage, type OwnExtras, type SimEnv,
} from '@space-game/common';
import { PILOT_EXTRAS } from '../../../common/src/ships/features/plan.js';
import { replicaAngle, quantizeReplicaAngle } from '../../../common/src/network/replication.js';
import { readShipJson, testCatalog } from '../../../common/src/ships/testData.js';
import { SCENARIOS, corsair, type Scenario, type ScriptTick } from '../../../common/src/ships/golden/testData.js';
import { parseBlueprint } from '../../../common/src/ships/blueprint.js';
import type { PortsState } from '../../../common/src/ships/power/ports.js';

/** A copy of the charge as it is now (a ports ship's state is changed in place by every later tick) */
function snapCharge(c: Charge): Charge {
  const e = c.e as PortsState | undefined;
  if (!e) return c;
  return { ...c, e: { ...e, held: e.held.slice(), flags: e.flags.slice(), amt: e.amt.slice(), mat: e.mat.slice(), closed: e.closed.slice(), aug: e.aug.slice(), sat: e.sat.slice() } };
}
import { bodyRow, chargeRow, hashRows, goldenFile, ranges, BODY_FIELDS } from '../../../common/src/ships/golden/testData.js';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(__dirname, '../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const files = readGameDataFiles(dataDir);
const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const pins = goldenFile<unknown>(join(__dirname, 'parity.golden.json'));
afterAll(() => pins.save());

const UP = -Math.PI / 2;

/** One tick of the server's state, after its step */
interface Tick {
  body: FlightBody;
  charge: Charge;
  /** The guns' state after the step (firing scenarios: gunRow) */
  guns: number[];
  /** The pilot row's gun-state slot as the server would send it this tick (packGunState behind an empty row) */
  wire: number[];
  jumpPrime: number;
  tow: number | undefined;
  /** The server's tick number during the step */
  tick: number;
  /** Slowed (features/weaponry): the tick its slowing ends as the pilot's row told it before this step (0: not slowed), and whether the server flew this step slowed (its replica control bit) */
  slowUntil: number;
  slowedBit: boolean;
  /** What the engines and the part features' bursts got and a refused boost, as its replica control bits carried them (flight.ts ctlOfPower, ctlOfShare, CTL.noBoost) */
  powerBits: number;
  /** The control bits it flew (all of them) and its stores, guns, hazards and priming as the tick ended (ShipBridge.ownExtras: an ownSync's, the head hash's) */
  bits: number;
  extras: OwnExtras;
}

/** A scenario some of whose ticks the pilot's ship is slowed on (a Frostbite's beam on it: [from, to) 0-based, renewed each tick as a held beam does) */
type SlowScenario = Scenario & { slow?: [number, number][] };

/** A firing scenario's tick: fire held or not */
type FireTick = ScriptTick & { fire?: boolean };

/** Every gun's state, quantised (cooldown, rounds, reload, charge, spin), in weapon order: what the server and the pilot's guns must agree on */
function gunRow(ship: ShipState): number[] {
  const q = (v: number) => Math.round(v * 1e6) / 1e6;
  const out: number[] = [];
  for (const w of ship.derived.weapons) out.push(q(ship.cooldown[w.part]), ship.rounds[w.part], q(ship.reload[w.part]), q(ship.charge[w.part]), q(ship.spin[w.part]));
  return out;
}

/** A pilot row carrying `ship`'s gun state, as the snapshot builder lays it out */
function wireRow(ship: ShipState): number[] {
  const d = new Array(CHARGE_GROUPS_AT).fill(0);
  d[PILOT_ROW.groups] = 1;
  d.push(100);
  for (let i = 0; i < PILOT_EXTRAS; i++) d.push(0);
  packGunState(ship, d);
  return d;
}

const keysOf = (t: ScriptTick) => ({ forward: false, backward: false, left: false, right: false, boost: false, ...t.keys });

function runServer(sc: Scenario) {
  resetGlobals();
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as any,
    scene: 'sectors',
    autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => 1_000_000,
  });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'parity' } as any);
  const pid = t.getPlayerId();
  const conn = server.pilots.connOf(pid)!;
  const ships = server.getShips()!;
  ships.respawnInPlace(pid, sc.ship());
  // Out in open space, away from anything, nose up, at rest
  Position.x[pid] = 40000; Position.y[pid] = 40000; Velocity.x[pid] = 0; Velocity.y[pid] = 0; Rotation.angle[pid] = UP;
  const ship = ships.get(pid)!;
  ship.angVel = 0;
  if (sc.cargoOre) server.pilots.get(conn)!.cargo.push({ id: 'iron_ore', n: sc.cargoOre });
  const wreck = sc.tow ? ships.spawnWreck(corsair(), 40000 - sc.tow.wreckDist, 40000, 0, InSystem.systemId[pid], 7) : 0;
  const read = (): Omit<Tick, 'tick' | 'slowUntil' | 'slowedBit' | 'powerBits' | 'bits' | 'extras'> => ({
    body: {
      x: Position.x[pid], y: Position.y[pid], vx: Velocity.x[pid], vy: Velocity.y[pid], angle: Rotation.angle[pid], angVel: ship.angVel,
      jump: ship.jump, jumpScale: ship.jumpScale, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir,
    },
    charge: snapCharge(ships.chargeOf(pid)), jumpPrime: ship.jumpPrime ?? 0, tow: ship.tow, guns: gunRow(ship), wire: wireRow(ship),
  });
  const start = read();
  const ticks: Tick[] = [];
  // (What the pilot's row says of its slowing: the tick it ends, as of the last snapshot)
  let slowKnown = 0;
  // (The control bits its flight step recorded for the replicas: Replication clears them at the end of the tick. The record
  // itself: the step adds the engines' power to it after recording it)
  let ctlRec: { bits: number } | undefined;
  const ctl = ships.replicaCtl, setCtl = ctl.set.bind(ctl);
  ctl.set = (k, v) => { if (k === pid) ctlRec = v; return setCtl(k, v); };
  sc.script.forEach((s, i) => {
    t.send({ type: 'input', seq: i + 1, tick: 0, fireLeft: !!(s as FireTick).fire, fireRight: false, ...keysOf(s), targetAngle: s.aim, cursorDist: s.dist ?? 0 } as any);
    if (sc.tow && i === sc.tow.from) t.send({ type: 'tow', on: true } as any);
    const slowUntil = slowKnown;
    server.step();
    const ctlBits = ctlRec?.bits ?? 0;
    const slowedBit = (ctlBits & CTL.slowed) !== 0;
    const powerBits = ctlBits & (CTL.noBoost | CTL.power | CTL.share);
    // A Frostbite's beam on it this tick (its weapons step: after the flight step, so it slows the next)
    if ((sc as SlowScenario).slow?.some(([a, b]) => i >= a && i < b)) ships.slow(pid, 42);
    const left = ships.slowedTicksLeft(pid);
    slowKnown = left > 0 ? server.getTick() + left : 0;
    ticks.push({ ...read(), tick: server.getTick(), slowUntil, slowedBit, powerBits, bits: ctlBits, extras: ships.ownExtras(pid, server.getTick())! });
  });
  const env: ReplicaEnv = (server as any).replicaEnv(InSystem.systemId[pid]);
  return { start, ticks, derived: ship.derived, env, wreck, ships, pid };
}

type Start = Omit<Tick, 'tick' | 'slowUntil' | 'slowedBit' | 'powerBits' | 'bits' | 'extras'>;

/** The input as Game.ts builds it (the aim through its 13 bits, the cursor distance in steps) */
function inputOf(s: ScriptTick, i: number, aim: 'wire' | 'game'): ClientInputMessage {
  return {
    type: 'input', seq: i + 1, tick: 0, fireLeft: !!(s as FireTick).fire, fireRight: false, ...keysOf(s),
    targetAngle: aim === 'wire' ? Math.fround(dequantizeCursorAngle(quantizeCursorAngle(s.aim))) : dequantizeCursorAngle(quantizeCursorAngle(s.aim)), cursorDist: quantizeCursorDist(s.dist ?? 0) * CURSOR_DIST_STEP,
  } as ClientInputMessage;
}

/**
 * The pilot's own ship on its tick layer: OwnTick.step's whole step (stepOwnShip) from its body and extras, the
 * controls and the rest of its input as OwnTick takes them from the input message (noteInput)
 */
function clientPredictor(sc: Scenario, env: ReplicaEnv) {
  const ship: ShipState = createShipState(catalog, tuning, 1, sc.ship(), 0);
  const fields = { central: env.central, lodestones: env.lodestones ?? [] };
  const simEnv = (tick: number): SimEnv => ({ tick, tuning, gravity: env.gravity, fields, terrain: env.terrain ?? null, hazard: env.hazard });
  return {
    ship,
    /** Its state as the pilot's snapshot (and an ownSync) gives it */
    player(t: Start, extras?: OwnExtras): { body: FlightBody; x: OwnExtras; bits: number } {
      const x = extras ? cloneOwnExtras(extras) : seedOwnExtras(ship, t.charge);
      x.jumpPrime = t.jumpPrime;
      return { body: { ...t.body }, x, bits: 0 };
    },
    /**
     * One tick of its layer. `aim` 'wire': the aim as the server has it from the wire (float32, protocol.ts
     * decodeInputBinary); 'game': as Game.ts hands its input over (dequantized, not float32-rounded). The layer puts
     * either on the grid (simAimQ), so both fly what the server flies
     */
    step(player: { body: FlightBody; x: OwnExtras; bits: number }, s: ScriptTick, i: number, charge: Charge, tick: number, server: Tick, aim: 'wire' | 'game' = 'wire'): Charge {
      // (What the server tells it: the load it flies with, the tow its beam draws for, the slowed ticks)
      player.body.cargo = server.body.cargo ?? 0;
      player.x.guns.tow = server.tow;
      player.x.hazard.slowUntil = server.slowUntil;
      player.x.charge = charge;
      const input = inputOf(s, i, aim);
      const dist = Number(input.cursorDist) || 0;
      const st = stepOwnShip(1, player.x, player.body, controlBits(buildFlightInputs(input, false)), simAimQ(input.targetAngle), { fire: !!input.fireLeft, fireAlt: !!input.fireRight, jumpDist: dist, aimDist: dist }, ownStructure(ship.derived, ship), simEnv(tick), []);
      player.x = { charge: st.charge, guns: st.guns, hazard: st.hazard, jumpPrime: st.jumpPrime };
      player.bits = st.ctl.bits;
      // (Its gun state onto its record, as ShipClient's drawing side has it: gunRow reads it)
      const g = st.guns;
      ship.cooldown = [...g.cooldown]; ship.rounds = [...g.rounds]; ship.reload = [...g.reload]; ship.charge = [...g.charge]; ship.spin = [...g.spin]; ship.aim = [...g.aim];
      return st.charge;
    },
    body(player: { body: FlightBody }): FlightBody {
      return { ...player.body };
    },
  };
}

const keyframe = (b: FlightBody) => unpackKeyframe(packKeyframe({ id: 1, mode: ReplicaMode.Player, body: { ...b }, ctl: { bits: 0, targetAngle: 0 }, q: 0 })).body;

/** The replica flown from `from` (keyframed there) to the end, re-keyframed wherever it leaves the server's path */
function runReplica(sc: Scenario, run: ReturnType<typeof runServer>, from: number) {
  // (From the start: keyframed with the hold's load, as the keyframe after it's taken on carries it)
  const startBody = from < 0 ? { ...run.start.body, cargo: run.ticks[0].body.cargo } : run.ticks[from].body;
  let body = keyframe(startBody);
  const keyframes: number[] = [];
  for (let i = from + 1; i < sc.script.length; i++) {
    const s = sc.script[i];
    // (A slowed ship's replica gets CTL.slowed in its control bits, as the server flew it)
    replicaStep(ReplicaMode.Player, body, { bits: controlBits(keysOf(s)) | (run.ticks[i].slowedBit ? CTL.slowed : 0) | run.ticks[i].powerBits, targetAngle: replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(s.aim)) }, run.derived, tuning, run.env, run.ticks[i].tick);
    if (!sameRow(bodyRow(body), bodyRow(run.ticks[i].body))) {
      keyframes.push(i);
      body = keyframe(run.ticks[i].body);
    }
  }
  return keyframes;
}

/** The aim it flew tick i with (the script's, on the grid) */
function aimAt(script: ScriptTick[], i: number): number {
  return simAimQ(Math.fround(dequantizeCursorAngle(quantizeCursorAngle(script[i].aim))));
}

const sameRow = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** The first tick (and field) where two runs differ, or null */
function firstDiff(server: Tick[], other: { body: number[]; charge?: number[] }[], from: number): string | null {
  for (let i = from; i < server.length; i++) {
    const a = bodyRow(server[i].body), b = other[i - from].body;
    if (!sameRow(a, b)) {
      const f = BODY_FIELDS.findIndex((_, k) => a[k] !== b[k]);
      return `tick ${i}: ${BODY_FIELDS[f]} server ${a[f]} vs ${b[f]}`;
    }
    const c = other[i - from].charge;
    if (c && !sameRow(chargeRow(server[i].charge), c)) return `tick ${i}: charge server ${chargeRow(server[i].charge)} vs ${c}`;
  }
  return null;
}

/** The client predicting from `from` (the server's state after that tick; -1: the start) to the end */
function runClient(sc: Scenario, run: ReturnType<typeof runServer>, from: number, aim: 'wire' | 'game' = 'wire') {
  const c = clientPredictor(sc, run.env);
  const st = from < 0 ? run.start : run.ticks[from];
  // (Reconciling from a snapshot: its keyframe and an ownSync of that tick, packed and unpacked as the wire has it)
  const player = from < 0 ? c.player(st) : c.player(st, unpackOwnSync(packOwnSync(run.ticks[from].tick, run.ticks[from].extras)));
  let charge = st.charge;
  const out: { body: number[]; charge: number[] }[] = [];
  for (let i = from + 1; i < sc.script.length; i++) {
    charge = c.step(player, sc.script[i], i, charge, run.ticks[i].tick, run.ticks[i], aim);
    out.push({ body: bodyRow(c.body(player)), charge: chargeRow(charge) });
  }
  return { out, ship: c.ship };
}

describe('prediction parity: server, client prediction and replicas fly the same script to the same numbers', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      let run: ReturnType<typeof runServer>;
      const server = () => (run ??= runServer(sc));

      it('the client prediction matches the server tick by tick (body and charge)', () => {
        const r = server();
        const { out, ship } = runClient(sc, r, -1);
        // (The same structure on both sides, as the ship sync gives it)
        expect(flightSignature(ship.derived)).toBe(flightSignature(r.derived));
        expect(firstDiff(r.ticks, out, 0)).toBeNull();
      });

      it('a client reconciling from a snapshot mid-script replays onto the server exactly', () => {
        const r = server();
        for (const at of sc.replayAt ?? []) expect([at, firstDiff(r.ticks, runClient(sc, r, at).out, at + 1)]).toEqual([at, null]);
      });

      it('a replica on the control bits stays on the real path (re-keyframed only where pinned)', () => {
        const r = server();
        const keyframes = runReplica(sc, r, -1);
        if (!sc.replicaDiverges) expect(keyframes).toEqual([]);
        else expect(keyframes.length).toBeGreaterThan(0);
        // Keyframed mid-script, it needs the same keyframes from there on
        for (const at of sc.replayAt ?? []) expect(runReplica(sc, r, at)).toEqual(keyframes.filter((k) => k > at));
        // Pinned: where it's re-keyframed, and the server's own trace (body and charge every tick)
        const actual = { keyframes: ranges(keyframes), server: hashRows(r.ticks.map((t) => [...bodyRow(t.body), ...chargeRow(t.charge)])) };
        expect(actual).toEqual(pins.check(`${sc.name}/replica`, actual));
      });

      it('known divergence, pinned: Game.ts hands its input over with the aim unrounded, the server flies it as float32', () => {
        // Game.ts keeps dequantizeCursorAngle(q); the server's input handler and decodeInputBinary give the step
        // Math.fround of it. The own layer puts both on the grid (OwnTick.noteInput: simAimQ), so this is null now.
        // Pinned as found (the first tick and field it shows, or null), so a new divergence is a deliberate change
        const r = server();
        const actual = firstDiff(r.ticks, runClient(sc, r, -1, 'game').out, 0);
        expect(actual).toEqual(pins.check(`${sc.name}/unrounded-aim`, actual));
      });
    });
  }

  it('the scenarios exercise what they say on the server (cargo, a tow held, dodges, a kick)', () => {
    const cargo = SCENARIOS.find((s) => s.name === 'heavy-cargo')!;
    const r = runServer(cargo);
    // (The hold's ore weighs what the shared golden traces fly with)
    expect(r.ticks[0].body.cargo).toBe(cargo.cargo);
    const tow = SCENARIOS.find((s) => s.name === 'tow')!;
    const t = runServer(tow);
    expect(t.ticks[tow.tow!.from].tow).toBe(t.wreck);
    expect(t.ticks[t.ticks.length - 1].body.cargo ?? 0).toBeGreaterThan(0);
    const dodges = SCENARIOS.find((s) => s.name === 'strafer-every-way')!;
    const d = runServer(dodges);
    expect(new Set(d.ticks.map((x) => x.body.dodgeDir ?? 0)).size).toBeGreaterThan(6);
  });
});

// ---- The firing models (docs/design/rework-2026-11.md §3): the pilot's own guns, stepped forward on its client, must
// keep the server's clips, reloads, charges, spin and cooldowns, and draw the same energy, tick by tick.

/** A Sparrow with its two Pips swapped for these models (their own cells and mounts: the shape is the Sparrow's) */
const armedSparrow = (left: string, right: string, file = 'blueprints/sparrow-t.json') => () => {
  const bp = readShipJson(file) as unknown;
  const b = parseBlueprint(JSON.stringify(bp));
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = left;
  pips[1].fn = right;
  return b;
};

/** Segments of [ticks, keys, fire held, aim (a number, or a function of the tick within the segment)] */
function fireScript(...segs: [number, ScriptTick['keys'], boolean, number | ((i: number) => number)][]): FireTick[] {
  const out: FireTick[] = [];
  for (const [n, keys, fire, aim] of segs) for (let i = 0; i < n; i++) out.push({ keys, fire, aim: typeof aim === 'number' ? aim : aim(i) });
  return out;
}

const FIRE_SCENARIOS: Scenario[] = [
  // A clip emptied and reloaded, a partial clip reloaded on idle; a charge fired by itself, cooled, then let go early
  {
    name: 'fire-clip-charge', ship: armedSparrow('railgun_rail_driver', 'cannon_longbarrel'), replicaDiverges: true, replayAt: [],
    script: fireScript([200, { forward: true }, true, UP], [30, {}, false, UP], [50, { left: true }, true, (i) => UP - i * 0.004], [100, {}, false, UP - 0.2], [300, { forward: true }, true, (i) => UP - 0.2 + i * 0.002]),
  },
  // A minigun spinning up and down, and a held lance with a windup, flown hard enough to run the ship short (the sputter)
  {
    name: 'fire-spin-beam', ship: armedSparrow('autocannon_chainsaw', 'lance_lance'), replicaDiverges: true, replayAt: [],
    script: fireScript([150, { forward: true, boost: true }, true, UP], [40, {}, false, UP], [400, { forward: true, boost: true }, true, (i) => UP + Math.sin(i / 40) * 0.3], [60, {}, false, UP]),
  },
  // A regrowing nest and a turret clip
  {
    name: 'fire-regrow', ship: armedSparrow('legendary_hive', 'autocannon_stinger'), replicaDiverges: true, replayAt: [],
    script: fireScript([400, { forward: true }, true, (i) => UP + Math.sin(i / 50) * 0.2], [200, {}, false, UP], [200, { right: true }, true, UP]),
  },
  // Shells that end at the aim (features/weaponry endAtAim): a clip of aim bursts and a charged orb. Their shells go
  // as rows (launch.ts firesStraight), but the guns' clip and charge are the pilot's to predict, at a cursor distance
  {
    name: 'fire-aim-burst', ship: armedSparrow('flak_cloudmaker', 'emp_blackout'), replicaDiverges: true, replayAt: [],
    script: fireScript([300, { forward: true }, true, (i) => UP + Math.sin(i / 60) * 0.3], [60, {}, false, UP], [300, { left: true }, true, UP])
      .map((t, i) => ({ ...t, dist: 600 + (i % 200) * 4 })),
  },
  // The cycle railguns: the Coilgun's five-slug cone and the Spear, power paid per shot, flown on the throttle
  {
    name: 'fire-rail-cycle', ship: armedSparrow('railgun_coilgun', 'railgun_spear'), replicaDiverges: true, replayAt: [],
    script: fireScript([300, { forward: true }, true, (i) => UP + Math.sin(i / 60) * 0.15], [40, {}, false, UP], [300, { forward: true, boost: true }, true, UP]),
  },
];
/** The first four on the pool-era Sparrow (a fixture): the pool core's clip reload eighths and feed shares, which the correction
 * and sputter checks below are written for (the ports core's guns are checked tick by tick above) */
const POOL_PAIRS: [string, string][] = [['railgun_rail_driver', 'cannon_longbarrel'], ['autocannon_chainsaw', 'lance_lance'], ['legendary_hive', 'autocannon_stinger'], ['flak_cloudmaker', 'emp_blackout']];
const POOL_FIRE: Scenario[] = POOL_PAIRS.map(([l, r], k) => ({ ...FIRE_SCENARIOS[k], ship: armedSparrow(l, r, 'blueprints/fixtures/sparrow-t.json') }));

describe('prediction parity: the firing models (the pilot\'s guns keep the server\'s state)', () => {
  for (const sc of FIRE_SCENARIOS) {
    it(`${sc.name}: guns, body and charge match the server tick by tick`, () => {
      const r = runServer(sc);
      const c = clientPredictor(sc, r.env);
      const player = c.player(r.start);
      let charge = r.start.charge;
      let shots = 0, diff: string | null = null;
      for (let i = 0; i < sc.script.length && !diff; i++) {
        charge = c.step(player, sc.script[i], i, charge, r.ticks[i].tick, r.ticks[i]);
        const s = r.ticks[i];
        if (!sameRow(bodyRow(s.body), bodyRow(c.body(player)))) diff = `tick ${i}: body`;
        else if (!sameRow(chargeRow(s.charge), chargeRow(charge))) diff = `tick ${i}: charge server ${chargeRow(s.charge)} vs ${chargeRow(charge)}`;
        else if (!sameRow(s.guns, gunRow(c.ship))) diff = `tick ${i}: guns server ${s.guns} vs ${gunRow(c.ship)}`;
        if (i > 0 && !sameRow(r.ticks[i - 1].guns, s.guns)) shots++;
      }
      expect(diff).toBeNull();
      // (They did fire, and their state moved)
      expect(shots).toBeGreaterThan(20);
    });
  }

  it('a missed shot: the full-state hash finds it at the next snapshot, and the ownSync puts the pilot\'s guns and stores back on the server\'s exactly', () => {
    for (const sc of POOL_FIRE.slice(0, 2)) {
      const r = runServer(sc);
      const gap = Math.round(TICK_RATE / SNAPSHOT_RATE);
      const c = clientPredictor(sc, r.env);
      // Its layer by tick (its state as each tick ended), stepped again from a correction as OwnTick is
      const layer: { body: FlightBody; x: OwnExtras; bits: number }[] = [];
      let player = c.player(r.start);
      // The pilot's client loses ticks 20-31 of its held fire (a lost input: shots missed, a charge not built)
      const DROP_FROM = 20, DROP_TO = 32;
      const script = sc.script.map((s, i) => (i >= DROP_FROM && i < DROP_TO ? { ...s, fire: false } : s));
      const stepTo = (i: number) => {
        c.step(player, script[i], i, player.x.charge, r.ticks[i].tick, r.ticks[i]);
        layer[i] = { body: { ...player.body }, x: cloneOwnExtras(player.x), bits: player.bits };
      };
      const hashOf = (tick: number, body: FlightBody, bits: number, x: OwnExtras) => ownStateHash(1, body, bits, aimAt(script, tick), x, r.ticks[tick].tick);
      let misses = 0, firstMiss = -1, lastMiss = -1;
      for (let i = 0; i < script.length; i++) {
        stepTo(i);
        // A snapshot of tick j reaches it 5 ticks on: its head hash against its layer there
        const j = i - 5;
        if (j < 0 || j % gap) continue;
        const srv = r.ticks[j], mine = layer[j];
        if (hashOf(j, srv.body, srv.bits, srv.extras) === hashOf(j, mine.body, mine.bits, mine.x)) continue;
        misses++;
        if (firstMiss < 0) firstMiss = j;
        lastMiss = j;
        // Off: the server's keyframe and ownSync of tick j (packed and unpacked as the wire has it); stepped again from there
        player = c.player(srv, unpackOwnSync(packOwnSync(srv.tick, srv.extras)));
        player.bits = srv.bits;
        for (let k = j + 1; k <= i; k++) stepTo(k);
      }
      // It went wrong in the drop and was found at the first snapshot that showed it, put right at each snapshot while
      // its inputs still said otherwise (none after the drop's last tick has shown), and from the last correction on
      // it is the server's, tick by tick
      expect([sc.name, firstMiss >= DROP_FROM, lastMiss <= DROP_TO + gap]).toEqual([sc.name, true, true]);
      expect(misses).toBeGreaterThan(0);
      expect(misses).toBeLessThanOrEqual(Math.ceil((DROP_TO - DROP_FROM) / gap) + 1);
      let diff: string | null = null;
      for (let i = lastMiss + 1; i < script.length && !diff; i++) {
        const s = r.ticks[i], m = layer[i];
        if (!sameRow(bodyRow(s.body), bodyRow(m.body))) diff = `tick ${i}: body`;
        else if (!sameRow(chargeRow(s.charge), chargeRow(m.x.charge))) diff = `tick ${i}: charge`;
        else if (hashOf(i, s.body, s.bits, s.extras) !== hashOf(i, m.body, m.bits, m.x)) diff = `tick ${i}: full state`;
      }
      expect([sc.name, diff]).toEqual([sc.name, null]);
    }
  });

  it('the scenarios exercise each model: a reload, a charge that fired and one let go, spin, a windup and a sputter, regrowth', () => {
    const cc = runServer(POOL_FIRE[0]);
    const [rd, lb] = cc.derived.weapons;
    expect([rd.fire.model, lb.fire.model]).toEqual(['clip', 'charge']);
    // (gunRow: cooldown, rounds, reload, charge, spin per gun)
    const g = (t: Tick, w: number, k: number) => t.guns[w * 5 + k];
    expect(cc.ticks.some((t) => g(t, 0, 2) > 0)).toBe(true);
    expect(cc.ticks.some((t) => g(t, 1, 3) < 0)).toBe(true);
    const sb = runServer(POOL_FIRE[1]);
    expect(sb.ticks.some((t) => g(t, 0, 4) === 1)).toBe(true);
    expect(sb.ticks.some((t) => (t.charge.gun ?? []).some((v) => v < 0.995))).toBe(true);
    const rg = runServer(POOL_FIRE[2]);
    const hive = rg.ticks.map((t) => g(t, 0, 1));
    expect(hive.some((v, i) => i > 0 && v === hive[i - 1] + 1)).toBe(true);
    // (Aim bursts: the Cloudmaker's clip emptied and reloaded, the Blackout charged and fired)
    const ab = runServer(POOL_FIRE[3]);
    expect(ab.derived.weapons.map((w) => w.fire.model)).toEqual(['clip', 'charge']);
    expect(ab.ticks.some((t) => g(t, 0, 2) > 0)).toBe(true);
    expect(ab.ticks.some((t) => g(t, 1, 3) > 0)).toBe(true);
  });
});

// ---- Mouse-steer in the nose frame (hits.ts CAPS.NOSE, flight.ts noseFrame: the view on the heading): both strafe bits
// with helm off push the movement keys along the ship. The server, the pilot's prediction and a replica on the control
// bits (which carry both strafe bits already) must fly it to the same numbers, tick by tick.
describe('prediction parity: mouse-steer in the nose frame (server, client prediction and replica)', () => {
  const plain = SCENARIOS.find((s) => s.name === 'plain-thrust-turn')!;
  const nose = { strafeLeft: true, strafeRight: true };
  const turning = (i: number) => -1.5 + i * 0.03;
  const script: ScriptTick[] = [
    ...Array.from({ length: 40 }, (): ScriptTick => ({ keys: { ...nose, forward: true }, aim: -1.5 })),
    ...Array.from({ length: 60 }, (_, i): ScriptTick => ({ keys: { ...nose, forward: true, right: i > 20 }, aim: turning(i) })),
    ...Array.from({ length: 40 }, (): ScriptTick => ({ keys: { ...nose, left: true, backward: true, boost: true }, aim: 0.3 })),
    ...Array.from({ length: 30 }, (): ScriptTick => ({ keys: { forward: true }, aim: 0.3 })),
    ...Array.from({ length: 30 }, (): ScriptTick => ({ keys: { ...nose }, aim: 2.4 })),
  ];
  const sc: Scenario = { ...plain, name: 'nose-frame', script, replayAt: [55, 145], replicaDiverges: false };

  it('the client prediction, a reconciling client and a replica match the server tick by tick', () => {
    const r = runServer(sc);
    expect(firstDiff(r.ticks, runClient(sc, r, -1).out, 0)).toBeNull();
    for (const at of sc.replayAt ?? []) expect([at, firstDiff(r.ticks, runClient(sc, r, at).out, at + 1)]).toEqual([at, null]);
    expect(runReplica(sc, r, -1)).toEqual([]);
    for (const at of sc.replayAt ?? []) expect(runReplica(sc, r, at)).toEqual([]);
  });

  it('it flies otherwise than the same keys along the world', () => {
    const r = runServer(sc);
    const world = runServer({ ...sc, script: script.map((s) => ({ ...s, keys: { ...s.keys, strafeLeft: false, strafeRight: false } })) });
    expect(firstDiff(world.ticks, r.ticks.map((t) => ({ body: bodyRow(t.body) })), 0)).not.toBeNull();
  });
});

// ---- Slowed (features/weaponry: a Frostbite's beam on the pilot): thrust and turning × SLOW_CONTROL while lit and
// 0.7 s after. The server flies it from its clock, the pilot's prediction from the slowed ticks its row tells, a
// replica from CTL.slowed in the control bits: all three must land on the same numbers, tick by tick.

const SLOW_SCENARIOS: SlowScenario[] = [
  // Lit while thrusting and turning, through a boost, and again over a helm turn; worn off in between
  { ...SCENARIOS.find((s) => s.name === 'plain-thrust-turn')!, name: 'slowed-thrust-turn', slow: [[20, 70], [150, 200]], replayAt: [40, 160, 230] },
];

describe('prediction parity: a slowed ship (server, client prediction and replica)', () => {
  for (const sc of SLOW_SCENARIOS) {
    it(`${sc.name}: the client prediction and a replica on the control bits match the server tick by tick`, () => {
      const r = runServer(sc);
      // It was slowed (and its replica told so) on the ticks after each beam, and not after they wore off
      const slowed = r.ticks.map((t) => t.slowedBit);
      expect(slowed[21]).toBe(true);
      expect(slowed[20 + 1 + 50 + 42 + 5]).toBe(false);
      expect(slowed.filter(Boolean).length).toBeGreaterThan(100);
      expect(firstDiff(r.ticks, runClient(sc, r, -1).out, 0)).toBeNull();
      for (const at of sc.replayAt ?? []) expect([at, firstDiff(r.ticks, runClient(sc, r, at).out, at + 1)]).toEqual([at, null]);
      expect(runReplica(sc, r, -1)).toEqual([]);
      for (const at of sc.replayAt ?? []) expect(runReplica(sc, r, at)).toEqual([]);
    });

    it(`${sc.name}: slowed, the ship flies otherwise than unslowed (and a replica without the bit leaves it)`, () => {
      const r = runServer(sc);
      const plain = runServer({ ...sc, slow: [] });
      expect(firstDiff(plain.ticks, r.ticks.map((t) => ({ body: bodyRow(t.body) })), 0)).not.toBeNull();
      // (The control bit is what carries it: a replica flown without it leaves the slowed path)
      let body = keyframe(r.start.body), off = -1;
      for (let i = 0; i < sc.script.length && off < 0; i++) {
        const s = sc.script[i];
        replicaStep(ReplicaMode.Player, body, { bits: controlBits(keysOf(s)), targetAngle: replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(s.aim)) }, r.derived, tuning, r.env, r.ticks[i].tick);
        if (!sameRow(bodyRow(body), bodyRow(r.ticks[i].body))) off = i;
      }
      expect(off).toBeGreaterThan(20);
      expect(off).toBeLessThan(80);
    });
  }
});
