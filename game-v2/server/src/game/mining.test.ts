import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { registerRockTypes, type Bag, type MiningTable } from '@space-game/common';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { Mining, type MiningHost } from './Mining.js';

const files = readGameDataFiles(join(__dirname, '../../../data'));
const table = files.mining as unknown as MiningTable;
registerRockTypes(table);

/** A rock at the origin and a miner at (`mx`, `my`): the chunks thrown, as (position, velocity) */
function mine(miner: { x: number; y: number } | null, tool = { yield: 1.6, hardness: 2, grade: 1 }) {
  const thrown: { x: number; y: number; vx: number; vy: number }[] = [];
  const h: MiningHost = {
    spawnChunk: (_s, x, y, vx, vy, _items: Bag) => { thrown.push({ x, y, vx, vy }); },
    minerAt: miner ? () => miner : undefined,
    awardXp: () => {}, notify: () => {}, tick: () => 0, respawn: () => {}, crumble: () => {},
  };
  const m = new Mining(h, table);
  m.register(1, 0, 0, 'asteroid_metal', 'sol:0:0', 4000, 1);
  // Cut from the rock's side facing away from the miner (the rock's own normal points the other way)
  for (let k = 0; k < 300 && thrown.length < 8; k++) m.extract(1, 99, 200, tool, -100, 0, -1, 0);
  return thrown;
}

describe('mined chunks', () => {
  it('are thrown towards whoever mined them, a little faster than they would drift out of the rock', () => {
    const miner = { x: 400, y: 0 };
    const chunks = mine(miner);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const speed = Math.hypot(c.vx, c.vy);
      // Aimed at the miner (the rock's normal here points the other way)
      const toMiner = Math.atan2(miner.y - c.y, miner.x - c.x), heading = Math.atan2(c.vy, c.vx);
      expect(Math.abs(Math.atan2(Math.sin(heading - toMiner), Math.cos(heading - toMiner)))).toBeLessThan(0.2);
      // 1.2 to 2.6, and the boost on top
      expect(speed).toBeGreaterThan(1.2 + 3.4);
      expect(speed).toBeLessThan(2.6 + 3.8);
    }
  });

  it('with nobody to throw to, fly straight out of the rock as before', () => {
    for (const c of mine(null)) {
      expect(c.vx).toBeLessThan(0);
      expect(Math.hypot(c.vx, c.vy)).toBeLessThan(2.7);
    }
  });
});

/** A Mk `grade` mining laser (the Prospector's is Mk I, alloy: hardness 2) */
const laser = (grade = 1, hardness = 2) => ({ yield: table.tools.miner.yield, hardness, grade });
const tools = table.tools as unknown as Record<string, { yield: number; hardness: number; mining?: boolean }>;

/**
 * `seconds` of mining a big `type` rock of tier `tier` (the system's Mk): each tool in `rigs` doing `dps` damage a
 * second to it, in hits of `hit` damage (a laser's every tick), from ship `ship` (default one ship for all). Ore kept
 * and chunks thrown a minute, in all.
 */
function rate(type: string, tier: number, rigs: { tool: { yield: number; hardness: number; grade?: number; mining?: boolean }; dps: number; hit?: number; ship?: number }[], seconds = 600) {
  let t = 0, chunks = 0, ore = 0;
  const h: MiningHost = {
    spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { chunks++; ore += Object.values(items).reduce((a, b) => a + b, 0); },
    awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {}, rockTier: () => tier,
  };
  const m = new Mining(h, table);
  m.register(1, 0, 0, type, `rate:${type}`, 1e6, tier);
  const owed = rigs.map(() => 0);
  for (t = 0; t < seconds * 60; t++) {
    rigs.forEach((r, i) => {
      const hit = r.hit ?? r.dps / 60;
      owed[i] += r.dps / 60;
      while (owed[i] >= hit) { owed[i] -= hit; m.extract(1, 100 + (r.ship ?? 0), hit, r.tool, 0, 0, 1, 0); }
    });
  }
  return { ore: (ore / seconds) * 60, chunks: (chunks / seconds) * 60 };
}

/** The Prospector's Mk I mining laser: 42 damage a second (tuning miner.dps) */
const LASER_DPS = 42;
/** A starter's two Pips: 56 damage a second each (partStats), shells of about 28 */
const pips = () => [{ tool: tools.fixed, dps: 56, hit: 28 }, { tool: tools.fixed, dps: 56, hit: 28 }];

describe('mining: work and keep', () => {
  it('every gun mines soft rock at one normalised yield (the EMP does no damage to rock); the mining tools keep theirs', () => {
    for (const [k, t] of Object.entries(tools)) {
      if (k.startsWith('_') || k === 'minerByMaterial' || k === 'miner') continue;
      if (k === 'emp') { expect(t.yield).toBe(0); continue; }
      if (t.mining) continue;
      expect(t.yield, k).toBe(tools.fixed.yield);
    }
    expect(tools.charge.mining).toBe(true);
    expect(tools.siphon.mining).toBe(true);
    expect(table.tools.miner.yield).toBe(1.6);
  });

  it("a starter's Pips throw chunks about as often as a Mk I laser on Mk I rock; the laser gets about three times the ore", () => {
    const gun = rate('asteroid_metal', 1, pips()), mk1 = rate('asteroid_metal', 1, [{ tool: laser(), dps: LASER_DPS }]);
    expect(gun.chunks / mk1.chunks).toBeGreaterThan(0.8);
    expect(gun.chunks / mk1.chunks).toBeLessThan(1.25);
    expect(mk1.ore / gun.ore).toBeGreaterThan(2.6);
    expect(mk1.ore / gun.ore).toBeLessThan(3.8);
    // The laser: about 0.7 ore a second, all of it kept
    expect(mk1.ore).toBeGreaterThan(0.65 * 60);
    expect(mk1.ore).toBeLessThan(0.75 * 60);
  });

  it('guns keep less past Mk I, and much less again further out; the drops that roll nothing are skipped', () => {
    // (Every unit is a dice roll: long runs, so the averages show through)
    const one = rate('asteroid_metal', 1, pips(), 3000), two = rate('asteroid_metal', 2, pips(), 3000), three = rate('asteroid_metal', 3, pips(), 3000);
    expect(two.ore).toBeLessThan(one.ore * 0.5);
    expect(three.ore).toBeLessThan(two.ore * 0.5);
    // Chunks come as often, but a drop whose rolls all failed is skipped: the less kept, the more skipped
    expect(two.chunks).toBeLessThan(one.chunks * 0.85);
    expect(two.chunks).toBeGreaterThan(one.chunks * 0.45);
    expect(three.chunks).toBeLessThan(two.chunks);
    // A Mk I laser a grade or two behind still beats them
    expect(rate('asteroid_metal', 2, [{ tool: laser(), dps: LASER_DPS }]).ore).toBeGreaterThan(two.ore * 3);
    expect(rate('asteroid_metal', 3, [{ tool: laser(), dps: LASER_DPS }]).ore).toBeGreaterThan(three.ore * 3);
  });

  it('a big gunship works the rock faster, but only with the square root of its damage past a starter\'s', () => {
    const starter = rate('asteroid_metal', 1, pips());
    const gale = rate('asteroid_metal', 1, [{ tool: tools.autocannon, dps: 160, hit: 5 }, { tool: tools.arc, dps: 77, hit: 8 }]);
    const ratio = gale.chunks / starter.chunks;
    expect(ratio).toBeGreaterThan(1.2);
    expect(ratio).toBeLessThan(Math.sqrt(237 / 112) * 1.15);
  });

  it('guns keep about a third of the common ores, and half that of the rest', () => {
    const got: Bag = {};
    let t = 0;
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {} };
    const m = new Mining({ ...h, mined: (_m, bag) => { for (const [k, n] of Object.entries(bag)) got[k] = (got[k] ?? 0) + n; } }, table);
    m.register(1, 0, 0, 'asteroid_metal', 'k', 1e6, 1);
    const before = m.remaining(1);
    for (t = 0; t < 360000; t++) if (t % 15 === 0) m.extract(1, 99, 28, tools.fixed, 0, 0, 1, 0);
    const kept = Object.values(got).reduce((a, b) => a + b, 0), gone = before - m.remaining(1);
    expect(kept / gone).toBeGreaterThan(0.27);
    expect(kept / gone).toBeLessThan(0.33);
    // Copper is 10 of the Chondrite's 111 (a third of it lost the more)
    expect((got.copper_ore ?? 0) / kept).toBeLessThan(0.07);
    expect((got.copper_ore ?? 0) / kept).toBeGreaterThan(0.02);
    expect((got.iron_ore ?? 0) / kept).toBeGreaterThan(0.5);
  });

  it('guns crack soft rock only, and say to fit a mining laser; a mining charge cracks the hardest', () => {
    const said: string[] = [];
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: (_e, text) => said.push(text), tick: () => 0, respawn: () => {}, crumble: () => {} };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'rock_rutile', 'a', 1e6, 1);
    m.register(2, 0, 0, 'rock_cobaltite', 'b', 1e6, 1);
    const r = m.remaining(1);
    // (A lance is as hard as they come, and still a gun)
    for (let k = 0; k < 100; k++) m.extract(1, 7, 50, tools.lance, 0, 0, 1, 0);
    expect(m.remaining(1)).toBe(r);
    expect(said[0]).toBe('This rock is too hard for your guns: fit a mining laser');
    const c = m.remaining(2);
    m.extract(2, 8, 400, tools.charge, 0, 0, 1, 0);
    expect(m.remaining(2)).toBeLessThan(c);
  });
});

describe('chunks follow the rock', () => {
  it('break off every 5 to 10 units worked, with whatever was kept in them (none empty)', () => {
    const sizes: number[] = [];
    let t = 0;
    const h: MiningHost = {
      spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { sizes.push(Object.values(items).reduce((a, b) => a + b, 0)); },
      awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {},
    };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'k', 1e6, 1);
    const before = m.remaining(1);
    for (t = 0; t < 60 * 120; t++) if (t % 15 === 0) m.extract(1, 99, 28, tools.fixed, 0, 0, 1, 0);
    const worked = before - m.remaining(1);
    // (A drop whose rolls all failed is skipped: at a third kept, one in ten or so)
    expect(sizes.length).toBeGreaterThan((worked / 10) * 0.7);
    expect(sizes.length).toBeLessThanOrEqual(worked / 5 + 1);
    for (const n of sizes) { expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(10); }
  });

  it('a laser keeps it all: 5 to 10 units a chunk (what is left still drops when the rock is mined out)', () => {
    const sizes: number[] = [];
    let crumbled = false;
    const h: MiningHost = {
      spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { sizes.push(Object.values(items).reduce((a, b) => a + b, 0)); },
      awardXp: () => {}, notify: () => {}, tick: () => 0, respawn: () => {}, crumble: () => { crumbled = true; },
    };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'sol:0:0', 400, 1);
    const units = m.get(1)!.units;
    for (let k = 0; k < 2000 && !crumbled; k++) m.extract(1, 99, 2, laser(), 0, 0, 1, 0);
    expect(crumbled).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(units);
    for (const n of sizes.slice(0, -1)) { expect(n).toBeGreaterThanOrEqual(5); expect(n).toBeLessThanOrEqual(10); }
    expect(sizes.at(-1)!).toBeLessThanOrEqual(10);
  });

  it('a drop whose rolls all failed is skipped; over many rolls the keep averages out', () => {
    const sizes: number[] = [];
    let t = 0;
    const h: MiningHost = { spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { sizes.push(Object.values(items).reduce((a, b) => a + b, 0)); }, awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {}, rockTier: () => 4 };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'k', 1e6, 4);
    const before = m.remaining(1);
    // (Mk IV rock: guns keep a fortieth or so)
    for (t = 0; t < 60 * 6000; t++) if (t % 15 === 0) m.extract(1, 99, 28, tools.fixed, 0, 0, 1, 0);
    const worked = before - m.remaining(1);
    expect(sizes.every((n) => n >= 1)).toBe(true);
    expect(sizes.length).toBeLessThan(worked / 10);
    const kept = sizes.reduce((a, b) => a + b, 0), want = table.guns!.keep * table.guns!.keepByTier['4'] * 0.95;
    expect(kept / worked).toBeGreaterThan(want * 0.8);
    expect(kept / worked).toBeLessThan(want * 1.2);
  });

  it('every keep is a dice roll: chunk sizes vary, and a run of bad rolls still takes the rock down', () => {
    // A Mk I laser a grade behind (80% kept), on one rock: chunk sizes spread around the average, not steady
    const sizes: number[] = [];
    let t = 0;
    const h: MiningHost = {
      spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { sizes.push(Object.values(items).reduce((a, b) => a + b, 0)); },
      awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {}, rockTier: () => 2,
    };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'k', 1e6, 2);
    const before = m.remaining(1);
    for (t = 0; t < 60 * 600; t++) m.extract(1, 99, LASER_DPS / 60, laser(1, 3), 0, 0, 1, 0);
    const worked = before - m.remaining(1), kept = sizes.reduce((a, b) => a + b, 0);
    expect(kept / worked).toBeGreaterThan(0.75);
    expect(kept / worked).toBeLessThan(0.85);
    // Mining XP is per unit kept (what's owed and not yet paid out in whole points)
    expect((m as unknown as { xpOwed: Map<number, number> }).xpOwed.get(99)).toBeCloseTo(kept * table.xpPerUnit, 6);
    // Variance: for one chunk length the kept count differs chunk to chunk (a running total would give the same each time)
    expect(new Set(sizes).size).toBeGreaterThan(4);
    expect(Math.min(...sizes)).toBeLessThan(5);
  });

  it("the rolls are the rock's own seeded dice: the same hits replay the same drops", () => {
    const run = () => {
      const sizes: number[] = [];
      const h: MiningHost = { spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { sizes.push(Object.values(items).reduce((a, b) => a + b, 0)); }, awardXp: () => {}, notify: () => {}, tick: () => 0, respawn: () => {}, crumble: () => {}, rockTier: () => 3 };
      const m = new Mining(h, table);
      m.register(5, 0, 0, 'asteroid_metal', 'k', 1e6, 3);
      for (let k = 0; k < 20000; k++) m.extract(5, 99, 1, laser(1, 3), 0, 0, 1, 0);
      return sizes;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(10);
    expect(run()).toEqual(a);
  });

  it('a chunk whose rolls all failed is skipped: at a third kept, some drops never come', () => {
    let chunks = 0, t = 0;
    const h: MiningHost = { spawnChunk: () => { chunks++; }, awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {} };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'k', 1e6, 1);
    const before = m.remaining(1);
    for (t = 0; t < 60 * 3000; t++) if (t % 15 === 0) m.extract(1, 99, 28, tools.fixed, 0, 0, 1, 0);
    // 5 to 10 units a drop (7.5 on average); a few in a hundred roll nothing at all
    const drops = (before - m.remaining(1)) / 7.5;
    expect(chunks).toBeLessThan(drops * 0.99);
    expect(chunks).toBeGreaterThan(drops * 0.85);
  });

  it('rocks hold 1.5x the ore they did (0.1 a unit of size before)', () => {
    expect(table.unitsPerSize).toBeCloseTo(0.15);
  });
});

describe('mining lasers against the rock', () => {
  it('full yield at their grade or below; a grade behind a little slower and keeping 80%; two behind slower again keeping 60%; further, nothing', () => {
    expect(table.laserGap!['0']).toEqual({ work: 1, keep: 1 });
    expect(table.laserGap!['-1']).toEqual({ work: 0.85, keep: 0.8 });
    expect(table.laserGap!['-2']).toEqual({ work: 0.7, keep: 0.6 });
    const at = (tier: number, grade = 1) => rate('asteroid_metal', tier, [{ tool: laser(grade, 3), dps: LASER_DPS }], 1800);
    const own = at(1), one = at(2), two = at(3), three = at(4);
    expect(one.chunks / own.chunks).toBeCloseTo(0.85, 1);
    expect(one.ore / own.ore).toBeCloseTo(0.85 * 0.8, 1);
    expect(two.chunks / own.chunks).toBeCloseTo(0.7, 1);
    expect(two.ore / own.ore).toBeCloseTo(0.7 * 0.6, 1);
    expect(three.ore).toBe(0);
    // A grade ahead: a little faster
    expect(at(1, 2).ore).toBeGreaterThan(own.ore * 1.1);
  });

  it('each laser mines on its own: twice the lasers, twice the ore (no crowding)', () => {
    for (const type of ['asteroid_metal', 'rock_cobaltite']) {
      const one = rate(type, 3, [{ tool: laser(3, 3), dps: LASER_DPS }], 120);
      const four = rate(type, 3, [0, 1, 2, 3].map((ship) => ({ tool: laser(3, 3), dps: LASER_DPS, ship })), 120);
      expect(four.ore / one.ore).toBeGreaterThan(3.7);
      expect(four.ore / one.ore).toBeLessThan(4.3);
    }
  });

  it('a laser behind the rock says what it gets, quietly; at its grade it says nothing', () => {
    const said: string[] = [];
    let t = 0;
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: (_e, text) => said.push(text), tick: () => t, respawn: () => {}, crumble: () => {}, rockTier: () => 2 };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'a', 1e6, 2);
    for (t = 0; t < 600; t++) m.extract(1, 7, 1, laser(2), 0, 0, 1, 0);
    expect(said).toEqual([]);
    for (; t < 1200; t++) m.extract(1, 7, 1, laser(1), 0, 0, 1, 0);
    expect(said[0]).toBe('Mk II rock: your Mk I mining laser works it 85% as fast and keeps 80% of the ore');
    // (Throttled: once every 6 seconds)
    expect(said.length).toBeLessThanOrEqual(2);
  });

  it('too hard for the laser: it says to fit a harder one', () => {
    const said: string[] = [];
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: (_e, text) => said.push(text), tick: () => 0, respawn: () => {}, crumble: () => {} };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'rock_cobaltite', 'a', 1e6, 1);
    const r = m.remaining(1);
    m.extract(1, 7, 500, laser(1, 2), 0, 0, 1, 0);
    expect(m.remaining(1)).toBe(r);
    expect(said[0]).toBe('This rock is too hard for your mining laser: fit a harder one');
  });
});

describe('the numbers (docs/areas/economy-quests.md)', () => {
  it('ore and chunks a minute', () => {
    // (Every keep is a dice roll: 3000 s so the averages show through)
    const S = 3000;
    const L = (grade: number) => ({ tool: laser(grade, 3), dps: LASER_DPS });
    const rows: [string, { ore: number; chunks: number }][] = [
      ['Starter Pips, Mk I soft rock', rate('asteroid_metal', 1, pips(), S)],
      ['Starter Pips, Mk II soft rock', rate('asteroid_metal', 2, pips(), S)],
      ['Starter Pips, Mk III soft rock', rate('asteroid_metal', 3, pips(), S)],
      ['Gale (2 Chainsaws, 2 Sparks), Mk I soft rock', rate('asteroid_metal', 1, [{ tool: tools.autocannon, dps: 160, hit: 5 }, { tool: tools.arc, dps: 77, hit: 8 }], S)],
      ['Mk I laser, Mk I rock (gap 0)', rate('asteroid_metal', 1, [L(1)], S)],
      ['Mk I laser, Mk II hard rock (gap -1)', rate('asteroid_mega', 2, [L(1)], S)],
      ['Mk I laser, Mk III hard rock (gap -2)', rate('asteroid_mega', 3, [L(1)], S)],
      ['Mk III laser, Mk III hard rock', rate('rock_cobaltite', 3, [L(3)], S)],
      ['3 Mk III lasers (3 ships), Mk III hard rock', rate('rock_cobaltite', 3, [0, 1, 2].map((ship) => ({ ...L(3), ship })), S)],
    ];
    console.log(rows.map(([k, v]) => `${k}: ${v.ore.toFixed(1)} ore/min, ${v.chunks.toFixed(1)} chunks/min`).join('\n'));
    // main_01: 10 ore with a starter's guns well inside 90 seconds of mining
    expect(600 / rows[0][1].ore).toBeLessThan(60);
  });
});

describe('mining pace', () => {
  /** Seconds `n` matching mining lasers (42 dps each, grade = the system's tier) take to mine out a `size` rock of `type` */
  function mineOut(type: string, size: number, n: number, gap = 0): number {
    let t = 0, gone = false;
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => { gone = true; }, rockTier: () => 3 };
    const m = new Mining(h, table);
    m.register(1, 0, 0, type, 'pace', size, 3);
    for (t = 0; t < 60 * 3600 && !gone; t++) for (let i = 0; i < n; i++) m.extract(1, 100 + i, 42 / 60, { yield: 1.6, hardness: 3, grade: 3 + gap }, 0, 0, 1, 0);
    return t / 60;
  }

  it('one matching laser takes 5 to 10 seconds on a small soft rock, and longer on bigger ones', () => {
    const small = mineOut('asteroid_metal', 33, 1), typical = mineOut('asteroid_metal', 60, 1), large = mineOut('asteroid_metal', 100, 1);
    expect(small).toBeGreaterThanOrEqual(5);
    expect(small).toBeLessThanOrEqual(10);
    expect(typical).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(typical);
    expect(large).toBeLessThan(30);
  });

  it('more lasers on a rock mine it out sooner', () => {
    expect(mineOut('asteroid_metal', 33, 2)).toBeLessThan(mineOut('asteroid_metal', 33, 1));
    expect(mineOut('asteroid_metal', 33, 4)).toBeLessThan(mineOut('asteroid_metal', 33, 2));
  });
});
