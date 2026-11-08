/**
 * @contract protocol.input-binary
 * owns:       the fixed binary layout of the input message, its riders (hit report, acks, checks) and its decoder
 * needs:      cursorDist, cursorState, hits, ownTick, inputCompactTables
 * invariants: encode then decode returns the input — common/src/network/protocol.test.ts
 *             byte layout is pinned by the wire hash — common/src/network/protocol.test.ts
 * extend:     a new rider is a flag bit plus a write and read pair here (bump the protocol version)
 */
import { CURSOR_DIST_STEP, quantizeCursorDist } from '../cursorDist.js';
import { quantizeCursorAngle, dequantizeCursorAngle } from '../cursorState.js';
import type { HitReport } from '../hits.js';
import type { OwnCheck } from '../ownTick.js';
import { CI_FLAG } from '../inputCompactTables.js';
import type { ClientInputMessage, BodyCheck } from './clientMessages.js';
// ============================================
// BINARY ENCODING FOR HIGH-FREQUENCY MESSAGES
// ============================================

// Binary message type IDs (first byte)
export const BINARY_MSG_INPUT_V1 = 0x01;
export const BINARY_MSG_INPUT = 0x03;
/** (The base layout with the weapon groups byte at [11], before the riders: ClientInputMessage.weaponGroups) */
export const BINARY_MSG_INPUT_G = 0x04;

// Input message binary format (11 bytes):
// [0]    : BINARY_MSG_INPUT
// [1-2]  : seq (16 bits)
// [3-4]  : targetTick, low 16 bits (the server takes the tick nearest its own: unwrapTick16)
// [5]    : flags (forward, backward, left, right, boost, fireLeft, fireRight)
// [6-7]  : aim angle in the 13-bit cursor quantization (the client only ever sends those)
// [8-9]  : cursorDist / CURSOR_DIST_STEP (16 bits)
// [10]   : flags2 (strafeLeft, strafeRight, helm, jump, has targetTick, hit report, dodge, own check)
// The tick the client was at isn't sent: nothing reads it.
// (Type 0x04: the same, then [11] the weapon groups selection (ClientInputMessage.weaponGroups); the riders follow it.)
// (The old 17-byte form, type 0x01, still decodes.)
// (Protocol 35, CAPS.INPUTS: the compact form, first byte 0x80 | the groups that changed: inputCompactTables.ts. It needs
// the last input on the socket to read, so it decodes only through an InputDecoder, never decodeInputBinary.)

/** A tick from its low 16 bits: the one nearest `near` */
export function unwrapTick16(low: number, near: number): number {
  const d = ((low - near) % 65536 + 65536 + 32768) % 65536 - 32768;
  return near + d;
}

/**
 * After the 11 bytes, optionally: a hit report (protocol 28, flags2 0x20: the chain's low byte, then 16 bits: the
 * snapshot tick's low 14 and the correction count's 2, ClientInputMessage.hitReport), then debris acks (protocol 25: a
 * count byte then each piece's id as a little-endian base-128 varint and its 8-bit check, ClientInputMessage.acks)
 */
const INPUT_BYTES = 11;
const MAX_INPUT_ACKS = 32;
const HIT_REPORT = 0x20;
const HIT_REPORT_BYTES = 3;
/** (protocol 34, flags2 0x80: an own check after the hit report: the state hash's byte, then 16 bits: the hp hash's 4 and the tick's low 12) */
const OWN_CHECK = 0x80;
const OWN_CHECK_BYTES = 3;
/** (Protocol 36, CAPS.BODIES: the first flags byte's top bit, a body check after the own check) */
const BODY_CHECK = 0x80;
const BODY_CHECK_BYTES = 3;

/** Debris acks as they follow an input (both layouts): a count byte, then each piece's id as a base-128 varint and its check */
export function inputAckTail(acks: number[] | undefined): number[] {
  if (!acks?.length) return [];
  const n = Math.min(MAX_INPUT_ACKS, acks.length >> 1);
  const out = [n];
  for (let i = 0; i < n; i++) {
    let id = Math.max(0, Math.floor(acks[i * 2])) >>> 0;
    do { const b = id & 0x7f; id >>>= 7; out.push(id ? b | 0x80 : b); } while (id);
    out.push(acks[i * 2 + 1] & 0xff);
  }
  return out;
}

export function readInputAcks(view: DataView, at = INPUT_BYTES): number[] | undefined {
  if (view.byteLength <= at) return undefined;
  const n = Math.min(MAX_INPUT_ACKS, view.getUint8(at++));
  const out: number[] = [];
  for (let i = 0; i < n && at < view.byteLength; i++) {
    let id = 0, shift = 0, b = 0, mul = 1;
    do { if (at >= view.byteLength || shift > 28) return out; b = view.getUint8(at++); id += (b & 0x7f) * mul; mul *= 128; shift += 7; } while (b & 0x80);
    if (at >= view.byteLength) return out;
    out.push(id, view.getUint8(at++));
  }
  return out.length ? out : undefined;
}

/** A hit report as it follows an input (3 bytes: the chain's low byte, then the tick's low 14 bits and the epoch's 2) */
export function writeHitReport(view: DataView, at: number, rep: HitReport): void {
  view.setUint8(at, rep.hash & 0xff);
  view.setUint16(at + 1, (rep.tick & 0x3fff) | ((rep.epoch & 3) << 14), true);
}
export function readHitReport(view: DataView, at: number): HitReport {
  const tt = view.getUint16(at + 1, true);
  return { hash: view.getUint8(at), tick: tt & 0x3fff, epoch: tt >>> 14 };
}
/** A body check as it follows an input (3 bytes: the hash byte, then the tick's low 12 bits) */
export function writeBodyCheck(view: DataView, at: number, chk: BodyCheck): void {
  view.setUint8(at, chk.hash & 0xff);
  view.setUint16(at + 1, chk.tick & 0xfff, true);
}
export function readBodyCheck(view: DataView, at: number): BodyCheck {
  return { hash: view.getUint8(at), tick: view.getUint16(at + 1, true) & 0xfff };
}
/** An own check as it follows an input (3 bytes: the state hash's byte, then the tick's low 12 bits and the hp hash's 4) */
export function writeOwnCheck(view: DataView, at: number, chk: OwnCheck): void {
  view.setUint8(at, chk.body & 0xff);
  view.setUint16(at + 1, (chk.tick & 0xfff) | ((chk.hp & 15) << 12), true);
}
export function readOwnCheck(view: DataView, at: number): OwnCheck {
  const ct = view.getUint16(at + 1, true);
  return { body: view.getUint8(at), hp: ct >>> 12, tick: ct & 0xfff };
}

export function encodeInputBinary(msg: ClientInputMessage): ArrayBuffer {
  const g = msg.weaponGroups, head = INPUT_BYTES + (g !== undefined ? 1 : 0);
  const tail = inputAckTail(msg.acks), rep = msg.hitReport, chk = msg.ownCheck, bck = msg.bodyCheck, at0 = head + (rep ? HIT_REPORT_BYTES : 0), at1 = at0 + (chk ? OWN_CHECK_BYTES : 0), at = at1 + (bck ? BODY_CHECK_BYTES : 0);
  const buffer = new ArrayBuffer(at + tail.length);
  const view = new DataView(buffer);
  for (let i = 0; i < tail.length; i++) view.setUint8(at + i, tail[i]);
  if (g !== undefined) view.setUint8(INPUT_BYTES, g & 0xff);
  if (rep) writeHitReport(view, head, rep);
  if (chk) writeOwnCheck(view, at0, chk);
  if (bck) writeBodyCheck(view, at1, bck);
  view.setUint8(0, g !== undefined ? BINARY_MSG_INPUT_G : BINARY_MSG_INPUT);
  view.setUint16(1, msg.seq & 0xFFFF, true);
  view.setUint16(3, (msg.targetTick ?? 0) & 0xFFFF, true);
  view.setUint8(5,
    (msg.forward ? 0x01 : 0) |
    (msg.backward ? 0x02 : 0) |
    (msg.left ? 0x04 : 0) |
    (msg.right ? 0x08 : 0) |
    (msg.boost ? 0x10 : 0) |
    (msg.fireLeft ? 0x20 : 0) |
    (msg.fireRight ? 0x40 : 0) |
    (bck ? BODY_CHECK : 0));
  view.setUint16(6, quantizeCursorAngle(msg.targetAngle), true);
  view.setUint16(8, quantizeCursorDist(msg.cursorDist ?? 0), true);
  view.setUint8(10,
    (msg.strafeLeft ? 0x01 : 0) |
    (msg.strafeRight ? 0x02 : 0) |
    (msg.helm ? 0x04 : 0) |
    (msg.jump ? 0x08 : 0) |
    (msg.targetTick !== undefined ? 0x10 : 0) |
    (rep ? HIT_REPORT : 0) |
    (msg.dodge ? 0x40 : 0) |
    (chk ? OWN_CHECK : 0));
  return buffer;
}

export function decodeInputBinary(data: ArrayBuffer | Uint8Array): ClientInputMessage {
  // (A Node Buffer shares a larger ArrayBuffer: respect its offset and length)
  const view = data instanceof ArrayBuffer ? new DataView(data) : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint8(0) === BINARY_MSG_INPUT_V1) return decodeInputV1(view);
  if (view.getUint8(0) & CI_FLAG) throw new Error('a compact input decodes only through an InputDecoder');
  const flags = view.getUint8(5);
  const flags2 = view.getUint8(10);
  const grouped = view.getUint8(0) === BINARY_MSG_INPUT_G && view.byteLength > INPUT_BYTES, head = grouped ? INPUT_BYTES + 1 : INPUT_BYTES;
  const rep = flags2 & HIT_REPORT && view.byteLength >= head + HIT_REPORT_BYTES;
  const at0 = rep ? head + HIT_REPORT_BYTES : head;
  const chk = flags2 & OWN_CHECK && view.byteLength >= at0 + OWN_CHECK_BYTES;
  const at1 = chk ? at0 + OWN_CHECK_BYTES : at0;
  const bck = flags & BODY_CHECK && view.byteLength >= at1 + BODY_CHECK_BYTES;
  return {
    type: 'input',
    seq: view.getUint16(1, true),
    tick: 0,
    targetTick: flags2 & 0x10 ? view.getUint16(3, true) : undefined,
    forward: (flags & 0x01) !== 0,
    backward: (flags & 0x02) !== 0,
    left: (flags & 0x04) !== 0,
    right: (flags & 0x08) !== 0,
    boost: (flags & 0x10) !== 0,
    fireLeft: (flags & 0x20) !== 0,
    fireRight: (flags & 0x40) !== 0,
    // As the old float32 form carried it, so the server steps exactly what the client predicted
    targetAngle: Math.fround(dequantizeCursorAngle(view.getUint16(6, true))),
    strafeLeft: (flags2 & 0x01) !== 0,
    strafeRight: (flags2 & 0x02) !== 0,
    helm: (flags2 & 0x04) !== 0,
    jump: (flags2 & 0x08) !== 0,
    dodge: (flags2 & 0x40) !== 0,
    cursorDist: view.getUint16(8, true) * CURSOR_DIST_STEP,
    acks: readInputAcks(view, bck ? at1 + BODY_CHECK_BYTES : at1),
    ...(rep ? { hitReport: readHitReport(view, head) } : {}),
    ...(chk ? { ownCheck: readOwnCheck(view, at0) } : {}),
    ...(bck ? { bodyCheck: readBodyCheck(view, at1) } : {}),
    ...(grouped ? { weaponGroups: view.getUint8(INPUT_BYTES) } : {}),
  };
}

function decodeInputV1(view: DataView): ClientInputMessage {
  const flags = view.getUint8(9);
  const flags2 = view.byteLength > 14 ? view.getUint8(14) : 0;
  return {
    type: 'input',
    seq: view.getUint16(1, true),
    tick: view.getUint8(3) | (view.getUint8(4) << 8) | (view.getUint8(5) << 16),
    targetTick: view.getUint8(6) | (view.getUint8(7) << 8) | (view.getUint8(8) << 16),
    forward: (flags & 0x01) !== 0,
    backward: (flags & 0x02) !== 0,
    left: (flags & 0x04) !== 0,
    right: (flags & 0x08) !== 0,
    boost: (flags & 0x10) !== 0,
    fireLeft: (flags & 0x20) !== 0,
    fireRight: (flags & 0x40) !== 0,
    targetAngle: view.getFloat32(10, true),
    strafeLeft: (flags2 & 0x01) !== 0,
    strafeRight: (flags2 & 0x02) !== 0,
    helm: (flags2 & 0x04) !== 0,
    jump: (flags2 & 0x08) !== 0,
    cursorDist: view.byteLength > 16 ? view.getUint16(15, true) * CURSOR_DIST_STEP : 0,
  };
}

/**
 * Check if data is a binary message (starts with known binary type ID)
 */
export function isBinaryMessage(data: ArrayBuffer | Uint8Array | string): boolean {
  if (typeof data === 'string') return false;
  // Handle Node.js Buffer properly - must respect byteOffset and byteLength
  let view: DataView;
  if (data instanceof ArrayBuffer) {
    view = new DataView(data);
  } else {
    view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  const firstByte = view.getUint8(0);
  return firstByte === BINARY_MSG_INPUT || firstByte === BINARY_MSG_INPUT_G || firstByte === BINARY_MSG_INPUT_V1 || (firstByte & CI_FLAG) !== 0;
}

