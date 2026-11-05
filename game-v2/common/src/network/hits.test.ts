import { describe, it, expect } from 'vitest';
import { packHits, unpackHits, hpChecksum, CAPS, hitHash, chainAdd, unwrapTick14, type ShellHitRecord } from './hits.js';
import { encodeBinary, decodeBinaryAll } from './binaryCodec.js';

describe('confirmed hit records (hits.ts)', () => {
  it('pack and unpack: targets only when they change, extras only when there are any', () => {
    const recs: ShellHitRecord[] = [
      { shell: 900, ago: 0, target: 12, part: 3, gone: true, glancing: false },
      { shell: 901, ago: 1, target: 12, part: 4, gone: false, glancing: true },
      { shell: 899, ago: 7, target: 40, part: 0, gone: true, glancing: false, d10: 31, shield: true, ignite: 5 },
      { shell: 905, ago: 3, target: 12, part: 200, gone: false, glancing: false, ignite: -1 },
    ];
    const h = packHits(recs);
    expect(h.slice(0, 4)).toEqual([900, 8 | 16, 12, 3]);
    expect(h.slice(4, 7)).toEqual([1, 1 | 32, 4]);
    expect(unpackHits(h)).toEqual(recs);
  });

  it('ago is clamped to 0-7', () => {
    expect(unpackHits(packHits([{ shell: 1, ago: 12, target: 2, part: 0, gone: false, glancing: false }]))[0].ago).toBe(7);
  });

  it('fuzz: 1,000 random batches come back the same through the binary codec', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const int = (n: number) => Math.floor(rnd() * n);
    for (let k = 0; k < 1000; k++) {
      const recs: ShellHitRecord[] = [];
      let target = 1000 + int(5000);
      for (let i = 0, n = 1 + int(12); i < n; i++) {
        if (rnd() < 0.3) target = 1000 + int(5000);
        const r: ShellHitRecord = { shell: 1 + int(60000), ago: int(8), target, part: int(300), gone: rnd() < 0.7, glancing: rnd() < 0.2 };
        if (rnd() < 0.2) r.d10 = int(5000);
        if (rnd() < 0.1) { r.shield = true; r.d10 = int(800); }
        if (rnd() < 0.1) r.ignite = int(40) - 1;
        recs.push(r);
      }
      const back = decodeBinaryAll(encodeBinary(packHits(recs)))[0] as number[];
      expect(unpackHits(back)).toEqual(recs);
    }
  });

  it('a list cut short gives what was read so far', () => {
    const h = packHits([{ shell: 7, ago: 0, target: 3, part: 1, gone: true, glancing: false }, { shell: 8, ago: 0, target: 3, part: 2, gone: true, glancing: false, d10: 40 }]);
    expect(unpackHits(h.slice(0, h.length - 1))).toHaveLength(1);
    expect(unpackHits([1, -5, 3])).toEqual([]);
  });

  it('hpChecksum: weighs each part by its place, to a tenth', () => {
    expect(hpChecksum([1, 2.5, 0])).toBe(10 + 50);
    expect(hpChecksum([2.5, 1, 0])).not.toBe(hpChecksum([1, 2.5, 0]));
    expect(hpChecksum([0.1])).not.toBe(hpChecksum([0.2]));
    expect(CAPS.HITS).toBe(1);
  });
});

describe('the hit chain (client-detected hits, part D)', () => {
  it('hitHash is a 32-bit mix of shell, ship and part: each one changes it', () => {
    const h = hitHash(5021, 1880, 7);
    expect(h).toBe(hitHash(5021, 1880, 7));
    expect(h >>> 0).toBe(h);
    expect(hitHash(5022, 1880, 7)).not.toBe(h);
    expect(hitHash(5021, 1881, 7)).not.toBe(h);
    expect(hitHash(5021, 1880, 8)).not.toBe(h);
    // (its low byte, what a report carries, spreads: 1,000 hits fill most of the 256 values)
    const lows = new Set<number>();
    for (let i = 0; i < 1000; i++) lows.add(hitHash(4000 + i, 1880, i % 40) & 0xff);
    expect(lows.size).toBeGreaterThan(220);
  });

  it('the chain is a sum: the same hits in any order come to the same chain', () => {
    const hits = [[5021, 1880, 7], [5023, 1880, 3], [4990, 2017, 140], [5100, 12, 0]].map(([s, t, p]) => hitHash(s, t, p));
    const a = hits.reduce(chainAdd, 0), b = [...hits].reverse().reduce(chainAdd, 0);
    expect(a).toBe(b);
    expect(a >>> 0).toBe(a);
    expect(hits.slice(1).reduce(chainAdd, 0)).not.toBe(a);
  });

  it('a report tick unwraps from its low 14 bits to the one nearest', () => {
    for (const t of [0, 5, 16383, 16384, 70119, 1_000_000]) {
      expect(unwrapTick14(t & 0x3fff, t + 40)).toBe(t);
      expect(unwrapTick14(t & 0x3fff, t - 40)).toBe(t);
    }
  });

  it('SELF_HITS is its own bit beside HITS', () => {
    expect(CAPS.SELF_HITS & CAPS.HITS).toBe(0);
  });
});
