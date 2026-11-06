/**
 * Payout dice (payoutDice.ts): rolls from the server's secret, never from what a client knows
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { join } from 'path';
import { registerRockTypes, type Bag, type MiningTable } from '@space-game/common';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { Mining, type MiningHost } from './Mining.js';
import { PayoutDice, compress } from './payoutDice.js';

const table = readGameDataFiles(join(__dirname, '../../../data')).mining as unknown as MiningTable;
registerRockTypes(table);

const draws = (d: () => number, n = 32) => Array.from({ length: n }, () => d());

describe('payout dice', () => {
  it("is SHA-256's compression function (the FIPS 180-4 'abc' block)", () => {
    const block = new Uint32Array(16), out = new Uint32Array(8);
    block[0] = 0x61626380;
    block[15] = 24;
    compress(block, out);
    const want = createHash('sha256').update('abc').digest();
    for (let i = 0; i < 8; i++) expect(out[i]).toBe(want.readUInt32BE(i * 4));
  });

  it('a fixed secret rolls the same every time; another secret, other rolls', () => {
    const a = draws(new PayoutDice('one').stream('rock', 12, 0));
    expect(draws(new PayoutDice('one').stream('rock', 12, 0))).toEqual(a);
    expect(draws(new PayoutDice('two').stream('rock', 12, 0))).not.toEqual(a);
    for (const x of a) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
  });

  it("each thing's stream is its own (name, numbers, a rock come back under the same id)", () => {
    const d = new PayoutDice('one'), a = draws(d.stream('rock', 12, 0));
    expect(draws(d.stream('rock', 12, 1))).not.toEqual(a);
    expect(draws(d.stream('rock', 13, 0))).not.toEqual(a);
    expect(draws(d.stream('kill loot'))).not.toEqual(draws(d.stream('boss loot')));
  });

  it('with no secret given or set, each boot rolls its own', () => {
    const was = process.env.PAYOUT_SECRET;
    delete process.env.PAYOUT_SECRET;
    try {
      expect(draws(new PayoutDice().stream('rock', 12, 0))).not.toEqual(draws(new PayoutDice().stream('rock', 12, 0)));
    } finally {
      process.env.PAYOUT_SECRET = was;
    }
    // (tests have one set: vitest.config.ts)
    expect(draws(new PayoutDice().stream('rock', 12, 0))).toEqual(draws(new PayoutDice(was).stream('rock', 12, 0)));
  });

  it("a rock's dice are the secret's, not its id's: the same rock under another secret pays otherwise", () => {
    const run = (secret: string) => {
      const out: string[] = [];
      const h: MiningHost = {
        spawnChunk: (_s, _x, _y, vx, vy, items: Bag) => { out.push(`${vx.toFixed(6)},${vy.toFixed(6)}:${JSON.stringify(items)}`); },
        awardXp: () => {}, notify: () => {}, tick: () => 0, respawn: () => {}, crumble: () => {},
      };
      const m = new Mining(h, table, new PayoutDice(secret));
      m.register(1, 0, 0, 'asteroid_metal', 'sol:0:0', 4000, 1);
      for (let k = 0; k < 300 && out.length < 8; k++) m.extract(1, 99, 200, { yield: 1.6, hardness: 2, grade: 1 }, -100, 0, -1, 0);
      return out;
    };
    const a = run('one');
    expect(a.length).toBeGreaterThan(3);
    expect(run('one')).toEqual(a);
    expect(run('two')).not.toEqual(a);
  });

  it('rolls evenly', () => {
    const d = new PayoutDice('one').stream('even'), bins = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) bins[Math.floor(d() * 10)]++;
    for (const b of bins) expect(Math.abs(b - 2000)).toBeLessThan(200);
  });
});
