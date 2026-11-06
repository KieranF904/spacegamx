/**
 * Payout dice: every roll that decides what a pilot gets draws from here, keyed by a secret only the server holds.
 * That covers mining's keep, gem, ore and skill bonus rolls, kill loot and salvaged parts, boss loot, event pods,
 * den caches and gem cuts (docs/areas/economy-quests.md, Invariants: "Two kinds of seed").
 *
 * A seed anything else knows (an entity id, a tick, a name) lets a client work out the rolls before they're made.
 * Clients may work out the *odds* (the rock's composition, the loot tables: the game shows them). The rolls come
 * from the secret.
 *
 * The secret is 256 bits: random each boot, or fixed by GameServerOptions.payoutSecret / the PAYOUT_SECRET environment
 * variable (tests, benches: the same rolls every run). It is never sent anywhere. Each stream is SHA-256's compression
 * function over the secret, the stream's name and numbers, and a counter (eight draws a block). The rolls can't be
 * worked back to the secret, and one stream's rolls say nothing of another's.
 *
 * Plain JavaScript (no node:crypto): the server also runs in the browser (proto mode). Server-only: common/ stays
 * deterministic and never sees this.
 */
import { hashString } from '@space-game/common';

/** A stream of draws in [0, 1) */
export type Dice = () => number;

export class PayoutDice {
  private readonly key: Uint32Array;

  /** `secret`: a fixed one (tests, benches); none: PAYOUT_SECRET if set, else random (each boot its own) */
  constructor(secret?: string) {
    const s = secret ?? envSecret();
    this.key = new Uint32Array(8);
    if (s !== undefined) for (let i = 0; i < 8; i++) this.key[i] = hashString(`${s}\u0000payout\u0000${i}`);
    else globalThis.crypto.getRandomValues(this.key);
  }

  /** A stream for one thing: a name and up to five numbers (a rock: 'rock', its id, which of its lives) */
  stream(name: string, ...keys: number[]): Dice {
    const block = new Uint32Array(16), out = new Uint32Array(8);
    block.set(this.key, 0);
    block[8] = hashString(name);
    for (let i = 0; i < 5; i++) block[9 + i] = (keys[i] ?? 0) >>> 0;
    block[15] = keys.length;
    let counter = 0, at = 8;
    return () => {
      if (at >= 8) {
        block[14] = counter++;
        compress(block, out);
        at = 0;
      }
      return out[at++] / 4294967296;
    };
  }

  /** One 32-bit seed for one thing (a roll made by code that keeps its own generator: a den cache's table) */
  seed(name: string, ...keys: number[]): number {
    return Math.floor(this.stream(name, ...keys)() * 4294967296) >>> 0;
  }
}

function envSecret(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.PAYOUT_SECRET || undefined;
}

// ---- SHA-256's compression function (FIPS 180-4), one block from the standard initial hash ----

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const W = new Uint32Array(64);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256's compression of one 16-word block (big-endian words) from the initial hash, into `out` (8 words) */
export function compress(block: Uint32Array, out: Uint32Array): void {
  for (let i = 0; i < 16; i++) W[i] = block[i];
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2];
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3), s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = IV[0], b = IV[1], c = IV[2], d = IV[3], e = IV[4], f = IV[5], g = IV[6], h = IV[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  out[0] = IV[0] + a; out[1] = IV[1] + b; out[2] = IV[2] + c; out[3] = IV[3] + d;
  out[4] = IV[4] + e; out[5] = IV[5] + f; out[6] = IV[6] + g; out[7] = IV[7] + h;
}
