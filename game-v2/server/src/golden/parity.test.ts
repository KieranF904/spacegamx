/**
 * Prediction parity harness (refactor safety net, Stage 0). The same scripted pilot (common/src/ships/golden/
 * testData.ts) is flown three ways, and the quantised bodies must agree tick by tick:
 *
 *   server   a full GameServer: inputs through LocalTransport (the real encode/decode and input handler), the
 *            server's tick (ShipBridge's flight step, Towing, cargo, energy), read back from the ECS and the ShipState
 *   client   ShipClient.prototype.predict, the pilot's prediction, called as Game.ts calls it (the aim quantised and
 *            dequantised, the cursor distance in steps), from the server's starting state and charge, told the
 *            hold's mass and the tow as the pilot's snapshot row does
 *   replica  replicaStep on the control bits (the server's shadow, what clients replay), keyframed through
 *            packKeyframe/unpackKeyframe; where it leaves the real path (full charge, no tick, cargo changes, a jump's
 *            distance) it is re-keyframed, and those ticks are pinned in parity.golden.json
 *
 * Plus snapshot replays: a client reconciling from the server's state mid-scenario (mid-burst for the strafer
 * scripts) and a replica keyframed there both land on the server's states to the end.
 *
 * Regenerate the keyframe pins deliberately with `UPDATE_GOLDEN=1 npx vitest run server/src/golden/parity.test.ts`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, createShipState, flightSignature, controlBits, replicaStep, ReplicaMode, CTL,
  quantizeCursorAngle, dequantizeCursorAngle, quantizeCursorDist, CURSOR_DIST_STEP, jumpTuning, packKeyframe, unpackKeyframe,
  packGunState, gunStateAt, gunStateValue, GUN_STATE_RELOADING, GUN_STATE_PATIENCE, CHARGE_GROUPS_AT, PILOT_ROW, SNAPSHOT_RATE, TICK_RATE,
  type FlightBody, type Charge, type ShipState, type ShipTuning, type ReplicaEnv, type ClientInputMessage,
} from '@space-game/common';
import { PILOT_EXTRAS } from '../../../common/src/ships/features/plan.js';
import { GunSync } from '../../../client/src/ships/gunSync.js';
import { replicaAngle, quantizeReplicaAngle } from '../../../common/src/network/replication.js';
import { readShipJson, testCatalog } from '../../../common/src/ships/testData.js';
import { SCENARIOS, corsair, type Scenario, type ScriptTick } from '../../../common/src/ships/golden/testData.js';
import { parseBlueprint } from '../../../common/src/ships/blueprint.js';
import { bodyRow, chargeRow, hashRows, goldenFile, ranges, BODY_FIELDS } from '../../../common/src/ships/golden/testData.js';
import { ShipClient } from '../../../client/src/ships/ShipClient.js';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { LocalTransport } from '../net/LocalTransport.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
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
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
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
  const read = (): Omit<Tick, 'tick' | 'slowUntil' | 'slowedBit' | 'powerBits'> => ({
    body: {
      x: Position.x[pid], y: Position.y[pid], vx: Velocity.x[pid], vy: Velocity.y[pid], angle: Rotation.angle[pid], angVel: ship.angVel,
      jump: ship.jump, jumpScale: ship.jumpScale, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir,
    },
    charge: ships.chargeOf(pid), jumpPrime: ship.jumpPrime ?? 0, tow: ship.tow, guns: gunRow(ship), wire: wireRow(ship),
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
    ticks.push({ ...read(), tick: server.getTick(), slowUntil, slowedBit, powerBits });
  });
  const env: ReplicaEnv = (server as any).replicaEnv(InSystem.systemId[pid]);
  return { start, ticks, derived: ship.derived, env, wreck, ships, pid };
}

/** The pilot's prediction: ShipClient.predict with just the state it reads (the rest of the client is the renderer's) */
function clientPredictor(sc: Scenario, env: ReplicaEnv, sync?: GunSync) {
  const ship: ShipState = createShipState(catalog, tuning, 1, sc.ship(), 0);
  const self = {
    store: { get: () => ship }, docked: false, berth: null,
    // (What predictGuns reaches for: the scene its shells go to, and the gun-state history)
    scene: { predictShot: () => {} }, gunSync: sync ?? { record: () => {} }, gunFeel: { own: () => {} },
    opts: { state: { entities: new Map() }, tuning },
    hazardFor: (d: never, x: number, y: number) => env.hazard?.(d, x, y),
    central: env.central, lodestones: env.lodestones ?? [], gravity: env.gravity, terrain: env.terrain ?? null,
    jump: jumpTuning(tuning),
  };
  const predict = ShipClient.prototype.predict as (this: unknown, ...a: Parameters<ShipClient['predict']>) => Charge | null;
  const predictGuns = ShipClient.prototype.predictGuns as (this: unknown, ...a: Parameters<ShipClient['predictGuns']>) => Charge | null;
  return {
    ship,
    /** A player entity as the pilot's snapshot gives it */
    player(t: Omit<Tick, 'tick' | 'slowUntil' | 'slowedBit' | 'powerBits'>) {
      const b = t.body;
      return { id: 1, x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: b.angle, angVel: b.angVel, jump: b.jump ?? 0, jumpScale: b.jumpScale, cargoMass: b.cargo ?? 0, dodge: b.dodge ?? 0, dodgeDir: b.dodgeDir ?? 0, jumpPrime: t.jumpPrime, warmth: 100 } as any;
    },
    /**
     * One predicted tick, the input as Game.ts builds it (the aim through its 13 bits, the cursor distance in steps).
     * `aim` 'wire': the aim as the server has it from the wire (float32, protocol.ts decodeInputBinary); 'game': as
     * Game.ts hands it to predict today (dequantized, not float32-rounded: a known divergence, pinned below)
     */
    step(player: any, s: ScriptTick, i: number, charge: Charge, tick: number, server: Tick, aim: 'wire' | 'game' = 'wire'): Charge {
      // (What the pilot's snapshot row tells it: the load it flies with, and the tow its beam draws for)
      player.cargoMass = server.body.cargo ?? 0;
      ship.tow = server.tow;
      // (and the slowed ticks it tells: GameState sets slowUntil from the pilot row's weaponry extras)
      player.slowUntil = server.slowUntil;
      const input: ClientInputMessage = {
        type: 'input', seq: i + 1, tick: 0, fireLeft: !!(s as FireTick).fire, fireRight: false, ...keysOf(s),
        targetAngle: aim === 'wire' ? Math.fround(dequantizeCursorAngle(quantizeCursorAngle(s.aim))) : dequantizeCursorAngle(quantizeCursorAngle(s.aim)), cursorDist: quantizeCursorDist(s.dist ?? 0) * CURSOR_DIST_STEP,
      } as ClientInputMessage;
      const after = predict.call(self, player, input, charge, tick)!;
      // (Then the guns, as Game.ts has GameState call them after the ship's step: forward only)
      return (s as FireTick).fire !== undefined ? predictGuns.call(self, player, input, tick, after) ?? after : after;
    },
    body(player: any): FlightBody {
      return { x: player.x, y: player.y, vx: player.vx, vy: player.vy, angle: player.angle, angVel: player.angVel, jump: player.jump, jumpScale: player.jumpScale, cargo: player.cargoMass, dodge: player.dodge, dodgeDir: player.dodgeDir };
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
  const player = c.player(st);
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

      it('known divergence, pinned: Game.ts predicts with the aim unrounded, the server flies it as float32', () => {
        // Game.ts sends dequantizeCursorAngle(q) to predict; the server's input handler and decodeInputBinary give the
        // step Math.fround of it. Where that moves a quantised body, the pilot rubber-bands a little. Pinned as found
        // (the first tick and field it shows, or null), so a fix or a new divergence is a deliberate change
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
const armedSparrow = (left: string, right: string) => () => {
  const bp = readShipJson('blueprints/sparrow-t.json') as unknown;
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

  it('under latency and a missed shot: the real GunSync pulls the pilot clip and charge back to the server within 30 ticks plus the snapshot gap', () => {
    const sc = FIRE_SCENARIOS[0];
    const r = runServer(sc);
    const gap = Math.round(TICK_RATE / SNAPSHOT_RATE);
    // The pilot's guns agree with the server's: a clip by rounds and reloading, a charge to within a few ticks
    const agree = (mine: ShipState, theirs: number[]) => {
      const at = gunStateAt(theirs);
      const reloading = (v: number) => v >= GUN_STATE_RELOADING;
      for (let k = 0; k < theirs[at]; k++) {
        const part = theirs[at + 1 + 2 * k], v = theirs[at + 2 + 2 * k];
        const w = mine.derived.weapons.find((x) => x.part === part)!;
        const m = gunStateValue(mine, w);
        if (w.fire.model === 'clip' ? m % GUN_STATE_RELOADING !== v % GUN_STATE_RELOADING || reloading(m) !== reloading(v) : Math.abs(m - v) > 3) return false;
      }
      return true;
    };
    // Held fire for the first 200 ticks; the pilot's client loses ticks 100-111 of it (a lost input: the Rail Driver's shot
    // and the Longbarrel's charge are missed there)
    const EIGHTH = Math.ceil((r.derived.weapons[0].fire.reload ?? 60) / 8);
    const DROP_FROM = 20, DROP_TO = 32;
    const flown = (delay: number, drop: boolean) => {
      const sync = new GunSync();
      const c = clientPredictor(sc, r.env, sync);
      const player = c.player(r.start);
      let charge = r.start.charge;
      const disagree: boolean[] = [];
      let adopted = 0;
      for (let i = 0; i < sc.script.length; i++) {
        const s = drop && i >= DROP_FROM && i < DROP_TO ? { ...sc.script[i], fire: false } : sc.script[i];
        charge = c.step(player, s, i, charge, r.ticks[i].tick, r.ticks[i]);
        // The server's row of step j reaches the client `delay` ticks later, on the snapshot ticks
        const j = i - delay;
        if (j >= 0 && j % gap === 0) adopted += sync.onRow(c.ship, r.ticks[j].wire, r.ticks[j].tick);
        // (Compared with the server's row of the same tick: the latest the server has, which is what the HUD would settle to)
        // (A reload is carried in eighths and adopted mid-eighth, so a reload may be an eighth early or late: the pilot
        // agrees when its guns hold the value the server held at some tick within that of this one)
        let ok = false;
        for (let k = Math.max(0, i - EIGHTH); k <= Math.min(r.ticks.length - 1, i + EIGHTH) && !ok; k++) ok = agree(c.ship, r.ticks[k].wire);
        disagree.push(!ok);
      }
      return { disagree, adopted };
    };
    for (const delay of [3, 5, 8]) {
      const clean = flown(delay, false);
      // Without a missed shot and with the server's rows late, the pilot's guns never leave the server's
      expect([delay, clean.disagree.indexOf(true), clean.adopted]).toEqual([delay, -1, 0]);
      const lost = flown(delay, true);
      // With it they leave (a shot was missed) ...
      const first = lost.disagree.indexOf(true);
      expect(first).toBeGreaterThanOrEqual(DROP_FROM);
      expect(lost.adopted).toBeGreaterThan(0);
      // ... and are back in step within GUN_STATE_PATIENCE ticks plus the gap and the delay of when they left, to the end of the held fire
      const by = DROP_FROM + GUN_STATE_PATIENCE + gap + delay + 12;
      expect([delay, lost.disagree.slice(by, 200).indexOf(true)]).toEqual([delay, -1]);
    }
  });

  it('the scenarios exercise each model: a reload, a charge that fired and one let go, spin, a windup and a sputter, regrowth', () => {
    const cc = runServer(FIRE_SCENARIOS[0]);
    const [rd, lb] = cc.derived.weapons;
    expect([rd.fire.model, lb.fire.model]).toEqual(['clip', 'charge']);
    // (gunRow: cooldown, rounds, reload, charge, spin per gun)
    const g = (t: Tick, w: number, k: number) => t.guns[w * 5 + k];
    expect(cc.ticks.some((t) => g(t, 0, 2) > 0)).toBe(true);
    expect(cc.ticks.some((t) => g(t, 1, 3) < 0)).toBe(true);
    const sb = runServer(FIRE_SCENARIOS[1]);
    expect(sb.ticks.some((t) => g(t, 0, 4) === 1)).toBe(true);
    expect(sb.ticks.some((t) => (t.charge.gun ?? []).some((v) => v < 0.995))).toBe(true);
    const rg = runServer(FIRE_SCENARIOS[2]);
    const hive = rg.ticks.map((t) => g(t, 0, 1));
    expect(hive.some((v, i) => i > 0 && v === hive[i - 1] + 1)).toBe(true);
    // (Aim bursts: the Cloudmaker's clip emptied and reloaded, the Blackout charged and fired)
    const ab = runServer(FIRE_SCENARIOS[3]);
    expect(ab.derived.weapons.map((w) => w.fire.model)).toEqual(['clip', 'charge']);
    expect(ab.ticks.some((t) => g(t, 0, 2) > 0)).toBe(true);
    expect(ab.ticks.some((t) => g(t, 1, 3) > 0)).toBe(true);
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
