import { describe, it, expect, afterEach } from 'vitest';
import { compilePlan, setPlanForTests, describePart, describeFn, type PartFeature, type Fact } from '@space-game/common';
import { readShipJson, testCatalog } from '../../../../common/src/ships/testData';
import type { ShipTuning } from '@space-game/common';
import { tipRows, chips, summaryFields, buildFactIndex, guideNumber, factValue } from './index';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const towFacts = (): Fact[] => [
  { feature: 'probe', key: 'range', label: 'Tows', value: 600, unit: 'm', tier: 'headline', sentence: 'within 600 m' },
  { feature: 'probe', key: 'draw', label: 'Draw', value: 40, unit: 'power', tier: 'stat', sentence: 'draws 40 towing' },
  { feature: 'probe', key: 'cold', label: 'Warning', value: 'never a working ship', tier: 'warning' },
  { feature: 'probe', key: 'note', label: 'Note', value: 2.5, unit: 'x', tier: 'detail' },
];
const probe: PartFeature = { id: 'probe', order: 0, applies: (fn) => !!fn.tow, describe: () => towFacts() };

afterEach(() => setPlanForTests(null));

describe('describePart and the renderers', () => {
  it('with no feature registered, a part has only its base stats and no facts', () => {
    const d = describePart(catalog, tuning, { fn: 'utility_tow_beam', material: 'steel', piece: 'rect2' })!;
    expect(d.base.tow).toBeDefined();
    expect(d.facts).toEqual([]);
    expect(describeFn(catalog, tuning, 'utility_tow_beam')).toEqual([]);
  });

  it('a feature\'s facts reach only the functions it applies to', () => {
    setPlanForTests(compilePlan([probe]));
    expect(describePart(catalog, tuning, { fn: 'utility_tow_beam', material: 'steel', piece: 'rect2' })!.facts).toHaveLength(4);
    expect(describePart(catalog, tuning, { fn: 'scanner', material: 'steel', piece: 'rect2' })!.facts).toEqual([]);
  });

  it('renders rows, chips, summary fields and guide numbers from the facts', () => {
    const f = towFacts();
    expect(tipRows(f)).toEqual([
      { label: 'Tows', text: 'within 600 m', warn: false },
      { label: 'Draw', text: 'draws 40 towing', warn: false },
      { label: 'Warning', text: 'never a working ship', warn: true },
      { label: 'Note', text: '×2.5', warn: false },
    ]);
    expect(tipRows(f, true)).toHaveLength(3);
    expect(chips(f)).toEqual(['within 600 m', 'draws 40 towing']);
    expect(summaryFields(f)).toEqual([{ key: 'probe.range', label: 'Tows', text: '600 m' }]);
    setPlanForTests(compilePlan([probe]));
    const idx = buildFactIndex(catalog, tuning);
    expect(guideNumber(idx, 'probe', 'range')).toBe('600 m');
    expect(guideNumber(idx, 'probe', 'nope', '?')).toBe('?');
    expect(factValue({ ...f[0], unit: '%', value: 0.25 })).toBe('25%');
  });
});
