/**
 * Backup ships (econ/backups.ts; docs/design/death-rework-2026-11.md): the starter always qualifies; a ship of a pilot's
 * own does if it costs at most backupCost times the starter's build points, has no part above its grade, and every part
 * is one a level 0 pilot may fit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from '../ships/catalog.js';
import { parseBlueprint } from '../ships/blueprint.js';
import { buildPoints } from '../ships/grades.js';
import type { Blueprint } from '../ships/types.js';
import { backupRefusal, isStarterDesign, shipTier } from './backups.js';
import { cloneJson } from '../math/basic.js';

const data = join(__dirname, '../../../data');
const json = (p: string) => JSON.parse(readFileSync(join(data, p), 'utf-8'));
const catalog = loadCatalog({ pieces: json('ships/pieces.json'), functions: json('ships/functions.json'), materials: json('ships/materials.json'), models: json('ships/models.json') });
const starter = parseBlueprint(readFileSync(join(data, 'ships/blueprints/sparrow-t.json'), 'utf-8'));

describe('backup ships', () => {
  it('the starter qualifies, and is the starter design', () => {
    expect(backupRefusal(catalog, starter, starter, 1.25)).toBeNull();
    expect(isStarterDesign(cloneJson(starter), starter)).toBe(true);
    expect(shipTier(catalog, starter)).toBe(1);
  });

  it('a ship over the cost, above the grade, or with parts a new pilot can\'t fit does not', () => {
    const hull = starter.parts.find((q) => q.fn === 'hull')!;
    // (Much bigger: copies of a hull laid out far off, past the starter's build points by 25%)
    const big: Blueprint = cloneJson(starter);
    let uid = Math.max(...big.parts.map((q) => q.uid)) + 1;
    while (buildPoints(catalog, big) <= buildPoints(catalog, starter) * 1.25) big.parts.push({ ...cloneJson(hull), uid: uid++, x: hull.x + 40 + uid, y: hull.y + 40 });
    expect(backupRefusal(catalog, big, starter, 1.25)).toMatch(/build points/);
    expect(backupRefusal(catalog, big, starter, 100)).toBeNull();
    // (A steel hull: Mk II, and steel opens at level 5)
    const steel: Blueprint = cloneJson(starter);
    steel.parts.find((q) => q.fn === 'hull')!.material = 'steel';
    expect(backupRefusal(catalog, steel, starter, 100)).toMatch(/grade/);
    expect(isStarterDesign(steel, starter)).toBe(false);
  });
});
