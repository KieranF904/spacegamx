/**
 * The input probe (docs/audits/input-compaction-2026-11-04.md): what a pilot sends up, and what its controls cost the
 * pilots near it. `npm run net:inputs` (scripts/net/inputs.mjs) runs every scenario; one by hand:
 *   node server/node_modules/tsx/dist/cli.mjs --tsconfig scripts/net/tsconfig.json scripts/net/inputProbe.ts <scenario> <secs> <out.json> [compact 0|1]
 * Scenarios: idle, keys (keys only), steer (mouse steering), fight (mouse and fire), docked (mouse and clicks on the
 * station's screen).
 * Drives the client's real input path (client/src/app/inputSend.ts tickInput) with a scripted mouse and keys, sends
 * what it sends through the client's encoder and the server's decoder into a real GameServer, and counts:
 *   up: messages/s, payload B/s, wire estimate (payload + 66 B a message)
 *   down: the bytes of this pilot's control rows (and its status row) to a nearby base-format observer and a nearby
 *         packed observer (packed: a bit-cost model of packedCodec controlsIO)
 *   parity: the server's applied controls each tick against what the client predicted for it
 * Works on the code before the compact inputs (no new imports: new symbols are looked up at run time).
 */
import { join, dirname } from 'path';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as common from '@space-game/common';
import {
  Position, Velocity, Input, InSystem, CAPS, PK_CONTROL, splitServerFrame, encodeBinary, encodeMessage, decodeMessage, PackedDecoder,
  quantizeCursorAngle, type ClientSocket, type ClientInputMessage, type ServerSnapshotMessage,
} from '@space-game/common';
import { tickInput, newInputSendState, type InputSendCtx } from '../../client/src/app/inputSend.js';
import { GameServer } from '../../server/src/GameServer.js';
import { GameData } from '../../server/src/data/GameData.js';
import { readGameDataFiles } from '../../server/src/data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../server/src/ships/loadShipConfig.js';
import { createShipBridge } from '../../server/src/proto/createProtoServer.js';
import { stationQuery } from '../../server/src/game/Docking.js';

const C = common as unknown as Record<string, any>;
{
  let seed = 0x2545f491;
  Math.random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '../../data');
const scenario = process.argv[2] ?? 'idle';
const secs = Number(process.argv[3]) || 20;
const outFile = process.argv[4];
const wantCompact = process.argv[5] === '1';
const LAT = 3;
const HDR = 66;

const clock = { t: 1_000_000 };
const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors', autoStart: false,
  ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  clock: () => clock.t,
  netCaps: 0xffff,
} as never);
const S = server as unknown as Record<string, any>;

// ---------------------------------------------------------------- observers
let measuring = false;
interface Obs { name: string; pid: number; packed: boolean; dec?: PackedDecoder; ctlB: number; ctlNoAimB: number; ctlRows: number; ctlEvents: number; statusB: number; frameB: number; frames: number }
const obs: Obs[] = [];
let A_pid = -1;

/** Bits of a varint / zigzag / control row in packedCodec's controlsIO (ref by slot, run bit, length, each value as num(v, 0, c)) */
const vuBits = (v: number, c: number) => { let n = 0, x = v; do { n += c + 1; x = Math.floor(x / (1 << c)); } while (x > 0); return n; };
const vsBits = (v: number, c: number) => vuBits(v >= 0 ? v * 2 : -v * 2 - 1, c);
function packedCtlBits(row: number[], slotWidth: number): number {
  let b = slotWidth + 1 + vuBits(row.length, 2);
  for (let i = 1; i < row.length; i++) b += 1 + vsBits(row[i], PK_CONTROL[Math.min(i, PK_CONTROL.length) - 1]);
  return b;
}
function ctlEventCount(row: number[]): number {
  if (row[0] < 0) { let i = 1; const v = row[i++]; if (v % 8 === 7) i++; return row.length - i; }
  let n = 0; for (let i = 1; i < row.length; ) { const v = row[i++]; if (v % 8 === 7) i++; i++; n++; }
  return n;
}
/** The row with every aim step 0: what any tightening of the aim steps could save at most */
function zeroAim(row: number[]): number[] {
  const r = [...row];
  let i = 1;
  if (row[0] < 0) { const v = r[i++]; if (v % 8 === 7) i++; for (; i < r.length; i++) r[i] = 0; return r; }
  while (i < r.length) { const v = r[i++]; if (v % 8 === 7) i++; if (i < r.length) r[i++] = 0; }
  return r;
}
const rowId = (r: number[]) => (r[0] < 0 ? -1 - r[0] : r[0]);

function seeFrame(o: Obs, buf: Uint8Array) {
  if (!measuring) { if (o.packed) try { o.dec!.decode(buf); } catch { /* not packed */ } return; }
  o.frameB += buf.length; o.frames++;
  if (!o.packed || buf[0] !== 0x04) {
    if (o.packed) return; // (a base frame to a packed client: none expected)
    for (const { msg, wire } of splitServerFrame(buf)) {
      if (msg.type !== 'snapshot') continue;
      const w = wire as unknown[];
      for (const row of (w[3] ?? []) as unknown[][]) if (row[0] === A_pid) o.statusB += encodeBinary(row).length;
      const s = msg as ServerSnapshotMessage;
      const ctlW = (w[7] ?? []) as unknown[][];
      (s.ctl ?? []).forEach((row, i) => { if (rowId(row) === A_pid) { if (process.env.ROWS && o.ctlRows < 25) console.log('ROW', JSON.stringify(ctlW[i]), encodeBinary(ctlW[i]).length); o.ctlB += encodeBinary(ctlW[i]).length; o.ctlNoAimB += encodeBinary([ctlW[i][0], ...zeroAim(row).slice(1)]).length; o.ctlRows++; o.ctlEvents += ctlEventCount(row); } });
    }
    return;
  }
  const subs = o.dec!.decode(buf);
  const width = (o.dec as unknown as { io: { things: { width(): number } } }).io.things.width();
  for (const msgs of subs) for (const msg of msgs) {
    if (msg.type !== 'snapshot') continue;
    for (const row of (msg as ServerSnapshotMessage).ctl ?? []) if (rowId(row) === A_pid) { o.ctlB += packedCtlBits(row, width) / 8; o.ctlNoAimB += packedCtlBits(zeroAim(row), width) / 8; o.ctlRows++; o.ctlEvents += ctlEventCount(row); }
  }
}

function connect(name: string, caps: number, packed: boolean): { pid: number; link: ReturnType<GameServer['connect']>; o?: Obs; caps: () => number } {
  let o: Obs | undefined;
  const socket: ClientSocket = {
    isOpen: () => true,
    send: (data) => {
      if (typeof data === 'string' || !o) return;
      seeFrame(o, data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
    },
  };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: `probe_${name}`, caps } as never);
  const pid = server.getPlayerId(socket);
  if (name !== 'A') { o = { name, pid, packed, dec: packed ? new PackedDecoder() : undefined, ctlB: 0, ctlNoAimB: 0, ctlRows: 0, ctlEvents: 0, statusB: 0, frameB: 0, frames: 0 }; obs.push(o); }
  const conn = () => [...(S.clients as Map<unknown, { playerId: number; caps?: number }>).values()].find((q) => q.playerId === pid);
  return { pid, link, o, caps: () => conn()?.caps ?? 0 };
}

const INPUTS_BIT: number = (CAPS as Record<string, number>).INPUTS ?? 0;
const A = connect('A', wantCompact ? INPUTS_BIT : 0, false);
A_pid = A.pid;
const B = connect('B_legacy', 0, false);
const P = connect('P_packed', CAPS.PACKED, true);
for (let i = 0; i < 30; i++) { server.step(); clock.t += 1000 / 60; }
const num = InSystem.systemId[A.pid];

const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
const stations = stationQuery(S.world).filter((s: number) => InSystem.systemId[s] === num);
let home = { x: Position.x[A.pid] + 30000, y: Position.y[A.pid] + 30000 };
if (scenario === 'docked') {
  const st = stations[0];
  home = { x: Position.x[st] + 150, y: Position.y[st] };
}
place(A.pid, home.x, home.y);
place(B.pid, home.x + 700, home.y + 500);
place(P.pid, home.x - 700, home.y + 500);

// ---------------------------------------------------------------- the client: tickInput on a fake host
let rs = 0x1234567 ^ scenario.length * 7919;
const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
const keys = new Set<string>();
const mouseBtn = new Set<number>();
const mouse = { x: 1100, y: 450 };
const cam = { x: home.x, y: home.y };
let seq = 0;
let docked = false, stationOpen = false;
const encoder = C.InputEncoder ? new C.InputEncoder() : null;
const decoder = C.InputDecoder ? new C.InputDecoder() : null;
let compact = false;
const up = { msgs: 0, bytes: 0, byKind: {} as Record<string, number> };
const clientByTick = new Map<number, ClientInputMessage>();
const pending: { at: number; data: ArrayBuffer }[] = [];

let lastUp: ClientInputMessage | null = null;
const whyUp: Record<string, number> = {};
const network = {
  isConnected: () => true,
  get compactInputs() { return compact; },
  send(msg: ClientInputMessage) {
    const data: ArrayBuffer = encoder ? encoder.encode(msg, compact) : (encodeMessage(msg) as ArrayBuffer);
    if (measuring) { up.msgs++; up.bytes += data.byteLength; const k = `${data.byteLength}B`; up.byKind[k] = (up.byKind[k] ?? 0) + 1; }
    if (msg.targetTick !== undefined) clientByTick.set(msg.targetTick, { ...msg });
    if (measuring && lastUp) {
      const keysCh = (['forward', 'backward', 'left', 'right', 'boost', 'fireLeft', 'fireRight', 'jump', 'helm', 'strafeLeft', 'strafeRight', 'dodge'] as const).some((k) => !!lastUp![k] !== !!msg[k]);
      const why = keysCh ? 'keys' : msg.targetAngle !== lastUp.targetAngle ? (msg.fireLeft || msg.fireRight ? 'aim(firing)' : 'aim') : msg.cursorDist !== lastUp.cursorDist ? 'dist' : 'other';
      whyUp[why] = (whyUp[why] ?? 0) + 1;
    }
    lastUp = { ...msg };
    pending.push({ at: server.getTick() + LAT - 1, data });
  },
};
const state = {
  get serverTick() { return server.getTick(); },
  get playerId() { return A.pid; },
  getPlayerPosition: () => ({ x: Position.x[A.pid], y: Position.y[A.pid] }),
  getInputTargetTick: () => server.getTick() + LAT + 1,
  nextInputSeq: () => (seq = (seq + 1) & 0xffff),
  applyInput: (_m: ClientInputMessage) => {},
  predictTick: (m: ClientInputMessage) => { if (m.targetTick !== undefined) clientByTick.set(m.targetTick, { ...m }); },
};
const ctx = {
  loggedIn: true,
  get stationOpen() { return stationOpen; },
  get localDead() { return false; },
  get compactInputs() { return compact; },
  proto: null,
  menu: { isOpen: false },
  adminPanel: null,
  shipClient: {
    hangarOpen: false,
    setJumpAim: () => {}, jumpAiming: () => false, helmMode: () => false, jumpHeld: () => false, dodgeControl: () => false,
    isDocked: () => docked, berthed: () => docked,
    takeAcks: () => undefined, takeHitReport: () => undefined, takeOwnCheck: () => undefined, noteInput: () => {},
  },
  autopilot: { active: false, cancel: () => {}, tick: () => null },
  context: { flight: () => null, withholdingLeft: () => false, jumpMark: () => false, cancel: () => false },
  playerStatsUI: { addShotFired: () => {} },
  systemMapUI: { aimWorld: () => null, jumpAim: null, jumpLock: () => null, firing: () => false },
  navMarkers: null,
  audio: { bumpCombat: () => {} },
  network,
  input: { get mouseX() { return mouse.x; }, get mouseY() { return mouse.y; }, isKeyDown: (k: string) => keys.has(k), isMouseDown: (b: number) => mouseBtn.has(b) },
  // (A camera that eases after the ship, as Renderer's does: a still mouse drifts over the world while the ship moves)
  renderer: { screenToWorld: (sx: number, sy: number) => ({ x: cam.x + (sx - 800), y: cam.y + (sy - 450) }) },
  state,
  rightHeld: () => mouseBtn.has(2),
  ...newInputSendState(),
} as unknown as InputSendCtx;

// ---------------------------------------------------------------- scripts
/** The mouse: moves in strokes (eased, whole pixels, as a real mouse reports) with still spells between */
let stroke: { from: [number, number]; to: [number, number]; t: number; len: number } | null = null, stillFor = 0;
function moveMouse() {
  if (stroke) {
    stroke.t++;
    const k = Math.min(1, stroke.t / stroke.len), e = k * k * (3 - 2 * k);
    mouse.x = Math.round(stroke.from[0] + (stroke.to[0] - stroke.from[0]) * e);
    mouse.y = Math.round(stroke.from[1] + (stroke.to[1] - stroke.from[1]) * e);
    if (k >= 1) { stroke = null; stillFor = 10 + Math.floor(rnd() * 50); }
    return;
  }
  if (stillFor-- > 0) return;
  const a = rnd() * Math.PI * 2, r = 120 + rnd() * 330;
  stroke = { from: [mouse.x, mouse.y], to: [Math.round(800 + Math.cos(a) * r), Math.round(450 + Math.sin(a) * r)], t: 0, len: 15 + Math.floor(rnd() * 70) };
}
let keyHold = 0;
function pressKeys(pool: string[], chance: number) {
  if (keyHold-- > 0) return;
  keyHold = 30 + Math.floor(rnd() * 70);
  keys.clear();
  for (const k of pool) if (rnd() < chance) keys.add(k);
}
let fireHold = 0, firing = false;
function fireBursts(onMin: number, onVar: number, offMin: number, offVar: number) {
  if (fireHold-- > 0) return;
  firing = !firing;
  fireHold = firing ? onMin + Math.floor(rnd() * onVar) : offMin + Math.floor(rnd() * offVar);
  if (firing) mouseBtn.add(0); else mouseBtn.delete(0);
}
function script(t: number) {
  switch (scenario) {
    case 'idle': break;
    case 'keys': pressKeys(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'], 0.35); break;
    case 'steer': moveMouse(); pressKeys(['KeyW', 'KeyW', 'KeyA', 'KeyD'], 0.4); break;
    case 'fight': moveMouse(); pressKeys(['KeyW', 'KeyA', 'KeyS', 'KeyD'], 0.4); fireBursts(40, 120, 20, 60); break;
    case 'docked': moveMouse(); fireBursts(4, 6, 50, 70); break;
  }
  void t;
}

// ---------------------------------------------------------------- run
const parity = { ticks: 0, same: 0, angleOff: 0, keysOff: 0, firstOff: [] as unknown[] };
function stepOnce() {
  const t = server.getTick();
  script(t);
  // (the camera after the ship, as the client draws it)
  cam.x += (Position.x[A.pid] - cam.x) * 0.12; cam.y += (Position.y[A.pid] - cam.y) * 0.12;
  tickInput(ctx);
  while (pending.length && pending[0].at <= t) {
    const data = pending.shift()!.data;
    const msg = decoder ? decoder.decode(new Uint8Array(data)) : decodeMessage(data);
    A.link.receive(msg as never);
  }
  server.step();
  clock.t += 1000 / 60;
  // The controls the server flew on this step against what the client predicted for that tick
  if (measuring) {
    const m = clientByTick.get(t + 1) ?? clientByTick.get(t);
    const cm = clientByTick.get(server.getTick());
    const use = cm ?? m;
    if (use && !docked) {
      parity.ticks++;
      const qa = quantizeCursorAngle(Input.targetAngle[A.pid]), qc = quantizeCursorAngle(use.targetAngle);
      const keysSame = (['forward', 'backward', 'left', 'right', 'boost', 'fireLeft', 'fireRight'] as const).every((k) => !!Input[k][A.pid] === !!use[k]);
      if (qa !== qc) parity.angleOff++;
      if (!keysSame) parity.keysOff++;
      if (qa === qc && keysSame) parity.same++;
      else if (parity.firstOff.length < 5) parity.firstOff.push({ tick: server.getTick(), qa, qc, keysSame });
    }
  }
}

for (let i = 0; i < 60; i++) stepOnce();
if (wantCompact && A.caps() & INPUTS_BIT) compact = true;
if (scenario === 'docked') {
  A.link.receive({ type: 'dock' } as never);
  docked = true; stationOpen = true;
}
for (let i = 0; i < 60; i++) stepOnce();
measuring = true;
for (let i = 0; i < secs * 60; i++) stepOnce();
measuring = false;

const r1 = (v: number) => Math.round(v * 10) / 10;
const result = {
  scenario, secs, compact, pilotCaps: A.caps(), docked: S.docking?.isDocked ? !!(S.clients && [...S.clients.values()].find((q: { playerId: number; docked?: unknown }) => q.playerId === A.pid)?.docked) : null,
  up: { msgsPerSec: r1(up.msgs / secs), payloadBps: r1(up.bytes / secs), wireBps: r1((up.bytes + HDR * up.msgs) / secs), meanBytes: up.msgs ? r1(up.bytes / up.msgs) : 0, sizes: up.byKind, why: whyUp },
  down: Object.fromEntries(obs.map((o) => [o.name, { ctlBps: r1(o.ctlB / secs), ctlBpsIfAimFree: r1(o.ctlNoAimB / secs), ctlRowsPerSec: r1(o.ctlRows / secs), ctlEventsPerSec: r1(o.ctlEvents / secs), statusRowBps: o.packed ? null : r1(o.statusB / secs), allFramesBps: r1(o.frameB / secs) }])),
  parity,
};
const json = JSON.stringify(result, null, 1);
if (outFile) writeFileSync(outFile, json);
console.log(json);
process.exit(0);
