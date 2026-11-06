/**
 * Deterministic randomness: the same numbers in Node and every browser engine (only integer ops and one exact division).
 *
 * Simulation code never calls Math.random (common/src/math/simMaths.test.ts fails on it). What both sides must work out
 * alike draws from a generator seeded by what both know: the system, the entity, the tick, a salt
 * (`tickRng(systemSeed, entity, tick, salt)`; shells: ships/rng.ts shotSeed; debris: ships/debris.ts splitRng; rocks:
 * asteroid/generation.ts). A decision only the server makes (where a pack spawns, a siege's next wave, a boss's next
 * attack) may use a long-lived server generator (`mulberry32(seed)` kept by its system): clients get the outcome, or
 * (lockstep, next stage) a small decision input both sides then act on at the same tick.
 *
 * Not for payouts: a roll that decides what a pilot gets (mining's dice, loot, salvage, pods, caches, gem cuts) is the
 * server's, keyed by a secret no client has (server/src/game/payoutDice.ts). These seeds are all things a client knows.
 */

/** 32-bit FNV-1a over integers (each as 4 bytes) */
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

/** 32-bit FNV-1a over a string's UTF-16 code units: a seed from a name */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a function giving floats in [0, 1), the state kept in 32 bits (the same sequence however long it runs) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The same generator (the name ships/ code has always used) */
export const seededRng = mulberry32;

/** A generator for one thing on one tick: seeded by hashInts of what both sides know (system, entity, tick, a salt) */
export function tickRng(...keys: number[]): () => number {
  return mulberry32(hashInts(...keys));
}

/** One draw in [0, 1) from integers, no generator kept (the first number tickRng(...keys) would give) */
export function hashUnit(...keys: number[]): number {
  let t = (hashInts(...keys) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
