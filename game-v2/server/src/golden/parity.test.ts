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
  Position, Velocity, Rotation, InSystem, createShipState, flightSignature, controlBits, replicaStep, ReplicaMode,
  quantizeCursorAngle, dequantizeCursorAngle, quantizeCursorDist, CURSOR_DIST_STEP, jumpTuning, packKeyframe, unpackKeyframe,
  type FlightBody, type Charge, type ShipState, type ShipTuning, type ReplicaEnv, type ClientInputMessage,
} from '@space-game/common';
import { replicaAngle, quantizeReplicaAngle } from '../../../common/src/network/replication.js';
import { readShipJson, testCatalog } from '../../../common/src/ships/testData.js';
import { SCENARIOS, corsair, type Scenario, type ScriptTick } from '../../../common/src/ships/golden/testData.js';
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
  jumpPrime: number;
  tow: number | undefined;
  /** The server's tick number during the step */
  tick: number;
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
  const read = (): Omit<Tick, 'tick'> => ({
    body: {
      x: Position.x[pid], y: Position.y[pid], vx: Velocity.x[pid], vy: Velocity.y[pid], angle: Rotation.angle[pid], angVel: ship.angVel,
      jump: ship.jump, jumpScale: ship.jumpScale, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir,
    },
    charge: ships.chargeOf(pid), jumpPrime: ship.jumpPrime ?? 0, tow: ship.tow,
  });
  const start = read();
  const ticks: Tick[] = [];
  sc.script.forEach((s, i) => {
    t.send({ type: 'input', seq: i + 1, tick: 0, fireLeft: false, fireRight: false, ...keysOf(s), targetAngle: s.aim, cursorDist: s.dist ?? 0 } as any);
    if (sc.tow && i === sc.tow.from) t.send({ type: 'tow', on: true } as any);
    server.step();
    ticks.push({ ...read(), tick: server.getTick() });
  });
  const env: ReplicaEnv = (server as any).replicaEnv(InSystem.systemId[pid]);
  return { start, ticks, derived: ship.derived, env, wreck, ships, pid };
}

/** The pilot's prediction: ShipClient.predict with just the state it reads (the rest of the client is the renderer's) */
function clientPredictor(sc: Scenario, env: ReplicaEnv) {
  const ship: ShipState = createShipState(catalog, tuning, 1, sc.ship(), 0);
  const self = {
    store: { get: () => ship }, docked: false, berth: null,
    opts: { state: { entities: new Map() }, tuning },
    hazardFor: (d: never, x: number, y: number) => env.hazard?.(d, x, y),
    central: env.central, lodestones: env.lodestones ?? [], gravity: env.gravity, terrain: env.terrain ?? null,
    jump: jumpTuning(tuning),
  };
  const predict = ShipClient.prototype.predict as (this: unknown, ...a: Parameters<ShipClient['predict']>) => Charge | null;
  return {
    ship,
    /** A player entity as the pilot's snapshot gives it */
    player(t: Omit<Tick, 'tick'>) {
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
      const input: ClientInputMessage = {
        type: 'input', seq: i + 1, tick: 0, fireLeft: false, fireRight: false, ...keysOf(s),
        targetAngle: aim === 'wire' ? Math.fround(dequantizeCursorAngle(quantizeCursorAngle(s.aim))) : dequantizeCursorAngle(quantizeCursorAngle(s.aim)), cursorDist: quantizeCursorDist(s.dist ?? 0) * CURSOR_DIST_STEP,
      } as ClientInputMessage;
      return predict.call(self, player, input, charge, tick)!;
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
    replicaStep(ReplicaMode.Player, body, { bits: controlBits(keysOf(s)), targetAngle: replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(s.aim)) }, run.derived, tuning, run.env, run.ticks[i].tick);
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
