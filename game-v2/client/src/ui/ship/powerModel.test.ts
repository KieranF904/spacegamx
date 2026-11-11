/**
 * The Power tab and the HUD's power margin from a ports ship: the sparrow's generators, its stores, a part moved off its
 * line starved, and the margin going negative as the keys ask more than the generators make.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, type Blueprint } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { powerMargin, powerSummary } from './powerModel';

const cfg = loadShipConfigCached(join(__dirname, '../../../../data'));
const { catalog, tuning } = createShipBridge(cfg);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const shipOf = (bp: Blueprint) => createShipState(catalog, tuning, 0, bp, 0);
const name = (bp: Blueprint) => (i: number) => catalog.functions.get(bp.parts[i].fn)?.name ?? bp.parts[i].fn;

describe('powerSummary', () => {
  it("the sparrow: two reactors making 70/s between them, nothing starved, firing doesn't brown out what it can't", () => {
    const bp = cfg.library!['sparrow-t'];
    const d = shipOf(bp).derived;
    const p = powerSummary(d, {}, name(bp));
    expect(p.supply).toBe(70);
    expect(p.gens).toHaveLength(2);
    for (const g of p.gens) {
      expect(g.output).toBeGreaterThan(0);
      expect(g.draw).toBeGreaterThanOrEqual(0);
      expect(g.load).toBeGreaterThanOrEqual(0);
      expect(g.load).toBeLessThanOrEqual(1);
    }
    expect(p.starved.filter((s) => s.why === 'unfed')).toEqual([]);
    // (No state yet: the stores read full)
    expect(p.gauge).toBe(100);
    expect(p.fire).not.toBeNull();
    expect(p.fireBrownout).toBe(p.fire!.tone !== 'ok');
  });

  it('a gun moved off the core is starved: no line in', () => {
    const bp = clone(cfg.library!['sparrow-t']);
    const pip = bp.parts.findIndex((q: { fn: string; x: number }) => q.fn === 'cannon_pip' && q.x === 0);
    bp.parts[pip].x = -1;
    const p = powerSummary(shipOf(bp).derived, {}, name(bp));
    expect(p.starved).toContainEqual(expect.objectContaining({ part: pip, why: 'unfed', share: 0 }));
  });
});

describe('powerMargin', () => {
  it('is supply less the steady loads at rest, and goes down as the keys ask the engines and guns for more', () => {
    const bp = cfg.library!['sparrow-t'];
    const d = shipOf(bp).derived;
    const rest = powerMargin(d, {}, { thrust: false, boost: false, firing: false });
    expect(rest.margin).toBeCloseTo(d.ports.supply - d.ports.shieldDraw, 5);
    expect(rest.starved).toBe(false);
    const cruise = powerMargin(d, {}, { thrust: true, boost: false, firing: false });
    const boost = powerMargin(d, {}, { thrust: true, boost: true, firing: false });
    const all = powerMargin(d, {}, { thrust: true, boost: true, firing: true });
    expect(cruise.margin).toBeLessThan(rest.margin);
    expect(boost.margin).toBeLessThanOrEqual(cruise.margin);
    expect(all.margin).toBeLessThan(boost.margin);
    expect(all.margin).toBeCloseTo(boost.margin - d.ports.weaponDraw, 5);
    // (Full stores: a deficit is paid from them, not starved yet)
    expect(all.gauge).toBe(100);
    if (all.margin < 0) expect(all.starved).toBe(false);
  });
});
