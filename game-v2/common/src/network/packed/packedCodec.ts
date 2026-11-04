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
import { decisionRowOk } from '../../bodies/decisions.js';
import {
  PACKED_FRAME, PK, PK_BITS, PACKED_FIELDS, PK_ENTITY, PK_ENTITY_DEFAULT, PK_DATA_CHUNK, PK_PROJECTILE,
  PK_KEYFRAME, PK_KEYFRAME_TAIL, PK_GUESS_TICKS, PK_CONTROL, type PackedField,
} from './tables.js';
import { PackedIO, isId, nullish, bitsFor, E_X, E_Y, E_ANGLE, E_VX, E_VY, E_AV, E_HP, E_MAXHP, E_TICK, K, K_TICK, type PackedPart } from './packedIO.js';

export type { PackedPart } from './packedIO.js';

// ------------------------------------------------------------------------------------------------ the messages

const SNAPSHOT_CODE = COMPACT_TYPES.indexOf('snapshot');
const HITS_CODE = COMPACT_TYPES.indexOf('hits');
const HPS_CODE = COMPACT_TYPES.indexOf('shipHps');
const isArr = Array.isArray;

/** Can the snapshot's row go packed (ids where ids go, rows the shapes the packing expects)? */
function snapshotOk(w: unknown[]): boolean {
  if (w.length > 12) return false;
  const [, , , e, p, r, k, c, o, f, n, d] = w as unknown[][];
  // (Decisions: rows of whole numbers, a boss's id first, an op the packing knows: decisionsIO)
  if (d != null && !(isArr(d) && d.every((row) => decisionRowOk(row) && isId(row[0]) && row[1] <= 0 && row[1] > -4096 && row.every((v, i) => i < 3 || (v >= -(2 ** 30) && v < 2 ** 30))))) return false;
  // (Own-ship causes: rows of numbers, a kind the packing knows: ownIO)
  if (n != null && !(isArr(n) && n.every((row) => isArr(row) && row.length >= 2 && row.length <= 15 && row.every((v) => typeof v === 'number') && Number.isInteger(row[0]) && (row[0] as number) >= 0 && Number.isInteger(row[1]) && (row[1] as number) >= 0 && (row[1] as number) < 4))) return false;
  if (e != null && !(isArr(e) && e.every((row) => isArr(row) && row.length >= 2 && row.length <= 15 && isId(row[0]) && Number.isInteger(row[1]) && (row[1] as number) >= 0 && (row[1] as number) < 32))) return false;
  if (p != null && !(isArr(p) && p.every((row) => isArr(row) && row.length >= 8 && row.length <= 15 && isId(row[0]) && isId(row[7])))) return false;
  if (r != null && !(isArr(r) && r.every(isId))) return false;
  if (k != null && !(isArr(k) && k.every((row) => isArr(row) && row.length >= 1 && row.length <= 31 && isId(row[0])))) return false;
  if (c != null) {
    if (!isArr(c)) return false;
    let id = 0;
    for (const row of c) {
      if (!isArr(row) || !row.length || !isId(row[0])) return false;
      id += Math.floor((row[0] as number) / 2);
      if (!isId(id)) return false;
    }
  }
  if (o != null && !(isArr(o) && o.every(isId))) return false;
  if (f != null) {
    if (!isArr(f)) return false;
    let owner = 0, id = 0;
    for (const row of f) {
      if (!isArr(row) || row.length < 4 || !Number.isInteger(row[0])) return false;
      owner += row[0] as number;
      if (!isId(owner)) return false;
      for (let i = 4; i < row.length; i++) { if (!Number.isInteger(row[i])) return false; id += row[i] as number; if (!isId(id)) return false; }
    }
  }
  return true;
}

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
  // (Out of view: forgotten here, as removals are)
  if (has(8)) {
    const o = at(8) as unknown as number[];
    const n = io.vu(o?.length ?? 0, 2);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) { const id = io.thing(o?.[i] ?? 0); ids.push(id); io.forget(id); }
    out[8] = ids;
  } else out[8] = null;
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

/** The ticks since an entity's last row (for the guesses), and that row's tick noted */
function ticksSince(pv: number[], at: number, tick: number): number {
  const dt = Math.max(0, Math.min(PK_GUESS_TICKS, tick - pv[at]));
  pv[at] = tick;
  return dt;
}

/** Entity rows [id, type, x, y, angle, vx, vy, hp, maxHp, data, name, av]: steps from that entity's last (x, y and the angle guessed on) */
function entitiesIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const len = io.u(row?.length ?? 0, 4);
    const type = io.u((row?.[1] as number) ?? 0, 5);
    const id = io.thing((row?.[0] as number) ?? 0);
    const spec = PK_ENTITY[type] ?? PK_ENTITY_DEFAULT;
    const pv = io.prevOf(id);
    const dt = ticksSince(pv, E_TICK, tick);
    const o: unknown[] = [id, type];
    for (let i = 2; i < len; i++) {
      const v = row?.[i];
      switch (i) {
        case 2: io.guess(pv, E_X, E_VX, spec.xy, spec.v, dt); o.push(io.num(v, spec.xy, 6, pv, E_X)); break;
        case 3: io.guess(pv, E_Y, E_VY, spec.xy, spec.v, dt); o.push(io.num(v, spec.xy, 6, pv, E_Y)); break;
        case 4: io.guess(pv, E_ANGLE, E_AV, spec.angle, 6, dt); o.push(io.num(v, spec.angle, 6, pv, E_ANGLE)); break;
        case 5: o.push(io.num(v, spec.v, 6, pv, E_VX)); break;
        case 6: o.push(io.num(v, spec.v, 6, pv, E_VY)); break;
        case 7: o.push(io.num(v, 0, 3, pv, E_HP)); break;
        case 8: o.push(io.num(v, 0, 3, pv, E_MAXHP)); break;
        case 9: o.push(dataIO(io, v, spec.data)); break;
        case 11: o.push(io.num(v, 6, 5, pv, E_AV)); break;
        default: o.push(io.any(v));
      }
    }
    out.push(o);
  }
  return out;
}

/** An entity row's data: '0' null, '10' a list of numbers (whole, each index its own chunk), '11' any other value */
function dataIO(io: PackedIO, v: unknown, chunks: readonly number[]): unknown {
  if (io.reading) {
    if (io.u(0, 1) === 0) return null;
    if (io.u(0, 1) === 1) return io.any(null);
  } else {
    if (nullish(v)) { io.u(0, 1); return null; }
    if (!isArr(v)) { io.u(3, 2); io.any(v); return v; }
    io.u(2, 2);
  }
  const a = v as unknown[] | null;
  const n = io.vu(a?.length ?? 0, 3);
  const out: unknown[] = [];
  for (let j = 0; j < n; j++) out.push(io.num(a?.[j], 0, chunks[j] ?? PK_DATA_CHUNK));
  return out;
}

/**
 * Projectile rows [id, vx, vy, weaponType, ticks since fired, spawnX, spawnY, owner, gun?, tier?, size?, turret?, end?,
 * x?, y?]: the owner and gun first (the gun as the step from the last row's), then the rest, steps from that gun's last
 */
function projectilesIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 3);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const len = io.u((row?.length ?? 8) - 8, 3) + 8;
    const o: unknown[] = new Array(len);
    o[0] = io.shell((row?.[0] as number) ?? 0);
    const owner = io.youOr((row?.[7] as number) ?? 0);
    o[7] = owner;
    if (len > 8) o[8] = io.num(row?.[8], 0, PK_PROJECTILE[7][1], io.proj, 7);
    const pv = io.gunPrev(owner, o[8]);
    for (let i = 1; i < len; i++) {
      if (i === 7 || i === 8) continue;
      const [d, c, delta] = PK_PROJECTILE[i - 1];
      o[i] = delta ? io.num(row?.[i], d, c, pv, i - 1) : io.num(row?.[i], d, c);
    }
    out.push(o);
  }
  return out;
}

/** Removed ids: a shell hit lately by its place in the pending list, else a shell's slot or another entity's */
function removedIO(io: PackedIO, ids: number[] | null): number[] {
  const n = io.vu(ids?.length ?? 0, 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const id0 = ids?.[i] ?? 0;
    let id: number;
    const pend = io.pending;
    const at = io.reading ? -1 : pend.indexOf(id0);
    if (pend.length && io.bit(at >= 0)) id = pend[io.u(at, bitsFor(pend.length - 1))];
    else if (io.bit(!io.reading && io.shells.has(id0))) id = io.shell(id0);
    else id = io.thing(id0);
    if (id === undefined) throw new Error('packed: bad removal');
    out.push(id);
    io.forget(id);
  }
  return out;
}

/** Keyframe rows [id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, ctlBits, q, ...tail]: steps from that ship's last */
function keyframesIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const id = io.thing((row?.[0] as number) ?? 0);
    const len = io.u(row?.length ?? 1, 5);
    const pv = io.prevOf(id);
    const dt = ticksSince(pv, K_TICK, tick);
    const o: unknown[] = [id];
    for (let i = 1; i < len; i++) {
      const v = row?.[i];
      const spec = PK_KEYFRAME[i - 1];
      if (!spec) { o.push(io.num(v, PK_KEYFRAME_TAIL[0], PK_KEYFRAME_TAIL[1])); continue; }
      const [d, c, delta, by] = spec;
      if (!delta) { o.push(io.num(v, d, c)); continue; }
      if (by) io.guess(pv, K + i - 1, K + by - 1, d, PK_KEYFRAME[by - 1][0], dt);
      o.push(io.num(v, d, c, pv, K + i - 1));
    }
    out.push(o);
  }
  return out;
}

/**
 * A pilot's own-ship causes (network/ownTick.ts: [ago, kind, ...]): ago and kind, then each value at its field's
 * decimals (a pull's push at PULL_PLACES; a contact's other by its slot, its flags, and the other's pose and velocity
 * as steps from that ship's last keyframe or contact values, its place guessed on by its velocity: the slots and guesses
 * keyframesIO keeps)
 */
const OWN_STATE: readonly [number, number, number, number][] = [[2, 6, K + 1, K + 3], [2, 6, K + 2, K + 4], [5, 6, K + 5, K + 6], [4, 6, K + 3, -1], [4, 6, K + 4, -1]];
function ownIO(io: PackedIO, rows: unknown[][] | null, tick: number): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 1);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const len = io.u(row?.length ?? 2, 4);
    const ago = io.vu((row?.[0] as number) ?? 0, 2), kind = io.u((row?.[1] as number) ?? 0, 2);
    const o: unknown[] = [ago, kind];
    let pv: number[] | null = null, dt = 0;
    for (let i = 2; i < len; i++) {
      const v = row?.[i];
      // (a pull's push: the step from the last one, a pull lasting many ticks pushes much alike each)
      if (kind === 0) o.push(io.num(v, 5, 5, io.prevOf(-1), i - 2));
      else if (kind === 1 && i === 2) { const id = io.thing((v as number) ?? 0); o.push(id); pv = io.prevOf(id); }
      else if (kind === 1 && i === 3) o.push(io.u((v as number) ?? 0, 5));
      else if (kind === 1 && pv && i <= 8) {
        if (i === 4) dt = ticksSince(pv, K_TICK, tick - ago);
        const [d, c, k, by] = OWN_STATE[i - 4];
        if (by >= 0) io.guess(pv, k, by, d, by === K + 6 ? 6 : 4, dt);
        o.push(io.num(v, d, c, pv, k));
      }
      else if (kind === 1) o.push(io.num(v, 0, 3));
      else o.push(io.num(v, 0, 3));
    }
    out.push(o);
  }
  return out;
}

/**
 * Bosses' decisions (common bodies/decisions.ts: [id, dt, op, ...args]): the boss by its slot, how many ticks before the
 * snapshot's (dt, 0 or less), the op (4 bits), the count of args, each a signed varint (most are a byte or less)
 */
function decisionsIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  for (let r = 0; r < n; r++) {
    const row = rows?.[r] as number[] | undefined;
    const id = io.thing(row?.[0] ?? 0);
    const ago = io.vu(-(row?.[1] ?? 0), 2);
    const op = io.u(row?.[2] ?? 0, 4);
    const len = io.vu(row ? row.length - 3 : 0, 2);
    const o: number[] = [id, ago ? -ago : 0, op];
    for (let i = 0; i < len; i++) o.push(io.vs(row?.[3 + i] ?? 0, 3));
    out.push(o);
  }
  return out;
}

/** Control rows as on the wire ([idStep * 2 + run, ...]): each id goes by its slot, the run flag as a bit */
function controlsIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 3);
  const out: unknown[][] = [];
  let prev = 0;
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    const r0 = (row?.[0] as number) ?? 0;
    const id = io.thing(prev + Math.floor(r0 / 2));
    const run = io.bit(r0 % 2 === 1);
    const len = io.vu(row?.length ?? 1, 2);
    const o: unknown[] = [(id - prev) * 2 + (run ? 1 : 0)];
    for (let i = 1; i < len; i++) o.push(io.num(row?.[i], 0, PK_CONTROL[Math.min(i, PK_CONTROL.length) - 1]));
    prev = id;
    out.push(o);
  }
  return out;
}

/** Fire events as on the wire ([ownerStep, ticksAgo, part, aimQ, ...idSteps]): owners by slot (or you), shells new */
function fireIO(io: PackedIO, rows: unknown[][] | null): unknown[][] {
  const n = io.vu(rows?.length ?? 0, 2);
  const out: unknown[][] = [];
  let owner = 0, id = 0, wOwner = 0, wId = 0;
  for (let r = 0; r < n; r++) {
    const row = rows?.[r];
    if (row) wOwner += row[0] as number;
    const who = io.youOr(wOwner);
    const fp = io.firerPrev(who);
    const o: unknown[] = [who - owner, io.num(row?.[1], 0, 2), io.num(row?.[2], 0, 5, fp, 0), io.num(row?.[3], 0, 6, fp, 1)];
    owner = who;
    const k = io.vu(row ? row.length - 4 : 0, 1);
    for (let i = 0; i < k; i++) {
      if (row) wId += row[4 + i] as number;
      const s = io.newShell(wId);
      o.push(s - id);
      id = s;
    }
    out.push(o);
  }
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
  /** Messages by how they went (the netcode probe): packed, or as the base format's bytes */
  readonly stats = { packed: 0, legacy: 0, resets: 0 };

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
