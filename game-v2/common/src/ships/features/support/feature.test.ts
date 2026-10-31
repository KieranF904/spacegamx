import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPlan, weaponRole, compilePlan } from '../plan.js';
import { feature } from './index.js';
import { REPAIR_BEAM, POINT_DEFENCE } from './support.js';
import { readShipJson } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';

const tuning: ShipTuning = readShipJson('tuning.json');

describe('support feature', () => {
  it('is a weapon-kind feature: it gives no function a feature of its own', () => {
    expect(feature.applies({} as never)).toBe(false);
    expect(getPlan().byId.get('support')).toBeGreaterThan(getPlan().byId.get('strafer')!);
  });
  it('its roles pick weapons by their tuning, as the old dispatch did', () => {
    const P = getPlan();
    const repair = weaponRole(P, 'support', REPAIR_BEAM), pd = weaponRole(P, 'support', POINT_DEFENCE);
    for (const [kind, def] of Object.entries(tuning.weapons ?? {})) {
      expect(repair.applies(def)).toBe(!!def.heal);
      expect(pd.applies(def)).toBe(!!def.pointDefence);
      if (kind === 'repair') expect(repair.applies(def)).toBe(true);
      if (kind === 'point_defence') expect(pd.applies(def)).toBe(true);
    }
    expect(repair.applies(undefined)).toBe(false);
    expect(pd.applies(undefined)).toBe(false);
  });
  it('refuses a duplicate role id, and an unknown role is an error', () => {
    const dup = { ...feature, id: 'dupRoles', weapon: [feature.weapon![0], feature.weapon![0]] };
    expect(() => compilePlan([dup])).toThrow(/listed twice/);
    expect(() => weaponRole(getPlan(), 'support', 'nope')).toThrow(/no weapon role/);
  });
  it('the bridge keeps no special case for either weapon kind', () => {
    const src = readFileSync(join(__dirname, '../../../../../server/src/ships/bridge/weapons.ts'), 'utf8');
    expect(src).not.toMatch(/\.heal\b|pointDefence|repairAt|stepPointDefenceAim/);
  });
});
