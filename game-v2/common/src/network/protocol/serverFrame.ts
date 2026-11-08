/**
 * @contract protocol.server-frame
 * owns:       server frames: encoding messages to bytes, splitting and decoding frames, snapshot byte caching
 * needs:      compact, snapshotCodec, inputBinary, binaryCodec
 * invariants: encodeSnapshot equals encodeBinary(packCompact(snapshot)) — common/src/network/protocol.test.ts
 * extend:     a new frame kind is a leading byte constant and a branch in decodeServerFrame
 */
import { encodeBinary, BinaryReader, BinaryWriter } from '../binaryCodec.js';
import type { ClientMessage } from './clientMessages.js';
import type { ServerSnapshotMessage } from './serverCore.js';
import type { ServerMessage } from './serverMessage.js';
import { decodeInputBinary, isBinaryMessage } from './inputBinary.js';
import { COMPACT_CODE, packCompact, unpackServer } from './compact.js';
import { packEntities, packFire } from './snapshotCodec.js';
/**
 * Everything in one frame from the server: a single message, or a batch of the
 * messages a tick produced ({ type: 'batch', m: [...] }).
 */
// ---------------------------------------------------------------------------
// Server → client frames are binary (binaryCodec.ts): SERVER_FRAME, then each
// message's wire form (a compact row, or a plain object) one after another.

export const SERVER_FRAME = 0x02;

/**
 * A server message's wire form (its compact row, a packed snapshot's row, or the plain object): what
 * encodeServerMessage writes as bytes and the bit-packed frames (network/packed) write as bits
 */
export function serverWire(msg: ServerMessage): unknown {
  return packCompact(msg) ?? msg;
}

/** A wire form back to its message (as a frame's reader does) */
export function serverFromWire(wire: unknown): ServerMessage {
  return unpackServer(wire);
}

/** A server message's bytes (encode once, send to every client it's for) */
export function encodeServerMessage(msg: ServerMessage): Uint8Array {
  if (msg.type === 'snapshot') return encodeSnapshot(msg);
  return encodeBinary(packCompact(msg) ?? msg);
}

/**
 * A snapshot's bytes: exactly what encodeBinary(packCompact(snapshot)) gives (protocol.test.ts holds it to that),
 * but each keyframe and control row is encoded once and its bytes kept with it. The server makes those rows once a
 * snapshot for every client that gets them (its Replication) and never changes one after, so each client's snapshot
 * copies them in rather than encoding them again. A control row's id goes as the step from the one before (see
 * packCtlIds), so what's kept of one is the rest of it.
 */
const keyframeBytes = new WeakMap<readonly number[], Uint8Array>();
const ctlTailBytes = new WeakMap<readonly number[], Uint8Array>();
const rowWriter = new BinaryWriter();
const snapWriter = new BinaryWriter();
const SNAPSHOT_CODE = COMPACT_CODE.get('snapshot')!.code;

function rowBytes(cache: WeakMap<readonly number[], Uint8Array>, row: readonly number[], from: number): Uint8Array {
  let b = cache.get(row);
  if (!b) {
    if (from === 0) rowWriter.value(row);
    else for (let i = from; i < row.length; i++) rowWriter.value(row[i]);
    b = rowWriter.take();
    cache.set(row, b);
  }
  return b;
}

function encodeSnapshot(m: ServerSnapshotMessage): Uint8Array {
  const { e, p } = packEntities(m);
  // (The compact row: [code, t, lp, e, p, r, k, c, o, f, n, d, x, w, h, g], absent ones null and trailing nulls dropped)
  const row: unknown[] = [SNAPSHOT_CODE, m.tick ?? null, m.lastProcessedInput ?? null, e.length ? e : null, p.length ? p : null,
    m.removed.length ? m.removed : null, m.ships?.length ? m.ships : null, m.ctl?.length ? m.ctl : null,
    m.out?.length ? m.out : null, m.fire?.length ? packFire(m.fire) : null, m.own?.length ? m.own : null, m.decisions?.length ? m.decisions : null, m.causes?.length ? m.causes : null, m.guides?.length ? m.guides : null, m.hh ?? null, m.gun?.length ? m.gun : null];
  while (row.length > 1 && row[row.length - 1] === null) row.pop();
  const w = snapWriter;
  w.arrayHeader(row.length);
  for (let i = 0; i < row.length; i++) {
    if (i === 6 && m.ships?.length) {
      w.arrayHeader(m.ships.length);
      for (const k of m.ships) w.bytes(rowBytes(keyframeBytes, k, 0));
    } else if (i === 7 && m.ctl?.length) {
      // (As packCtlIds: in id order, each id the step from the one before, doubled, plus 1 for a run row)
      const ided = m.ctl.map((r) => (r[0] < 0 ? { id: -1 - r[0], run: 1, r } : { id: r[0], run: 0, r })).sort((a, b) => a.id - b.id);
      w.arrayHeader(ided.length);
      let prev = 0;
      for (const { id, run, r } of ided) {
        w.arrayHeader(r.length);
        w.number((id - prev) * 2 + run);
        w.bytes(rowBytes(ctlTailBytes, r, 1));
        prev = id;
      }
    } else {
      w.value(row[i]);
    }
  }
  return w.take();
}

/** A frame of encoded messages */
export function serverFrame(parts: Uint8Array[]): Uint8Array {
  let n = 1;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  out[0] = SERVER_FRAME;
  let at = 1;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function bytesOf(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** A binary frame's messages, each with its size on the wire (for tools that count traffic) */
export function splitServerFrame(data: ArrayBuffer | Uint8Array): { msg: ServerMessage; wire: unknown; bytes: number }[] {
  const buf = bytesOf(data);
  if (buf[0] !== SERVER_FRAME) throw new Error('not a server frame');
  const r = new BinaryReader(buf);
  r.pos = 1;
  const out: { msg: ServerMessage; wire: unknown; bytes: number }[] = [];
  while (!r.done) {
    const at = r.pos;
    const wire = r.value();
    out.push({ msg: unpackServer(wire), wire, bytes: r.pos - at });
  }
  return out;
}

export function decodeServerFrame(data: string | ArrayBuffer | Uint8Array): ServerMessage[] {
  if (typeof data !== 'string') {
    const buf = bytesOf(data);
    if (buf[0] !== SERVER_FRAME) return [decodeMessage(buf) as ServerMessage];
    const r = new BinaryReader(buf);
    r.pos = 1;
    const out: ServerMessage[] = [];
    while (!r.done) out.push(unpackServer(r.value()));
    return out;
  }
  const m = JSON.parse(data);
  const list: unknown[] = !Array.isArray(m) && m.type === 'batch' ? m.m : [m];
  return list.map(unpackServer);
}

export function decodeMessage(data: string | ArrayBuffer | Uint8Array): ClientMessage | ServerMessage {
  // Check for binary message
  if (typeof data !== 'string') {
    if (isBinaryMessage(data)) {
      return decodeInputBinary(data);
    }
    // Unknown binary format - should not happen, but try to handle gracefully
    throw new Error('Unknown binary message format');
  }
  const m = JSON.parse(data);
  return Array.isArray(m) || m.type === 'snapshot' ? unpackServer(m) : m;
}

