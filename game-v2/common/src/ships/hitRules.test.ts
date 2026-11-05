import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHIP_DATA_DIR, readShipJson, testCatalog } from './testData.js';
import { parseBlueprint, blueprintGeometry } from './blueprint.js';
import { createShipState, type ShipState } from './state.js';
import { stageOf, currentStage, standing, deciding, RUIN_HP } from './stages.js';
import { hitMultiplier, weaponHit } from './damage.js';
import { weaponDef } from './launch.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';
import type { Blueprint } from './types.js';
import {
  GLANCING, STAGE_COVER, PIERCE_KEEP, hpWire, bursts, pierceKeepOf, shellGone, shellAmount, shellVs, coverPart, partHit,
  igniteRule, hitEndFx, deriveShellHit, type HitCtx, type HitMods, type CoverMemo,
} from './hitRules.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const design = (name: string): Blueprint => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${name}.json`), 'utf-8'));
const ctx: HitCtx = { catalog, tuning, geometry: (s) => blueprintGeometry(catalog, s.blueprint) };
const ship = (name: string, id = 1): ShipState => createShipState(catalog, tuning, id, design(name), 0);
const mods = (extra: Partial<HitMods> = {}): HitMods => ({ tick: 7, ...extra });

describe('hitRules: small rules', () => {
  it('hpWire: a tenth, never rounded down to nothing, 0 for gone', () => {
    expect(hpWire(0)).toBe(0);
    expect(hpWire(-3)).toBe(0);
    expect(hpWire(0.01)).toBe(0.1);
    expect(hpWire(12.34)).toBe(12.3);
    expect(hpWire(12.36)).toBe(12.4);
    expect(hpWire(70.5)).toBe(70.5);
  });

  it('shellAmount: def damage × strength, × pierceKeep each pass, stored as f32 like Projectile.damage', () => {
    const rail = weaponDef(tuning, 'railgun'), f32 = new Float32Array(1);
    f32[0] = (rail.damage ?? 14) * 1.37;
    expect(shellAmount(rail, 1.37)).toBe(f32[0]);
    f32[0] *= pierceKeepOf(rail);
    f32[0] *= pierceKeepOf(rail);
    expect(shellAmount(rail, 1.37, 2)).toBe(f32[0]);
    expect(shellAmount({ type: 'projectile' } as WeaponTuning, 1)).toBe(14);
    expect(pierceKeepOf({ type: 'projectile' } as WeaponTuning)).toBe(PIERCE_KEEP);
    expect(pierceKeepOf({ type: 'projectile', pierceKeep: 0.9 } as WeaponTuning)).toBe(0.9);
  });

  it('shellGone: spent once its pierce passes are used', () => {
    const def = { type: 'projectile', pierce: 2 } as WeaponTuning;
    expect([0, 1, 2, 3].map((p) => shellGone(def, p))).toEqual([false, false, true, true]);
    expect(shellGone({ type: 'projectile' } as WeaponTuning, 0)).toBe(true);
  });

  it('shellVs: the hit at the grade, shield and hull scales only when the def has one, bane when it has one', () => {
    const cannon = weaponDef(tuning, 'cannon');
    expect(shellVs('cannon', cannon, 2)).toEqual({ hit: weaponHit('cannon', cannon, 2) });
    const torp = { ...cannon, vsShield: 0 } as WeaponTuning;
    expect(shellVs('torpedo', torp, 1)).toEqual({ shield: 0, hull: undefined, hit: weaponHit('torpedo', torp, 1) });
    const bane = { ...cannon, bane: { faction: 'cult', damage: 2 } } as WeaponTuning;
    expect(shellVs('cannon', bane, 1).bane).toEqual({ faction: 'cult', damage: 2 });
  });

  it('bursts and hitEndFx: a plain slug says nothing; a burst at its end with its radius; a pierce pass when it keeps damage', () => {
    const cannon = weaponDef(tuning, 'cannon'), flak = weaponDef(tuning, 'flak');
    expect(bursts(cannon)).toBe(false);
    expect(hitEndFx('cannon', cannon, true)).toBeNull();
    expect(bursts(flak)).toBe(true);
    expect(hitEndFx('flak', flak, true)).toEqual({ kind: 'flak', radius: flak.splash!.radius });
    const emp = { type: 'projectile', emp: { radius: 90, ticks: 10 } } as WeaponTuning;
    expect(hitEndFx('emp', emp, true)).toEqual({ kind: 'emp', radius: 90 });
    const ig = { type: 'projectile', ignite: { dps: 1, ticks: 2, radius: 1 } } as WeaponTuning;
    expect(hitEndFx('magma', ig, true)).toEqual({ kind: 'magma', radius: 40 });
    expect(hitEndFx('phase', { type: 'projectile', pierce: 3, pierceKeep: 1 } as WeaponTuning, false)).toEqual({ kind: 'phase', radius: 40 });
    expect(hitEndFx('railgun', { type: 'projectile', pierce: 3 } as WeaponTuning, false)).toBeNull();
  });

  it('igniteRule: the struck part, if the shell carries fire, the target is a ship and the part is still there', () => {
    const s = ship('enemy/pirate_gunship');
    const fire = { type: 'projectile', ignite: { dps: 5, ticks: 60, radius: 2 } } as WeaponTuning;
    expect(igniteRule(s, 3, fire)).toBe(3);
    expect(igniteRule(s, 3, weaponDef(tuning, 'cannon'))).toBe(-1);
    expect(igniteRule(s, -1, fire)).toBe(-1);
    s.hp[3] = 0;
    expect(igniteRule(s, 3, fire)).toBe(-1);
    s.hp[4] = 5; s.detached[4] = true;
    expect(igniteRule(s, 4, fire)).toBe(-1);
    expect(igniteRule({ ...s, kind: 'debris' }, 5, fire)).toBe(-1);
  });
});

describe('hitRules: partHit', () => {
  it('a plain hit: the part takes amount × armour, nothing more', () => {
    const s = ship('enemy/pirate_gunship'), part = 2, hit = weaponHit('cannon', weaponDef(tuning, 'cannon'), 1);
    const before = s.hp[part], k = hitMultiplier(catalog, tuning, s.blueprint.parts[part], hit);
    const r = partHit(ctx, s, part, 10, { hit }, mods());
    expect(r.part).toBe(part);
    expect(r.through).toBe(k);
    expect(r.share).toBe(k);
    expect(r.glancing).toBe(k < GLANCING);
    expect(r.dealt).toBe(before - s.hp[part]);
    expect(s.hp[part]).toBe(Math.max(0, before - Math.min(10 * 1 * k, before)));
    expect(r.soak).toBe(0);
  });

  it('nothing for nothing: amount 0 leaves the ship alone and reports no part', () => {
    const s = ship('enemy/pirate_gunship'), hp = s.hp.slice();
    expect(partHit(ctx, s, 2, 0, undefined, mods()).part).toBe(-1);
    expect(s.hp).toEqual(hp);
  });

  it('the shield soaks first (× vs.shield), the rest goes on; a shield emptied reports broke; shieldHitTick is the tick', () => {
    const s = ship('enemy/pirate_gunship'), part = 2;
    s.shield = 4;
    const r = partHit(ctx, s, part, 10, { shield: 2 }, mods({ tick: 99 }));
    expect(r.soak).toBe(4);
    expect(r.broke).toBe(true);
    expect(s.shield).toBe(0);
    expect(s.shieldHitTick).toBe(99);
    // 10 - 4/2 = 8 to the hull
    expect(r.dealt).toBeCloseTo(4 + 8, 9);
    // A shield that holds isn't broken; vs.shield 0 passes it by
    s.shield = 50;
    expect(partHit(ctx, s, part, 10, undefined, mods()).broke).toBe(false);
    expect(s.shield).toBe(40);
    expect(partHit(ctx, s, part, 10, { shield: 0 }, mods()).soak).toBe(0);
    expect(s.shield).toBe(40);
  });

  it('splash share, bane, taken: each × the amount, asked only when they apply', () => {
    const s = ship('enemy/pirate_gunship'), part = 2;
    let asked = 0;
    const m = mods({ baneFaction: () => { asked++; return 'pirates'; }, taken: () => 0.5 });
    const before = s.hp[part];
    partHit(ctx, s, part, 8, undefined, m);
    expect(asked).toBe(0);
    expect(before - s.hp[part]).toBeCloseTo(4, 9);
    const b2 = s.hp[part];
    const r = partHit(ctx, s, part, 8, { bane: { faction: 'pirates', damage: 2 } }, m);
    expect(asked).toBe(1);
    expect(b2 - s.hp[part]).toBeCloseTo(8, 9);
    // a braced boss shows it glancing: share = through × min(1, taken)
    expect(r.share).toBe(0.5);
    expect(r.glancing).toBe(true);
    const sp = catalog.functions.get(s.blueprint.parts[part].fn)?.splashTaken ?? 1;
    const b3 = s.hp[part];
    partHit(ctx, s, part, 2, { splash: true }, mods());
    expect(b3 - s.hp[part]).toBeCloseTo(Math.min(b3, 2 * sp), 9);
  });

  it('a ruin piece never breaks: it stops at RUIN_HP', () => {
    const s = ship('enemy/pyreclast_heart');
    const ruin = s.blueprint.parts.findIndex((p, i) => catalog.pieces.get(p.piece)?.ruin && stageOf(catalog, s, i) === currentStage(catalog, s));
    expect(ruin).toBeGreaterThanOrEqual(0);
    partHit(ctx, s, ruin, 1e9, undefined, mods());
    expect(s.hp[ruin]).toBe(RUIN_HP);
  });
});

describe('hitRules: coverPart (a staged boss)', () => {
  const s = ship('enemy/scrap_mother');
  const first = currentStage(catalog, s);
  const all = s.hp.map((_, i) => i).filter((i) => standing(catalog, s, i));
  const later = all.find((i) => stageOf(catalog, s, i) > first)!;
  const plate = all.find((i) => stageOf(catalog, s, i) === first && deciding(catalog, s, i))!;

  it('an unstaged part takes its own hit; a standing current-stage part too', () => {
    const g = ship('enemy/pirate_gunship');
    expect(coverPart(ctx, g, 3)).toBe(3);
    expect(coverPart(ctx, s, plate)).toBe(plate);
  });

  it("a later stage's part: the nearest deciding plate of the stage being fought takes it, at STAGE_COVER (or the boss's own share)", () => {
    expect(later).toBeDefined();
    const at = ctx.geometry(s)[later].centroid;
    const c = coverPart(ctx, s, later, at);
    expect(c).toBeGreaterThanOrEqual(0);
    expect(stageOf(catalog, s, c)).toBe(first);
    expect(deciding(catalog, s, c)).toBe(true);
    const t = ship('enemy/scrap_mother', 2), b = t.hp[c];
    const r = partHit(ctx, t, later, 10, { at }, mods());
    expect(r.part).toBe(c);
    expect(b - t.hp[c]).toBeCloseTo(10 * STAGE_COVER, 9);
    const u = ship('enemy/scrap_mother', 3);
    partHit(ctx, u, later, 10, { at }, mods({ stageCover: () => 0.5 }));
    expect(b - u.hp[c]).toBeCloseTo(5, 9);
  });

  it('one blast from one point: the memo keeps its choice while that part stands', () => {
    const at = ctx.geometry(s)[later].centroid;
    const memo: CoverMemo = { ship: s, at, first: 0, best: -1 };
    const c = coverPart(ctx, s, later, at, memo);
    expect(memo.best).toBe(c);
    expect(memo.first).toBe(first);
    expect(coverPart(ctx, s, later, at, memo)).toBe(c);
  });
});

describe('hitRules: deriveShellHit (the client view)', () => {
  it('equals partHit when the view has the true inputs (no shield, no boss modifiers), HP to the wire tenth', () => {
    for (const [kind, name] of [['cannon', 'enemy/pirate_gunship'], ['railgun', 'enemy/pirate_gunship'], ['magma', 'enemy/redtooth_brawler'], ['flak', 'enemy/scrap_mother']] as const) {
      const def = weaponDef(tuning, kind);
      for (let part = 0; part < 12; part++) {
        for (const passes of [0, 1]) {
          const truth = ship(name), view = ship(name);
          truth.hp[part] = view.hp[part] = Math.max(0.1, truth.hp[part] * 0.6);
          const at = ctx.geometry(truth)[part].centroid;
          const want = partHit(ctx, truth, part, shellAmount(def, 1.25, passes), { ...shellVs(kind, def, 2), at }, { tick: 0 });
          const got = deriveShellHit({ ctx, ship: view, struck: part, kind, def, grade: 2, strength: 1.25, passes, at });
          expect(got.part).toBe(want.part);
          expect(got.dealt).toBe(want.dealt);
          expect(got.glancing).toBe(want.glancing);
          if (want.part >= 0) {
            expect(got.hpAfter).toBe(hpWire(truth.hp[want.part]));
            expect(view.hp[want.part]).toBe(got.hpAfter);
          }
          expect(got.ignite).toBe(igniteRule(truth, part, def));
          expect(got.gone).toBe(shellGone(def, passes));
          expect(got.fx).toEqual(hitEndFx(kind, def, got.gone));
        }
      }
    }
  });

  it('leaves the shield alone (the view never knows it) and does not soak with it', () => {
    const s = ship('enemy/pirate_gunship');
    s.shield = 30;
    const def = weaponDef(tuning, 'cannon'), before = s.hp[2];
    const r = deriveShellHit({ ctx, ship: s, struck: 2, kind: 'cannon', def, grade: 1, strength: 1, passes: 0 });
    expect(s.shield).toBe(30);
    expect(r.dealt).toBeGreaterThan(0);
    expect(s.hp[2]).toBeLessThan(before);
  });
});

describe('sidesHurt (who may hurt whom: GameServer.canDamage bar its PvP zones)', () => {
  it('matches the server rule for every pair of sides', async () => {
    const { sidesHurt, SIDE } = await import('./hitRules.js');
    // The server's rule as it was written before it moved here
    const old = (a: number, t: number): 0 | 1 | 2 => {
      if ((a | t) & SIDE.DOCKED) return 0;
      if ((a | t) & SIDE.PERSON) return 0;
      const ap = !!(a & SIDE.PILOT), tp = !!(t & SIDE.PILOT);
      if ((ap || a & SIDE.WARD) && (tp || t & SIDE.WARD) && !(ap && tp)) return 0;
      if (!ap || !tp) return 1;
      return 2;
    };
    for (let a = 0; a < 16; a++) for (let t = 0; t < 16; t++) expect(sidesHurt(a, t), `${a} vs ${t}`).toBe(old(a, t));
    expect(sidesHurt(SIDE.PILOT, 0)).toBe(1);
    expect(sidesHurt(SIDE.PILOT, SIDE.WARD)).toBe(0);
    expect(sidesHurt(SIDE.PILOT, SIDE.PILOT)).toBe(2);
  });
});
