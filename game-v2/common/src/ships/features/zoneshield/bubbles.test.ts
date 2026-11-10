/**
 * The ship-wide bubble shields (Deflector, Flicker Screen, Flash Screen, Bulwark Projector) are switched off for player
 * ships: a production catalog keeps the parts but they give no shield and draw nothing. The code path stays: a catalog
 * that asks gets them as before, and an enemy's own shield function (a legacy function, not a player model) is untouched.
 *
 * (Each test loads the catalog it needs right before using it: a catalog registers the function kinds for the whole
 * process, so two live at once would disagree.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { loadCatalog, PLAYER_BUBBLE_MODELS } from '../../catalog.js';
import { createShipState, type ShipState } from '../../state.js';
import { feedParts, readCatalogFiles, readShipJson, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import type { Blueprint, PlacedPart, Rot } from '../../types.js';
import { newPartHit, partHit, type HitCtx } from '../../hitRules.js';
import { blueprintGeometry } from '../../blueprint.js';

const tuning: ShipTuning = readShipJson('tuning.json');
const BUBBLES = ['shield_deflector', 'shield_flicker_screen', 'shield_flash_screen', 'shield_bulwark_projector'];
const pieceOf = (fn: string) => (fn === 'shield_bulwark_projector' ? 'block2' : fn === 'shield_flicker_screen' ? 'round' : 'sq');

/** The starter with a bubble shield on its left (the Bulwark Projector, 2x2, ahead of its left reactor), fed by a Cell Reactor across its in ports */
const sparrow = (cat: ReturnType<typeof loadCatalog>, fn?: string): ShipState => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  if (fn) {
    const big = pieceOf(fn) === 'block2';
    bp.parts.push({ uid: 70, piece: pieceOf(fn), fn, material: cat.functions.get(fn)!.material, x: -2, y: big ? -2 : 0, rot: 0 as Rot, flip: false } as PlacedPart);
    // (Production catalogs give a bubble no ports to feed: it's off)
    if (cat.functions.get(fn)!.ports?.length) feedParts(cat, bp, [70]);
  }
  return createShipState(cat, tuning, 1, bp, 0);
};

describe('the ship-wide bubbles', () => {
  // (First: the wire layout of a design is remembered for the whole process by its parts' functions and places, so the catalog
  // with the bubbles on lays them out before the one with them off does)
  it('are still fully there in a catalog that asks (the code path stays), and a bubble still soaks a hit', () => {
    const on = loadCatalog(readCatalogFiles(), { playerBubbles: true });
    const ctx: HitCtx = { catalog: on, tuning, geometry: (s) => blueprintGeometry(on, s.blueprint) };
    for (const fn of BUBBLES) expect(sparrow(on, fn).derived.shieldMax, fn).toBeGreaterThan(0);
    const s = sparrow(on, 'shield_deflector');
    s.shield = s.derived.shieldMax;
    const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
    const hp0 = s.hp[core];
    const r = partHit(ctx, s, core, 10, undefined, { tick: 1 }, newPartHit());
    expect(r.soak).toBe(10);
    expect(s.hp[core]).toBe(hp0);
  });

  it('are the four player models, and give a player ship nothing in a production catalog: no shield, no refill, no draw', () => {
    expect([...PLAYER_BUBBLE_MODELS].sort()).toEqual([...BUBBLES].sort());
    const production = loadCatalog(readCatalogFiles());
    const base = sparrow(production).derived;
    for (const fn of BUBBLES) {
      const f = production.functions.get(fn)!;
      expect(f.bubbleOff, fn).toBe(true);
      expect(f.shield, fn).toBeUndefined();
      expect(f.demand, fn).toBeUndefined();
      const d = sparrow(production, fn).derived;
      expect(d.shieldMax, fn).toBe(0);
      expect(d.shieldRegen, fn).toBe(0);
      expect(d.fx?.flash, fn).toBeUndefined();
      expect(d.energy.weaponDraw, fn).toBe(base.energy.weaponDraw);
    }
  });

  it('an enemy\'s own shield function (legacy, not a player model) keeps its bubble in a production catalog', () => {
    const production = loadCatalog(readCatalogFiles());
    const bp: Blueprint = { name: 'enemy', catalogVersion: 1, parts: [
      { uid: 0, piece: 'rect2', fn: 'core', material: 'alloy', x: 0, y: 0, rot: 0, flip: false },
      { uid: 1, piece: 'sq', fn: 'generator', material: 'alloy', x: 0, y: 1, rot: 0, flip: false },
      { uid: 2, piece: 'sq', fn: 'shield', material: 'steel', x: 1, y: 1, rot: 0, flip: false },
    ] } as never;
    const e = createShipState(production, tuning, 2, bp, 0);
    expect(production.functions.get('shield')!.shield).toBeGreaterThan(0);
    expect(e.derived.shieldMax).toBeGreaterThan(0);
    expect(e.shield).toBe(e.derived.shieldMax);
  });
});
