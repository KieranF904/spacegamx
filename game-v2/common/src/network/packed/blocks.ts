/**
 * Encode-once blocks (CAPS.BLOCKS, with PACKED; docs/design/awareness-model.md 7.6): a snapshot's rows about other
 * entities (their status rows, keyframes, control rows, fire events) are each bit-packed once per snapshot, into a
 * block every client that gets that row copies as it is. Nothing in a block depends on the client:
 *
 * - **Ids** are per-system wire ids (BlockStore.widOf: dense, lowest free first, the same for every client), coded in
 *   8-18 bits (PackedIO.wid). A client learns a wid's entity once, from an intro in the snapshot that first uses it.
 * - **Delta bases are per entity** ("chains"): a status row or keyframe is coded as the step from that entity's chain,
 *   which is where its last canonical block left every holder. The server keeps one chain per entity (the wire shadow:
 *   what its holders have of it), and each block comes in two forms: delta (for clients holding the chain's generation
 *   it was coded from) and absolute (anyone else; the same bits for all of them). After either, a holder's chain is
 *   the same function of the row (`settle`), so both end where the shared chain does.
 * - Per client, the server keeps only which wids it has been told and the generation it holds of each chain
 *   (blockPeer.ts); the snapshot itself (packedCodec.ts blocksIO) is a header, those intros and the copied blocks.
 *
 * A row is canonical (it moves its entity's chain on) when it is the first of its chain this snapshot and not a first
 * sight (a ship's or pilot's row that carries where it is: only new holders get that one). Fire events and control
 * rows have no base: one form each.
 */
import { EntityType, SNAP_FIELDS, packProjectile, type EntityState } from '../protocol.js';
import { PK_ENTITY, PK_ENTITY_DEFAULT, PK_KEYFRAME, PK_CONTROL, PK_PROJECTILE } from './tables.js';
import { PackedIO, POW10, isId, E_X, E_Y, E_ANGLE, E_VX, E_VY, E_AV, E_HP, E_MAXHP, E_TICK } from './packedIO.js';
import { entityFieldsIO, keyframeFieldsIO, gunRowOk, gunRowBody } from './rowsIO.js';

/** A block's bits */
export interface Bits { b: Uint8Array; n: number }

/** An encoded row: who it's about, its wid, its forms, and the chain generations it steps from and to */
export interface BlockRec {
  eid: number;
  wid: number;
  tick: number;
  /** The absolute form (or the only one) */
  abs: Bits;
  /** The delta form (canonical rows of a chain that had a generation before) */
  delta?: Bits;
  before: number;
  /** The generation its holders end at (-1: not canonical, they hold none they can step from) */
  after: number;
  /** A shell row's gun chain (owner and gun: gunKey), -1 none */
  gun?: number;
}

/** A status row made from another (a name added for one client): the row its block is made from */
export const ROW_BASE = Symbol('rowBase');
/** `row` with `extra` on top, its block that of `row` (the extras go apart: a name) */
export function derivedRow<T extends object>(row: T, extra: Partial<T>): T {
  const out = { ...row, ...extra };
  Object.defineProperty(out, ROW_BASE, { value: (row as Record<symbol, unknown>)[ROW_BASE] ?? row, enumerable: false });
  return out;
}

const E_LEN = E_TICK + 1;
const K_LEN = PK_KEYFRAME.length + 1;
const K_TICK_AT = PK_KEYFRAME.length;

/** A value's mantissa at d decimals when it's exact there (what num steps from), else 0 */
function mant(v: unknown, d: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const m = Math.round(v * POW10[d]);
  return Math.abs(m) < 2 ** 50 && m / POW10[d] === v ? m : 0;
}

/** A status row's chain after it (whatever it stepped from) */
export function settleEntity(pv: number[], o: readonly unknown[], tick: number): void {
  const spec = PK_ENTITY[o[1] as number] ?? PK_ENTITY_DEFAULT;
  pv[E_X] = mant(o[2], spec.xy); pv[E_Y] = mant(o[3], spec.xy); pv[E_ANGLE] = mant(o[4], spec.angle);
  pv[E_VX] = mant(o[5], spec.v); pv[E_VY] = mant(o[6], spec.v); pv[E_HP] = mant(o[7], 0); pv[E_MAXHP] = mant(o[8], 0);
  pv[E_AV] = mant(o[11], 6); pv[E_TICK] = tick;
}

/** A keyframe's chain after it */
export function settleKeyframe(pv: number[], o: readonly unknown[], tick: number): void {
  for (let j = 0; j < PK_KEYFRAME.length; j++) pv[j] = PK_KEYFRAME[j][2] ? mant(o[j + 1], PK_KEYFRAME[j][0]) : 0;
  pv[K_TICK_AT] = tick;
}

/** A shell row's chain: its owner's gun (as the per-connection codec's gunPrev keys it), or -1 (no whole gun: no chain) */
export function gunKey(owner: number, gun: unknown): number {
  return typeof gun === 'number' && Number.isInteger(gun) && gun >= 0 && gun < 2 ** 20 && owner < 2 ** 28 ? owner * 2 ** 20 + gun : -1;
}
/** A shell row chain's fields: PK_PROJECTILE's, then the last shell's id */
export const P_ID = PK_PROJECTILE.length;

/** A shell row's chain after it: its delta fields, and its id */
export function settleProjectile(pv: number[], o: readonly unknown[]): void {
  for (let i = 1; i <= PK_PROJECTILE.length; i++) pv[i - 1] = i !== 7 && i !== 8 && PK_PROJECTILE[i - 1][2] ? mant(o[i], PK_PROJECTILE[i - 1][0]) : 0;
  pv[P_ID] = o[0] as number;
}

// ---- Block bodies: each writes (or reads) a block after its wid ----

/** A status row's block body: absolute bit, length, type, fields (no name) from `pv`. Returns the row with id slot 0 */
export function entityBody(io: PackedIO, row: unknown[] | undefined, pv: number[], tick: number): unknown[] {
  const len = io.u(row?.length ?? 0, 4);
  const type = io.u((row?.[1] as number) ?? 0, 5);
  const o: unknown[] = [0, type];
  entityFieldsIO(io, row, len, type, pv, tick, o, true);
  return o;
}

export function keyframeBody(io: PackedIO, row: unknown[] | undefined, pv: number[], tick: number): unknown[] {
  const len = io.u(row?.length ?? 1, 5);
  const o: unknown[] = [0];
  keyframeFieldsIO(io, row, len, pv, 0, K_TICK_AT, tick, o);
  return o;
}

/** A control row's block body after the wid ([id or -1 - id for a run row, ...]): the run bit, then the values */
export function controlBody(io: PackedIO, row: readonly number[] | undefined): { run: boolean; rest: unknown[] } {
  const run = io.bit(!!row && row[0] < 0);
  const len = io.vu(row?.length ?? 1, 2);
  const rest: unknown[] = [];
  for (let i = 1; i < len; i++) rest.push(io.num(row?.[i], 0, PK_CONTROL[Math.min(i, PK_CONTROL.length) - 1]));
  return { run, rest };
}

/**
 * A shell row's block body after its owner's wid (protocol.ts packProjectile's row: [id, vx, vy, weaponType, ticks since
 * fired, spawnX, spawnY, owner, gun?, ...]): the absolute bit, the length, the gun (as itself: it picks the chain), the
 * shell's id as the step from the gun's last shell, then the rest as projectilesIO has them, from `pv`. `pv`: the gun's
 * chain, or (absolute) zeros; returns the row with the owner's slot 0
 */
export function projectileBody(io: PackedIO, row: readonly unknown[] | undefined, abs: boolean, chainOf: (gun: unknown) => number[], gotAbs?: (abs: boolean) => void): unknown[] {
  const a = io.bit(abs);
  gotAbs?.(a);
  const len = io.u((row?.length ?? 8) - 8, 3) + 8;
  const o: unknown[] = new Array(len);
  o[7] = 0;
  if (len > 8) o[8] = io.num(row?.[8], 0, PK_PROJECTILE[7][1]);
  const pv = chainOf(o[8]);
  o[0] = (pv[P_ID] ?? 0) + io.vs(((row?.[0] as number) ?? 0) - (pv[P_ID] ?? 0), 6);
  for (let i = 1; i < len; i++) {
    if (i === 7 || i === 8) continue;
    const [d, c, delta] = PK_PROJECTILE[i - 1];
    o[i] = delta ? io.num(row?.[i], d, c, pv, i - 1) : io.num(row?.[i], d, c);
  }
  return o;
}

/**
 * A fire event's block body after the owner's wid ([owner, ticksAgo, part, aimQ, ...shell ids], all absolute). The part
 * field's augmented flag (+ 65536: a ports ship's augmented shot, nearly every shot a Gale fires) goes as a bit of its
 * own, ahead of the rest: as a number it took three more varint chunks than the part (about 2 B a record)
 */
export function fireBody(io: PackedIO, row: readonly number[] | undefined): unknown[] {
  const ago = io.num(row?.[1], 0, 2);
  const p = row?.[2];
  const aug = io.bit(typeof p === 'number' && p >= 65536 && p < 131072);
  const part = io.num(row ? (aug ? p! - 65536 : p) : undefined, 0, 5);
  const o: unknown[] = [0, ago, aug ? (part as number) + 65536 : part, io.num(row?.[3], 0, 6)];
  const k = io.vu(row ? row.length - 4 : 0, 1);
  let id = 0;
  for (let i = 0; i < k; i++) {
    id = i === 0 ? io.vu(row?.[4] ?? 0, 7) : id + io.vs((row?.[4 + i] ?? 0) - id, 3);
    o.push(id);
  }
  return o;
}

// ---- The server's side: one store per server, shared by every client's encoder ----

/** A status row's compact row without its name (packEntities' row, name null, trailing nulls dropped) */
function rowOf(s: EntityState): unknown[] {
  const rec = s as unknown as Record<string, unknown>;
  const row: unknown[] = new Array(SNAP_FIELDS.length);
  for (let i = 0; i < SNAP_FIELDS.length; i++) row[i] = i === 10 ? null : rec[SNAP_FIELDS[i]] ?? null;
  while (row.length && row[row.length - 1] === null) row.pop();
  return row;
}

interface Chain { pv: number[]; gen: number; tick: number }
interface Ent { sys: number; wid: number; seen: number; e?: Chain; k?: Chain }

/** A system's wire ids: dense, the lowest free one first (a binary min-heap of the freed) */
class WidPool {
  private next = 0;
  private free: number[] = [];
  take(): number {
    const h = this.free;
    if (!h.length) return this.next++;
    const top = h[0], last = h.pop()!;
    if (h.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l] < (m === i ? last : h[m])) m = l;
        if (r < h.length && h[r] < (m === i ? last : h[m])) m = r;
        if (m === i) break;
        h[i] = h[m];
        i = m;
      }
      h[i] = last;
    }
    return top;
  }
  give(w: number): void {
    const h = this.free;
    let i = h.length;
    h.push(w);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p] <= w) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = w;
  }
}

export class BlockStore {
  private ents = new Map<number, Ent>();
  private pools = new Map<number, WidPool>();
  private gen = 0;
  private readonly writer = new PackedIO();
  private readonly zero = new Array<number>(Math.max(E_LEN, K_LEN)).fill(0);
  private readonly recE = new WeakMap<object, BlockRec | null>();
  private readonly recK = new WeakMap<object, BlockRec | null>();
  private readonly recC = new WeakMap<object, BlockRec | null>();
  private readonly recF = new WeakMap<object, BlockRec | null>();
  private readonly recG = new WeakMap<object, BlockRec | null>();
  private sweptAt = 0;
  /** Blocks encoded (each once, whoever gets it), by kind; and the bits each form came to */
  readonly stats = { e: 0, k: 0, c: 0, f: 0, g: 0, p: 0, delta: 0, abs: 0, bits: 0 };

  /** `systemOf`: the system an entity is in now (ids are per system) */
  constructor(private readonly systemOf: (eid: number) => number) {}

  /** An entity's wire id in its system (given on first need; a new one if it moved system) */
  private ent(eid: number, tick: number): Ent {
    const sys = this.systemOf(eid);
    let e = this.ents.get(eid);
    if (e && e.sys !== sys) { this.poolOf(e.sys).give(e.wid); e = undefined; }
    if (!e) { e = { sys, wid: this.poolOf(sys).take(), seen: tick }; this.ents.set(eid, e); }
    e.seen = tick;
    return e;
  }

  private poolOf(sys: number): WidPool {
    let p = this.pools.get(sys);
    if (!p) { p = new WidPool(); this.pools.set(sys, p); }
    return p;
  }

  /** Entities gone (removed from the world): their wids are free and their chains go */
  removed(eids: Iterable<number>): void {
    for (const eid of eids) {
      const e = this.ents.get(eid);
      if (!e) continue;
      this.poolOf(e.sys).give(e.wid);
      this.ents.delete(eid);
    }
  }

  /** Entities no block has named for `idle` ticks give their wids back (a later block names them afresh) */
  sweep(tick: number, idle = 1200): void {
    if (tick - this.sweptAt < idle / 2) return;
    this.sweptAt = tick;
    for (const [eid, e] of this.ents) if (tick - e.seen > idle) { this.poolOf(e.sys).give(e.wid); this.ents.delete(eid); }
    for (const [k, g] of this.guns) if (tick - g.seen > idle) this.guns.delete(k);
  }

  /** How many entities hold a wire id (tests, stats) */
  get size(): number {
    return this.ents.size;
  }

  private bits(write: (io: PackedIO) => void): Bits {
    const io = this.writer;
    io.startWrite();
    write(io);
    const b = io.takeBits();
    this.stats.bits += b.n;
    return b;
  }

  /** A chain's block: the delta form when the row is canonical (and the chain had a generation), the absolute form always */
  private chained(cache: WeakMap<object, BlockRec | null>, key: object, eid: number, tick: number, k: boolean, canonicalShape: boolean,
    body: (io: PackedIO, pv: number[]) => unknown[], settle: (pv: number[], o: readonly unknown[], tick: number) => void): BlockRec {
    const ent = this.ent(eid, tick);
    const wid = ent.wid;
    const len = k ? K_LEN : E_LEN;
    let chain = k ? ent.k : ent.e;
    if (!chain) {
      chain = { pv: new Array<number>(len).fill(0), gen: ++this.gen, tick: -1 };
      if (k) ent.k = chain; else ent.e = chain;
    }
    const z = this.zero;
    const abs = this.bits((io) => { io.wid(wid); io.bit(true); z.fill(0); body(io, z); });
    this.stats.abs++;
    const rec: BlockRec = { eid, wid, tick, abs, before: chain.gen, after: -1 };
    if (canonicalShape && chain.tick !== tick) {
      const pv = chain.pv;
      let o: unknown[] = [];
      rec.delta = this.bits((io) => { io.wid(wid); io.bit(false); o = body(io, pv); });
      this.stats.delta++;
      settle(pv, o, tick);
      chain.gen = ++this.gen;
      chain.tick = tick;
      rec.after = chain.gen;
    }
    cache.set(key, rec);
    return rec;
  }

  /** A status row's block (null: it can't go as one; a name on it goes apart) */
  entity(s: EntityState, tick: number): BlockRec | null {
    const key = ((s as unknown as Record<symbol, unknown>)[ROW_BASE] as EntityState | undefined) ?? s;
    const had = this.recE.get(key);
    if (had !== undefined && (had === null || had.tick === tick)) return had;
    const row = rowOf(key);
    if (!isId(row[0]) || !Number.isInteger(row[1]) || (row[1] as number) < 0 || (row[1] as number) >= 32 || row.length > 15) { this.recE.set(key, null); return null; }
    this.stats.e++;
    // (A ship's or pilot's row with where it is: a first sight, only for new holders)
    const first = (key.type === EntityType.Player || key.type === EntityType.ShipBody) && key.x !== undefined;
    return this.chained(this.recE, key, key.id, tick, false, !first, (io, pv) => entityBody(io, row, pv, tick), settleEntity);
  }

  /** A keyframe row's block */
  keyframe(row: number[], tick: number): BlockRec | null {
    const had = this.recK.get(row);
    if (had !== undefined && (had === null || had.tick === tick)) return had;
    if (!isId(row[0]) || row.length > 31) { this.recK.set(row, null); return null; }
    this.stats.k++;
    return this.chained(this.recK, row, row[0], tick, true, true, (io, pv) => keyframeBody(io, row, pv, tick), settleKeyframe);
  }

  /** A control row's block ([id, ...], or [-1 - id, ...] for a run row) */
  control(row: number[], tick: number): BlockRec | null {
    const had = this.recC.get(row);
    if (had !== undefined && (had === null || had.tick === tick)) return had;
    const id = row[0] < 0 ? -1 - row[0] : row[0];
    if (!isId(id)) { this.recC.set(row, null); return null; }
    this.stats.c++;
    const wid = this.ent(id, tick).wid;
    const rec: BlockRec = { eid: id, wid, tick, abs: this.bits((io) => { io.wid(wid); controlBody(io, row); }), before: -1, after: -1 };
    this.recC.set(row, rec);
    return rec;
  }

  /** A gun row's block (sim/otherGuns.ts packGunRow: [id, ...], or [-1 - id, ...] for a run row; GunNet makes each once a round) */
  gunRow(row: number[], tick: number): BlockRec | null {
    const had = this.recG.get(row);
    if (had !== undefined && (had === null || had.tick === tick)) return had;
    if (!gunRowOk(row)) { this.recG.set(row, null); return null; }
    this.stats.g++;
    const id = row[0] < 0 ? -1 - row[0] : row[0];
    const wid = this.ent(id, tick).wid;
    const rec: BlockRec = { eid: id, wid, tick, abs: this.bits((io) => { io.wid(wid); gunRowBody(io, row); }), before: -1, after: -1 };
    this.recG.set(row, rec);
    return rec;
  }

  /** Shell rows' chains, by gunKey */
  private guns = new Map<number, Chain & { seen: number }>();
  private readonly recP = new WeakMap<object, BlockRec | null | false>();

  /**
   * A shell's row as a block (its status as SnapshotBuilder makes it once: packProjectile's row); false: it isn't a
   * shell row (it goes as a status row); null: it can't go as a block
   */
  projectile(s: EntityState, tick: number): BlockRec | null | false {
    const had = this.recP.get(s);
    if (had !== undefined && (had === null || had === false || had.tick === tick)) return had;
    const row = packProjectile(s, tick);
    if (!row) { this.recP.set(s, false); return false; }
    if (row.length > 15 || !isId(row[0]) || !isId(row[7])) { this.recP.set(s, null); return null; }
    const owner = row[7] as number;
    const wid = this.ent(owner, tick).wid;
    const key = gunKey(owner, row[8]);
    const zero = new Array<number>(P_ID + 1).fill(0);
    const abs = this.bits((io) => { io.wid(wid); projectileBody(io, row, true, () => zero); });
    this.stats.p++;
    const rec: BlockRec = { eid: owner, wid, tick, abs, before: -1, after: -1, gun: key };
    if (key >= 0) {
      let chain = this.guns.get(key);
      if (!chain) { chain = { pv: new Array<number>(P_ID + 1).fill(0), gen: ++this.gen, tick: -1, seen: tick }; this.guns.set(key, chain); }
      chain.seen = tick;
      const pv = chain.pv;
      let o: unknown[] = [];
      rec.before = chain.gen;
      rec.delta = this.bits((io) => { io.wid(wid); o = projectileBody(io, row, false, () => pv); });
      o[7] = owner;
      settleProjectile(pv, o);
      chain.gen = ++this.gen;
      rec.after = chain.gen;
    }
    this.recP.set(s, rec);
    return rec;
  }

  /** A fire event's block ([owner, ticksAgo, part, aimQ, ...shell ids]) */
  fire(row: number[], tick: number): BlockRec | null {
    const had = this.recF.get(row);
    if (had !== undefined && (had === null || had.tick === tick)) return had;
    if (row.length < 4 || !isId(row[0]) || !row.every((v, i) => i < 4 ? typeof v === 'number' : isId(v)) || row.length - 4 > 4096) { this.recF.set(row, null); return null; }
    this.stats.f++;
    const wid = this.ent(row[0], tick).wid;
    const rec: BlockRec = { eid: row[0], wid, tick, abs: this.bits((io) => { io.wid(wid); fireBody(io, row); }), before: -1, after: -1 };
    this.recF.set(row, rec);
    return rec;
  }
}

/** The form of a chained block a client gets (its generation of that chain), and the generation it then holds */
export function formFor(rec: BlockRec, held: number): { bits: Bits; gen: number } {
  if (rec.delta && held === rec.before) return { bits: rec.delta, gen: rec.after };
  return { bits: rec.abs, gen: rec.after };
}
