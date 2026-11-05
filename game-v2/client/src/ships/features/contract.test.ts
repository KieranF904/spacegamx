/**
 * The client half of the part contract (common/src/ships/features/contract.ts): every fact a feature describes for a part
 * it applies to renders, as a non-empty text, in the full tooltip, the compact tooltip, the card chips (headline and stat)
 * and the ship summary (headline), with no "undefined" or "NaN" in it.
 */
import { describe, it, expect } from 'vitest';
import { FEATURES, featureFacts } from '@space-game/common';
import { readShipJson, testCatalog } from '../../../../common/src/ships/testData';
import type { ShipTuning } from '@space-game/common';
import { tipRows, chips, summaryFields, factValue } from '../describe/index';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const clean = (s: string) => s.trim().length > 0 && !/undefined|NaN|\[object/.test(s);

for (const feature of FEATURES) {
  describe(`part contract (client): ${feature.id}`, () => {
    it('every fact renders in the tooltip, compact tooltip, card chips and summary', () => {
      for (const fn of [...catalog.functions.values()].filter((f) => feature.applies(f))) {
        const facts = featureFacts({ catalog, tuning, fn }).filter((f) => f.feature === feature.id);
        for (const f of facts) expect(clean(factValue(f)), `${fn.id} ${f.key}`).toBe(true);
        const full = tipRows(facts), compact = tipRows(facts, true);
        expect(full.length).toBe(facts.length);
        expect(compact.length).toBe(facts.filter((f) => f.tier !== 'detail').length);
        for (const r of [...full, ...compact]) expect(clean(r.label) && clean(r.text), `${fn.id} row ${r.label}`).toBe(true);
        const shown = facts.filter((f) => f.tier === 'headline' || f.tier === 'stat');
        const cs = chips(facts);
        expect(cs.length).toBe(shown.length);
        for (const c of cs) expect(clean(c), `${fn.id} chip`).toBe(true);
        const heads = facts.filter((f) => f.tier === 'headline');
        const sum = summaryFields(facts);
        expect(sum.length).toBe(new Set(heads.map((f) => f.key)).size);
        for (const s of sum) expect(clean(s.text) && clean(s.label), `${fn.id} summary ${s.key}`).toBe(true);
      }
    });
  });
}
