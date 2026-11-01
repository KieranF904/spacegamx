/**
 * Test-only: energy layouts from parts on the grid (real geometry and joins), or from a bundled blueprint. Not exported
 * from index.ts (it reads the data from disk through testData.ts).
 */

import type { Blueprint, FunctionDef, PlacedPart, Rot, Side } from '../types.js';
import type { ShipTuning } from '../tuning.js';
import { blueprintGeometry } from '../blueprint.js';
import { computeJoins } from '../grid.js';
import { readShipJson, testCatalog } from '../testData.js';
import { blueprintEnergyInput } from './blueprint.js';
import { type EnergyLayout, type EnergyLayoutInput, buildEnergyLayout } from './layout.js';

export const catalog = testCatalog();
export const tuning: ShipTuning = readShipJson('tuning.json');

/** A part: its piece, its function (an id in the catalog, or a FunctionDef of the test's own), its cell, and its facing */
export type PartSpec = [piece: string, fn: string | FunctionDef, x: number, y: number, facing?: Side];

const fnOf = (f: string | FunctionDef): FunctionDef => {
  if (typeof f !== 'string') return f;
  const d = catalog.functions.get(f);
  if (!d) throw new Error(`no function ${f}`);
  return d;
};

/** A store of the test's own (per cell, as models.json): Holds, Gives, Takes; `oneWay` a Diode */
export function storeFn(id: string, store: number, discharge: number, intake: number, oneWay = false): FunctionDef {
  return { id, pieces: '*', hpScale: 1, model: true, store, discharge, intake, ...(oneWay ? { oneWay: true, facing: true } : {}) };
}
/** A generator of the test's own (E a second, per cell) */
export function genFn(id: string, produce: number): FunctionDef {
  return { id, pieces: '*', hpScale: 1, model: true, produce };
}

export function layoutInput(specs: PartSpec[], alive?: boolean[]): EnergyLayoutInput {
  const fns = specs.map((s) => fnOf(s[1]));
  const parts: PlacedPart[] = specs.map(([piece, , x, y, facing], uid) => ({
    uid, piece, fn: fns[uid].id, material: fns[uid].material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...(facing ? { facing } : {}),
  }));
  const bp: Blueprint = { name: 'power-test', catalogVersion: 1, parts };
  const geoms = blueprintGeometry(catalog, bp);
  const weapons = fns.flatMap((fn, part) => (fn.weapon && fn.fire ? [{ part, fire: fn.fire, interval: fn.fireInterval ?? fn.fire.interval }] : []));
  return {
    fns, area: geoms.map((g) => g.area), mats: fns.map((fn) => catalog.materials.get(fn.material ?? 'alloy')),
    alive: alive ?? fns.map(() => true), joins: computeJoins(geoms), core: fns.findIndex((f) => f.id === 'core'),
    tuning, weapons, geoms,
  };
}

export function layoutOf(specs: PartSpec[], alive?: boolean[]): EnergyLayout {
  return buildEnergyLayout(layoutInput(specs, alive));
}

/** A bundled blueprint's layout, built from its rebuild as P2's rebuild will */
export function blueprintInput(bp: Blueprint): EnergyLayoutInput {
  return blueprintEnergyInput(catalog, tuning, bp);
}
