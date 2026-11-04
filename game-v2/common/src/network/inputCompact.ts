/**
 * Compact inputs (CAPS.INPUTS, protocol 35): the layout is in inputCompactTables.ts. An input sends only what changed
 * since the last input on the socket: a mouse-steer tick is 2 bytes (the groups byte and an aim step), a key 2-3.
 *
 * Both ends keep that last input (InputRef) the same way: InputDecoder reads every input, the base layout's too, and
 * InputEncoder writes through its own decoder, so what it compares against is what the server has, by construction.
 * The encoder is exact: an input it can't say compactly (an aim off the step grids, a distance off its grid, no target
 * tick) goes in the base layout, which the decoder also reads. Seq isn't sent (the socket keeps order) unless it isn't
 * the next one.
 *
 * The client chooses what it sends so that it is cheap (planAim, cursorDistOnGrid) and steers by exactly that:
 * client/src/app/inputCompactSend.ts. Deterministic: integers only (the distance grid is built by integer steps).
 */
import {
  type ClientInputMessage, encodeInputBinary, decodeInputBinary, inputAckTail, readInputAcks,
  writeHitReport, readHitReport, writeOwnCheck, readOwnCheck, CURSOR_DIST_MAX,
} from './protocol.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from './cursorState.js';
import {
  CI_FLAG, CI, CI_EXTRA, CI_KEYS, CI_MODES, CI_AIM_FINE, CI_AIM_COARSE, CI_TICK_ESCAPE, CI_DIST_ESCAPE, CI_DIST,
} from './inputCompactTables.js';

// ---------------------------------------------------------------- the grids

const AIM_Q = 8192;
/** The step from one 13-bit aim to another, the short way round (-4096..4095) */
export function aimStep(from: number, to: number): number {
  return ((to - from) % AIM_Q + AIM_Q + AIM_Q / 2) % AIM_Q - AIM_Q / 2;
}
const addAim = (q: number, d: number) => ((q + d) % AIM_Q + AIM_Q) % AIM_Q;

/** The cursor distance's grid (CI_DIST): whole units, increasing, built by integer steps */
export const CURSOR_DIST_GRID: readonly number[] = (() => {
  const g = [0];
  let d = 0;
  const max = Math.min(CI_DIST.max, CURSOR_DIST_MAX);
  while (d < max) { d = Math.min(max, d + Math.max(CI_DIST.step, d >> CI_DIST.shift)); g.push(d); }
  return g;
})();
const GRID_INDEX = new Map(CURSOR_DIST_GRID.map((d, i) => [d, i]));

/** The grid index nearest a distance */
export function cursorDistIndex(d: number): number {
  const g = CURSOR_DIST_GRID;
  if (!(d > 0)) return 0;
  if (d >= g[g.length - 1]) return g.length - 1;
  let lo = 0, hi = g.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g[m] <= d) lo = m; else hi = m; }
  return d - g[lo] <= g[hi] - d ? lo : hi;
}

/** A distance put on the grid (what a compact input says for it) */
export function cursorDistOnGrid(d: number): number {
  return CURSOR_DIST_GRID[cursorDistIndex(d)];
}

/**
 * The aim to send for `want`, from the last one sent (`from`; -1 none yet), that a compact input says in the fewest
 * bytes: a fine step (within 254 of it: off by at most 1, 0.044 deg), a coarse one (within 2,032: off by at most 8,
 * 0.35 deg, the rest going next tick: a flick split over two ticks), or `want` itself (2 bytes)
 */
export function planAim(from: number, want: number): number {
  if (from < 0) return want;
  const d = aimStep(from, want);
  const fine = Math.trunc(d / CI_AIM_FINE);
  if (Math.abs(fine) <= 127) return addAim(from, fine * CI_AIM_FINE);
  const coarse = Math.round(d / CI_AIM_COARSE);
  if (Math.abs(coarse) <= 127) return addAim(from, coarse * CI_AIM_COARSE);
  return want;
}

// ---------------------------------------------------------------- the last input, as both ends have it

export interface InputRef {
  /** Its target tick's low 16 bits (-1: none yet, or it had none) */
  tick: number;
  seq: number;
  /** CI_KEYS and CI_MODES as bits */
  keys: number;
  modes: number;
  /** The 13-bit aim (-1: none yet) */
  q: number;
  /** The cursor distance as decoded, and its grid index (-1: off the grid) */
  dist: number;
  distIdx: number;
}

const newRef = (): InputRef => ({ tick: -1, seq: 0, keys: 0, modes: 0, q: -1, dist: 0, distIdx: 0 });
const bitsOf = (m: ClientInputMessage, names: readonly string[]) => {
  let b = 0;
  for (let i = 0; i < names.length; i++) if ((m as unknown as Record<string, unknown>)[names[i]]) b |= 1 << i;
  return b;
};
const bytesOf = (data: ArrayBuffer | Uint8Array) => (data instanceof Uint8Array ? data : new Uint8Array(data));

/** The server's side (and the encoder's copy of it): every input on one socket, in order */
export class InputDecoder {
  ref: InputRef = newRef();

  decode(data: ArrayBuffer | Uint8Array): ClientInputMessage {
    const buf = bytesOf(data);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (!(buf[0] & CI_FLAG)) {
      const m = decodeInputBinary(buf);
      const q = buf[0] === 0x03 ? view.getUint16(6, true) & 0x1fff : quantizeCursorAngle(m.targetAngle);
      const dist = m.cursorDist ?? 0;
      this.ref = { tick: m.targetTick === undefined ? -1 : m.targetTick & 0xffff, seq: m.seq & 0xffff, keys: bitsOf(m, CI_KEYS), modes: bitsOf(m, CI_MODES), q, dist, distIdx: GRID_INDEX.get(dist) ?? -1 };
      return m;
    }
    const r = this.ref;
    const mask = buf[0] & 0x7f;
    let at = 1;
    const need = (n: number) => { if (at + n > buf.length) throw new Error('compact input ended early'); };
    const u8 = () => { need(1); return buf[at++]; };
    const s8 = () => { need(1); return view.getInt8(at++); };
    const u16 = () => { need(2); const v = view.getUint16(at, true); at += 2; return v; };
    const extra = mask & CI.EXTRA ? u8() : 0;
    let tick: number;
    const v = mask & CI.TICK ? u8() : 1;
    if (v === CI_TICK_ESCAPE) tick = u16();
    else if (r.tick < 0) throw new Error('compact input: no tick to step from');
    else tick = (r.tick + v) & 0xffff;
    const keys = mask & CI.KEYS ? u8() : r.keys;
    const modes = mask & CI.MODES ? u8() & 0x0f : r.modes;
    const aim = mask & (CI.AIM_FINE | CI.AIM_COARSE);
    let q = r.q;
    if (aim === (CI.AIM_FINE | CI.AIM_COARSE)) q = u16() & 0x1fff;
    else if (aim) { if (r.q < 0) throw new Error('compact input: no aim to step from'); q = addAim(r.q, s8() * (aim === CI.AIM_FINE ? CI_AIM_FINE : CI_AIM_COARSE)); }
    if (q < 0) throw new Error('compact input: no aim');
    let dist = r.dist, distIdx = r.distIdx;
    if (mask & CI.DIST) {
      const v = s8();
      if (v === CI_DIST_ESCAPE) distIdx = u16();
      else { if (r.distIdx < 0) throw new Error('compact input: no distance to step from'); distIdx = r.distIdx + v; }
      if (distIdx < 0 || distIdx >= CURSOR_DIST_GRID.length) throw new Error('compact input: distance off the grid');
      dist = CURSOR_DIST_GRID[distIdx];
    }
    const seq = extra & CI_EXTRA.SEQ ? u16() : (r.seq + 1) & 0xffff;
    let hitReport, ownCheck, acks;
    if (extra & CI_EXTRA.HIT_REPORT) { need(3); hitReport = readHitReport(view, at); at += 3; }
    if (extra & CI_EXTRA.OWN_CHECK) { need(3); ownCheck = readOwnCheck(view, at); at += 3; }
    if (extra & CI_EXTRA.ACKS) acks = readInputAcks(view, at);
    this.ref = { tick, seq, keys, modes, q, dist, distIdx };
    const msg: ClientInputMessage = {
      type: 'input', seq, tick: 0, targetTick: tick,
      forward: !!(keys & 1), backward: !!(keys & 2), left: !!(keys & 4), right: !!(keys & 8), boost: !!(keys & 16),
      fireLeft: !!(keys & 32), fireRight: !!(keys & 64), jump: !!(keys & 128),
      strafeLeft: !!(modes & 1), strafeRight: !!(modes & 2), helm: !!(modes & 4), dodge: !!(modes & 8),
      // (As the base layout gives it: the server steps exactly what the client predicted)
      targetAngle: Math.fround(dequantizeCursorAngle(q)),
      cursorDist: dist,
    };
    if (acks) msg.acks = acks;
    if (hitReport) msg.hitReport = hitReport;
    if (ownCheck) msg.ownCheck = ownCheck;
    return msg;
  }
}

/** The input's fields the compact layout carries (anything else set: the base layout) */
const CARRIED = new Set<string>(['type', 'seq', 'tick', 'targetTick', 'targetAngle', 'cursorDist', 'acks', 'hitReport', 'ownCheck', ...CI_KEYS, ...CI_MODES]);

/** The client's side: one per socket (a new socket starts afresh on both ends) */
export class InputEncoder {
  private readonly dec = new InputDecoder();
  /** How each input went, for the network readout and the probe */
  readonly stats = { compact: 0, base: 0, bytes: 0 };

  get ref(): Readonly<InputRef> { return this.dec.ref; }

  /** The input's bytes: compact when `compact` and it can be said exactly, else the base layout */
  encode(msg: ClientInputMessage, compact: boolean): ArrayBuffer {
    const out = (compact && this.compact(msg)) || encodeInputBinary(msg);
    this.dec.decode(out);
    if (out.byteLength && new Uint8Array(out)[0] & CI_FLAG) this.stats.compact++; else this.stats.base++;
    this.stats.bytes += out.byteLength;
    return out;
  }

  private compact(msg: ClientInputMessage): ArrayBuffer | null {
    if (msg.targetTick === undefined) return null;
    // (A field the compact layout doesn't carry, a rider added to the base layout since: that layout, until it does)
    for (const k in msg) if (!CARRIED.has(k) && (msg as unknown as Record<string, unknown>)[k] !== undefined) return null;
    const r = this.dec.ref;
    const b: number[] = [0];
    let mask = 0, extra = 0;
    // The tick: +1 says nothing, a step of 2..255 a byte, anything else (none yet, the same, back, far) the escape
    const tick = msg.targetTick & 0xffff;
    const dt = r.tick < 0 ? -1 : (tick - r.tick) & 0xffff;
    const tickBytes = dt === 1 ? [] : dt > 1 && dt <= 255 ? [dt] : [CI_TICK_ESCAPE, tick & 0xff, tick >> 8];
    if (tickBytes.length) mask |= CI.TICK;
    const keys = bitsOf(msg, CI_KEYS), modes = bitsOf(msg, CI_MODES);
    if (keys !== r.keys) mask |= CI.KEYS;
    if (modes !== r.modes) mask |= CI.MODES;
    // The aim: a step on either grid, exactly, or the aim itself
    const q = quantizeCursorAngle(msg.targetAngle);
    let aimBytes: number[] = [];
    if (r.q < 0 || q !== r.q) {
      const d = r.q < 0 ? NaN : aimStep(r.q, q);
      if (d % CI_AIM_FINE === 0 && Math.abs(d / CI_AIM_FINE) <= 127) { mask |= CI.AIM_FINE; aimBytes = [(d / CI_AIM_FINE) & 0xff]; }
      else if (d % CI_AIM_COARSE === 0 && Math.abs(d / CI_AIM_COARSE) <= 127) { mask |= CI.AIM_COARSE; aimBytes = [(d / CI_AIM_COARSE) & 0xff]; }
      else { mask |= CI.AIM_FINE | CI.AIM_COARSE; aimBytes = [q & 0xff, q >> 8]; }
    }
    // The distance: unchanged says nothing; on the grid, a step or its index; off it, the base layout
    const dist = msg.cursorDist ?? 0;
    let distBytes: number[] = [];
    if (dist !== r.dist) {
      const idx = GRID_INDEX.get(dist);
      if (idx === undefined) return null;
      const d = r.distIdx < 0 ? NaN : idx - r.distIdx;
      distBytes = Math.abs(d) <= 127 ? [d & 0xff] : [CI_DIST_ESCAPE & 0xff, idx & 0xff, idx >> 8];
      mask |= CI.DIST;
    }
    // What rides along
    const tail: number[] = [];
    const seq = msg.seq & 0xffff;
    if (seq !== ((r.seq + 1) & 0xffff)) { extra |= CI_EXTRA.SEQ; tail.push(seq & 0xff, seq >> 8); }
    const riders = (msg.hitReport ? 3 : 0) + (msg.ownCheck ? 3 : 0);
    const at = tail.length;
    for (let i = 0; i < riders; i++) tail.push(0);
    if (msg.hitReport) extra |= CI_EXTRA.HIT_REPORT;
    if (msg.ownCheck) extra |= CI_EXTRA.OWN_CHECK;
    const acks = inputAckTail(msg.acks);
    if (acks.length) { extra |= CI_EXTRA.ACKS; tail.push(...acks); }
    if (extra) mask |= CI.EXTRA;
    b[0] = CI_FLAG | mask;
    if (extra) b.push(extra);
    b.push(...tickBytes);
    if (mask & CI.KEYS) b.push(keys);
    if (mask & CI.MODES) b.push(modes);
    b.push(...aimBytes, ...distBytes);
    const head = b.length;
    b.push(...tail);
    const out = new Uint8Array(b);
    const view = new DataView(out.buffer);
    let w = head + at;
    if (msg.hitReport) { writeHitReport(view, w, msg.hitReport); w += 3; }
    if (msg.ownCheck) writeOwnCheck(view, w, msg.ownCheck);
    return out.buffer;
  }
}
