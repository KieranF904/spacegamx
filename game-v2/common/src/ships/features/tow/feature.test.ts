import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import { getPlan, featureFacts } from '../plan.js';
import { gunLoad } from '../../energy.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const TOW_PART = { uid: 70, piece: 'rect2', fn: 'utility_tow_beam', material: 'steel', x: -3, y: 0, rot: 0, flip: false, facing: 'W' };
const sparrow = (extra: object[] = []) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  bp.parts.push(...(extra as never[]));
  return createShipState(catalog, tuning, 1, bp, 0);
};

describe('the tow feature (registered)', () => {
  it('is in the plan, draws by the tick, and owns the pinned pilot-row and status slots', () => {
    const P = getPlan(), i = P.byId.get('tow')!;
    expect(i).toBeGreaterThanOrEqual(0);
    expect(P.burstMask & (1 << i)).not.toBe(0);
    expect(P.replicate.filter((r) => r.feature === 'tow').map((r) => `${r.where}:${r.slot}`).sort()).toEqual(['pilotExtra:2', 'status:8']);
  });

  it('a ship with a Tow Beam has fx.tow and the feature bit; one without has no feature fields', () => {
    const d = sparrow([TOW_PART]).derived;
    expect(d.fx?.tow?.parts.length).toBe(1);
    expect(d.fxMask).toBe(1 << getPlan().byId.get('tow')!);
    expect(d.tow).toBeUndefined();
    const plain = sparrow().derived;
    expect('fx' in plain || 'fxMask' in plain).toBe(false);
  });

  it('draws only while the server says it tows', () => {
    const ship = sparrow([TOW_PART]);
    const f = ship.derived.power!.feedOf[ship.derived.fx!.tow!.parts[0]];
    expect(gunLoad(ship, 0)![f]).toBe(0);
    expect(gunLoad({ ...ship, tow: 5 }, 0)![f]).toBeGreaterThan(0);
  });

  it('says what it tows, for the tooltip, the compact tooltip and the card', () => {
    const [fact, ...rest] = featureFacts({ catalog, tuning, fn: catalog.functions.get('utility_tow_beam')! });
    expect(rest).toEqual([]);
    expect(fact).toMatchObject({ label: 'Tows', tier: 'stat', chip: 'tows within 420 m', drawWhen: 'towing', short: 'wrecks, debris and pods within 420 m' });
    expect(fact.sentence).toBe('wrecks, debris and pods within 420 m of your hull · snaps past 900 m · into a station to salvage');
    expect(featureFacts({ catalog, tuning, fn: catalog.functions.get('scanner')! })).toEqual([]);
  });
});
