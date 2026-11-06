/**
 * A pilot's jump, end to end (Kieran, 2026-11-06: "When I jump, I go way further than I aimed with my mouse", "the
 * spooling time seems random"). The client's real input path (client app/inputSend.ts tickInput, compact inputs
 * through an InputEncoder and the server's InputDecoder) flies a real GameServer; its own ship is stepped by itself
 * (CAPS.OWN_SIM, client OwnTick on a FakeHitsClient); the overlay's landing is worked out as ShipClient.jumpLanding
 * does (common ships/jumpAim.ts, from the distance the input sent).
 *
 * The jump lands where the cursor was (to the distance grid's step), the client's own ship is the server's every tick
 * (the charge too), the overlay says where it lands, and every jump charges the same 3 s whatever its distance, the
 * cursor moving or not. Where it goes is where the cursor was as the charge started (Kieran, 2026-11-07: "i click on
 * sol station to jump to it, then move my cursor, it jumps to my new cursor location"): the cursor moving after, its
 * bearing or its distance, or the map's lock-on (a station under the map's cursor) coming and going, changes nothing.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Input, InputEncoder, InputDecoder, jumpBurnAt, jumpTuning, jumpReachAt, jumpLanding, jumpPhase, cursorDistOnGrid, FRICTION,
  type ReplicaEnv, type ClientMessage, type ClientInputMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { tickInput, newInputSendState, type InputSendCtx } from '../../../../client/src/app/inputSend.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** The map's lock-on as the input path reads it (SystemMapUI.jumpLock): the marker under the map's cursor, or none */
type MapLock = { name: string; x: number; y: number; stop?: number } | null;

/**
 * Aim the cursor `dist(t)` east of the ship (t: ticks since J; `bearing(t)`: or that way), J pressed (latched, as the
 * tap mode does), and fly until it has jumped. `v0`: its speed east as J goes down. `lock(t, at)`: the map's lock-on
 * (`at`: where the ship was as J went down)
 */
function jumpWithMouse(dist: (t: number) => number, v0 = 0, opts: { bearing?: (t: number) => number; lock?: (t: number, at: { x: number; y: number }) => MapLock } = {}) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
  });
  const ships = server.getShips();
  const jt = jumpTuning((ships as unknown as { tuning: never }).tuning);
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'jumper', env });
  // (A pilot watching from beside it: its replica of the jumper, which doesn't know the distance, waits for the burn's keyframe)
  const C = new FakeHitsClient(server, { name: 'watcher', env });
  const enc = new InputEncoder(), dec = new InputDecoder();
  const own = () => A.reps.at(A.pid, server.getTick())?.body;
  let latched = false, since = -1, seq = 0, sent = 0;
  const mouse = { x: 0, y: 0 };
  const state = {
    get serverTick() { return server.getTick(); }, playerId: A.pid,
    // (Where the ship is drawn: its own layer)
    getPlayerPosition: () => { const b = own(); return b ? { x: b.x, y: b.y } : { x: Position.x[A.pid], y: Position.y[A.pid] }; },
    getInputTargetTick: () => server.getTick() + 3,
    inputLate: () => false,
    nextInputSeq: () => (seq = (seq + 1) & 0xffff),
    applyInput: () => {}, predictTick: () => {},
  };
  const pending: ClientMessage[] = [];
  const ctx = {
    loggedIn: true, compactInputs: true, stationOpen: false, localDead: false, proto: null, menu: { isOpen: false }, adminPanel: null,
    shipClient: {
      hangarOpen: false, setJumpAim: () => {}, jumpAiming: () => latched, helmMode: () => false,
      // (ShipClient.jumpHeld: latched until its own ship's burn starts)
      jumpHeld: () => { if ((own()?.jump ?? 0) >= jumpBurnAt(jt)) latched = false; return latched; },
      dodgeControl: () => false, berthed: () => false,
      noteInput: (m: ClientInputMessage) => { A.noteInput(m); },
      setJumpSent: (_a: number, d: number) => { sent = d; },
    },
    autopilot: { active: false, cancel: () => {}, tick: () => null },
    context: { flight: () => null, withholdingLeft: () => false, jumpMark: () => false, cancel: () => false },
    playerStatsUI: { addShotFired: () => {} },
    systemMapUI: { aimWorld: () => null, jumpAim: null, jumpLock: () => (opts.lock && since >= 0 ? opts.lock(since, jAt) : null), firing: () => false },
    navMarkers: null,
    audio: { bumpCombat: () => {} },
    network: { isConnected: () => true, send: (m: ClientInputMessage) => { pending.push(dec.decode(new Uint8Array(enc.encode(m, true))) as ClientMessage); } },
    input: { mouseX: 0, mouseY: 0, isKeyDown: () => false, isMouseDown: () => false },
    renderer: { screenToWorld: () => mouse },
    rightHeld: () => false,
    state,
    ...newInputSendState(),
  } as unknown as InputSendCtx;
  let jAt = { x: 0, y: 0 };
  const aim = () => {
    const p = state.getPlayerPosition(), t = Math.max(0, since), b = opts.bearing?.(t) ?? 0;
    mouse.x = p.x + dist(t) * Math.cos(b); mouse.y = p.y + dist(t) * Math.sin(b);
  };
  const step = () => {
    aim();
    tickInput(ctx);
    for (const m of pending.splice(0)) A.link!.receive(m);
    server.step(); clock.t += 1000 / 60;
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    C.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  Position.x[A.pid] += 30000; Position.y[A.pid] += 30000; Velocity.x[A.pid] = v0; Velocity.y[A.pid] = 0;
  Position.x[C.pid] = Position.x[A.pid] - 400; Position.y[C.pid] = Position.y[A.pid] - 300; Velocity.x[C.pid] = 0; Velocity.y[C.pid] = 0;
  // (Settled on the aim, east)
  for (let i = 0; i < 120; i++) step();
  const s = ships.get(A.pid)!;
  const reach = jumpReachAt(s.derived, jt);
  // J
  jAt = { x: Position.x[A.pid], y: Position.y[A.pid] };
  latched = true; since = 0;
  const misses0 = A.own.stats.headMisses, fixes0 = A.own.stats.fixes;
  let charged = -1, first = -1, start = { x: 0, y: 0 }, overlay: [number, number] | null = null, offTicks = 0, chargeOff = 0, burnDist = -1, ownDist = -1;
  // (The distance the charge started with, and that as the burn starts its pilot's cursor was at; the overlay late in the charge)
  let startDist = -1, lockTo = -1, lateOverlay: [number, number] | null = null;
  for (; since < 700; since++) {
    step();
    const j = s.jump ?? 0, b = own();
    if (!b || b.x !== Position.x[A.pid] || b.y !== Position.y[A.pid]) offTicks++;
    if ((b?.jump ?? 0) !== j) chargeOff++;
    // The server's counter: its first charging tick, and the burn's
    if (j === 1) { start = { x: Position.x[A.pid], y: Position.y[A.pid] }; first = since; startDist = Input.cursorDist[A.pid]; lockTo = s.jumpTo ?? -1; }
    // (The overlay a second into the charge, from the lock its own ship carries, as ShipClient.jumpLanding draws it then)
    if (j === 60 && b && b.jumpAim !== undefined) lateOverlay = jumpLanding(b, b.jump ?? 0, b.jumpAim, b.jumpTo ?? 0, reach, jt, { friction: FRICTION, gravity: null, hazard: null });
    // (The overlay as the drive starts charging, from the drawn ship and what the input sent: ShipClient.jumpLanding)
    if (j === 1 && b) overlay = jumpLanding(b, b.jump ?? 0, 0, sent, reach, jt, { friction: FRICTION, gravity: null, hazard: null });
    if (charged < 0 && jumpPhase(j, jt).phase === 'burn') {
      // (Ticks charged, the first one's too; the distance the burn went by, as the server held it and the client's own step had it)
      charged = since - first + 1; burnDist = Input.cursorDist[A.pid]; ownDist = A.own.inputAt(server.getTick()).jumpDist;
    }
  }
  const at = { x: Position.x[A.pid], y: Position.y[A.pid] };
  const seen = C.reps.at(A.pid, server.getTick())?.body;
  const watcherOff = seen ? Math.hypot(seen.x - at.x, seen.y - at.y) : Infinity;
  return { jt, reach, start, at, overlay, lateOverlay, offTicks, chargeOff, charged, burnDist, ownDist, startDist, lockTo, headMisses: A.own.stats.headMisses - misses0, fixes: A.own.stats.fixes - fixes0, watcherOff };
}

describe('a pilot\'s jump lands where it was aimed, charging the same 3 s whatever the distance', () => {
  for (const D of [8000, 20000, 40000]) for (const v0 of [0, 12]) {
    it(`aimed ${D / 1000}k${v0 ? ', sliding' : ''}: lands there, the client's own ship and overlay agree, charged 180 ticks`, () => {
      const r = jumpWithMouse(() => D, v0);
      // (From where it started charging: the slide while it charges, then the aim, on the distance grid)
      const landed = Math.hypot(r.at.x - r.start.x, r.at.y - r.start.y);
      const grid = cursorDistOnGrid(D);
      if (process.env.JUMP_DEBUG) console.log(JSON.stringify({ D, v0, grid, landed, overlay: r.overlay && Math.hypot(r.overlay[0] - r.start.x, r.overlay[1] - r.start.y), charged: r.charged }));
      if (!v0) expect(Math.abs(landed - D)).toBeLessThan(Math.max(10, D * 0.003));
      // (On the distance grid, then the burn's scale as snapshots carry it: 0.001, about 27 units)
      expect(Math.abs(landed - grid)).toBeLessThan(v0 ? 400 : 20);
      // The overlay: where it lands
      expect(Math.hypot(r.overlay![0] - r.at.x, r.overlay![1] - r.at.y)).toBeLessThan(30);
      // The client's own ship was the server's every tick, its charge too, and it was never put right
      expect(r.offTicks).toBe(0);
      expect(r.chargeOff).toBe(0);
      expect(r.headMisses).toBe(0);
      expect(r.fixes).toBe(0);
      // 3 s of charge: the burn starts chargeTicks after the charge did
      expect(r.charged).toBe(r.jt.chargeTicks);
      expect(r.jt.chargeTicks).toBe(180);
      expect(r.burnDist).toBe(grid);
      expect(r.ownDist).toBe(grid);
      // (The watcher, still near enough to hold it after a short jump, has it where it landed)
      if (D <= 8000) expect(r.watcherOff).toBeLessThan(1);
    }, 120_000);
  }

  it('the charge takes the same ticks for 6k, 20k and 45k, and with the cursor moving the whole time it lands at the distance sent as the charge started', () => {
    const ticks = [6000, 20000, 45000].map((D) => jumpWithMouse(() => D).charged);
    expect(new Set(ticks).size).toBe(1);
    const r = jumpWithMouse((t) => 8000 + ((t * 331) % 30000));
    expect(r.charged).toBe(ticks[0]);
    expect(r.chargeOff).toBe(0);
    expect(r.offTicks).toBe(0);
    expect(r.lockTo).toBe(r.startDist);
    expect(r.burnDist).not.toBe(r.startDist);
    expect(Math.abs(Math.hypot(r.at.x - r.start.x, r.at.y - r.start.y) - r.startDist)).toBeLessThan(20);
  }, 240_000);

  it('the bug (Kieran, 2026-11-07): aimed 9k east, the cursor then swung round and out to 25k all through the charge: it lands 9k east', () => {
    const r = jumpWithMouse((t) => (t === 0 ? 9000 : 25000), 0, { bearing: (t) => (t === 0 ? 0 : 1.9 + 0.5 * Math.sin(t / 13)) });
    expect(r.startDist).toBe(9000);
    // (East of where it charged, 9k: the cursor's first place, not its last)
    expect(Math.abs(r.at.x - r.start.x - 9000)).toBeLessThan(30);
    expect(Math.abs(r.at.y - r.start.y)).toBeLessThan(30);
    // The overlay a second in shows the locked landing, the client's own ship is the server's every tick, never put right
    expect(Math.hypot(r.lateOverlay![0] - r.at.x, r.lateOverlay![1] - r.at.y)).toBeLessThan(30);
    expect(r.offTicks).toBe(0);
    expect(r.chargeOff).toBe(0);
    expect(r.headMisses).toBe(0);
    expect(r.fixes).toBe(0);
    expect(r.charged).toBe(r.jt.chargeTicks);
  }, 120_000);

  it('a station locked on to on the map as J goes down, then the map\'s cursor moved off it: it jumps to the station (its stop short of it)', () => {
    // (A station 20k north-east of where J went down; the map's cursor over it only then, afterwards on open space west)
    const off = { x: 14000, y: 14000 };
    const r = jumpWithMouse(() => 6000, 0, {
      bearing: (t) => (t === 0 ? Math.PI / 4 : Math.PI),
      lock: (t, at) => (t === 0 ? { name: 'Sol Station', x: at.x + off.x, y: at.y + off.y } : null),
    });
    const station = { x: r.start.x + off.x, y: r.start.y + off.y };
    // (inputSend: just short of it, 1500)
    expect(Math.abs(Math.hypot(station.x - r.at.x, station.y - r.at.y) - 1500)).toBeLessThan(40);
    expect(r.offTicks).toBe(0);
    expect(r.fixes).toBe(0);
  }, 120_000);

  it('no shortest jump (Kieran, 2026-11-06): a 2k hop goes 2k, a 500 one 500, as the overlay says', () => {
    for (const D of [2000, 500]) {
      const r = jumpWithMouse(() => D);
      const landed = Math.hypot(r.at.x - r.start.x, r.at.y - r.start.y);
      expect(Math.abs(landed - D), String(D)).toBeLessThan(30);
      expect(Math.hypot(r.overlay![0] - r.at.x, r.overlay![1] - r.at.y)).toBeLessThan(30);
      expect(r.charged).toBe(r.jt.chargeTicks);
    }
  }, 240_000);

  it('aimed right at the ship itself: a hop of one distance step, never a full-range jump (0 on the wire means as far as the drive goes)', () => {
    const r = jumpWithMouse(() => 0);
    expect(r.burnDist).toBe(4);
    expect(Math.hypot(r.at.x - r.start.x, r.at.y - r.start.y)).toBeLessThan(40);
    expect(r.offTicks).toBe(0);
  }, 120_000);
});
