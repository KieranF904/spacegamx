/**
 * Engine exhaust line of sight (mounting.ts engineExhaust, applied in rebuild.ts): an engine pushes with the share of its
 * exhaust lanes (one a cell across its back) the ship leaves clear out past its last cell; a clear engine pushes with
 * every cell of it. And a Torch stood on end (its two in ports on one cell) can be fed its whole burn on the ports core.
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot, Side } from './types.js';
import { validateBlueprint } from './blueprint.js';
import { createShipState, damagePart, rebuildShip } from './state.js';
import { placeGeometry } from './grid.js';
import { cellMap, engineExhaust, exhaustProblem, partMountingProblems } from './mounting.js';
import { stepShipPhysics } from './physics.js';
import { fullPortsCharge, type Charge } from './energy.js';
import { portsThrustFrac } from './power/ports.js';
import type { ShipTuning } from './tuning.js';
import { readShipJson, testCatalog } from './testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const S = { facing: 'S' as Side };
/** A 2×1 core at (0,0)-(1,0), two Cell Reactors under it giving S, and the parts given (on the ports core) */
const ship = (...parts: PlacedPart[]): Blueprint => ({
  name: 'test', catalogVersion: 1,
  parts: [p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'power_cell_reactor', 0, 1, { rot: 2 }), p(2, 'sq', 'power_cell_reactor', 1, 1, { rot: 2 }), ...parts],
});
const geoms = (b: Blueprint) => b.parts.map((q) => placeGeometry(catalog, q));
const derived = (b: Blueprint) => createShipState(catalog, tuning, 0, b, 0).derived;
/** Each engine's push forward (ship-local -y), by uid */
const pushes = (b: Blueprint) => Object.fromEntries(derived(b).thrusters.map((t) => [b.parts[t.part].uid, -t.force[1]]));
const at = (b: Blueprint, uid: number) => b.parts.findIndex((q) => q.uid === uid);

// A Torch (rect2, 2 across) under the reactors, pushing S: its two lanes are x 0 and 1 from y 3 down
const torch = p(3, 'rect2', 'engine_torch', 0, 2, S);
/** A column of hull at x 2 from y 1 to 4, beside the torch and its lanes, holding on whatever is put behind it */
const frame = [1, 2, 3, 4].map((y) => p(10 + y, 'sq', 'hull', 2, y));

describe('engine exhaust: line of sight behind it', () => {
  it('clear: nothing behind it out to the ship\'s edge, so all its thrust (4 a cell, 2 cells)', () => {
    const b = ship(torch);
    const e = engineExhaust(geoms(b), at(b, 3), 'S');
    expect(e).toEqual({ lanes: 2, clear: 2, share: 1, blocked: [] });
    expect(pushes(b)[3]).toBeCloseTo(8, 9);
    expect(derived(b).thrusters[0].exhaust).toBeUndefined();
    expect(exhaustProblem(catalog, geoms(b), at(b, 3))).toBeNull();
  });

  it('fully blocked: a part anywhere in each lane, not only against its edge, and it gives nothing', () => {
    // Armour two cells behind, not against its edge (which stays free: validation's facing rule is kept)
    const b = ship(torch, ...frame, p(6, 'rect2', 'armor', 0, 4));
    const e = engineExhaust(geoms(b), at(b, 3), 'S');
    expect(e).toMatchObject({ lanes: 2, clear: 0, share: 0 });
    expect(e.blocked).toHaveLength(2);
    expect(e.blocked).toEqual(expect.arrayContaining([[0, 4], [1, 4]]));
    expect(pushes(b)[3]).toBeCloseTo(0, 9);
    expect(derived(b).maxThrust.forward).toBe(0);
    // A warning, never a refusal: it validates, and the hangar's placement check (the guns' rules) passes it
    expect(validateBlueprint(catalog, b, tuning, null).errors.map((x) => x.code)).toEqual([]);
    expect(partMountingProblems(catalog, geoms(b), at(b, 3))).toEqual([]);
    const w = exhaustProblem(catalog, geoms(b), at(b, 3))!;
    expect(w).toMatchObject({ uid: 3, rule: 'exhaust', cells: expect.arrayContaining([[0, 4], [1, 4]]) });
    expect(w.message).toMatch(/no thrust/);
  });

  it('partly blocked: the share of its lanes clear (one of two: half)', () => {
    const b = ship(torch, ...frame, p(6, 'sq', 'armor', 1, 4));
    const e = engineExhaust(geoms(b), at(b, 3), 'S');
    expect(e).toEqual({ lanes: 2, clear: 1, share: 0.5, blocked: [[1, 4]] });
    expect(pushes(b)[3]).toBeCloseTo(4, 9);
    expect(derived(b).thrusters[0].exhaust).toBe(0.5);
    expect(exhaustProblem(catalog, geoms(b), at(b, 3))!.message).toMatch(/1 of its 2 exhaust lanes.*50% thrust/);
  });

  it('a part beside the lane, or ahead of the engine, blocks nothing', () => {
    const b = ship(torch, ...frame, p(7, 'sq', 'hull', -1, 0));
    expect(engineExhaust(geoms(b), at(b, 3), 'S').share).toBe(1);
    expect(pushes(b)[3]).toBeCloseTo(8, 9);
  });

  it('multi-cell engines push with every cell: a Torch stood on end (one lane, two deep) gives all 8, two side by side 16', () => {
    // rot 1: (x, 2) and (x, 3), pushing S out of one cell edge
    const b = ship(p(3, 'rect2', 'engine_torch', 0, 2, { rot: 1, ...S }), p(4, 'rect2', 'engine_torch', 1, 2, { rot: 1, ...S }));
    expect(engineExhaust(geoms(b), at(b, 3), 'S')).toEqual({ lanes: 1, clear: 1, share: 1, blocked: [] });
    expect(pushes(b)).toEqual({ 3: expect.closeTo(8, 9), 4: expect.closeTo(8, 9) });
    expect(derived(b).maxThrust.forward).toBeCloseTo(16, 9);
  });

  it('two engines one behind the other: the front one\'s facing edge is taken (refused, as before), the back one pushes', () => {
    const b = ship(torch, p(4, 'rect2', 'engine_torch', 0, 3, S));
    expect(validateBlueprint(catalog, b, tuning, null).errors.map((x) => x.code)).toContain('facingBlocked');
    expect(engineExhaust(geoms(b), at(b, 3), 'S').share).toBe(0);
    expect(engineExhaust(geoms(b), at(b, 4), 'S').share).toBe(1);
  });

  it('works from the ship as it stands: a blocker shot off clears the lane (alike wherever the rebuild runs)', () => {
    const b = ship(torch, ...frame, p(6, 'sq', 'armor', 1, 4));
    const s = createShipState(catalog, tuning, 0, b, 0);
    expect(-s.derived.thrusters[0].force[1]).toBeCloseTo(4, 9);
    damagePart(s, at(b, 6), 1e9, tuning);
    rebuildShip(s, catalog, tuning);
    expect(-s.derived.thrusters[0].force[1]).toBeCloseTo(8, 9);
    expect(s.derived.thrusters[0].exhaust).toBeUndefined();
  });

  it('a cell map of some parts only: what isn\'t in it blocks nothing', () => {
    const b = ship(torch, ...frame, p(6, 'sq', 'armor', 1, 4));
    const g = geoms(b), k = at(b, 6);
    expect(engineExhaust(g, at(b, 3), 'S', cellMap(g, (j) => j !== k)).share).toBe(1);
  });
});

describe('a Torch stood on end on the ports core: its two in ports are one, rated for both', () => {
  /** Its average share of its burn over 10 s of cruise (after 10 s to settle) */
  const fed = (b: Blueprint, uid: number) => {
    const d = derived(b), k = at(b, uid);
    let charge: Charge = fullPortsCharge(d), sum = 0;
    const body = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, angVel: 0, jump: 0 } as Parameters<typeof stepShipPhysics>[0];
    for (let t = 0; t < 1200; t++) {
      charge = stepShipPhysics(body, { forward: true, backward: false, left: false, right: false, boost: false, targetAngle: -Math.PI / 2 } as never, d, tuning, { charge, drainRate: 1, tick: t }).charge;
      if (t >= 600) sum += portsThrustFrac()[k];
    }
    return sum / 600;
  };

  it('a Joiner Bank (90) gives it its whole burn (68); a Cell Reactor (35) about half', () => {
    // Two reactors into a Joiner Bank, its out (x 3) into the top of the Torch
    const joined: Blueprint = {
      name: 'test', catalogVersion: 1,
      parts: [p(0, 'rect2', 'core', 0, 0), p(1, 'sq', 'power_cell_reactor', 2, -1, { rot: 2 }), p(2, 'sq', 'power_cell_reactor', 3, -1, { rot: 2 }),
        p(3, 'rect2', 'power_joiner_bank', 3, 0, { rot: 2, material: 'steel' }), p(4, 'rect2', 'engine_torch', 3, 1, { rot: 1, ...S })],
    };
    expect(validateBlueprint(catalog, joined, tuning, null).ok).toBe(true);
    const L = derived(joined).ports!;
    expect(L.ports.filter((q) => q.part === at(joined, 4))).toEqual([expect.objectContaining({ dir: 0, rate: 68, link: 1 })]);
    expect(fed(joined, 4)).toBeCloseTo(1, 3);
    const one = ship(p(3, 'rect2', 'engine_torch', 0, 2, { rot: 1, ...S }));
    expect(fed(one, 3)).toBeCloseTo(35 / 68, 2);
  });
});
