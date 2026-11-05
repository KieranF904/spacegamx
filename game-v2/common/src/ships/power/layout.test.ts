/**
 * The energy graph (power/layout.ts; docs/design/energy-routing-impl.md §1.1 with §0 D1): touch only (full shared edges,
 * bespoke joins, never a corner), the Diode's one-way pairs and out-side source, CSR order, and determinism.
 */

import { describe, it, expect } from 'vitest';
import type { BespokeFile, Blueprint, FunctionDef } from '../types.js';
import { loadCatalog } from '../catalog.js';
import { blueprintGeometry } from '../blueprint.js';
import { computeJoins } from '../grid.js';
import { readCatalogFiles, readShipJson } from '../testData.js';
import {
  GUN_BEAM, GUN_CLIP, GUN_SHOT, PHASE_THRUST, PHASE_TOOL, PHASE_WEAPON, ROLE_DYNAMO, ROLE_GEN, ROLE_INERT, ROLE_RELAY, ROLE_THRUSTER, ROLE_TOOL, ROLE_WEAPON,
  NO_DEPTH, type EnergyLayout, buildEnergyLayout, partGives, partHolds, partTakes, powerTuning,
} from './layout.js';
import { partDemand } from '../grades.js';
import { perTick, perTickUp, toEu } from './units.js';
import { catalog, genFn, layoutInput, layoutOf, storeFn, tuning } from './testData.js';

const BAT = storeFn('t_battery', 300, 150, 50);
const DIODE = storeFn('t_diode', 10, 200, 200, true);
const GEN = genFn('t_gen', 35);

/** The sources phase k's consumer `c` draws on, in serve order before the fill sort (generators, then relays) */
function sourcesOf(L: EnergyLayout, c: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 3; k++) {
    for (let j = L.srcStart[k]; j < L.srcStart[k + 1]; j++) {
      for (let f = L.feedStart[j]; f < L.feedStart[j + 1]; f++) if (L.feedCons[f] === c) out.push(L.srcPart[j]);
    }
  }
  return out;
}
const pairs = (L: EnergyLayout) => Array.from(L.pairA, (a, x) => [a, L.pairB[x], L.pairDir[x]]);
const pushes = (L: EnergyLayout, g: number) => {
  const gi = Array.from(L.gens).indexOf(g);
  return Array.from(L.pushRelay.subarray(L.pushStart[gi], L.pushStart[gi + 1]));
};

describe('energy layout', () => {
  it('gives each part its role and its budgets in eu', () => {
    const L = layoutOf([
      ['sq', 'core', 0, 0], ['sq', 'power_cell_reactor', 1, 0], ['sq', 'power_battery', 2, 0], ['sq', 'cannon_pip', 3, 0, 'E'],
      ['sq', 'engine_ion_drive', 0, 1, 'S'], ['sq', 'shield_deflector', 1, 1], ['sq', 'power_pulse_dynamo', 2, 1], ['sq', 'hull', 3, 1],
      ['rect2', 'laser_cutter', 0, 2, 'W'], ['rect2', 'cannon_twinlink', 2, 2, 'E'],
    ]);
    expect(Array.from(L.role)).toEqual([ROLE_RELAY, ROLE_GEN, ROLE_RELAY, ROLE_WEAPON, ROLE_THRUSTER, ROLE_TOOL, ROLE_DYNAMO, ROLE_INERT, ROLE_WEAPON, ROLE_WEAPON]);
    const pt = powerTuning(tuning);
    // The core: tuning energy
    expect([L.cap[0], L.give[0], L.take[0]]).toEqual([toEu(pt.coreCapacity), perTick(pt.coreDischarge), perTick(pt.coreIntake)]);
    expect(L.rate[1]).toBe(perTick(35));
    const bat = catalog.functions.get('power_battery')!;
    expect([L.cap[2], L.give[2], L.take[2]]).toEqual([toEu(partHolds(bat, 1, undefined)), perTick(partGives(bat, 1, undefined, pt)), perTick(partTakes(bat, 1, undefined, pt))]);
    // The Pip: a buffer of one 5 E shot, refilled at 20 E/s rounded up (so it has its shot on the 15-tick beat)
    expect([L.gun[3], L.shot[3], L.cap[3], L.rate[3]]).toEqual([GUN_SHOT, toEu(5), toEu(5), perTickUp(20)]);
    expect(L.rate[3] * 15).toBeGreaterThanOrEqual(L.shot[3]);
    // The Ion Drive: burn 9, boost 9 × (1 + 2.2), × 2 thrust, intake 12, buffer 30
    expect([L.burn[4], L.bBurn[4], L.boostMul[4], L.rate[4], L.cap[4]]).toEqual([perTick(9), perTick(28.8), 2, perTick(12), toEu(30)]);
    expect([L.rate[5], L.shield[5]]).toEqual([perTick(16), 1]);
    expect(L.rate[6]).toBe(perTick(10));
    // The Cutter: burns 90, takes 40, holds 180, relights at half; the Twinlink: a clip of 16
    expect([L.gun[8], L.shot[8], L.rate[8], L.cap[8], L.relight[8]]).toEqual([GUN_BEAM, perTick(90), perTickUp(40), toEu(180), toEu(90)]);
    expect([L.gun[9], L.shot[9], L.cap[9]]).toEqual([GUN_CLIP, toEu(5.15625), toEu(5.15625) * 16]);
    expect(L.gaugeMax).toBe(L.cap[0] + L.cap[2]);
  });

  it('joins only parts that share a full edge: a corner never conducts', () => {
    const L = layoutOf([['sq', GEN, 0, 0], ['sq', BAT, 1, 1], ['sq', BAT, 1, 0]]);
    expect(pushes(L, 0)).toEqual([2]);
    expect(pairs(L)).toEqual([[1, 2, 0]]);
  });

  it('follows bespoke pieces\' joins (they hold on to what they touch)', () => {
    const SMALL: BespokeFile = { pieces: [{ id: 't_core', polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] }, { id: 't_wing', polygon: [[2, 0], [4.5, 1], [2, 2]] }] };
    const files = readCatalogFiles();
    const cat = loadCatalog({ ...files, bespoke: [...(files.bespoke ?? []), SMALL] }, { overlapShrink: readShipJson('tuning.json').overlapShrink });
    const bp: Blueprint = { name: 'b', catalogVersion: 1, parts: [
      { uid: 0, piece: 't_core', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
      { uid: 1, piece: 't_wing', fn: 't_battery', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
    ] };
    const geoms = blueprintGeometry(cat, bp);
    const L = buildEnergyLayout({ fns: [cat.functions.get('core')!, BAT], area: geoms.map((g) => g.area), mats: [undefined, undefined], alive: [true, true], joins: computeJoins(geoms), core: 0, tuning, geoms });
    expect(pairs(L)).toEqual([[0, 1, 0]]);
  });

  it('lets a Diode give only out of its facing edge, and take from every other', () => {
    //   y0:  BAT  DIODE> BAT
    //   y1:  pip  pip    pip     (pip under the diode touches it on a side that isn't its out edge)
    //   y-1:      gen
    const L = layoutOf([
      ['sq', BAT, 0, 0], ['sq', DIODE, 1, 0, 'E'], ['sq', BAT, 2, 0],
      ['sq', 'cannon_pip', 0, 1, 'S'], ['sq', 'cannon_pip', 1, 1, 'S'], ['sq', 'cannon_pip', 2, 1, 'S'], ['sq', GEN, 1, -1],
    ]);
    expect(L.diodeOut[1]).toBe(2);
    // Battery 0 may only feed the diode; the diode may only feed battery 2
    expect(pairs(L)).toEqual([[0, 1, 1], [1, 2, 1]]);
    // The generator pushes into the diode (it isn't across the out edge); the pip on its side gets nothing from it
    expect(pushes(L, 6)).toEqual([1]);
    expect(sourcesOf(L, 4)).toEqual([]);
    expect(sourcesOf(L, 3)).toEqual([0]);
    // Turned to face down, the pip under it is its out side: a source for that pip, and both batteries only feed it
    const D = layoutOf([
      ['sq', BAT, 0, 0], ['sq', DIODE, 1, 0, 'S'], ['sq', BAT, 2, 0], ['sq', 'cannon_pip', 1, 1, 'S'],
    ]);
    expect(D.diodeOut[1]).toBe(3);
    expect(sourcesOf(D, 3)).toEqual([1]);
    expect(pairs(D)).toEqual([[0, 1, 1], [1, 2, 2]]);
    expect(D.linked[3]).toBe(0);
    expect(D.fed[3]).toBe(1);
  });

  it('never lets a dynamo top up a Diode', () => {
    const L = layoutOf([['sq', 'power_pulse_dynamo', 0, 0], ['sq', DIODE, 1, 0, 'E'], ['sq', BAT, 0, 1]]);
    expect(Array.from(L.dynRelay)).toEqual([2]);
    expect(L.linked[2]).toBe(1);
  });

  it('lists sources generators first, then relays, ascending, with each one\'s consumers ascending', () => {
    const L = layoutOf([
      ['sq', BAT, 0, 0], ['sq', 'cannon_pip', 1, 0, 'N'], ['sq', GEN, 2, 0], ['sq', 'engine_ion_drive', 1, 1, 'S'],
      ['sq', BAT, 0, 1], ['sq', 'cannon_pip', 2, 1, 'E'], ['sq', 'shield_deflector', 1, 2],
    ]);
    expect(Array.from(L.cons.subarray(L.phase[PHASE_THRUST], L.phase[PHASE_THRUST + 1]))).toEqual([3]);
    expect(Array.from(L.cons.subarray(L.phase[PHASE_TOOL], L.phase[PHASE_TOOL + 1]))).toEqual([6]);
    expect(Array.from(L.cons.subarray(L.phase[PHASE_WEAPON], L.phase[PHASE_WEAPON + 1]))).toEqual([1, 5]);
    // Weapons: the generator (2) first, then battery 0
    const w = Array.from(L.srcPart.subarray(L.srcStart[PHASE_WEAPON], L.srcStart[PHASE_WEAPON + 1]));
    expect(w).toEqual([2, 0]);
    expect(L.srcRelay[PHASE_WEAPON] - L.srcStart[PHASE_WEAPON]).toBe(1);
    expect(sourcesOf(L, 1)).toEqual([2, 0]);
    expect(sourcesOf(L, 5)).toEqual([2]);
    expect(sourcesOf(L, 3)).toEqual([4]);
    expect(L.links).toBe(L.feedCons.length + L.pushRelay.length + L.pairA.length + L.dynRelay.length);
    for (let x = 0; x < L.feedCons.length; x++) expect(L.linkTo[x]).toBe(L.feedCons[x]);
  });

  it('leaves dead parts out of the graph', () => {
    const specs: [string, string | FunctionDef, number, number][] = [['sq', GEN, 0, 0], ['sq', BAT, 1, 0], ['sq', 'cannon_pip', 2, 0]];
    const L = layoutOf(specs, [true, false, true]);
    expect(L.role[1]).toBe(ROLE_INERT);
    expect(L.cap[1]).toBe(0);
    expect(L.pushRelay.length).toBe(0);
    expect(L.linked[2]).toBe(0);
  });

  it('is the same built twice (and its sig says so; a change of budget changes it)', () => {
    const specs: [string, string | FunctionDef, number, number, ('E' | 'S')?][] = [
      ['sq', 'core', 0, 0], ['sq', 'power_cell_reactor', 1, 0], ['sq', 'power_battery', 2, 0], ['sq', 'cannon_pip', 3, 0, 'E'],
      ['sq', DIODE, 1, 1, 'E'], ['sq', 'engine_ion_drive', 2, 1, 'S'],
    ];
    const a = layoutOf(specs), b = buildEnergyLayout(layoutInput(specs));
    expect(b).toEqual(a);
    expect(a.sig).toBeGreaterThan(0);
    expect(a.sig).toBeLessThan(65536);
    const c = layoutOf(specs.map((s, i) => (i === 2 ? ['sq', BAT, 2, 0] : s)));
    expect(c.sig).not.toBe(a.sig);
  });

  it('keeps its sig when a generator or dynamo is hit (their rate goes with health), so a lagging pilot still takes corrections', () => {
    const specs: [string, string | FunctionDef, number, number][] = [['sq', GEN, 0, 0], ['sq', BAT, 1, 0], ['sq', 'power_pulse_dynamo', 2, 0]];
    const whole = layoutOf(specs), hurt = buildEnergyLayout({ ...layoutInput(specs), health: [0.5, 1, 0.5] });
    expect(hurt.rate[0]).toBe(perTick(17.5));
    expect(hurt.rate[2]).toBeLessThan(whole.rate[2]);
    expect(hurt.sig).toBe(whole.sig);
  });

  it('never lets a dynamo top up a pass-through relay (a Conduit: relayOnly)', () => {
    const CONDUIT: FunctionDef = { ...storeFn('t_conduit', 10, 200, 200), relayOnly: true };
    const L = layoutOf([['sq', 'power_pulse_dynamo', 0, 0], ['sq', CONDUIT, 1, 0], ['sq', BAT, 0, 1]]);
    expect(Array.from(L.dynRelay)).toEqual([2]);
    expect(L.role[1]).toBe(ROLE_RELAY);
  });

  it('counts each relay\'s hops from generation, only the ways power may go', () => {
    //   gen  BAT  BAT  DIODE>  BAT
    const row = (facing: 'E' | 'W') => layoutOf([['sq', GEN, 0, 0], ['sq', BAT, 1, 0], ['sq', BAT, 2, 0], ['sq', DIODE, 3, 0, facing], ['sq', BAT, 4, 0]]);
    expect(Array.from(row('E').depth)).toEqual([NO_DEPTH, 0, 1, 2, 3]);
    // Facing back, it only gives towards the generator: nothing reaches it or what's beyond
    const back = row('W');
    expect(Array.from(back.depth)).toEqual([NO_DEPTH, 0, 1, NO_DEPTH, NO_DEPTH]);
    expect([back.linked[3], back.linked[4]]).toEqual([0, 0]);
  });

  it('gives a clip its salvo (the Hive 4 rounds, the Twinlink 1) and every other gun 1', () => {
    const L = layoutOf([['sq', 'legendary_hive', 0, 0, 'N'], ['rect2', 'cannon_twinlink', 1, 0, 'N'], ['sq', 'cannon_pip', 3, 0, 'N']]);
    expect(Array.from(L.rounds)).toEqual([4, 1, 1]);
  });

  it('grows a model gun\'s intake with a rate mod, so it keeps its faster beat; its shot is unchanged', () => {
    const specs: [string, string | FunctionDef, number, number, 'E'][] = [['sq', 'cannon_pip', 0, 0, 'E']];
    const base = layoutOf(specs), input = layoutInput(specs);
    const fast = buildEnergyLayout({ ...input, weapons: [{ ...input.weapons![0], interval: 7.5 }] });
    expect(base.rate[0]).toBe(perTickUp(20));
    expect(fast.rate[0]).toBe(perTickUp(40));
    expect(fast.shot[0]).toBe(base.shot[0]);
    expect(fast.rate[0] * 7.5).toBeGreaterThanOrEqual(fast.shot[0]);
  });

  it('gives legacy guns and engines their defaults (a shot of draw × interval from a buffer of one; a second of boost buffered)', () => {
    const specs: [string, string | FunctionDef, number, number, 'E' | 'S'][] = [['sq', 'weapon', 0, 0, 'E'], ['sq', 'thruster', 1, 0, 'S']];
    const input = layoutInput(specs);
    const L = buildEnergyLayout({ ...input, weapons: [{ part: 0, fire: { model: 'cycle', interval: 10 }, interval: 10 }] });
    const gunDraw = partDemand(input.fns[0], input.area[0], input.mats[0]), engDraw = partDemand(input.fns[1], input.area[1], input.mats[1]);
    expect([L.gun[0], L.shot[0], L.cap[0], L.rate[0]]).toEqual([GUN_SHOT, toEu((gunDraw * 10) / 60), toEu((gunDraw * 10) / 60), perTickUp(gunDraw)]);
    const boosted = engDraw * (1 + powerTuning(tuning).boostDraw);
    expect([L.burn[1], L.bBurn[1], L.boostMul[1], L.rate[1], L.cap[1]]).toEqual([perTick(engDraw), perTick(boosted), 2.2, perTick(boosted), toEu(boosted)]);
  });
});
