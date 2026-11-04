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
import { BinaryReader, DICTIONARY, encodeBinary } from '../binaryCodec.js';
import { COMPACT_TYPES, decodeServerFrame, serverFromWire, serverWire, type ServerMessage } from '../protocol.js';
import { packHits, unpackHits } from '../hits.js';
import {
  PACKED_FRAME, PK, PK_BITS, PACKED_FIELDS, PK_KEY_COUNT, PK_ENTITY, PK_ENTITY_DEFAULT, PK_DATA_CHUNK, PK_PROJECTILE,
  PK_KEYFRAME, PK_KEYFRAME_TAIL, PK_GUESS_TICKS, PK_CONTROL, PK_TABLE_MAX, PK_PENDING_MAX, type PackedField,
} from './tables.js';

// (Both are globals in browsers and Node; common is built without the DOM types)
declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(b: Uint8Array): string } };
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];
const DICT_INDEX = new Map(DICTIONARY.map((s, i) => [s, i]));
/** Entity ids: whole, not negative (anything else in an id's place makes the message go as it is) */
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 48;
/** What the base codec sends as null: null itself, and what JSON turns into null in an array */
const nullish = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint';
const bitsFor = (n: number): number => (n <= 0 ? 0 : 32 - Math.clz32(n));
const f64 = new DataView(new ArrayBuffer(8));

/** An entity's last values (PackedIO.prevOf): its status rows' x, y, angle, vx, vy, turn rate, hp, max hp and tick; its keyframe's fields from K */
const E_X = 0, E_Y = 1, E_ANGLE = 2, E_VX = 3, E_VY = 4, E_AV = 5, E_HP = 6, E_MAXHP = 7, E_TICK = 8, K = 9, K_TICK = K + PK_KEYFRAME.length, PREV_LEN = K_TICK + 1;

/** One part of a frame: a message, and its base-format bytes if they're to hand (they go as they are when not packed) */
export interface PackedPart { msg: ServerMessage; bytes?: Uint8Array | null }

/** A slot table: ids by small numbers (code 0: a new id follows; slot s: code s + 1), the lowest free slot reused */
class Slots {
  readonly slot = new Map<number, number>();
  readonly ids: number[] = [];
  private free: number[] = [];
  high = 0;
  lastNew = 0;

  width(): number { return bitsFor(this.high); }
  has(id: number): boolean { return this.slot.has(id); }

  add(id: number): void {
    if (this.slot.has(id)) return;
    let s: number;
    if (this.free.length) {
      let k = 0;
      for (let i = 1; i < this.free.length; i++) if (this.free[i] < this.free[k]) k = i;
      s = this.free[k];
      this.free[k] = this.free[this.free.length - 1];
      this.free.pop();
    } else s = this.high++;
    this.slot.set(id, s);
    this.ids[s] = id;
  }

  release(id: number): void {
    const s = this.slot.get(id);
    if (s === undefined) return;
    this.slot.delete(id);
    this.ids[s] = -1;
    this.free.push(s);
  }
}

/**
 * Bits in and out, and the codec's state. Each method writes its value (writing) or reads one (reading) and returns
 * the value as the other side will have it.
 */
class PackedIO {
  reading = false;
  // Writing
  private out = new Uint8Array(512);
  private len = 0;
  private acc = 0;
  private nacc = 0;
  // Reading
  private src: Uint8Array = new Uint8Array(0);
  private pos = 0;

  // ---- The state both sides keep ----
  you = -1;
  things = new Slots();
  shells = new Slots();
  /** Shells hit (projectileHit) and not yet removed: a removal names one by its place here */
  pending: number[] = [];
  /** Last mantissas: per key (field-by-field messages), the snapshot header, projectile rows; per entity (its rows, keyframes) */
  keys = new Array<number>(PK_KEY_COUNT).fill(0);
  head = [0, 0];
  proj = new Array<number>(PK_PROJECTILE.length).fill(0);
  private per = new Map<number, number[]>();
  /** Per gun (owner and gun): its last shell's row; per fire-event owner: its last [part, aim]; per ship and part: its last HP */
  private guns = new Map<number, number[]>();
  private firers = new Map<number, number[]>();
  private hps = new Map<number, number>();
  private scratch = [0];

  resetState(you: number): void {
    this.you = you;
    this.things = new Slots();
    this.shells = new Slots();
    this.pending = [];
    this.keys.fill(0);
    this.head = [0, 0];
    this.proj.fill(0);
    this.per.clear();
    this.guns.clear();
    this.firers.clear();
    this.hps.clear();
  }

  /** The last values of one entity's rows: E_* for its status rows, then K + i for its keyframe's field i, and K_TICK */
  prevOf(id: number): number[] {
    let p = this.per.get(id);
    if (!p) { p = new Array<number>(PREV_LEN).fill(0); this.per.set(id, p); }
    return p;
  }

  /** A gun's last shell row (owner and gun as the key; a gun that isn't a whole number: the last row of all) */
  gunPrev(owner: number, gun: unknown): number[] {
    if (typeof gun !== 'number' || !Number.isInteger(gun) || gun < 0 || gun >= 2 ** 20 || owner >= 2 ** 28) return this.proj;
    const key = owner * 2 ** 20 + gun;
    let p = this.guns.get(key);
    if (!p) {
      if (this.guns.size >= 1024) this.guns.clear();
      p = new Array<number>(PK_PROJECTILE.length).fill(0);
      this.guns.set(key, p);
    }
    return p;
  }

  /** A fire event owner's last [part, aim] */
  firerPrev(owner: number): number[] {
    let p = this.firers.get(owner);
    if (!p) {
      if (this.firers.size >= 1024) this.firers.clear();
      p = [0, 0];
      this.firers.set(owner, p);
    }
    return p;
  }

  /**
   * Moves a last value on by a rate for the ticks since (the guess a delta is taken from): x by vx, an angle by its turn
   * rate. Mantissas: pv[k] at d decimals, pv[kv] at dv
   */
  guess(pv: number[], k: number, kv: number, d: number, dv: number, dt: number): void {
    if (dt > 0 && pv[kv] !== 0) pv[k] += Math.round((pv[kv] * dt * POW10[d]) / POW10[dv]);
  }

  /** An entity both sides are done with (removed, out of view, a spent shell) */
  forget(id: number): void {
    this.things.release(id);
    this.shells.release(id);
    this.per.delete(id);
    const i = this.pending.indexOf(id);
    if (i >= 0) this.pending.splice(i, 1);
  }

  get tablesFull(): boolean {
    return this.things.high > PK_TABLE_MAX || this.shells.high > PK_TABLE_MAX;
  }

  // ---- Raw bits ----

  startWrite(): void { this.reading = false; this.len = 0; this.acc = 0; this.nacc = 0; }
  startRead(src: Uint8Array, bytePos: number): void { this.reading = true; this.src = src; this.pos = bytePos * 8; }

  private room(n: number): void {
    if (this.len + n <= this.out.length) return;
    let size = this.out.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.out.subarray(0, this.len));
    this.out = next;
  }

  private put(v: number, w: number): void {
    // (w <= 24: the accumulator holds under 8 bits between calls)
    this.acc = (this.acc << w) | v;
    this.nacc += w;
    while (this.nacc >= 8) {
      this.nacc -= 8;
      this.room(1);
      this.out[this.len++] = (this.acc >>> this.nacc) & 255;
    }
    this.acc &= (1 << this.nacc) - 1;
  }

  private get(w: number): number {
    let v = 0;
    while (w > 0) {
      const at = this.pos >>> 3;
      if (at >= this.src.length) throw new Error('packed frame ended early');
      const off = this.pos & 7, avail = 8 - off, take = avail < w ? avail : w;
      v = v * (1 << take) + ((this.src[at] >>> (avail - take)) & ((1 << take) - 1));
      this.pos += take;
      w -= take;
    }
    return v;
  }

  /** An unsigned value in w bits (up to 48) */
  u(v: number, w: number): number {
    if (w === 0) return 0;
    if (this.reading) {
      if (w <= 24) return this.get(w);
      const hi = this.get(w - 24);
      return hi * 16777216 + this.get(24);
    }
    if (w <= 24) this.put(v & ((1 << w) - 1), w);
    else { this.put(Math.floor(v / 16777216), w - 24); this.put(v % 16777216, 24); }
    return v;
  }

  bit(b: boolean): boolean {
    return this.u(b ? 1 : 0, 1) === 1;
  }

  /** An unsigned varint: c bits a chunk, low first, each followed by a "more" bit */
  vu(v: number, c: number): number {
    const step = 1 << c; // (c is a few bits: 1 << c is 2^c exactly)
    if (this.reading) {
      let n = 0, mul = 1, more: boolean;
      do {
        n += this.get(c) * mul;
        mul *= step;
        more = this.get(1) === 1;
        if (mul > 2 ** 60) throw new Error('packed varint too long');
      } while (more);
      return n;
    }
    let x = v;
    do {
      const chunk = x % step;
      x = Math.floor(x / step);
      this.u(chunk, c);
      this.put(x > 0 ? 1 : 0, 1);
    } while (x > 0);
    return v;
  }

  /** A signed whole number (zigzag) */
  vs(v: number, c: number): number {
    if (this.reading) { const z = this.vu(0, c); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
    this.vu(v >= 0 ? v * 2 : -v * 2 - 1, c);
    return v;
  }

  align(): void {
    if (this.reading) { this.pos = Math.ceil(this.pos / 8) * 8; return; }
    if (this.nacc) this.put(0, 8 - this.nacc);
  }

  /** The base codec's bytes for one value, byte-aligned (writing); the value they decode to (reading) */
  legacy(bytes: Uint8Array | null): unknown {
    this.align();
    if (this.reading) {
      const r = new BinaryReader(this.src);
      r.pos = this.pos >>> 3;
      const v = r.value();
      this.pos = r.pos * 8;
      return v;
    }
    this.room(bytes!.length);
    this.out.set(bytes!, this.len);
    this.len += bytes!.length;
    return null;
  }

  /** Tools that count what each part of a snapshot costs: told each part's name and the bits before it */
  section: ((name: string, bits: number) => void) | null = null;

  /** Bits written so far (tools that count what each part costs) */
  get bitLength(): number {
    return this.len * 8 + this.nacc;
  }

  take(): Uint8Array {
    this.align();
    return this.out.slice(0, this.len);
  }

  get done(): boolean {
    return (this.pos >>> 3) >= this.src.length;
  }

  // ---- Values ----

  /** Any value, as the base codec carries it (null for what JSON drops in an array; objects' keys as they come) */
  any(v: unknown): unknown {
    if (this.reading) {
      switch (this.get(3)) {
        case 0: return null;
        case 1: return false;
        case 2: return true;
        case 3: return this.anyNum(0);
        case 4: return this.str('');
        case 5: { const n = this.vu(0, 3); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.any(null); return a; }
        case 6: {
          const n = this.vu(0, 3);
          const o: Record<string, unknown> = {};
          for (let i = 0; i < n; i++) { const k = this.str(''); o[k] = this.any(null); }
          return o;
        }
        default: throw new Error('packed: bad value tag');
      }
    }
    if (nullish(v)) { this.put(0, 3); return null; }
    if (typeof v === 'boolean') { this.put(v ? 2 : 1, 3); return v; }
    if (typeof v === 'number') { this.put(3, 3); this.anyNum(v); return v; }
    if (typeof v === 'string') { this.put(4, 3); this.str(v); return v; }
    if (typeof v !== 'object') { this.put(0, 3); return null; }
    if (Array.isArray(v)) {
      this.put(5, 3);
      this.vu(v.length, 3);
      for (const x of v) this.any(x);
      return v;
    }
    const o = v as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof o.toJSON === 'function') return this.any(o.toJSON());
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function');
    this.put(6, 3);
    this.vu(keys.length, 3);
    for (const k of keys) { this.str(k); this.any(o[k]); }
    return v;
  }

  /** A finite number: whole, or a decimal of 1-6 places, or the double itself */
  private anyNum(v: number): number {
    if (this.reading) {
      if (this.get(1) === 0) return this.vs(0, 5);
      const k = this.get(3);
      if (k >= 1 && k <= 6) return this.vs(0, 6) / POW10[k];
      for (let i = 0; i < 8; i++) f64.setUint8(i, this.get(8));
      return f64.getFloat64(0);
    }
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) { this.put(0, 1); this.vs(v, 5); return v; }
    this.put(1, 1);
    for (let k = 1; k <= 6; k++) {
      const m = Math.round(v * POW10[k]);
      if (Math.abs(m) < 2 ** 51 && m / POW10[k] === v) { this.put(k, 3); this.vs(m, 6); return v; }
    }
    this.put(7, 3);
    f64.setFloat64(0, v);
    for (let i = 0; i < 8; i++) this.put(f64.getUint8(i), 8);
    return v;
  }

  private str(s: string): string {
    if (this.reading) {
      if (this.get(1) === 1) {
        const d = DICTIONARY[this.vu(0, 7)];
        if (d === undefined) throw new Error('packed: unknown dictionary string');
        return d;
      }
      const n = this.vu(0, 5);
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = this.get(8);
      return fromUtf8.decode(b);
    }
    const d = DICT_INDEX.get(s);
    if (d !== undefined) { this.put(1, 1); this.vu(d, 7); return s; }
    this.put(0, 1);
    const b = utf8.encode(s);
    this.vu(b.length, 5);
    for (const x of b) this.put(x, 8);
    return s;
  }

  /**
   * A number field at d decimals: '0' exact there (zigzag mantissa, chunk c; as the step from prev[k] if given),
   * '10' null, '110' any other number, '111' any other value
   */
  num(v: unknown, d: number, c: number, prev?: number[], k = 0): unknown {
    const p = POW10[d];
    if (this.reading) {
      if (this.get(1) === 0) {
        let m = this.vs(0, c);
        if (prev) { m += prev[k]; prev[k] = m; }
        return m / p;
      }
      if (this.get(1) === 0) return null;
      return this.get(1) === 0 ? this.anyNum(0) : this.any(null);
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      const m = Math.round(v * p);
      if (Math.abs(m) < 2 ** 50 && m / p === v) {
        this.put(0, 1);
        if (prev) { this.vs(m - prev[k], c); prev[k] = m; } else this.vs(m, c);
        return v;
      }
      this.put(6, 3);
      this.anyNum(v);
      return v;
    }
    if (nullish(v)) { this.put(2, 2); return null; }
    this.put(7, 3);
    this.any(v);
    return v;
  }

  /** An entity's id by its slot (a new one: the step from the last new one, and it takes a slot) */
  thing(id: number): number {
    return this.ref(this.things, id);
  }

  shell(id: number): number {
    return this.ref(this.shells, id);
  }

  private ref(t: Slots, id: number): number {
    const w = t.width();
    if (this.reading) {
      const code = this.u(0, w);
      if (code) {
        const got = t.ids[code - 1];
        if (got === undefined || got < 0) throw new Error('packed: empty slot');
        return got;
      }
      const nid = t.lastNew + this.vs(0, 6);
      t.lastNew = nid;
      t.add(nid);
      return nid;
    }
    const s = t.slot.get(id);
    if (s !== undefined) { this.u(s + 1, w); return id; }
    this.u(0, w);
    this.vs(id - t.lastNew, 6);
    t.lastNew = id;
    t.add(id);
    return id;
  }

  /** A shell that's new for sure (a fire event's): the step from the last new shell, and it takes a slot */
  newShell(id: number): number {
    const t = this.shells;
    const nid = this.reading ? t.lastNew + this.vs(0, 3) : (this.vs(id - t.lastNew, 3), id);
    t.lastNew = nid;
    t.add(nid);
    return nid;
  }

  /** Who: '0' null, '10' you, '110' an entity slot, '111' any other value */
  who(v: unknown): unknown {
    if (this.reading) {
      if (this.get(1) === 0) return null;
      if (this.get(1) === 0) return this.you;
      return this.get(1) === 0 ? this.thing(0) : this.any(null);
    }
    if (nullish(v)) { this.put(0, 1); return null; }
    if (v === this.you && this.you >= 0) { this.put(2, 2); return v; }
    if (isId(v)) { this.put(6, 3); this.thing(v); return v; }
    this.put(7, 3);
    this.any(v);
    return v;
  }

  /** An entity that's you, or not (always an id): 1 bit, or 0 and its slot */
  youOr(id: number): number {
    if (this.reading) return this.get(1) === 1 ? this.you : this.thing(0);
    if (id === this.you && this.you >= 0) { this.put(1, 1); return id; }
    this.put(0, 1);
    return this.thing(id);
  }

  /** A field of the field-by-field messages (`ship`: the message's first field, for part HP) */
  field(v: unknown, f: PackedField, ship: unknown): unknown {
    switch (f[0]) {
      case 'w': return this.who(v);
      case 'n': return this.num(v, f[1], f[2]);
      case 'd': return this.num(v, f[1], f[2], this.keys, f[3]);
      case 'f': return this.flag(v);
      case 'p': return this.pairs(v, ship);
      case 'l': return this.list(v, f[1], f[2]);
      case 's': return this.shellField(v);
      default: return this.any(v);
    }
  }

  /** A shell: '0' null, '10' its slot (it's noted as hit: projectileHit), '11' any other value */
  private shellField(v: unknown): unknown {
    if (this.reading) {
      if (this.get(1) === 0) return null;
      if (this.get(1) === 1) return this.any(null);
      const id = this.shell(0);
      this.noteHit(id);
      return id;
    }
    if (nullish(v)) { this.put(0, 1); return null; }
    if (!isId(v)) { this.put(3, 2); this.any(v); return v; }
    this.put(2, 2);
    this.shell(v);
    this.noteHit(v);
    return v;
  }

  private noteHit(id: number): void {
    if (this.pending.includes(id)) return;
    this.pending.push(id);
    if (this.pending.length > PK_PENDING_MAX) this.pending.shift();
  }

  /** '0' null, '10' true, '110' false, '111' any other value */
  private flag(v: unknown): unknown {
    if (this.reading) {
      if (this.get(1) === 0) return null;
      if (this.get(1) === 0) return true;
      return this.get(1) === 0 ? false : this.any(null);
    }
    if (nullish(v)) { this.put(0, 1); return null; }
    if (v === true) { this.put(2, 2); return v; }
    if (v === false) { this.put(6, 3); return v; }
    this.put(7, 3);
    this.any(v);
    return v;
  }

  /** A list of numbers: '0' null, '10' the list (each at d decimals, the step from the one before), '11' any other value */
  list(v: unknown, d: number, c: number): unknown {
    if (this.reading) {
      if (this.get(1) === 0) return null;
      if (this.get(1) === 1) return this.any(null);
    } else {
      if (nullish(v)) { this.put(0, 1); return null; }
      if (!Array.isArray(v)) { this.put(3, 2); this.any(v); return v; }
      this.put(2, 2);
    }
    const a = v as unknown[] | null;
    const n = this.vu(a?.length ?? 0, 4);
    const out: unknown[] = new Array(n);
    const t = this.scratch;
    t[0] = 0;
    for (let i = 0; i < n; i++) out[i] = this.num(a?.[i], d, c, t, 0);
    return out;
  }

  /**
   * [part, hp] pairs: '0' null, '10' the pairs, '11' any other value. A part goes as the step from the one before, its
   * HP (at 0.1) as the step from the last HP sent for that part of that ship (`ship`, when it's an id)
   */
  pairs(v: unknown, ship: unknown): unknown {
    if (this.reading) {
      if (this.get(1) === 0) return null;
      if (this.get(1) === 1) return this.any(null);
    } else {
      if (nullish(v)) { this.put(0, 1); return null; }
      if (!Array.isArray(v) || !v.every((p) => Array.isArray(p) && p.length === 2 && isId(p[0]) && p[0] < 4096 && typeof p[1] === 'number')) {
        this.put(3, 2);
        this.any(v);
        return v;
      }
      this.put(2, 2);
    }
    const a = v as number[][] | null;
    const n = this.vu(a?.length ?? 0, 3);
    const out: unknown[] = new Array(n);
    const keyed = isId(ship) && ship < 2 ** 36;
    if (keyed && this.hps.size >= 8192) this.hps.clear();
    let part = 0;
    for (let i = 0; i < n; i++) {
      part += this.vs((a?.[i][0] ?? 0) - part, 4);
      const t = this.scratch;
      const key = keyed ? (ship as number) * 4096 + part : -1;
      t[0] = keyed ? this.hps.get(key) ?? 0 : 0;
      out[i] = [part, this.num(a?.[i][1], 1, 6, t, 0)];
      if (keyed) this.hps.set(key, t[0]);
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ the messages

const SNAPSHOT_CODE = COMPACT_TYPES.indexOf('snapshot');
const HITS_CODE = COMPACT_TYPES.indexOf('hits');
const HPS_CODE = COMPACT_TYPES.indexOf('shipHps');
const isArr = Array.isArray;

/** Can the snapshot's row go packed (ids where ids go, rows the shapes the packing expects)? */
function snapshotOk(w: unknown[]): boolean {
  if (w.length > 11) return false;
  const [, , , e, p, r, k, c, o, f, n] = w as unknown[][];
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

/** A snapshot's compact row ([code, t, lp, e, p, r, k, c, o, f, n], trailing nulls dropped) */
function snapshotIO(io: PackedIO, w: unknown[] | null): unknown[] {
  let mask = 0;
  if (w) for (let i = 1; i < w.length; i++) if (w[i] != null) mask |= 1 << (i - 1);
  mask = io.u(mask, 10);
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
