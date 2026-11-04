/**
 * Bit-packed frames (CAPS.PACKED, protocol 29): the codec. The format is described in tables.ts.
 *
 * One `PackedCodec` per connection on each side: the server's encodes, the client's decodes, and both keep the same
 * state (the slot tables, the last values deltas are taken from, the shells hit and not yet removed), changed only by
 * what goes through it, so they stay in step. Every message is written and read by the same function (`PackedIO`:
 * each call writes its value or reads it back and returns it), so the two directions can't drift apart.
 *
 * Packed messages carry their compact rows (protocol.ts serverWire) and decode to exactly what the base format decodes
 * to (serverFromWire): handlers can't tell the two apart. What isn't packed goes as the base format's bytes.
 */
import { encodeBinary } from '../binaryCodec.js';
import { COMPACT_TYPES, decodeServerFrame, serverFromWire, serverWire, type ServerMessage } from '../protocol.js';
import { packHits, unpackHits } from '../hits.js';
import { PACKED_FRAME, PK, PK_BITS, PACKED_FIELDS, type PackedField } from './tables.js';
import { PackedIO, isId, type PackedPart } from './packedIO.js';
import {
  SNAPSHOT_CODE, snapshotOk, entitiesIO, projectilesIO, removedIO, keyframesIO, controlsIO, outIO, fireIO, ownIO, decisionsIO,
} from './snapshotSections.js';

import type { BlockStore } from './blocks.js';
import { planBlocks, blocksWrite, blocksRead, type BlocksPlan } from './blocksSnapshot.js';

export type { PackedPart } from './packedIO.js';

// ------------------------------------------------------------------------------------------------ the messages

const HITS_CODE = COMPACT_TYPES.indexOf('hits');
const HPS_CODE = COMPACT_TYPES.indexOf('shipHps');
const isArr = Array.isArray;

/** A snapshot's compact row ([code, t, lp, e, p, r, k, c, o, f, n, d], trailing nulls dropped) */
function snapshotIO(io: PackedIO, w: unknown[] | null): unknown[] {
  let mask = 0;
  if (w) for (let i = 1; i < w.length; i++) if (w[i] != null) mask |= 1 << (i - 1);
  mask = io.u(mask, 11);
  const out: unknown[] = [SNAPSHOT_CODE];
  const has = (i: number) => (mask & (1 << (i - 1))) !== 0;
  const at = (i: number) => (w ? w[i] : null) as unknown[][];
  const sec = io.section;
  out[1] = has(1) ? io.num(w?.[1], 0, 3, io.head, 0) : null;
  out[2] = has(2) ? io.num(w?.[2], 0, 2, io.head, 1) : null;
  sec?.('e', io.bitLength);
  const tick = typeof out[1] === 'number' ? out[1] : 0;
  out[3] = has(3) ? entitiesIO(io, at(3), tick) : null;
  sec?.('p', io.bitLength);
  out[4] = has(4) ? projectilesIO(io, at(4)) : null;
  sec?.('r', io.bitLength);
  out[5] = has(5) ? removedIO(io, at(5) as unknown as number[]) : null;
  sec?.('k', io.bitLength);
  out[6] = has(6) ? keyframesIO(io, at(6), tick) : null;
  sec?.('c', io.bitLength);
  out[7] = has(7) ? controlsIO(io, at(7)) : null;
  sec?.('o', io.bitLength);
  out[8] = has(8) ? outIO(io, at(8) as unknown as number[]) : null;
  sec?.('f', io.bitLength);
  out[9] = has(9) ? fireIO(io, at(9)) : null;
  sec?.('n', io.bitLength);
  out[10] = has(10) ? ownIO(io, at(10), tick) : null;
  sec?.('d', io.bitLength);
  out[11] = has(11) ? decisionsIO(io, at(11)) : null;
  sec?.('end', io.bitLength);
  while (out.length > 1 && out[out.length - 1] === null) out.pop();
  return out;
}

/** Confirmed hits ([code, h]): each record's shell by its slot, its target by slot (or you) when it changes */
function hitsIO(io: PackedIO, w: unknown[] | null): unknown[] {
  const recs = w ? unpackHits(w[1] as number[]) : [];
  const n = io.vu(recs.length, 2);
  const out: ReturnType<typeof unpackHits> = [];
  let target = -1;
  for (let i = 0; i < n; i++) {
    const r = recs[i];
    const shell = io.shell(r?.shell ?? 0);
    const ago = io.u(r?.ago ?? 0, 3);
    if (io.bit(!!r && r.target !== target)) target = io.youOr(r?.target ?? 0);
    const rec: (typeof out)[number] = { shell, ago, target, part: io.vs(r?.part ?? 0, 4), gone: io.bit(!!r?.gone), glancing: io.bit(!!r?.glancing) };
    if (io.bit(!!r && (r.d10 !== undefined || !!r.shield || r.ignite !== undefined))) {
      if (io.bit(r?.d10 !== undefined)) rec.d10 = io.vs(r?.d10 ?? 0, 6);
      if (io.bit(!!r?.shield)) rec.shield = true;
      if (io.bit(r?.ignite !== undefined)) rec.ignite = io.vs(r?.ignite ?? 0, 4);
    }
    out.push(rec);
    if (rec.gone) io.forget(shell);
  }
  return [HITS_CODE, packHits(out)];
}

function hitsOk(w: unknown[]): boolean {
  if (w.length !== 2 || !isArr(w[1])) return false;
  const h = w[1] as unknown[];
  if (!h.every((x) => Number.isSafeInteger(x))) return false;
  const recs = unpackHits(h as number[]);
  if (!recs.every((r) => isId(r.shell) && isId(r.target))) return false;
  const again = packHits(recs);
  return again.length === h.length && again.every((x, i) => x === h[i]);
}

/** Part HP ([code, [[ship, [[part, hp], ...]], ...]]) */
function hpsIO(io: PackedIO, w: unknown[] | null): unknown[] {
  const ships = (w?.[1] ?? null) as [number, number[][]][] | null;
  const n = io.vu(ships?.length ?? 0, 1);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const s = ships?.[i];
    const id = io.youOr(s?.[0] ?? 0);
    out.push([id, io.pairs(s?.[1], id)]);
  }
  return [HPS_CODE, out];
}

function hpsOk(w: unknown[]): boolean {
  return w.length === 2 && isArr(w[1]) && (w[1] as unknown[]).every((s) => isArr(s) && s.length === 2 && isId(s[0]));
}

/** The field-by-field messages, by compact code */
const BY_CODE = new Map<number, { type: string; pk: number; fields: readonly PackedField[] }>();
const BY_PK = new Map<number, { code: number; fields: readonly PackedField[] }>();
for (const [type, { code: pk, fields }] of Object.entries(PACKED_FIELDS)) {
  const code = COMPACT_TYPES.indexOf(type);
  if (code < 0) throw new Error(`packed: ${type} isn't a compact type`);
  BY_CODE.set(code, { type, pk, fields });
  BY_PK.set(pk, { code, fields });
}

function fieldsIO(io: PackedIO, code: number, fields: readonly PackedField[], w: unknown[] | null): unknown[] {
  const len = io.u((w?.length ?? 1) - 1, 4);
  const out: unknown[] = [code];
  for (let i = 0; i < len; i++) out.push(io.field(w?.[i + 1], fields[Math.min(i, fields.length - 1)], out[1]));
  return out;
}

// ------------------------------------------------------------------------------------------------ frames

/** The server's side, one per connection */
export class PackedEncoder {
  private io = new PackedIO();
  private started = false;
  /** Messages by how they went (the netcode probe): packed, or as the base format's bytes; snapshots as blocks */
  readonly stats = { packed: 0, legacy: 0, resets: 0, blocks: 0 };
  /** Snapshots planned as blocks (prepare), each when it was queued (null: it goes as PK.SNAPSHOT) */
  private plans = new WeakMap<ServerMessage, BlocksPlan | null>();

  /** `store`: the server's encode-once blocks (CAPS.BLOCKS: blocks.ts), shared by every client's encoder */
  constructor(private readonly store: BlockStore | null = null) {}

  /**
   * A snapshot queued for this client while it takes blocks: its blocks are made (once, for every client) now, in
   * snapshot order, so each entity's chain moves on a snapshot at a time whenever this client's frame goes
   */
  prepare(msg: ServerMessage, you: number): void {
    if (this.store && msg.type === 'snapshot' && !this.plans.has(msg)) this.plans.set(msg, planBlocks(this.store, msg, you));
  }

  /** Start afresh with the next frame (the client lost track: packedResync) */
  reset(): void {
    this.started = false;
  }

  /** Sub-frames (each a tick's messages, in order) as one WebSocket message, for the client whose ship is `you` */
  encode(subs: readonly (readonly PackedPart[])[], you: number): Uint8Array {
    const io = this.io;
    io.startWrite();
    io.u(PACKED_FRAME, 8);
    const reset = !this.started || io.you !== you || io.tablesFull;
    io.bit(reset);
    if (reset) {
      io.resetState(you);
      io.vs(you, 8);
      this.started = true;
      this.stats.resets++;
    }
    for (let s = 0; s < subs.length; s++) {
      for (const part of subs[s]) this.message(part);
      io.u(s === subs.length - 1 ? PK.LAST : PK.END, PK_BITS);
    }
    if (!subs.length) io.u(PK.LAST, PK_BITS);
    return io.take();
  }

  private message(part: PackedPart): void {
    const io = this.io;
    const plan = this.store && part.msg.type === 'snapshot' ? this.plans.get(part.msg) : undefined;
    if (plan) { io.u(PK.BLOCKS, PK_BITS); blocksWrite(io, plan); this.stats.packed++; this.stats.blocks++; return; }
    const wire = serverWire(part.msg);
    if (isArr(wire)) {
      const code = wire[0] as number;
      if (code === SNAPSHOT_CODE && snapshotOk(wire)) { io.u(PK.SNAPSHOT, PK_BITS); snapshotIO(io, wire); this.stats.packed++; return; }
      if (code === HITS_CODE && hitsOk(wire)) { io.u(PK.HITS, PK_BITS); hitsIO(io, wire); this.stats.packed++; return; }
      if (code === HPS_CODE && hpsOk(wire)) { io.u(PK.SHIP_HPS, PK_BITS); hpsIO(io, wire); this.stats.packed++; return; }
      const f = BY_CODE.get(code);
      if (f && wire.length - 1 <= 15) { io.u(f.pk, PK_BITS); fieldsIO(io, code, f.fields, wire); this.stats.packed++; return; }
    }
    io.u(PK.LEGACY, PK_BITS);
    io.legacy(part.bytes ?? encodeBinary(wire));
    this.stats.legacy++;
  }
}

/** The client's side: packed WebSocket messages back into their sub-frames' messages */
export class PackedDecoder {
  private io = new PackedIO();
  /** Lost track (a frame that didn't decode): nothing more is read until the server starts afresh */
  broken = true;

  decode(data: Uint8Array): ServerMessage[][] {
    const io = this.io;
    if (data[0] !== PACKED_FRAME) throw new Error('not a packed frame');
    io.startRead(data, 1);
    const reset = io.bit(false);
    if (reset) { io.resetState(io.vs(0, 8)); this.broken = false; }
    if (this.broken) return [];
    try {
      const subs: ServerMessage[][] = [[]];
      for (;;) {
        const pk = io.u(0, PK_BITS);
        if (pk === PK.LAST) break;
        if (pk === PK.END) { subs.push([]); continue; }
        subs[subs.length - 1].push(serverFromWire(this.message(pk)));
      }
      if (!subs[subs.length - 1].length) subs.pop();
      return subs;
    } catch (e) {
      this.broken = true;
      throw e;
    }
  }

  private message(pk: number): unknown {
    const io = this.io;
    switch (pk) {
      case PK.LEGACY: return io.legacy(null);
      case PK.SNAPSHOT: return snapshotIO(io, null);
      case PK.BLOCKS: return blocksRead(io);
      case PK.HITS: return hitsIO(io, null);
      case PK.SHIP_HPS: return hpsIO(io, null);
    }
    const f = BY_PK.get(pk);
    if (!f) throw new Error(`packed: unknown code ${pk}`);
    return fieldsIO(io, f.code, f.fields, null);
  }
}

/**
 * A client's reader for whatever the server sends: a base-format frame (one sub-frame) or a packed message (one or
 * more). `needsResync`: a packed message didn't decode, so the server should start afresh (packedResync).
 */
export class ServerFrameReader {
  private packed = new PackedDecoder();
  get needsResync(): boolean {
    return this.packed.broken && this.sawPacked;
  }
  private sawPacked = false;

  read(data: string | ArrayBuffer | Uint8Array): ServerMessage[][] {
    if (typeof data !== 'string') {
      const b = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (b[0] === PACKED_FRAME) { this.sawPacked = true; return this.packed.decode(b); }
    }
    return [decodeServerFrame(data)];
  }
}
