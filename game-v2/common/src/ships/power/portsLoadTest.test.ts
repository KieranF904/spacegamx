/**
 * The hangar's ports views: each port's state (portStates.ts: linked, open, wasted, clashing, and what a part in hand
 * would meet) and the load test (portsLoadTest.ts: firing, boosting, both, against the same ship with unlimited power)
 * on the starter and the dev Lancer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Blueprint } from '../types.js';
import { parseBlueprint } from '../blueprint.js';
import { placeGeometry } from '../grid.js';
import { createShipState } from '../state.js';
import { SHIP_DATA_DIR } from '../testData.js';
import { catalog, tuning } from './testData.js';
import { PS_CLASH, PS_LINKED, PS_OPEN, PS_SPARE, PS_WASTE, portsView, previewPorts } from './portStates.js';
import { PORTS_SCENARIOS, portsLoadTest } from './portsLoadTest.js';

const load = (path: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', path), 'utf8'));
const derive = (bp: Blueprint) => createShipState(catalog, tuning, 1, bp, 0).derived;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// (The first ports starter, kept as a fixture: the library's now feeds its Pips from a core hub)
const starter = () => load('fixtures/sparrow-t-reactors.json');
const idx = (bp: Blueprint, uid: number) => bp.parts.findIndex((p) => p.uid === uid);
// (That starter: Pips at (-1,0) and (2,0), each fed from below by a reactor giving N (uids 7, 8); reactors 4 and 13 give S into the engines)
const PIP = 2, PIP_REACTOR = 7, ENGINE_REACTOR = 4, ENGINE_REACTOR_2 = 13;

describe('portsView', () => {
  it('the starter: every power port linked or spare, nothing open, wasted or clashing', () => {
    const v = portsView(derive(starter()).ports!);
    expect(v.open + v.waste + v.clash).toBe(0);
    expect(v.ports.every((p) => p.state === PS_LINKED || p.state === PS_SPARE)).toBe(true);
    // (each link has its two ends, and knows where it crosses)
    expect(v.linked).toBe(2 * v.links.length);
    for (const l of v.links) expect(l.at).not.toBeNull();
  });

  it('a reactor turned away: its out port is wasted, the Pip it fed has its in port open', () => {
    const bp = starter();
    bp.parts[idx(bp, PIP_REACTOR)].rot = 2;
    const v = portsView(derive(bp).ports!);
    const r = v.byPart[idx(bp, PIP_REACTOR)].map((k) => v.ports[k]), pip = v.byPart[idx(bp, PIP)].map((k) => v.ports[k]);
    expect(r.map((p) => p.state)).toEqual([PS_WASTE]);
    expect(pip.map((p) => p.state)).toEqual([PS_OPEN]);
    expect(v.waste).toBe(1);
    expect(v.open).toBe(1);
  });

  it('two reactors turned to give into each other clash, both ends, and name each other', () => {
    const bp = starter(), a = idx(bp, ENGINE_REACTOR), b = idx(bp, ENGINE_REACTOR_2);
    // (4 at (0,1) gives E, 13 at (1,1) gives W: two outs on one edge)
    bp.parts[a].rot = 1; bp.parts[b].rot = 3;
    const v = portsView(derive(bp).ports!);
    const pa = v.ports[v.byPart[a][0]], pb = v.ports[v.byPart[b][0]];
    expect([pa.state, pb.state]).toEqual([PS_CLASH, PS_CLASH]);
    expect([pa.to, pb.to]).toEqual([b, a]);
    expect(v.clash).toBe(2);
  });

  it('previewPorts: a reactor in hand under a Pip would link to it; turned about, it would face a hull and waste its line', () => {
    const full = starter(), k = idx(full, PIP_REACTOR), part = full.parts[k];
    const bp = clone(full); bp.parts.splice(k, 1);
    const d = derive(bp), fn = catalog.functions.get(part.fn)!;
    const occ = new Map<string, number>();
    bp.parts.forEach((q, i) => { for (const c of placeGeometry(catalog, q).cells) occ.set(`${c[0]},${c[1]}`, i); });
    const occupant = (x: number, y: number) => occ.get(`${x},${y}`) ?? -1;
    const here = previewPorts(d.ports, part, fn, placeGeometry(catalog, part).cells, occupant);
    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ dir: 1, state: PS_LINKED, to: idx(bp, PIP), x: -1, y: 1, side: 'N' });
    const turned = { ...part, rot: 2 as const };
    const away = previewPorts(d.ports, turned, fn, placeGeometry(catalog, turned).cells, occupant);
    expect(away[0]).toMatchObject({ dir: 1, state: PS_WASTE, side: 'S', blocked: true });
  });
});

describe('portsLoadTest', () => {
  it('the starter holds up firing, boosting and both: no brownout, every gun and engine in use at full share', () => {
    const bp = starter(), d = derive(bp);
    for (const s of PORTS_SCENARIOS) {
      const r = portsLoadTest(d, s, 6)!;
      expect(r.firstBrown).toBe(-1);
      expect(Math.min(r.guns, r.engines, r.tools)).toBe(1);
      const guns = bp.parts.map((p, i) => (p.fn === 'cannon_pip' ? i : -1)).filter((i) => i >= 0);
      for (const g of guns) expect(r.used[g]).toBe(s === 'boost' ? 0 : 1);
    }
  });

  it('is deterministic: the same design gives the same numbers', () => {
    const d = derive(load('dev/ports-lancer.json'));
    const a = portsLoadTest(d, 'both', 8)!, b = portsLoadTest(derive(load('dev/ports-lancer.json')), 'both', 8)!;
    expect(Array.from(a.end)).toEqual(Array.from(b.end));
    expect(Array.from(a.flow)).toEqual(Array.from(b.flow));
    expect([a.firstBrown, a.storeEnd]).toEqual([b.firstBrown, b.storeEnd]);
  });

  it('a gun with nothing feeding it fires what its buffer holds, then nothing', () => {
    const bp = starter();
    bp.parts[idx(bp, PIP_REACTOR)].rot = 2;
    const r = portsLoadTest(derive(bp), 'fire', 4)!, pip = idx(bp, PIP);
    expect(r.brownAt[pip]).toBeGreaterThanOrEqual(0);
    expect(r.brownAt[pip]).toBeLessThan(1);
    expect(r.end[pip]).toBe(0);
    expect(r.guns).toBe(0);
    expect(r.firstPart).toBe(pip);
  });

  it('the dev Lancer: firing drains its stores, then its Lance browns out; boosting alone holds', () => {
    const bp = load('dev/ports-lancer.json'), d = derive(bp), lance = bp.parts.findIndex((p) => p.fn === 'lance_lance');
    const fire = portsLoadTest(d, 'fire', 20)!;
    expect(fire.brownAt[lance]).toBeGreaterThan(1);
    expect(fire.end[lance]).toBeLessThan(0.5);
    expect(fire.storeLow).toBeLessThan(10);
    expect(fire.firstPart).toBe(lance);
    const boost = portsLoadTest(d, 'boost', 20)!;
    expect(boost.firstBrown).toBe(-1);
    expect(boost.used[lance]).toBe(0);
  });

  it('every link carries no more than its cap, and stores report their fill', () => {
    const d = derive(load('dev/ports-lancer.json')), v = portsView(d.ports!), r = portsLoadTest(d, 'both', 10)!;
    for (const l of v.links) expect(r.flow[l.id]).toBeLessThanOrEqual(l.cap + 1e-9);
    expect(r.flow.some((f) => f > 0)).toBe(true);
    for (const s of d.ports!.relays) expect(r.fill[s]).toBeGreaterThanOrEqual(0);
  });
});
