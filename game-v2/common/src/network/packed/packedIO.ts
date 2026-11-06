/**
 * Bit-packed frames (CAPS.PACKED): the bits in and out, and the state both sides keep (moved from packedCodec.ts, which
 * holds the messages). `PackedIO`'s methods each write their value (writing) or read one back (reading) and return the
 * value as the other side will have it, so one function writes and reads each message.
 */
import { BinaryReader, DICTIONARY } from '../binaryCodec.js';
import { PK_KEY_COUNT, PK_PROJECTILE, PK_KEYFRAME, PK_TABLE_MAX, PK_PENDING_MAX, type PackedField } from './tables.js';
import type { ServerMessage } from '../protocol.js';
import { BlockPeer } from './blockPeer.js';

// (Both are globals in browsers and Node; common is built without the DOM types)
declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(b: Uint8Array): string } };
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];
const DICT_INDEX = new Map(DICTIONARY.map((s, i) => [s, i]));
/** Entity ids: whole, not negative (anything else in an id's place makes the message go as it is) */
export const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 48;
/** What the base codec sends as null: null itself, and what JSON turns into null in an array */
export const nullish = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint';
export const bitsFor = (n: number): number => (n <= 0 ? 0 : 32 - Math.clz32(n));
const f64 = new DataView(new ArrayBuffer(8));

/** An entity's last values (PackedIO.prevOf): its status rows' x, y, angle, vx, vy, turn rate, hp, max hp and tick; its keyframe's fields from K */
export const E_X = 0, E_Y = 1, E_ANGLE = 2, E_VX = 3, E_VY = 4, E_AV = 5, E_HP = 6, E_MAXHP = 7, E_TICK = 8, K = 9, K_TICK = K + PK_KEYFRAME.length, PREV_LEN = K_TICK + 1;

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
export class PackedIO {
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
  /** Encode-once blocks (CAPS.BLOCKS): the wire ids and chains this connection's ends keep (blockPeer.ts) */
  readonly blk = new BlockPeer();

  resetState(you: number): void {
    this.you = you;
    this.blk.reset();
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

  /** What was written, as bits (a block: blocks.ts copies it into frames as it is) */
  takeBits(): { b: Uint8Array; n: number } {
    const n = this.bitLength;
    return { b: this.take(), n };
  }

  /** Another writer's bits, as they are (an encode-once block) */
  copyBits(b: Uint8Array, n: number): void {
    const whole = n >>> 3, rest = n & 7;
    this.room(whole + 2);
    if (this.nacc === 0) {
      this.out.set(b.subarray(0, whole), this.len);
      this.len += whole;
    } else for (let i = 0; i < whole; i++) this.put(b[i], 8);
    if (rest) this.put(b[whole] >>> (8 - rest), rest);
  }

  /**
   * A per-system wire id (encode-once blocks): a 2-bit prefix, then 0-63 in 6 bits, 64-575 in 9, 576-4671 in 12,
   * else 16 (up to 70207)
   */
  wid(w: number): number {
    if (this.reading) {
      const p = this.get(2);
      return p === 0 ? this.get(6) : p === 1 ? 64 + this.get(9) : p === 2 ? 576 + this.get(12) : 4672 + this.get(16);
    }
    if (w < 64) { this.put(0, 2); this.put(w, 6); }
    else if (w < 576) { this.put(1, 2); this.put(w - 64, 9); }
    else if (w < 4672) { this.put(2, 2); this.put(w - 576, 12); }
    else if (w < 4672 + 65536) { this.put(3, 2); this.put(w - 4672, 16); }
    else throw new Error('packed: wire id out of range');
    return w;
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
      case 'r': return this.rows(v, f[1], f[2], f[3]);
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
   * A flat list in rows of `n` numbers: '0' null, '10' the list (each at d decimals, the step from the same column of
   * the row before), '11' any other value
   */
  rows(v: unknown, n: number, d: number, c: number): unknown {
    if (this.reading) {
      if (this.get(1) === 0) return null;
      if (this.get(1) === 1) return this.any(null);
    } else {
      if (nullish(v)) { this.put(0, 1); return null; }
      if (!Array.isArray(v)) { this.put(3, 2); this.any(v); return v; }
      this.put(2, 2);
    }
    const a = v as unknown[] | null;
    const len = this.vu(a?.length ?? 0, 6);
    const out: unknown[] = new Array(len);
    const cols = new Array<number>(n).fill(0);
    for (let i = 0; i < len; i++) out[i] = this.num(a?.[i], d, c, cols, i % n);
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
