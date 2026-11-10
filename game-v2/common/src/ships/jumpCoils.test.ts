/**
 * Jump coils against the hull (Kieran, 2026-11-06: "More jump coils should extend range and offset range decrease based
 * on ship size; there should be diminishing returns after the proper cell-to-size ratio"; and "feeding jump coils does
 * nothing" on the ports core). flight.ts jumpDriveStats, rebuild.ts (the coils' capacity), power/ports.ts portsFed.
 */
import { describe, it, expect } from 'vitest';
import { parseBlueprint } from './blueprint.js';
import { rebuild } from './rebuild.js';
import { createShipState } from './state.js';
import { ShipTuning } from './tuning.js';
import { jumpDriveStats, jumpTuning, jumpChargeNeed } from './flight.js';
import { testCatalog, readShipJson, SHIP_DATA_DIR } from './testData.js';
import { portsFed } from './power/ports.js';
import type { Blueprint, Rot } from './types.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const catalog = testCatalog();
const tuning = readShipJson('tuning.json') as ShipTuning;
const jt = jumpTuning(tuning);
const load = (f: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, `blueprints/${f}.json`), 'utf-8'));
const derive = (b: Blueprint) => {
  const s = createShipState(catalog, tuning, 1, b, 0);
  return rebuild({ catalog, tuning, blueprint: b, hp: s.hp, maxHp: s.maxHp, detached: s.detached, rootMode: 'core' });
};

describe('jump coils against the hull', () => {
  it('under the proper ratio the range falls off, coils make it up to full range at 1x, and past it each coil adds less, with no cap', () => {
    const at = (r: number) => jumpDriveStats(100 * r, 100, 1, jt).range;
    expect(at(1)).toBe(jt.baseRange);
    // Under: less (a big hull short of coils), never under the floor; each coil added brings it back up
    expect(at(0.5)).toBeLessThan(at(0.75));
    expect(at(0.75)).toBeLessThan(at(1));
    expect(at(0.01)).toBe(Math.round(jt.baseRange * jt.underRangeFloor));
    // Over: still further for more coils, by less each time (diminishing returns), and no cap
    const over = [1, 2, 4, 8, 16, 32].map(at);
    for (let i = 1; i < over.length; i++) expect(over[i], `${2 ** i}x`).toBeGreaterThan(over[i - 1]);
    const gains = over.slice(1).map((r, i) => r - over[i]);
    for (let i = 1; i < gains.length; i++) expect(gains[i], `${2 ** (i + 1)}x`).toBeLessThan(gains[i - 1]);
    // (+18% at twice the need, about +29% at 4x, +39% at 8x: tuning.json jump._over)
    expect(at(2) / jt.baseRange).toBeCloseTo(1 + jt.overRange, 3);
    expect(at(4) / jt.baseRange).toBeCloseTo(1.292, 2);
    expect(at(8) / jt.baseRange).toBeCloseTo(1.388, 2);
    if (process.env.COIL_TABLE) console.log([0.5, 1, 2, 4].map((r) => `${r}x ${at(r)}`).join(' | '));
  });

  it('coils never change the charge: every jump charges the same 3 s', () => {
    for (const f of ['sparrow-t', 'sunspear', 'hauler', 'ark-tender']) {
      const d = derive(load(f));
      expect(jumpChargeNeed(d.jumpRange, jt), f).toBe(180);
    }
  });

  it('on the ports core a coil counts once power reaches it: fed, it extends the range; cut off, it does nothing', () => {
    const b = load('remakes/player-xire-sparrow');
    const coils = b.parts.map((p, i) => (/coil/.test(p.fn) ? i : -1)).filter((i) => i >= 0);
    expect(coils.length).toBeGreaterThan(0);
    const fed = derive(b);
    const f = portsFed(fed.ports!);
    for (const i of coils) expect(f[i], `coil ${i}`).toBe(1);
    // The same hull with its coils turned round, their in ports facing nothing: cut off
    const cut = load('remakes/player-xire-sparrow');
    for (const i of coils) cut.parts[i].rot = (((cut.parts[i].rot ?? 0) + 2) % 4) as Rot;
    const off = derive(cut);
    const f2 = portsFed(off.ports!);
    expect(coils.some((i) => !f2[i])).toBe(true);
    expect(off.jumpRatio).toBeLessThan(fed.jumpRatio);
    expect(off.jumpRange).toBeLessThan(fed.jumpRange);
    // ...and with no coils at all it is the cut-off one's drive (the unfed ones count for nothing)
    const none = load('remakes/player-xire-sparrow');
    const unfed = coils.filter((i) => !f2[i]);
    for (const i of unfed) none.parts[i].fn = 'hull';
    const bare = derive(none);
    expect(bare.jumpRatio).toBe(off.jumpRatio);
    if (process.env.COIL_TABLE) console.log('ports sparrow: fed', fed.jumpRatio, fed.jumpRange, '| cut off', off.jumpRatio, off.jumpRange);
  });
});
