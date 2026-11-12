/**
 * A spreading fire's rules (fire.ts), as pure functions and run to the end on real hulls: fire feeds fire (chances
 * never fall as more burns beside a part), it always falls off (generations, the time cap, the parts cap), a part
 * with nothing burning beside it burns as long as it always did, and the same fires step the same way anywhere.
 * The last test is the measure the tuning was set by: what one shot's fire does, as a multiple of a fire that never
 * spreads, over every part of several real hulls and many seeds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHIP_DATA_DIR, readShipJson, testCatalog } from './testData.js';
import { parseBlueprint } from './blueprint.js';
import { designOf } from './design.js';
import { fxDef } from './modifiers/fxDef.js';
import { FX_STEPS } from './modifiers/types.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';
import { FIRE_STEP, fireNeighbours, spreadChance, surviveChance, nextGen, stepFires, type FireSpread, type PartFire } from './fire.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const mt = tuning.modifiers!;
const shell: WeaponTuning = { type: 'projectile', damage: 20, speed: 40, life: 100, spread: 2, size: 1 };
const burn = fxDef(shell, mt, [{ fx: mt.effects.indexOf('burn'), q: FX_STEPS }], 1);
const S: FireSpread = burn.ignite!.fire!;
const hull = (name: string) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
  const d = designOf(catalog, bp);
  return { n: bp.parts.length, adj: fireNeighbours(d.joins, bp.parts.length) };
};
/** (`end`: the last tick it did damage on) */
/** Hulls of the middle sizes (a raider to a frigate), and the giants a fire must not run away on */
const MID = ['enemy/pirate_raider', 'enemy/pirate_gunship', 'arrow', 'bulwark', 'drum', 'halberd'];
const BIG = ['enemy/giant_mammoth', 'enemy/giant_midden'];

/**
 * One shot's fire on `part` at `tick0`, run until nothing burns: the damage done as a multiple of the first fire's
 * own (dps × its time), the parts it was ever on, and the tick the last of it went out
 */
function run(key: number, adj: number[][], part: number, tick0: number, s = S, dead: (p: number) => boolean = () => false) {
  const first: PartFire = { part, until: tick0 + burn.ignite!.ticks, dps: 1, ticks: burn.ignite!.ticks, fire: s, gen: 0, ev: { born: tick0, lit: 1 } };
  const fires: PartFire[] = [first], ever = new Set([part]);
  let done = 0, tick = tick0, maxGen = 0, end = tick0;
  // (the server's step: every FIRE_STEP ticks, the fires stepped, then each that burns does a step's damage)
  for (tick = Math.ceil((tick0 + 1) / FIRE_STEP) * FIRE_STEP; fires.length; tick += FIRE_STEP) {
    stepFires(key, fires, adj, (p) => !dead(p), tick, (from) => ({ ...from }), (f) => { ever.add(f.part); maxGen = Math.max(maxGen, f.gen ?? 0); });
    for (const f of fires) { done += f.dps * FIRE_STEP; end = tick; }
    if (tick - tick0 > 100000) throw new Error('a fire that never ends');
  }
  return { x: done / (1 * burn.ignite!.ticks), parts: ever.size, end, maxGen, first };
}

describe('a spreading fire: the chances', () => {
  it('the Burn modifier\'s fire carries its rules from tuning (modifiers.burn.fire), a multiple of the step in its beat', () => {
    expect(S).toEqual(mt.burn.fire);
    expect(S.beat % FIRE_STEP).toBe(0);
    expect(S.total % FIRE_STEP).toBe(0);
    expect(burn.ignite!.ticks % FIRE_STEP).toBe(0);
  });

  it('fire feeds fire: neither chance ever falls as more burns beside the part, and both stop at their caps', () => {
    for (let gen = 0; gen < S.gens; gen++) {
      for (let n = 0; n < 12; n++) {
        expect(spreadChance(S, n + 1, gen)).toBeGreaterThanOrEqual(spreadChance(S, n, gen));
        expect(surviveChance(S, n + 1, gen)).toBeGreaterThanOrEqual(surviveChance(S, n, gen));
        expect(spreadChance(S, n, gen)).toBeLessThanOrEqual(S.cap);
        expect(surviveChance(S, n, gen)).toBeLessThanOrEqual(S.surviveCap);
      }
      expect(spreadChance(S, 2, gen)).toBeGreaterThan(spreadChance(S, 0, gen));
      expect(surviveChance(S, 2, gen)).toBeGreaterThan(surviveChance(S, 1, gen));
    }
  });

  it('it falls off: each generation on is likelier to stop, cooler and shorter; the last generation does neither', () => {
    for (let gen = 0; gen + 1 < S.gens; gen++) {
      expect(spreadChance(S, 3, gen + 1)).toBeLessThan(spreadChance(S, 3, gen));
      expect(surviveChance(S, 3, gen + 1)).toBeLessThan(surviveChance(S, 3, gen));
    }
    for (let n = 0; n < 8; n++) { expect(spreadChance(S, n, S.gens)).toBe(0); expect(surviveChance(S, n, S.gens)).toBe(0); }
    const g = nextGen(S, { part: 0, until: 0, dps: 10, ticks: 180 });
    expect(g.dps).toBeCloseTo(10 * S.keep, 9);
    expect(g.ticks).toBeLessThan(180);
    expect(g.ticks % FIRE_STEP).toBe(0);
    expect(nextGen(S, { part: 0, until: 0, dps: 10, ticks: 10 }).ticks).toBe(FIRE_STEP);
  });

  it('a part with nothing burning beside it never outlasts its time', () => {
    for (let gen = 0; gen <= S.gens; gen++) expect(surviveChance(S, 0, gen)).toBe(0);
  });
});

describe('a spreading fire: run to its end', () => {
  it('a lone part (nothing joined to it) burns exactly its time, as a fire always did', () => {
    for (let t0 = 100; t0 < 140; t0 += 7) {
      const r = run(9, [[]], 0, t0);
      expect(r.parts).toBe(1);
      expect(r.maxGen).toBe(0);
      expect(r.end).toBeLessThan(t0 + burn.ignite!.ticks);
      expect(r.end).toBeGreaterThanOrEqual(t0 + burn.ignite!.ticks - FIRE_STEP);
      expect(r.x).toBeGreaterThan(0.9);
      expect(r.x).toBeLessThanOrEqual(1);
    }
  });

  it('a fire with no rules of spread (any gun\'s own) is left alone: it lights nothing and is not dropped', () => {
    const { adj } = hull('arrow');
    const f: PartFire = { part: 3, until: 400, dps: 5 };
    const fires = [f];
    for (let tick = 10; tick <= 600; tick += FIRE_STEP) stepFires(1, fires, adj, () => true, tick, (from) => ({ ...from }));
    expect(fires).toEqual([{ part: 3, until: 400, dps: 5 }]);
  });

  it('always ends, inside the time cap, on no more than the parts cap, never past the last generation: every part of every hull, many seeds', () => {
    for (const name of [...MID, ...BIG]) {
      const { n, adj } = hull(name);
      for (let part = 0; part < n; part++) for (let seed = 0; seed < 6; seed++) {
        const t0 = 1000 + seed * 37 + part, r = run(100 + seed, adj, part, t0);
        expect(r.end, name).toBeLessThanOrEqual(t0 + S.total);
        expect(r.parts, name).toBeLessThanOrEqual(S.parts);
        expect(r.maxGen, name).toBeLessThanOrEqual(S.gens);
      }
    }
  });

  it('stops at gaps and at parts that are gone: it spreads only along joins, to parts that stand', () => {
    const { n, adj } = hull('bulwark');
    for (let part = 0; part < n; part++) for (let seed = 0; seed < 8; seed++) {
      // (every other part gone: only what is joined to the first through standing parts can ever burn)
      const dead = (p: number) => p !== part && p % 2 === 0;
      const first: PartFire = { part, until: 2000 + burn.ignite!.ticks, dps: 1, ticks: burn.ignite!.ticks, fire: S, gen: 0, ev: { born: 2000, lit: 1 } };
      const fires = [first];
      for (let tick = 2010; fires.length; tick += FIRE_STEP) {
        stepFires(seed, fires, adj, (p) => !dead(p), tick, (from) => ({ ...from }), (f, from) => {
          expect(dead(f.part)).toBe(false);
          if (from) expect(adj[from.part]).toContain(f.part);
        });
      }
    }
  });

  it('a part that is destroyed stops burning at the next step, and lights nothing', () => {
    const { adj } = hull('arrow');
    const first: PartFire = { part: 0, until: 5000, dps: 1, ticks: 180, fire: S, gen: 0, ev: { born: 100, lit: 1 } };
    const fires = [first];
    stepFires(1, fires, adj, () => false, 120, (from) => ({ ...from }));
    expect(fires).toEqual([]);
  });

  it('the same fires step the same way anywhere: two runs of one shot agree to the tick', () => {
    const { n, adj } = hull('halberd');
    let spread = 0;
    for (let part = 0; part < n; part += 3) {
      const a = run(77, adj, part, 900 + part), b = run(77, adj, part, 900 + part);
      expect(b).toEqual(a);
      if (a.parts > 1) spread++;
      // (another ship: another fire)
    }
    expect(spread).toBeGreaterThan(0);
  });

  it('the measure: one shot\'s fire against a fire that never spreads, on mid-size hulls about twice, bounded on any', () => {
    const rows: string[] = [];
    let allSum = 0, allN = 0, allMax = 0;
    // (the most one shot's fire can ever do: its own line of generations, and every other part it may light at its hottest)
    let line = 0, k = 1;
    for (let g = 0; g <= S.gens; g++) { line += k; k *= S.keep * S.time; }
    const bound = line + (S.parts - 1) * (line - 1);
    for (const name of [...MID, ...BIG]) {
      const { n, adj } = hull(name);
      let sum = 0, cnt = 0, max = 0, parts = 0;
      for (let part = 0; part < n; part++) for (let seed = 0; seed < 40; seed++) {
        const r = run(500 + seed * 13, adj, part, 3000 + seed * 11 + part * 3);
        sum += r.x; cnt++; max = Math.max(max, r.x); parts += r.parts;
        expect(r.x).toBeLessThanOrEqual(bound + 1e-9);
      }
      rows.push(`${name}: ${n} parts, mean x${(sum / cnt).toFixed(2)}, max x${max.toFixed(2)}, mean parts lit ${(parts / cnt).toFixed(2)}`);
      if (MID.includes(name)) { allSum += sum; allN += cnt; }
      allMax = Math.max(allMax, max);
      // (no hull's mean runs away, the giants' least of all)
      expect(sum / cnt, name).toBeGreaterThan(1.2);
      expect(sum / cnt, name).toBeLessThan(3);
    }
    console.log(`fire spread, x a lone burn (bound x${bound.toFixed(2)}):\n  ${rows.join('\n  ')}\n  mid-size mean x${(allSum / allN).toFixed(2)}, max of all x${allMax.toFixed(2)}`);
    expect(allSum / allN).toBeGreaterThanOrEqual(1.5);
    expect(allSum / allN).toBeLessThanOrEqual(2.5);
  });
});
