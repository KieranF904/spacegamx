import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { assetKind, hashOf, pack, setAssetStore, trim, unpack, type AssetMeta, type AssetStore } from './assetCache';

/** A store in a Map (IndexedDB's stand-in), counting what it's asked */
function mapStore() {
  const data = new Map<string, unknown>(), meta = new Map<string, AssetMeta>();
  const s: AssetStore & { data: typeof data; reads: number } = {
    data, reads: 0,
    async read(k) { s.reads++; return data.get(k); },
    async write(k, m, v) { data.set(k, v); meta.set(k, m); },
    async remove(keys) { for (const k of keys) { data.delete(k); meta.delete(k); } },
    async metas() { return [...meta.values()]; },
    async touch(k, used) { const m = meta.get(k); if (m) meta.set(k, { ...m, used }); },
  };
  return s;
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); expect(ok()).toBe(true); };

afterEach(() => setAssetStore(null));

describe('asset cache', () => {
  it('builds once, then serves it from memory', async () => {
    setAssetStore(null);
    const kind = assetKind<number[]>('test-memory', 1);
    let builds = 0;
    const build = () => { builds++; return [1, 2, 3]; };
    const [a, b] = await Promise.all([kind.get('x', build), kind.get('x', build)]);
    expect(await kind.get('x', build)).toBe(a);
    expect(b).toBe(a);
    expect(builds).toBe(1);
    expect(kind.peek('x')).toBe(a);
    expect(kind.peek('y')).toBeUndefined();
  });

  it('stores in the background and reads it back on a later visit, exactly as built (big arrays compressed)', async () => {
    const store = mapStore();
    setAssetStore(store);
    const smooth = new Uint8Array(256 * 1024).map((_, i) => (i >> 10) & 255);
    const value = { atlas: smooth, verts: new Float32Array([0.5, -1.25, 3e-8]), pieces: [{ n: 2, idx: new Uint32Array([1, 2, 3]) }], name: 'x' };
    const first = assetKind<typeof value>('test-store', 1);
    expect(await first.get('in', () => value)).toBe(value);
    await until(() => store.data.size === 1);
    const packed = [...store.data.values()][0] as { atlas: { __z?: string } };
    expect(packed.atlas.__z).toBe('Uint8Array');
    // (A new visit: nothing in memory)
    const again = assetKind<typeof value>('test-store', 1);
    let built = false;
    const read = await again.get('in', () => { built = true; return value; });
    expect(built).toBe(false);
    expect(read).not.toBe(value);
    expect(read.atlas).toBeInstanceOf(Uint8Array);
    expect([...read.atlas]).toEqual([...smooth]);
    expect(read.verts).toEqual(value.verts);
    expect(read.pieces[0].idx).toEqual(value.pieces[0].idx);
    expect(read.name).toBe('x');
  });

  it('keeps a copy: the caller can hand the original away at once', async () => {
    const store = mapStore();
    setAssetStore(store);
    const kind = assetKind<Uint8Array>('test-copy', 1, { memory: false });
    const a = await kind.get('', () => new Uint8Array([7, 8, 9]));
    a.fill(0);
    await until(() => store.data.size === 1);
    expect([...(await assetKind<Uint8Array>('test-copy', 1).get('', () => new Uint8Array(0)))]).toEqual([7, 8, 9]);
  });

  it('a new version never reads the old one, and the old ones are cleared out', async () => {
    const store = mapStore();
    setAssetStore(store);
    await assetKind<string>('test-version', 1).get('', () => 'old');
    await until(() => store.data.size === 1);
    expect(() => assetKind<string>('test-version', 2)).toThrow(/declared twice/);
  });

  it('drops the least recently used past the budget', async () => {
    const store = mapStore();
    setAssetStore(store);
    for (const [k, used] of [['a', 1], ['b', 3], ['c', 2]] as const) {
      await store.write(k, { key: k, kind: 'test-lru', version: 1, size: 100, used }, 'v');
    }
    await trim(250);
    expect([...store.data.keys()].sort()).toEqual(['b', 'c']);
  });

  it('carries on building when the store fails', async () => {
    const fail = async () => { throw new Error('quota'); };
    setAssetStore({ read: fail, write: fail, remove: fail, metas: fail, touch: fail });
    const kind = assetKind<number>('test-broken', 1);
    expect(await kind.get('', () => 42)).toBe(42);
    expect(await assetKind<number>('test-broken', 1).get('', () => 43)).toBe(43);
  });

  it('packs to nothing smaller when it does not help, and back exactly', async () => {
    const noise = new Uint8Array(64 * 1024).map(() => Math.floor(Math.random() * 256));
    expect(await pack(noise)).toBe(noise);
    const small = new Float32Array([1, 2]);
    expect(await pack(small)).toBe(small);
    expect(await unpack(await pack({ a: [noise, 'x'] }))).toEqual({ a: [noise, 'x'] });
  });

  it('hashes inputs by their content, keys in any order', () => {
    expect(hashOf({ a: 1, b: [2, 'x'] })).toBe(hashOf({ b: [2, 'x'], a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(hashOf({ a: '1' })).not.toBe(hashOf({ a: 1 }));
    expect(hashOf(new Float32Array([1, 2]))).not.toBe(hashOf(new Float32Array([1, 3])));
    expect(hashOf(new Float32Array([1, 2]))).not.toBe(hashOf(new Uint8Array(new Float32Array([1, 2]).buffer)));
  });

  it('every kind declared in the client names its generator\'s version: an exported whole number', () => {
    const src = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p); } };
    walk(src);
    const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
    const versions = new Map<string, number>();
    for (const t of texts.values()) for (const m of t.matchAll(/export const ([A-Z][A-Z0-9_]*_VERSION) = (\d+);/g)) versions.set(m[1], Number(m[2]));
    const names = new Set<string>();
    let declared = 0;
    for (const [f, t] of texts) {
      if (f.endsWith(join('assets', 'assetCache.ts')) || f.endsWith(join('assets', 'pictureSheet.ts'))) continue;
      for (const m of t.matchAll(/(?:assetKind|pictureSheet)(?:<.+?>)?\(\s*'([^']+)',\s*([A-Za-z0-9_]+)/g)) {
        declared++;
        const [, name, version] = m;
        expect(version, `${name} (${f})`).toMatch(/_VERSION$/);
        expect(versions.get(version), `${version} for ${name}`).toBeGreaterThanOrEqual(1);
        expect(names.has(name), `${name} declared twice`).toBe(false);
        names.add(name);
      }
    }
    // (rocks, stillstones, station atlas and bakes, hull atlas and geometry, sky noise, icons, part pictures, frost)
    expect(declared).toBeGreaterThanOrEqual(10);
  });
});
