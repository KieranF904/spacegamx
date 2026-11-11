import { describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { unitsPerDrop, pulseProfile, pulseCut, pulseCutOver, MINING_PULSE, registerRockTypes, type MiningTable } from '@space-game/common';

// (No canvas here: the strike's particle textures are stand-ins)
vi.mock('../rendering/fxTextures', () => ({ disc: () => 'disc', rock: (i: number) => `rock:${Math.abs(i) % 4}` }));

import { readGameDataFiles } from '../../../server/src/data/loadGameDataFromDisk';
import { Mining, type MiningHost, type MiningTool } from '../../../server/src/game/Mining';
import { PayoutDice } from '../../../server/src/game/payoutDice';
import { MiningProgress, SHOW_FOR, FADE } from './MiningProgress';

const table = readGameDataFiles(join(__dirname, '../../../data')).mining as unknown as MiningTable;
registerRockTypes(table);

function rig() {
  let t = 100;
  const p = new MiningProgress(null, table, () => t);
  return { p, at: (s: number) => { t = s; }, now: () => t };
}

const ME = 7, THEM = 8, ROCK = 1;

/**
 * The server's mining (its own dice: a fixed secret) and your client's ring side by side, on one big rock of `tier`:
 * each tick `hit(tick)` says what lands (who, damage, tool), the server works it, your client works out your own the
 * way it does in play, and the server's mineChunk words reach it straight away (or `lag` ticks later). (The words go
 * rounded to a hundredth of a unit, hosts/mining.ts; here exact, so the fills can be held to a hair)
 */
function pair(tier: number, type = 'asteroid_metal', lag = 0) {
  let tick = 0;
  const drops = new Map<number, number>();
  const told: { tick: number; miner: number; rock: number; due: number; at: number; drop: boolean }[] = [];
  const host: MiningHost = {
    spawnChunk: (_s, _x, _y, _vx, _vy, _items, miner) => { drops.set(miner ?? -1, (drops.get(miner ?? -1) ?? 0) + 1); },
    chunk: (miner, rock, due, at, drop) => { told.push({ tick, miner, rock, due, at, drop }); },
    awardXp: () => {}, notify: () => {}, tick: () => tick, respawn: () => {}, crumble: () => {}, rockTier: () => tier,
  };
  const server = new Mining(host, table, new PayoutDice('mining-ring-test'));
  server.register(ROCK, 0, 0, type, 'ring:0', 1e6, tier);
  const client = new MiningProgress(null, table, () => tick / 60);
  return {
    server, client, told, drops,
    get tick() { return tick; },
    step(): void { tick++; },
    /** The server's words for your client that are due by now: delivered, as ShipMessages does */
    deliver(): number {
      let n = 0;
      for (let i = 0; i < told.length; i++) {
        const m = told[i];
        if (m.miner !== ME || tick - m.tick < lag) continue;
        client.chunk(m.rock, m.due, m.at, m.drop);
        told.splice(i--, 1);
        n++;
      }
      return n;
    },
    /** Your fill as the server has it (rock units into the chunk ÷ where its drop falls) */
    serverFill(miner = ME): number {
      const c = server.chunkOf(ROCK, miner)!;
      return Math.min(1, c.at / c.due);
    },
  };
}

const laser = (grade: number): MiningTool => ({ yield: table.tools.miner.yield, hardness: 2, grade });
const gun: MiningTool = { yield: table.tools.fixed.yield, hardness: 1 };

/**
 * Run `ticks` of one tool on the rock and check, hit by hit, that the ring is the server's: equal fills (to a hair:
 * floating point apart), and a drop exactly as the ring reaches full. Returns the drops seen
 */
function run(s: ReturnType<typeof pair>, ticks: number, hit: (tick: number) => { dmg: number; tool: MiningTool; mine: (c: MiningProgress) => void } | null): number {
  let drops = 0, heard = !!s.server.chunkOf(ROCK, ME);
  for (let k = 0; k < ticks; k++) {
    s.step();
    const h = hit(s.tick);
    if (!h) continue;
    const before = s.drops.get(ME) ?? 0;
    s.server.extract(ROCK, ME, h.dmg, h.tool, -100, 0, -1, 0);
    h.mine(s.client);
    const ring = s.client.progress(ROCK), dropped = (s.drops.get(ME) ?? 0) > before;
    // A drop exactly as the ring reaches full: never before it fills, and it never sits full past one
    if (heard) {
      if (dropped) expect(ring).toBeGreaterThan(1 - 1e-6);
      else expect(ring).toBeLessThan(1);
    }
    if (s.deliver()) heard = true;
    if (dropped) drops++;
    // ...and the same fill as the server's, the new chunk's after a drop
    expect(s.client.progress(ROCK)).toBeCloseTo(s.serverFill(), 9);
  }
  return drops;
}

describe('the mining progress ring is the server\'s (Mining.extract), worked out from your own hits', () => {
  it('a mining laser cutting steadily (a ports ship\'s at its fill), a grade behind the rock: it keeps 80%, so drops carry', () => {
    const s = pair(2), dps = 42 * 0.85, perTick = dps / 60;
    const drops = run(s, 60 * 60, () => ({ dmg: perTick, tool: laser(1), mine: (c) => c.laser(ROCK, dps, 1 / 60, 1, 2) }));
    expect(drops).toBeGreaterThan(10);
  });

  it('a pulsed mining laser: it cuts by its pulse\'s curve, nearly half a pulse at its flare, and the ring fills by the same', () => {
    const s = pair(1), prof = pulseProfile(MINING_PULSE), dps = 42;
    // The pulses as your client draws them: one every MINING_PULSE.ticks from the first, the cut counted frame by frame
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
    // (Over a whole pulse it cuts what it would steadily)
    expect(pulseCutOver([{ start: 0 }], prof, -1, prof.ticks - 1)).toBeCloseTo(prof.ticks / 60, 9);
  });

  it('guns on Mk II rock (they keep an eighth: long carries) at a big gunship\'s pace (past refDps, the square root)', () => {
    const s = pair(2);
    const drops = run(s, 120 * 60, (t) => (t % 6 ? null : { dmg: 30, tool: gun, mine: (c) => c.shell(ROCK, 'fixed', 30, 2) }));
    expect(drops).toBeGreaterThan(5);
  });

  it('a new chunk starts the ring over from where the server is in it, towards a drop it says (chunkUnits or a carry past)', () => {
    const s = pair(1);
    const seen: number[] = [];
    for (let k = 0; k < 40 * 60; k++) {
      s.step();
      s.server.extract(ROCK, ME, 0.7, laser(1), -100, 0, -1, 0);
      s.client.laser(ROCK, 42, 1 / 60, 1, 1);
      const drop = s.told.find((m) => m.miner === ME && m.drop);
      s.deliver();
      if (!drop) continue;
      seen.push(drop.due);
      // (just past the drop: a sliver of the next unit)
      expect(drop.at).toBeLessThan(1);
      expect(s.client.progress(ROCK)).toBeCloseTo(drop.at / drop.due, 6);
    }
    // A laser keeping it all: every drop at chunkUnits, all of them seen
    const [lo, hi] = table.chunkUnits;
    expect(seen.length).toBeGreaterThan(10);
    expect(Math.min(...seen)).toBe(lo);
    expect(Math.max(...seen)).toBe(hi);
  });

  it("another pilot's hits on the rock are theirs: your ring and your chunk are untouched, and they're told of their own", () => {
    const s = pair(1);
    let theirDrops = 0;
    const drops = run(s, 30 * 60, (t) => {
      // They cut the same rock every tick, three times as hard
      s.server.extract(ROCK, THEM, 2.1, laser(1), 100, 0, 1, 0);
      return t % 2 ? null : { dmg: 1.4, tool: laser(1), mine: (c) => c.laser(ROCK, 42, 2 / 60, 1, 1) };
    });
    theirDrops = s.drops.get(THEM) ?? 0;
    expect(drops).toBeGreaterThan(5);
    expect(theirDrops).toBeGreaterThan(drops * 2);
    expect(s.told.every((m) => m.miner === THEM)).toBe(true);
    expect(s.told.length).toBeGreaterThan(0);
  });

  it('another tool on the same chunk moves its drop (its keep says where the carry ends): the server says so', () => {
    // Guns keep an eighth on Mk II, so a chunk's drop is often carried past its size; a laser of the rock's grade keeps
    // it all, so the same chunk's drop comes at its size. Over many rocks' first chunks, some move
    let moved = 0;
    for (let rock = 0; rock < 30; rock++) {
      const s = pair(2);
      s.server.register(50 + rock, 0, 0, 'asteroid_metal', `ring:${rock}`, 1e6, 2);
      s.step();
      s.server.extract(50 + rock, ME, 5, gun, -100, 0, -1, 0);
      const gunDue = s.server.chunkOf(50 + rock, ME)!.due;
      s.told.length = 0;
      s.step();
      s.server.extract(50 + rock, ME, 0.5, laser(2), -100, 0, -1, 0);
      const laserDue = s.server.chunkOf(50 + rock, ME)!.due;
      expect(laserDue).toBeLessThanOrEqual(gunDue);
      expect(laserDue).toBeGreaterThanOrEqual(table.chunkUnits[0]);
      expect(laserDue).toBeLessThanOrEqual(table.chunkUnits[1]);
      // Told exactly when it moved (not a drop)
      expect(s.told.map((m) => [m.rock, m.due, m.drop])).toEqual(laserDue === gunDue ? [] : [[50 + rock, laserDue, false]]);
      if (laserDue !== gunDue) moved++;
    }
    expect(moved).toBeGreaterThan(3);
  });

  it('the server tells only when a chunk starts or moves: a few words a minute, never one a hit', () => {
    const s = pair(1);
    let words = 0;
    for (let k = 0; k < 60 * 60; k++) {
      s.step();
      s.server.extract(ROCK, ME, 0.7, laser(1), -100, 0, -1, 0);
      s.client.laser(ROCK, 42, 1 / 60, 1, 1);
      words += s.deliver();
    }
    expect(words).toBe((s.drops.get(ME) ?? 0) + 1);
    expect(words).toBeLessThan(60);
  });

  it('the server\'s word a little late still leaves the ring the server\'s at each word', () => {
    const s = pair(1, 'asteroid_metal', 6);
    for (let k = 0; k < 20 * 60; k++) {
      s.step();
      s.server.extract(ROCK, ME, 0.7, laser(1), -100, 0, -1, 0);
      s.client.laser(ROCK, 42, 1 / 60, 1, 1);
      const due = s.told.find((m) => m.miner === ME && s.tick - m.tick >= 6);
      s.deliver();
      if (due) expect(s.client.progress(ROCK)).toBeCloseTo(due.at / due.due, 6);
    }
    expect(s.drops.get(ME)).toBeGreaterThan(5);
  });
});

describe('the mining progress ring before the server\'s first word on a rock', () => {
  it("a starter's Pips fill it in about the server's average time between their drops on Mk I rock", () => {
    const { p, at } = rig();
    // Two Pips, a 28 shell each every 30 ticks (112 a second between them), on soft Mk I rock
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

  it("a Mk I laser on its own grade's rock fills it in the server's average (it keeps it all); past its reach, nothing", () => {
    const { p, at } = rig();
    let t = 100, filled = -1;
    for (let k = 0; k < 4000 && filled < 0; k++) {
      t += 1 / 60;
      at(t);
      if (p.laser(7, 42, 1 / 60, 1, 1) >= 1) filled = t - 100;
    }
    const want = (unitsPerDrop(table, 1) * table.damagePerUnit) / (42 * table.tools.miner.yield);
    expect(filled).toBeGreaterThan(want * 0.95);
    expect(filled).toBeLessThan(want * 1.05);
    // Mk III rock is past a Mk I laser: no work, no ring
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
