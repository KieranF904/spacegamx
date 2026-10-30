import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadCatalog } from './catalog.js';
import { readCatalogFiles, SHIP_DATA_DIR } from './testData.js';
import { createShipState } from './state.js';
import { parseBlueprint, validateBlueprint } from './blueprint.js';
import { blueprintGeometry } from './blueprint.js';
import { computeJoins, mountOf } from './grid.js';
import { readShipJson } from './testData.js';
import type { Blueprint, BespokeFile } from './types.js';

const tuning = readShipJson('tuning.json');

/** Two triangles sharing an edge, a core between, a gun pointing out at an angle */
const SMALL: BespokeFile = {
  pieces: [
    { id: 't_core', polygon: [[0, 0], [2, 0], [2, 2], [0, 2]] },
    { id: 't_wing', polygon: [[2, 0], [4.5, 1], [2, 2]] },
    { id: 't_gun', polygon: [[0, 0], [0, 2], [-1.7, 1.3], [-1.7, 0.4]], mount: { at: [-1.7, 0.85], dir: [-1, -0.3], width: 0.9 } },
    { id: 't_loose', polygon: [[10, 10], [11, 10], [11, 11]] },
  ],
};

function smallCatalog() {
  return loadCatalog({ ...readCatalogFiles(), bespoke: [...(readCatalogFiles().bespoke ?? []), SMALL] }, { overlapShrink: tuning.overlapShrink });
}

const bp = (parts: [string, string, string?][]): Blueprint => ({
  name: 'test', catalogVersion: 1,
  parts: parts.map(([piece, fn, mount], uid) => ({ uid, piece, fn, material: 'alloy', x: 0, y: 0, rot: 0, flip: false, ...(mount ? { mount: mount as 'turret' } : {}) })),
});

describe('bespoke pieces', () => {
  it('are loaded with the cells their shape covers, and stay out of the pilots\' piece list', () => {
    const cat = smallCatalog();
    const wing = cat.pieces.get('t_wing')!;
    expect(wing.bespoke).toBe(true);
    expect(wing.cells.map((c) => c.join(','))).toEqual(expect.arrayContaining(['2,0', '3,0', '4,0', '2,1', '3,1', '4,1']));
    expect(cat.pieceIds).not.toContain('t_wing');
    expect(cat.pieceIds).toContain('sq');
  });

  it('join what they touch, and point out of their mount at any angle', () => {
    const cat = smallCatalog();
    const b = bp([['t_core', 'core'], ['t_wing', 'hull'], ['t_gun', 'weapon', 'turret'], ['t_loose', 'hull']]);
    const joins = computeJoins(blueprintGeometry(cat, b));
    expect(joins).toEqual(expect.arrayContaining([[0, 1], [0, 2]]));
    expect(joins.some(([a, c]) => a === 3 || c === 3)).toBe(false);
    const geom = blueprintGeometry(cat, b)[2];
    const m = mountOf(geom)!;
    expect(m.dir[0]).toBeCloseTo(-1 / Math.hypot(1, 0.3), 5);
    const ship = createShipState(cat, tuning, 1, b, 0);
    // The loose triangle isn't held on; the gun is, and fires out of its mount
    expect(ship.derived.alive).toEqual([true, true, true, false]);
    expect(ship.derived.weapons).toHaveLength(1);
    expect(ship.derived.weapons[0].dir[0]).toBeLessThan(-0.9);
    expect(ship.derived.weapons[0].window).toBeDefined();
  });

  it('are never allowed in a pilot\'s design, nor are the game\'s own ships\' parts', () => {
    const cat = smallCatalog();
    const errs = validateBlueprint(cat, bp([['t_core', 'core'], ['t_wing', 'hull']]), tuning, null).errors;
    expect(errs.some((e) => e.code === 'exclusive')).toBe(true);
    const own = validateBlueprint(cat, { name: 'x', catalogVersion: 1, parts: [
      { uid: 0, piece: 'sq', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
      { uid: 1, piece: 'sq', fn: 'dash_coil', material: 'alloy', x: 1, y: 0, rot: 0, flip: false },
    ] }, tuning, null).errors;
    expect(own.some((e) => e.code === 'exclusive')).toBe(true);
  });
});

describe('the Pyreclast', () => {
  const cat = loadCatalog(readCatalogFiles(), { overlapShrink: tuning.overlapShrink });
  const design = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/enemy/pyreclast.json'), 'utf-8'));
  const ship = createShipState(cat, tuning, 1, design, 0);

  it('holds together: every part reaches the core', () => {
    const lost = design.parts.filter((_, i) => !ship.derived.alive[i]).map((p) => p.piece);
    expect(lost).toEqual([]);
  });

  it('has power everywhere it needs it, its guns, bays, coils and drives', () => {
    const d = ship.derived;
    const unpowered = d.weapons.filter((w) => w.satisfaction <= 0).map((w) => design.parts[w.part].piece);
    expect(unpowered).toEqual([]);
    expect(d.weapons.length).toBe(6);
    expect(d.weapons.every((w) => w.mount === 'turret' && w.window && w.window.open.length > 0)).toBe(true);
    expect(d.launchers).toHaveLength(2);
    expect(d.dash.coils).toBe(2);
    // (three great drives, four small steering ones under the bays; and its heart's three, beneath its own, there from
    // the start: scripts/bespoke/pyreclast_heart.mjs)
    expect(d.thrusters).toHaveLength(10);
    expect(d.thrusters.every((t) => t.force[1] < 0)).toBe(true);
    // Big: well over a thousand units across
    expect(d.radius).toBeGreaterThan(600);
  });
});
