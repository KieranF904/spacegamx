/**
 * A sharing shell's rules (hitRules.ts passShare, burnLights, exitHeading, hitEndFx's pass): the share a hull takes,
 * its fire (the part it strikes on every hull, the same on the server and in a client's derivation),
 * the heading an exit blast is told with, and the blast a pass is told with. A shell that shares nothing is as it was.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHIP_DATA_DIR, readShipJson, testCatalog } from './testData.js';
import { parseBlueprint, blueprintGeometry } from './blueprint.js';
import { createShipState } from './state.js';
import { fxDef } from './modifiers/fxDef.js';
import { FX_STEPS, type GunFx } from './modifiers/types.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';
import { passShare, exitHeading, hitEndFx, igniteRule, deriveShellHit, type HitCtx } from './hitRules.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const mt = tuning.modifiers!;
const ctx: HitCtx = { catalog, tuning, geometry: (s) => blueprintGeometry(catalog, s.blueprint) };
const skiff = () => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/enemy/pirate_gunship.json'), 'utf-8')), 0);
const shell: WeaponTuning = { type: 'projectile', damage: 20, speed: 40, life: 100, spread: 2, size: 1 };
const withFx = (...names: string[]): WeaponTuning => {
  const l: GunFx[] = names.map((n) => ({ fx: mt.effects.indexOf(n), q: FX_STEPS }));
  return fxDef(shell, mt, l, (1 << l.length) - 1);
};

describe('a sharing shell', () => {
  it('passShare: the hull\'s share of the hit, the last share for any hull past the list; 1 for a shell that shares nothing', () => {
    const def = withFx('pierce'), f = def.pierceFracs!;
    expect(f.map((_, i) => passShare(def, i))).toEqual(f);
    expect(passShare(def, f.length + 3)).toBe(f[f.length - 1]);
    expect(passShare(shell, 0)).toBe(1);
    expect(passShare({ ...shell, pierce: 2, pierceKeep: 1 }, 1)).toBe(1);
  });

  it('its fire: the part it strikes on every hull, whatever pass it is on (no dice), as a client works it out too', () => {
    const def = withFx('pierce', 'burn');
    for (let passes = 0; passes < 4; passes++) {
      const truth = skiff(), part = truth.hp.findIndex((h) => h > 0);
      expect(igniteRule(truth, part, def)).toBe(part);
      expect(deriveShellHit({ ctx, ship: skiff(), struck: part, kind: 'cannon', def, grade: 1, strength: 0.01, passes }).ignite).toBe(part);
    }
  });

  it('hitEndFx: a pass is told with its blast when it shares and has one; without a blast, or sharing nothing, as before', () => {
    const both = withFx('pierce', 'explosive');
    expect(hitEndFx('cannon', both, false)).toEqual({ kind: 'cannon', radius: both.splash!.radius });
    expect(hitEndFx('cannon', both, true)).toEqual({ kind: 'cannon', radius: both.splash!.radius });
    expect(hitEndFx('cannon', withFx('pierce'), false)).toBeNull();
    expect(hitEndFx('cannon', withFx('explosive'), false)).toBeNull();
    expect(hitEndFx('railgun', { type: 'projectile', pierce: 3 } as WeaponTuning, false)).toBeNull();
    expect(hitEndFx('phase', { type: 'projectile', pierce: 3, pierceKeep: 1 } as WeaponTuning, false)).toEqual({ kind: 'phase', radius: 40 });
  });

  it('exitHeading: whole degrees, 0..359', () => {
    expect(exitHeading(1, 0)).toBe(0);
    expect(exitHeading(0, 1)).toBe(90);
    expect(exitHeading(-1, 0)).toBe(180);
    expect(exitHeading(0, -1)).toBe(270);
    expect(exitHeading(1, -0.001)).toBe(0);
    for (let a = 0; a < 720; a += 7) { const h = exitHeading(Math.cos(a), Math.sin(a)); expect(Number.isInteger(h) && h >= 0 && h < 360).toBe(true); }
  });
});
