/**
 * The client's asset cache. Anything the client generates (textures, atlases, built geometry, icons) goes through here,
 * so it's made once per browser rather than once per visit: from memory, else IndexedDB, else built (and then stored, in
 * the background).
 *
 * - A kind of asset is declared once, with its generator's version: `assetKind('rockAtlas', ROCK_ATLAS_VERSION)`. Bump
 *   the version whenever what the generator makes changes; the old ones are never read again, and are cleared out.
 * - Each asset is keyed by its input: any string, or `hashOf(input)` for the data it's made from. Anything the output
 *   depends on belongs in it (game data too: dataHash).
 * - A value is anything structured clone takes (typed arrays, plain objects, strings, Blobs). Large typed arrays are
 *   compressed (CompressionStream) when that saves space.
 * - Least recently used assets go past the budget (BUDGET).
 * - Storing never holds anything up: the value is copied at once, then compressed and written when the thread is idle.
 * - Without IndexedDB (a private window, blocked storage, tests), or if it fails, assets are simply built.
 * The same in workers: each opens the store itself, so a worker's assets never cross the main thread.
 */

export interface AssetKind<T> {
  readonly name: string;
  readonly version: number;
  /** The asset made from `input`: from memory, else stored, else built (and stored) */
  get(input: string, build: () => T | Promise<T>): Promise<T>;
  /** Already in memory, else undefined (for a caller that can't wait) */
  peek(input: string): T | undefined;
  /** Into memory, if stored (for a caller that can't wait, later) */
  preload(input: string): Promise<T | undefined>;
  /** Keep this as the asset made from `input` (one built bit by bit: pictureSheet) */
  save(input: string, value: T): void;
}

/** Storage under the cache (IndexedDB; a Map in tests). Any method may throw or reject: the cache carries on without */
export interface AssetStore {
  read(key: string): Promise<unknown>;
  write(key: string, meta: AssetMeta, value: unknown): Promise<void>;
  remove(keys: string[]): Promise<void>;
  metas(): Promise<AssetMeta[]>;
  touch(key: string, used: number): Promise<void>;
}
export interface AssetMeta { key: string; kind: string; version: number; size: number; used: number }

/** What's kept in all (bytes, after compression) */
export const BUDGET = 256 * 1024 * 1024;
/** Typed arrays this big or more are compressed (if that saves a tenth or more) */
const COMPRESS_FROM = 16 * 1024;
/** How stale a last-used time gets before it's written again */
const TOUCH_AFTER = 60 * 60 * 1000;

const kinds = new Map<string, number>();
/** Every kind declared so far, with its version */
export const assetKinds = (): ReadonlyMap<string, number> => kinds;

/**
 * A kind of asset. `memory: false` keeps nothing in memory once it's handed over (big ones the caller keeps, or a
 * worker's, which are transferred away)
 */
export function assetKind<T>(name: string, version: number, opts: { memory?: boolean } = {}): AssetKind<T> {
  if (!Number.isInteger(version) || version < 1) throw new Error(`asset kind ${name}: its version must be a whole number from 1`);
  const known = kinds.get(name);
  if (known !== undefined && known !== version) throw new Error(`asset kind ${name} declared twice (versions ${known} and ${version})`);
  kinds.set(name, version);
  const keep = opts.memory !== false;
  const memory = new Map<string, T>();
  const inFlight = new Map<string, Promise<T>>();
  const keyOf = (input: string) => `${name}@${version}:${input}`;
  const load = async (input: string): Promise<T | undefined> => {
    const v = await readStored(keyOf(input));
    return v === undefined ? undefined : (v as T);
  };
  return {
    name,
    version,
    get(input, build) {
      const hit = memory.get(input);
      if (hit !== undefined) return Promise.resolve(hit);
      let p = inFlight.get(input);
      if (p) return p;
      p = (async () => {
        let value = await load(input);
        if (value === undefined) {
          value = await build();
          // (A copy now: the caller may hand the original's buffers to another thread straight away)
          store(keyOf(input), name, version, value);
        }
        if (keep) memory.set(input, value);
        return value;
      })().finally(() => inFlight.delete(input));
      inFlight.set(input, p);
      return p;
    },
    peek: (input) => memory.get(input),
    save(input, value) {
      if (keep) memory.set(input, value);
      store(keyOf(input), name, version, value);
    },
    async preload(input) {
      const hit = memory.get(input);
      if (hit !== undefined) return hit;
      const value = await load(input);
      if (value !== undefined && keep) memory.set(input, value);
      return value;
    },
  };
}

// ---- hashing inputs ----

/**
 * A short, stable key for some data (objects by their keys in order, typed arrays by their bytes): two 32-bit FNV-1a
 * lanes and the length, so a collision would take both lanes at once
 */
export function hashOf(value: unknown): string {
  let a = 0x811c9dc5, b = 0x2f6f13d1, n = 0;
  const byte = (c: number) => { a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x01000193 ^ 0x5bd1e995); n++; };
  const text = (s: string) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); byte(c & 255); if (c > 255) byte(c >>> 8); } };
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) { text(String(v)); return; }
    if (typeof v !== 'object') { text(`${(typeof v)[0]}${String(v)};`); return; }
    if (ArrayBuffer.isView(v)) {
      text(`${v.constructor.name}${v.byteLength}[`);
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (let i = 0; i < bytes.length; i++) byte(bytes[i]);
      text(']');
      return;
    }
    if (Array.isArray(v)) { text('['); for (const x of v) walk(x); text(']'); return; }
    text('{');
    for (const k of Object.keys(v).sort()) { text(k); text(':'); walk((v as Record<string, unknown>)[k]); }
    text('}');
  };
  walk(value);
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${n.toString(36)}`;
}

// ---- storing ----

let store_: AssetStore | null | undefined;
/** Use this storage (tests); null: none */
export function setAssetStore(s: AssetStore | null): void {
  store_ = s;
  touched.clear();
}
function storage(): AssetStore | null {
  if (store_ === undefined) store_ = typeof indexedDB === 'undefined' ? null : idbStore();
  return store_;
}
/** Something went wrong under it: no more storage this visit (assets are built as before) */
function broken(err: unknown): void {
  if (store_) console.warn('[asset cache] off for this visit:', err);
  store_ = null;
}

async function readStored(key: string): Promise<unknown> {
  const s = storage();
  if (!s) return undefined;
  try {
    const packed = await s.read(key);
    if (packed === undefined) return undefined;
    if (!touched.has(key)) { touched.add(key); later(() => s.touch(key, Date.now()).catch(() => {})); }
    return await unpack(packed);
  } catch (err) {
    broken(err);
    return undefined;
  }
}
const touched = new Set<string>();

/** Stores still to be written */
const writing = new Set<Promise<void>>();
/** When every store asked for so far is written (or has failed): a one-shot worker waits for this before it's ended */
export async function storesSettled(): Promise<void> {
  while (writing.size) await Promise.all(writing);
}

function store(key: string, kind: string, version: number, value: unknown): void {
  const s = storage();
  if (!s) return;
  let copy: unknown;
  try { copy = structuredClone(value); } catch { return; }
  let wrote!: () => void;
  const w = new Promise<void>((ok) => (wrote = ok));
  writing.add(w);
  void w.then(() => writing.delete(w));
  later(async () => {
    try {
      const packed = await pack(copy);
      const size = sizeOf(packed);
      if (size > BUDGET / 4) return;
      await s.write(key, { key, kind, version, size, used: Date.now() }, packed);
      trimSoon();
    } catch (err) {
      broken(err);
    } finally {
      wrote();
    }
  });
}

let trimming: ReturnType<typeof setTimeout> | null = null;
/** Old versions out, then the least recently used past the budget (a little after the last write) */
function trimSoon(): void {
  if (trimming) clearTimeout(trimming);
  trimming = setTimeout(() => { trimming = null; void trim(); }, 2000);
}
export async function trim(budget = BUDGET): Promise<void> {
  const s = storage();
  if (!s) return;
  try {
    const metas = await s.metas();
    const old = metas.filter((m) => kinds.has(m.kind) && kinds.get(m.kind) !== m.version);
    const kept = metas.filter((m) => !old.includes(m)).sort((x, y) => y.used - x.used);
    let total = 0;
    const over: AssetMeta[] = [];
    for (const m of kept) { total += m.size; if (total > budget) over.push(m); }
    const gone = [...old, ...over].map((m) => m.key);
    if (gone.length) await s.remove(gone);
  } catch (err) {
    broken(err);
  }
}

/** On the thread's idle time (a worker has nothing else to do: soon) */
export function later(fn: () => unknown): void {
  const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(() => void fn(), { timeout: 4000 });
  else setTimeout(() => void fn(), 20);
}

// ---- packing: big typed arrays compressed ----

const ARRAYS: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
};
interface Packed { __z: string; bytes: ArrayBuffer }
const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function through(bytes: BufferSource, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
}

export async function pack(v: unknown): Promise<unknown> {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor.name;
    if (!canCompress || v.byteLength < COMPRESS_FROM || !ARRAYS[name]) return v;
    const z = await through(v as BufferSource, new CompressionStream('deflate-raw'));
    return z.byteLength < v.byteLength * 0.9 ? ({ __z: name, bytes: z } satisfies Packed) : v;
  }
  if (Array.isArray(v)) return Promise.all(v.map(pack));
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = await pack(x);
  return out;
}

export async function unpack(v: unknown): Promise<unknown> {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return Promise.all(v.map(unpack));
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  const z = v as Partial<Packed>;
  if (typeof z.__z === 'string' && z.bytes instanceof ArrayBuffer) return new ARRAYS[z.__z](await through(z.bytes, new DecompressionStream('deflate-raw')));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = await unpack(x);
  return out;
}

function sizeOf(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') return v.length * 2;
  if (typeof v !== 'object') return 8;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v.byteLength;
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v.size;
  let n = 0;
  for (const x of Object.values(v)) n += sizeOf(x) + 16;
  return n;
}

// ---- IndexedDB ----

const DB_NAME = 'space-assets';

function idbStore(): AssetStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('meta', { keyPath: 'key' });
      d.createObjectStore('data');
    };
    req.onsuccess = () => {
      const d = req.result;
      // (Another tab upgrading it: let it)
      d.onversionchange = () => d.close();
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  }));
  const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
  const ask = <R>(r: IDBRequest<R>) => new Promise<R>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  return {
    async read(key) {
      return ask((await open()).transaction('data').objectStore('data').get(key));
    },
    async write(key, meta, value) {
      const tx = (await open()).transaction(['meta', 'data'], 'readwrite');
      tx.objectStore('data').put(value, key);
      tx.objectStore('meta').put(meta);
      await done(tx);
    },
    async remove(keys) {
      const tx = (await open()).transaction(['meta', 'data'], 'readwrite');
      for (const k of keys) { tx.objectStore('meta').delete(k); tx.objectStore('data').delete(k); }
      await done(tx);
    },
    async metas() {
      return ask((await open()).transaction('meta').objectStore('meta').getAll()) as Promise<AssetMeta[]>;
    },
    async touch(key, used) {
      const tx = (await open()).transaction('meta', 'readwrite'), metas = tx.objectStore('meta');
      const m = await ask(metas.get(key)) as AssetMeta | undefined;
      if (m && used - m.used > TOUCH_AFTER) metas.put({ ...m, used });
      await done(tx);
    },
  };
}
