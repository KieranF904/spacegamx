/**
 * The hover card's pure parts: the one sentence is never empty and never over 15 words, the three numbers follow the part's kind,
 * the card is placed inside the viewport, and the Burst's stale summary now comes from its data.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/proto/createProtoServer';
import { tradeOff } from '../modelCards';
import { cardKind, cardNumbers, partSummary, placeCard, SUMMARY_WORDS } from './partCard';

const { catalog, tuning } = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const fn = (id: string) => catalog.functions.get(id)!;
const labels = (id: string) => cardNumbers(catalog, tuning, fn(id)).map((n) => n.label);
const all = [...catalog.functions.values()];

describe('part card', () => {
  it('every part has a sentence: not empty, at most 15 words', () => {
    for (const f of all) {
      const s = partSummary(f);
      expect(s.trim().length, f.id).toBeGreaterThan(0);
      // (a cut-down description ends in an ellipsis: that counts as one of the words' last)
      expect(s.split(/\s+/).length, `${f.id}: ${s}`).toBeLessThanOrEqual(SUMMARY_WORDS);
    }
  });

  it('a part with no text falls back to its name', () => {
    expect(partSummary({ id: 'x', name: 'Thing', pieces: ['sq'] } as never)).toBe('Thing');
    expect(partSummary({ id: 'y', pieces: ['sq'] } as never)).toBe('y');
  });

  it('three numbers, picked by kind', () => {
    expect(labels('cannon_pip')).toEqual(['Damage', 'Rate', 'Reach']);
    expect(labels('railgun_rail_driver')).toEqual(['Damage', 'Clip', 'Reach']);
    expect(labels('engine_plasma_drive')).toEqual(['Thrust', 'Power', 'Boost']);
    expect(labels('power_cell_reactor')).toEqual(['Output', 'Hull', 'Mass']);
    expect(labels('shield_visor')).toEqual(['Shield', 'Refills', 'Covers']);
    expect(labels('power_battery')).toEqual(['Holds', 'Hull', 'Mass']);
    expect(labels('utility_repair_beam')[0]).toBe('Mends');
    for (const f of all) expect(cardNumbers(catalog, tuning, f).length, f.id).toBeLessThanOrEqual(3);
  });

  it('structure shows hull and mass', () => {
    const plate = all.find((f) => !f.model && !f.weapon && cardKind(f, { supply: 0, thrust: 0, shield: 0, cargo: 0 }) === 'structure');
    expect(plate).toBeTruthy();
    expect(cardNumbers(catalog, tuning, plate!).map((n) => n.label).slice(0, 2)).toEqual(['Hull', 'Mass']);
  });

  it('the Burst says what it does now: at the aim distance, or sooner near a target', () => {
    const t = tradeOff(fn('flak_burst'));
    expect(t).toMatch(/aim distance/);
    expect(t).not.toMatch(/near what it passes/);
  });

  it('places the card beside the list, inside the viewport, off the ship centre', () => {
    const vw = 1600, vh = 900;
    // a list on the left: the card goes right of it
    const a = placeCard({ left: 0, right: 340 }, { top: 20, height: 40 }, 316, 300, vw, vh);
    expect(a.x).toBe(350);
    expect(a.y).toBeGreaterThanOrEqual(8);
    // a list on the right edge: the card goes left of it
    const b = placeCard({ left: 1300, right: 1600 }, { top: 800, height: 40 }, 316, 300, vw, vh);
    expect(b.x).toBe(1300 - 316 - 10);
    expect(b.y + 300).toBeLessThanOrEqual(vh - 8);
    // a card that would sit on the centre moves above or below it
    const c = placeCard({ left: 1300, right: 1600 }, { top: 440, height: 20 }, 600, 300, vw, vh);
    const hits = c.x < vw / 2 + 70 && c.x + 600 > vw / 2 - 70 && c.y < vh / 2 + 70 && c.y + 300 > vh / 2 - 70;
    expect(hits).toBe(false);
    expect(c.y).toBeGreaterThanOrEqual(8);
    expect(c.y + 300).toBeLessThanOrEqual(vh - 8);
  });
});
