import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import {
  unitsPerDrop, pulseProfile, pulseCut, pulseCutOver, MINING_PULSE, registerRockTypes, asteroidComposition, mineSeed, chunkWant, unitKept,
  keepOdds, toolKeep, type MiningTable,
} from '@space-game/common';

// (No canvas here: the strike's particle textures are stand-ins)
vi.mock('../rendering/fxTextures', () => ({ disc: () => 'disc', rock: (i: number) => `rock:${Math.abs(i) % 4}` }));

import { readGameDataFiles } from '../../../server/src/data/loadGameDataFromDisk';
import { Mining, type MiningHost, type MiningTool } from '../../../server/src/game/Mining';
import { PayoutDice } from '../../../server/src/game/payoutDice';
import { MiningProgress, SHOW_FOR, FADE, type MineRock } from './MiningProgress';

const table = readGameDataFiles(join(__dirname, '../../../data')).mining as unknown as MiningTable;
registerRockTypes(table);

function rig() {
  let t = 100;
  const p = new MiningProgress(null, table, () => t);
  return { p, at: (s: number) => { t = s; }, now: () => t };
}

const ME = 7, THEM = 8, ROCK = 1, TYPE = 'asteroid_metal';

/** A rock as both sides know it: its composition key (system:index:spawnTick) and so its public seed and composition */
function publicRock(key: string, tier: number, type = TYPE): MineRock {
  return { seed: mineSeed(type, key), composition: asteroidComposition(table, type, key, 1e6, tier) };
}

/**
 * The server's mining (its own dice: a fixed secret) and your client's ring side by side, on one big rock of `tier`.
 * Every host call the server makes is counted (`calls`): the server has nothing to tell your client about its chunks
 */
function pair(tier: number, type = TYPE, secret = 'mining-ring-test') {
  let tick = 0;
  const drops = new Map<number, number>(), calls = new Map<string, number>(), pods: Record<string, number>[] = [];
  const base: MiningHost = {
    spawnChunk: (_s, _x, _y, _vx, _vy, items, miner) => { drops.set(miner ?? -1, (drops.get(miner ?? -1) ?? 0) + 1); if (miner === ME) pods.push({ ...items }); },
    awardXp: () => {}, notify: () => {}, tick: () => tick, respawn: () => {}, crumble: () => {}, rockTier: () => tier,
  };
  const host = new Proxy(base, { get: (o, k: string) => { if (typeof (o as never)[k] === 'function') calls.set(k, (calls.get(k) ?? 0) + 1); return (o as never)[k]; } });
  const server = new Mining(host, table, new PayoutDice(secret));
  const key = 'sol:3:1200';
  server.register(ROCK, 0, 3, type, key, 1e6, tier);
  const rock = publicRock(key, tier, type);
  const client = new MiningProgress(null, table, () => tick / 60, (id) => (id === ROCK ? rock : undefined));
  return { server, client, drops, calls, pods, rock, get tick() { return tick; }, step(): void { tick++; } };
}

const laser = (grade: number): MiningTool => ({ yield: table.tools.miner.yield, hardness: 2, grade });
const gun: MiningTool = { yield: table.tools.fixed.yield, hardness: 1 };

/** Your client's place in its chunks is the server's: the same chunk, units and keep, the fraction to a hair */
function same(s: ReturnType<typeof pair>): void {
  const a = s.client.chunkOf(ROCK), b = s.server.chunkOf(ROCK, ME);
  if (!b) return;
  expect(a).not.toBeNull();
  expect([a!.chunk, a!.worked, a!.kept]).toEqual([b.chunk, b.worked, b.kept]);
  expect(a!.owed).toBeCloseTo(b.owed, 9);
}

/**
 * Run `ticks` of one tool on the rock and check, hit by hit, that the ring is the server's: the same place in the same
 * chunk, and a drop on exactly the hit the server throws one (the ring full on it, never before). Returns the drops
 */
function run(s: ReturnType<typeof pair>, ticks: number, hit: (tick: number) => { dmg: number; tool: MiningTool; mine: (c: MiningProgress) => void } | null): number {
  let drops = 0;
  for (let k = 0; k < ticks; k++) {
    s.step();
    const h = hit(s.tick);
    if (!h) continue;
    const before = s.drops.get(ME) ?? 0, chunkBefore = s.client.chunkOf(ROCK)?.chunk ?? 0, ring = s.client.progress(ROCK);
    s.server.extract(ROCK, ME, h.dmg, h.tool, -100, 0, -1, 0);
    h.mine(s.client);
    const dropped = (s.drops.get(ME) ?? 0) - before, predicted = (s.client.chunkOf(ROCK)?.chunk ?? 0) - chunkBefore;
    // The drop lands on the hit your client predicts it on: never before the ring fills
    expect(predicted).toBe(dropped);
    expect(ring).toBeLessThan(1);
    same(s);
    drops += dropped;
  }
  return drops;
}

describe('when a chunk drops is public: the ring steps your own hits to the server\'s drops (common econ/miningChunks.ts)', () => {
  it("a starter's two Pips on Mk I rock (a 28 shell each every 30 ticks, staggered): every drop on the hit the ring fills", () => {
    const s = pair(1);
    const drops = run(s, 120 * 60, (t) => (t % 15 ? null : { dmg: 28, tool: gun, mine: (c) => c.shell(ROCK, 'fixed', 28, 1) }));
    expect(drops).toBeGreaterThan(15);
  });

  it("a steady mining laser (a ports ship's at its fill), a grade behind the rock: it keeps 80%, so drops carry", () => {
    const s = pair(2), dps = 42 * 0.85, perTick = dps / 60;
    const drops = run(s, 60 * 60, () => ({ dmg: perTick, tool: laser(1), mine: (c) => c.laser(ROCK, dps, 1 / 60, 1, 2) }));
    expect(drops).toBeGreaterThan(10);
  });

  it("a pulsed mining laser: it cuts by its pulse's curve, nearly half a pulse at its flare, and the ring steps the same", () => {
    const s = pair(1), prof = pulseProfile(MINING_PULSE), dps = 42;
    const runs = [{ start: 1 }];
    let counted = 0;
    const drops = run(s, 60 * 60, (t) => {
      if (t - runs[runs.length - 1].start >= prof.ticks) runs.push({ start: runs[runs.length - 1].start + prof.ticks });
      const age = t - runs[runs.length - 1].start;
      const dt = pulseCutOver(runs, prof, counted, t);
      counted = t;
      return { dmg: (dps / 60) * pulseCut(prof, age), tool: laser(1), mine: (c) => c.laser(ROCK, dps, dt, 1, 1) };
    });
    expect(drops).toBeGreaterThan(20);
    expect(pulseCutOver([{ start: 0 }], prof, -1, prof.ticks - 1)).toBeCloseTo(prof.ticks / 60, 9);
  });

  it("guns on Mk II rock (they keep an eighth of the common ores: long carries) at a big gunship's pace (past refDps)", () => {
    const s = pair(2);
    const drops = run(s, 120 * 60, (t) => (t % 6 ? null : { dmg: 30, tool: gun, mine: (c) => c.shell(ROCK, 'fixed', 30, 2) }));
    expect(drops).toBeGreaterThan(5);
  });

  it('another tool on the same chunk (guns, then a laser): its keep moves where the carry ends, on both sides alike', () => {
    const s = pair(2);
    const drops = run(s, 60 * 60, (t) => (t < 900
      ? (t % 10 ? null : { dmg: 30, tool: gun, mine: (c) => c.shell(ROCK, 'fixed', 30, 2) })
      : { dmg: 0.7, tool: laser(2), mine: (c) => c.laser(ROCK, 42, 1 / 60, 2, 2) }));
    expect(drops).toBeGreaterThan(10);
  });

  it("another pilot's hits on the rock are theirs: your chunks are untouched (each miner's work on a rock is their own)", () => {
    const s = pair(1);
    const drops = run(s, 30 * 60, (t) => {
      s.server.extract(ROCK, THEM, 2.1, laser(1), 100, 0, 1, 0);
      return t % 2 ? null : { dmg: 1.4, tool: laser(1), mine: (c) => c.laser(ROCK, 42, 2 / 60, 1, 1) };
    });
    expect(drops).toBeGreaterThan(5);
    expect(s.drops.get(THEM) ?? 0).toBeGreaterThan(drops * 2);
  });

  it('the chunk sizes and keeps are the seed\'s, the same on both sides: sizes chunkUnits evenly, keeps at the tool\'s odds', () => {
    const { seed, composition } = publicRock('sol:3:1200', 1);
    const [lo, hi] = table.chunkUnits, sizes = new Map<number, number>();
    for (let c = 0; c < 6000; c++) { const w = chunkWant(table, seed, c); sizes.set(w, (sizes.get(w) ?? 0) + 1); }
    expect([...sizes.keys()].sort()).toEqual(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    for (const n of sizes.values()) expect(n / 6000).toBeCloseTo(1 / (hi - lo + 1), 1);
    // Guns on Mk I: a third of the common ores, half that of the rest; the seed keeps them at that average
    const odds = keepOdds(table, composition, { keep: toolKeep(table, {}, 1).keep, gun: table.guns, hardness: 1 });
    let kept = 0;
    for (let u = 0; u < 20000; u++) if (unitKept(seed, u >> 4, u & 15, odds.keep)) kept++;
    expect(kept / 20000).toBeCloseTo(odds.keep, 2);
    expect(odds.keep).toBeLessThan(table.guns!.keep);
    expect(odds.keep).toBeGreaterThan(table.guns!.keep * table.guns!.keepOther);
    // A laser keeping it all keeps every unit: drops at exactly chunkUnits
    expect(keepOdds(table, composition, { keep: 1, gun: undefined, hardness: 2 }).keep).toBe(1);
  });

  it('the server sends nothing for it: no host call a hit or a chunk tells your client anything (only the pods it throws)', () => {
    const s = pair(1);
    run(s, 60 * 60, () => ({ dmg: 0.7, tool: laser(1), mine: (c) => c.laser(ROCK, 42, 1 / 60, 1, 1) }));
    const told = [...s.calls.keys()].filter((k) => !['spawnChunk', 'minerAt', 'miningSkill', 'mined', 'awardXp', 'tick', 'rockTier', 'traceTier', 'notify'].includes(k));
    expect(told).toEqual([]);
    // (one pod a drop: the chunk itself, as ever)
    expect(s.calls.get('spawnChunk')).toBe(s.drops.get(ME));
    expect('chunk' in (s.server as unknown as { host: object }).host).toBe(false);
  });
});

describe('what a drop holds stays the server\'s secret', () => {
  it('the public seed cannot predict the ore or gem: the same rock and hits under two secrets drop at the same units with different ore', () => {
    const a = pair(1, TYPE, 'secret-a'), b = pair(1, TYPE, 'secret-b');
    for (let k = 0; k < 60 * 60; k++) {
      a.step(); b.step();
      if (k % 15) continue;
      a.server.extract(ROCK, ME, 28, gun, -100, 0, -1, 0);
      b.server.extract(ROCK, ME, 28, gun, -100, 0, -1, 0);
    }
    // When: the same (public)
    expect(a.server.chunkOf(ROCK, ME)).toEqual(b.server.chunkOf(ROCK, ME));
    expect(a.pods.length).toBe(b.pods.length);
    expect(a.pods.length).toBeGreaterThan(10);
    // What: not (the secret's): the chunks' ore differs between the two
    const differ = a.pods.filter((p, i) => JSON.stringify(p) !== JSON.stringify(b.pods[i])).length;
    expect(differ).toBeGreaterThan(a.pods.length / 4);
  });

  it('a kept unit is each ore at its old odds given it was kept (guns keep the rarer ores at half): over many, the shares hold', () => {
    const s = pair(1);
    for (let k = 0; k < 600 * 60; k++) { s.step(); if (k % 15 === 0) s.server.extract(ROCK, ME, 28, gun, -100, 0, -1, 0); }
    const got: Record<string, number> = {};
    for (const p of s.pods) for (const [id, n] of Object.entries(p)) got[id] = (got[id] ?? 0) + n;
    const odds = keepOdds(table, s.rock.composition, { keep: table.guns!.keep, gun: table.guns, hardness: 1 });
    const total = Object.values(got).reduce((x, y) => x + y, 0), sum = odds.kept.reduce((x, y) => x + y, 0);
    for (let i = 0; i < odds.ids.length; i++) if (odds.kept[i] / sum > 0.1) expect((got[odds.ids[i]] ?? 0) / total).toBeCloseTo(odds.kept[i] / sum, 1);
  });
});

describe('entering a system: your part-worked chunks, told once (asteroidSeed `mine`)', () => {
  it('a client coming in on a rock it part-worked (back from another system) picks up where the server is, and agrees from there', () => {
    const s = pair(1);
    // Worked a while (no client of yours watching)
    for (let k = 0; k < 47 * 15; k++) { s.step(); if (k % 15 === 0) s.server.extract(ROCK, ME, 28, gun, -100, 0, -1, 0); }
    const at = s.server.chunkOf(ROCK, ME)!;
    expect(at.chunk).toBeGreaterThan(2);
    // Entering: the one word (asteroidSeed `mine`, as enterSystem sends it: server/src/net/snapshot/systemEntry.test.ts), as JSON on the wire
    const wire = JSON.parse(JSON.stringify({ mine: s.server.partWorked(ME, 0) })) as { mine: number[] };
    expect(wire.mine).toHaveLength(4);
    expect(JSON.stringify(wire).length).toBeLessThan(48);
    const late = new MiningProgress(null, table, () => s.tick / 60, (id) => (id === ROCK ? s.rock : undefined));
    late.enter(wire.mine, true);
    expect(late.chunkOf(ROCK)).toEqual(at);
    // ...and from there it steps your hits to the server's drops
    s.client = late;
    const drops = run(s, 60 * 60, (k) => (k % 15 ? null : { dmg: 28, tool: gun, mine: (c) => c.shell(ROCK, 'fixed', 28, 1) }));
    expect(drops).toBeGreaterThan(5);
  });

  it('a pilot with no work on the system\'s rocks is told nothing of it; another pilot\'s work is never theirs', () => {
    const s = pair(1);
    for (let k = 0; k < 200; k++) { s.step(); s.server.extract(ROCK, THEM, 2, laser(1), 100, 0, 1, 0); }
    expect(s.server.partWorked(ME, 0)).toEqual([]);
    expect(s.server.partWorked(THEM, 0)).toHaveLength(4);
    // Told nothing: every rock fresh for you, and fresh on the server too
    const c = new MiningProgress(null, table, () => 0, () => s.rock);
    c.enter(undefined, true);
    expect(c.chunkOf(ROCK)).toBeNull();
    expect(s.server.chunkOf(ROCK, ME)).toBeNull();
  });
});

describe('the mining progress ring without a rock\'s seed (none known: the average)', () => {
  it("a starter's Pips fill it in about the server's average time between their drops on Mk I rock", () => {
    const { p, at } = rig();
    let t = 100, filled = -1;
    for (let k = 0; k < 4000 && filled < 0; k++) {
      t += 15 / 60;
      at(t);
      if (p.shell(7, 'fixed', 28, 1) >= 1) filled = t - 100;
    }
    const want = (unitsPerDrop(table, table.guns!.keep) * table.damagePerUnit) / (112 * table.tools.fixed.yield);
    expect(filled).toBeGreaterThan(want * 0.9);
    expect(filled).toBeLessThan(want * 1.1);
  });

  it("a Mk I laser past its reach does no work: no ring", () => {
    const { p } = rig();
    expect(p.laser(8, 42, 1, 1, 4)).toBe(0);
  });

  it('is up while you work the rock, fades a little after you stop', () => {
    const { p, at } = rig();
    p.shell(7, 'fixed', 28, 1);
    expect(p.visibility(7)).toBe(1);
    at(100 + SHOW_FOR + FADE / 2);
    expect(p.visibility(7)).toBeCloseTo(0.5, 1);
    at(100 + SHOW_FOR + FADE + 0.1);
    expect(p.visibility(7)).toBe(0);
    expect(p.visibility(99)).toBe(0);
  });
});
