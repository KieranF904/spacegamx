/**
 * Weapon mounting rules (mounting.ts; docs/parts-redesign.md §Mounting): each model's rules, the checker, the
 * sides a right-angle mount fires and bolts on at, turret arcs in the rebuild, the starter, and saves fitted before
 * the rules that still load.
 */

import { describe, it, expect } from 'vitest';
import type { Blueprint, PlacedPart, Rot, Side } from './types.js';
import { validateBlueprint } from './blueprint.js';
import { createShipState } from './state.js';
import { placeGeometry } from './grid.js';
import { attachSide, checkMounting, clearCells, mountingOf, mountingWords, partMountingProblems, weaponSides } from './mounting.js';
import { stepTurretAim } from './turret.js';
import type { ShipTuning } from './tuning.js';
import { readShipJson, testCatalog } from './testData.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const FN = (id: string) => catalog.functions.get(id)!;
const DEG = Math.PI / 180;
/** A part, in its model's own material */
const p = (uid: number, piece: string, fn: string, x: number, y: number, extra: Partial<PlacedPart> = {}): PlacedPart =>
  ({ uid, piece, fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as Rot, flip: false, ...extra });
const bp = (parts: PlacedPart[]): Blueprint => ({ name: 'test', catalogVersion: 1, parts });
/** A 2×1 core at (0,0)-(1,0) and the parts given */
const ship = (...parts: PlacedPart[]) => bp([p(0, 'rect2', 'core', 0, 0), ...parts]);
const problems = (b: Blueprint) => checkMounting(catalog, b.parts.map((q) => placeGeometry(catalog, q)));
const rules = (b: Blueprint, uid: number) => problems(b).filter((m) => m.uid === uid).map((m) => m.rule);
const codes = (b: Blueprint) => validateBlueprint(catalog, b, tuning, null).errors.map((e) => e.code);

describe('mounting rules: each weapon model its own', () => {
  const weapons = [...catalog.functions.values()].filter((f) => f.model && f.weapon);

  it('every weapon model has rules; a turret its arc, a fixed gun none; legacy weapons none (they mount anywhere)', () => {
    expect(weapons.length).toBe(37);
    for (const f of weapons) {
      expect(f.mounting, f.id).toBeDefined();
      const m = mountingOf(catalog, f.id)!;
      expect(m.rules, f.id).toBe(true);
      if (f.mount === 'turret') expect(f.mounting!.arc! > 0 && f.mounting!.arc! <= 360, f.id).toBe(true);
      else expect(f.mounting!.arc, f.id).toBeUndefined();
      for (const [, ahead] of m.clear) expect(ahead, f.id).toBeGreaterThanOrEqual(1);
    }
    // Nothing else has them
    expect([...catalog.functions.values()].filter((f) => f.mounting && !(f.model && f.weapon)).map((f) => f.id)).toEqual([]);
    // Legacy guns (enemies', bosses'): no rules, a turret the tuning's arc
    expect(mountingOf(catalog, 'weapon')).toMatchObject({ rules: false, attach: 'any', angle: 'straight', clear: [], arc: 0 });
    expect(mountingOf(catalog, 'weapon', tuning, 'turret')!.arc).toBe(tuning.turret.halfArcDeg * 2);
    expect(mountingOf(catalog, 'hull')).toBeNull();
  });

  it('the rules fit each gun: long barrels need room and bolt on behind, light turrets turn far, heavy ones little', () => {
    const arc = (id: string) => mountingOf(catalog, id)!.arc;
    const ahead = (id: string) => Math.max(0, ...mountingOf(catalog, id)!.clear.map(([, a]) => a));
    for (const id of ['cannon_longbarrel', 'railgun_needle', 'railgun_coilgun', 'railgun_spear', 'lance_lance', 'cannon_bastion', 'torpedo_eel', 'torpedo_leviathan']) {
      expect(mountingOf(catalog, id)!.attach, id).toBe('back');
      expect(ahead(id), id).toBeGreaterThanOrEqual(2);
      expect(ahead(id), id).toBeLessThanOrEqual(4);
    }
    expect(ahead('cannon_longbarrel')).toBe(3);
    expect(ahead('lance_lance')).toBe(4);
    expect(arc('autocannon_rattler')).toBe(270);
    expect(arc('laser_searchlight')).toBe(360);
    expect(arc('cannon_twinlink')).toBe(180);
    expect(arc('mortar_lobber')).toBe(360);
    expect(arc('pulse_overpulse')).toBe(120);
    expect(arc('emp_blackout')).toBe(120);
    // Side mounts: flak, the Searchlight's and Tesla's round emitters, the Swarm's pods
    const right = weapons.filter((f) => f.mounting!.angle === 'right').map((f) => f.id).sort();
    expect(right).toEqual(['arc_tesla', 'flak_burst', 'flak_cloudmaker', 'laser_searchlight', 'missile_swarm']);
    // Mixed: fixed and turreted side mounts, both
    expect(new Set(right.map((id) => FN(id).mount))).toEqual(new Set(['fixed', 'turret']));
    // A spread of arcs
    expect(new Set(weapons.filter((f) => f.mount === 'turret').map((f) => f.mounting!.arc)).size).toBeGreaterThanOrEqual(6);
  });

  it('the Pip is a fixed gun that bolts on from behind, and the starter still validates with its guns fixed', () => {
    expect(FN('cannon_pip').mount).toBe('fixed');
    expect(FN('cannon_pip').mounting).toEqual({ attach: 'back' });
    const sparrow = readShipJson<Blueprint>('blueprints/sparrow-t.json');
    expect(problems(sparrow)).toEqual([]);
    expect(validateBlueprint(catalog, sparrow, tuning, null).errors).toEqual([]);
    const d = createShipState(catalog, tuning, 1, sparrow, 0).derived;
    expect(d.weapons.map((w) => w.mount)).toEqual(['fixed', 'fixed']);
    expect(d.weapons.every((w) => !w.window)).toBe(true);
  });

  it('says its rules in plain words', () => {
    expect(mountingWords(catalog, 'autocannon_rattler')).toEqual(['Turret, 270°', 'Bolts on any side']);
    expect(mountingWords(catalog, 'cannon_longbarrel')).toEqual(['Fixed: aims with the ship', 'Bolts on from behind only', 'Needs 3 clear cells ahead']);
    expect(mountingWords(catalog, 'flak_burst')).toEqual(['Turret, 200°', 'Side mount (flippable)', 'Bolts on at its side only']);
    expect(mountingWords(catalog, 'weapon')).toEqual(['Fixed: aims with the ship', 'Mounts anywhere']);
  });
});

describe('mounting: sides and the checker', () => {
  it('a straight mount bolts on opposite where it fires; a right-angle one to its left, to its right when flipped', () => {
    expect((['N', 'E', 'S', 'W'] as Side[]).map((s) => attachSide(s, 'straight', false))).toEqual(['S', 'W', 'N', 'E']);
    expect((['N', 'E', 'S', 'W'] as Side[]).map((s) => attachSide(s, 'right', false))).toEqual(['W', 'N', 'E', 'S']);
    expect((['N', 'E', 'S', 'W'] as Side[]).map((s) => attachSide(s, 'right', true))).toEqual(['E', 'S', 'W', 'N']);
    expect(weaponSides(catalog, { fn: 'cannon_pip', facing: 'N', flip: false })).toEqual({ fire: 'N', attach: 'S' });
    expect(weaponSides(catalog, { fn: 'flak_burst', facing: 'N', flip: false })).toEqual({ fire: 'N', attach: 'W' });
    expect(weaponSides(catalog, { fn: 'flak_burst', facing: 'N', flip: true })).toEqual({ fire: 'N', attach: 'E' });
    expect(weaponSides(catalog, { fn: 'flak_burst', flip: false })).toBeNull();
    expect(weaponSides(catalog, { fn: 'hull', facing: 'N', flip: false })).toBeNull();
  });

  it('back attach: the edge behind must be what bolts it on', () => {
    // On the core's nose, bolted on behind
    expect(rules(ship(p(1, 'sq', 'cannon_pip', 0, -1, { facing: 'N' })), 1)).toEqual([]);
    // Beside the core, facing forward: held by its side, nothing behind
    const side = ship(p(1, 'sq', 'cannon_pip', -1, 0, { facing: 'N' }));
    expect(rules(side, 1)).toEqual(['attach']);
    expect(codes(side)).toEqual(['badMounting']);
    // Beside the core facing out: bolted on behind again
    expect(rules(ship(p(1, 'sq', 'cannon_pip', 2, 0, { facing: 'E' })), 1)).toEqual([]);
    // An 'any' gun is happy held by its side
    expect(rules(ship(p(1, 'sq', 'autocannon_rattler', -1, 0, { facing: 'N' })), 1)).toEqual([]);
  });

  it('barrel clearance: its cells ahead, from each cell of its firing edge, must hold no part', () => {
    const gun = p(1, 'rect2', 'cannon_longbarrel', 0, -1, { facing: 'N' });
    const g = placeGeometry(catalog, gun);
    // A 2-wide firing edge, 3 ahead: a 2×3 lane
    expect(clearCells(catalog, g).map(([x, y]) => `${x},${y}`).sort()).toEqual(['0,-2', '0,-3', '0,-4', '1,-2', '1,-3', '1,-4'].sort());
    expect(rules(ship(gun), 1)).toEqual([]);
    const blocked = ship(gun, p(2, 'sq', 'hull', 1, -3), p(3, 'sq', 'hull', 1, -2));
    const pr = problems(blocked).find((m) => m.uid === 1)!;
    expect(pr.rule).toBe('clear');
    expect(pr.cells!.map(([x, y]) => `${x},${y}`).sort()).toEqual(['1,-2', '1,-3']);
    expect(pr.message).toMatch(/3 clear cells ahead/);
    // Beside its lane, or past it, is fine
    expect(rules(ship(gun, p(2, 'sq', 'hull', 1, -5)), 1)).toEqual([]);
    expect(rules(ship(gun, p(2, 'sq', 'hull', 2, -2), p(3, 'sq', 'hull', 2, -3)), 1)).toEqual([]);
  });

  it('clear cells turn with the gun and mirror with its flip', () => {
    const custom = { ...FN('cannon_pip'), id: 'test_gun', mounting: { clear: [[1, 1], [0, 2]] as [number, number][] } };
    catalog.functions.set('test_gun', custom);
    try {
      const at = (facing: Side, flip = false) => clearCells(catalog, placeGeometry(catalog, p(1, 'sq', 'test_gun', 0, 0, { facing, flip }))).map(([x, y]) => `${x},${y}`);
      // Facing N, right is east: (1,-1) and (0,-2)
      expect(at('N')).toEqual(['1,-1', '0,-2']);
      expect(at('N', true)).toEqual(['-1,-1', '0,-2']);
      // Facing E, right is south
      expect(at('E')).toEqual(['1,1', '2,0']);
    } finally {
      catalog.functions.delete('test_gun');
    }
  });

  it('a right-angle mount bolts on at its side: the flip says which, and a round emitter only fires along a straight edge', () => {
    // On the core's east end, firing forward: its west side on the hull
    expect(rules(ship(p(1, 'sq', 'flak_burst', 2, 0, { facing: 'N' })), 1)).toEqual([]);
    // Mirrored, it would bolt on at its east side: nothing there
    expect(rules(ship(p(1, 'sq', 'flak_burst', 2, 0, { facing: 'N', flip: true })), 1)).toEqual(['attach']);
    // Firing back: mirrored is right
    expect(rules(ship(p(1, 'sq', 'flak_burst', 2, 0, { facing: 'S', flip: true })), 1)).toEqual([]);
    expect(rules(ship(p(1, 'sq', 'flak_burst', 2, 0, { facing: 'S' })), 1)).toEqual(['attach']);
    // A Searchlight (a quarter-round: straight W and S edges) on the nose: fires west, bolts on at its south edge
    expect(rules(ship(p(1, 'round', 'laser_searchlight', 0, -1, { facing: 'W' })), 1)).toEqual([]);
    expect(codes(ship(p(1, 'round', 'laser_searchlight', 0, -1, { facing: 'W' })))).toEqual([]);
    // Mirrored, its straight edges are E and S: fires east
    expect(rules(ship(p(1, 'round', 'laser_searchlight', 0, -1, { facing: 'E', flip: true })), 1)).toEqual([]);
    // Firing out of its south edge would bolt it on at its round side: no edge there
    expect(rules(ship(p(1, 'round', 'laser_searchlight', 0, -2, { facing: 'S' })), 1)).toEqual(['angle']);
  });

  it('reports every rule a part breaks, each part its own', () => {
    // A Longbarrel held by its side with a hull in its lane; a Pip beside it held by its side too
    const b = ship(p(1, 'rect2', 'cannon_longbarrel', -2, 0, { facing: 'N' }), p(2, 'sq', 'hull', -2, -2), p(3, 'sq', 'cannon_pip', 2, 0, { facing: 'N' }));
    expect(rules(b, 1).sort()).toEqual(['attach', 'clear']);
    expect(rules(b, 3)).toEqual(['attach']);
    expect(problems(b).filter((m) => m.uid === 0 || m.uid === 2)).toEqual([]);
    // (partMountingProblems for one, as the hangar asks of the part in hand)
    const geoms = b.parts.map((q) => placeGeometry(catalog, q));
    expect(partMountingProblems(catalog, geoms, 3).map((m) => m.rule)).toEqual(['attach']);
  });

  it("legacy guns (enemies', bosses') go anywhere", () => {
    const b = ship(p(1, 'sq', 'weapon', -1, 0, { facing: 'N', material: 'alloy' }), p(2, 'sq', 'weapon', 2, 0, { facing: 'N', material: 'alloy', mount: 'turret' }));
    expect(problems(b)).toEqual([]);
    expect(codes(b)).not.toContain('badMounting');
  });
});

describe('mounting: validation, saves and the rebuild', () => {
  it('validation refuses a design that breaks a rule; loading a saved ship (mounting: false) lets it fly', () => {
    const b = ship(p(1, 'sq', 'cannon_pip', -1, 0, { facing: 'N' }), p(2, 'sq', 'power_cell_reactor', 0, 1), p(3, 'sq', 'engine_ion_drive', 1, 1, { facing: 'S' }));
    expect(validateBlueprint(catalog, b, tuning, null).ok).toBe(false);
    expect(validateBlueprint(catalog, b, tuning, null).errors.map((e) => [e.code, e.uids])).toEqual([['badMounting', [1]]]);
    expect(validateBlueprint(catalog, b, tuning, null, { mounting: false }).errors).toEqual([]);
    // It flies and fights: its Pip fires out of its facing as ever
    const d = createShipState(catalog, tuning, 1, b, 0).derived;
    expect(d.weapons).toHaveLength(1);
    expect(d.weapons[0].dir).toEqual([0, -1]);
  });

  it('a turret turns within its own arc; a legacy one within the tuning\'s', () => {
    const half = (fn: string, piece = 'sq', extra: Partial<PlacedPart> = {}) =>
      createShipState(catalog, tuning, 1, ship(p(1, piece, fn, 0, -1, { facing: 'N', ...extra })), 0).derived.weapons[0].window!.half / DEG;
    expect(half('autocannon_rattler')).toBeCloseTo(135, 6);
    expect(half('pulse_overpulse', 'rect2')).toBeCloseTo(60, 6);
    expect(half('mortar_lobber')).toBeCloseTo(180, 6);
    expect(half('weapon', 'sq', { mount: 'turret', material: 'alloy' })).toBeCloseTo(tuning.turret.halfArcDeg, 6);
    // Its open sectors stay within its arc, and the hull it sits on closes the angles behind it
    const w = createShipState(catalog, tuning, 1, ship(p(1, 'sq', 'mortar_lobber', 0, -1, { facing: 'N' })), 0).derived.weapons[0].window!;
    const open = w.open.reduce((s, [lo, hi]) => s + hi - lo, 0) / DEG;
    expect(open).toBeGreaterThan(170);
    expect(open).toBeLessThan(300);
  });

  it('a right-angle mount fires out of the side it should', () => {
    const fire = (facing: Side, flip: boolean) => createShipState(catalog, tuning, 1, ship(p(1, 'sq', 'flak_burst', 2, 0, { facing, flip })), 0).derived.weapons[0];
    const n = fire('N', false), s = fire('S', true);
    expect(n.dir).toEqual([0, -1]);
    expect(n.window!.center).toBeCloseTo(-Math.PI / 2, 9);
    expect(s.dir).toEqual([0, 1]);
    expect(s.window!.center).toBeCloseTo(Math.PI / 2, 9);
    expect(n.window!.half / DEG).toBeCloseTo(100, 6);
  });

  it('a full-circle turret turns the short way round', () => {
    const w = { center: 0, half: Math.PI, open: [[-Math.PI, Math.PI]] as [number, number][], pivot: [0, 0] as [number, number], barrel: 1 };
    // From 170° to -170°: through 180°, not back across 0
    const r = stepTurretAim(w, 170 * DEG, -170 * DEG, tuning);
    expect(r.offset > 170 * DEG || r.offset < -170 * DEG).toBe(true);
    let a = 170 * DEG;
    for (let i = 0; i < 10; i++) a = stepTurretAim(w, a, -170 * DEG, tuning).offset;
    expect(a).toBeCloseTo(-170 * DEG, 6);
    // A half-circle one still clamps at its edge
    const h = { ...w, half: Math.PI / 2, open: [[-Math.PI / 2, Math.PI / 2]] as [number, number][] };
    expect(stepTurretAim(h, Math.PI / 2, Math.PI, tuning).canFire).toBe(false);
  });
});
