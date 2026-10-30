/**
 * Deterministic randomness for ship logic. Never use Math.random in ships/.
 */

/** 32-bit FNV-1a style mix of integers. */
export function hashInts(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193);
      x >>>= 8;
    }
  }
  return h >>> 0;
}

/** mulberry32: returns a function giving floats in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shot seed: hash(shipId, weaponUid, tick). */
export function shotSeed(shipId: number, weaponUid: number, tick: number): number {
  return hashInts(shipId, weaponUid, tick);
}
