// The changes evolve asks a model for, picked from what a design's check says it lacks. Nothing names a part: power
// roles come from the legend (so "guard the engines with a Diode" appears only when the brief's legend has a diode).
import type { BriefCheck, CheckResult, LegendEntry } from '../core/index';

export interface Mutation {
  instruction: string;
  /** How likely it is to be picked (weaknesses weigh more) */
  weight: number;
  why: string;
}

const nameOf = (entries: LegendEntry[], role: string) => entries.find((e) => e.power.role === role);

export function mutationsFor(result: CheckResult | undefined, brief: BriefCheck | undefined, legend: LegendEntry[]): Mutation[] {
  const out: Mutation[] = [];
  const add = (instruction: string, weight: number, why: string) => out.push({ instruction, weight, why });
  const s = result?.scores, p = result?.power;
  if (result && !result.valid) add('make it valid: fix every rule the check listed, change nothing else', 6, 'invalid');
  for (const u of brief?.unmet ?? []) add(`meet the brief: ${u}`, 4, 'brief unmet');
  if (p?.unpowered.length) add(`power ${p.unpowered.slice(0, 3).map((u) => `the ${u.name} at row ${u.row} col ${u.col}`).join(', ')}: each must touch a generator, store, conduit or the core`, 4, 'unpowered');
  const weak = p?.weapons.filter((w) => w.linked && w.pctLong < 80) ?? [];
  if (weak.length) add(`keep the guns firing: put a store or a generator beside ${weak.slice(0, 2).map((w) => `the ${w.name} at row ${w.row} col ${w.col}`).join(' and ')}`, 3, 'guns starved');
  if (p && p.thrust.boostPct < 80) add('feed the engines\' boost: a store touching the engines', 2, 'boost starved');
  const diode = nameOf(legend, 'diode');
  if (diode && p?.consumers.some((c) => c.kind === 'thruster')) {
    add(`guard the engines with a ${diode.name} (${diode.code}): a store just for the engines, filled through a ${diode.code} whose mark points at it, so the guns can't drain it`, 1.5, 'diode available');
  }
  if (s && s.symmetry < 0.9) add('mirror it exactly left to right about the core', 3, 'asymmetric');
  if (s && s.armourOutside < 0.8) add('move the core, generators and stores inside; hull or armour on the outside edge', 2, 'power parts exposed');
  if (s && s.enginesAft < 0.9) add('put every engine at the back, facing v', 2, 'engines not aft');
  if (s && s.gunsOut !== null && s.gunsOut < 0.9) add('point every fixed gun forward (^), with nothing in front of it', 2, 'guns blocked');
  if (s && s.compactness < 0.6) add('make it more compact: fill the holes and trim the spikes', 1.5, 'loose');
  for (const m of brief?.missing ?? []) add(`add ${m}`, 1.5, 'brief encourages');
  // Always on the menu
  add('make it faster: more engines at the back (facing v), and power for them', 1, 'variety');
  add('add a gun grid: two more guns at the front facing ^, each touching a store', 1, 'variety');
  add('make it tougher: armour across the nose and down the flanks', 1, 'variety');
  add('make it lighter and cheaper: drop parts that add little', 0.7, 'variety');
  add('give it a more striking silhouette (wings, a pointed nose) while keeping it valid and powered', 0.7, 'variety');
  return out;
}

/** A weighted pick (rng in [0,1)) */
export function pickMutation(list: Mutation[], rng: () => number): Mutation {
  const total = list.reduce((a, m) => a + m.weight, 0);
  let r = rng() * total;
  for (const m of list) { r -= m.weight; if (r < 0) return m; }
  return list[list.length - 1];
}

/** A small seeded RNG (mulberry32) */
export function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
