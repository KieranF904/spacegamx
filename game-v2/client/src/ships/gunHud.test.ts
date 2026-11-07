import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, FULL_CHARGE, type ShipState } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../common/src/ships/testData';
import { RingModel, type RingSources } from './gunHud';
import { GunFeel } from './gunFeel';

const catalog = testCatalog();
const tuning = readShipJson('tuning.json');

function shipWith(fn: string): ShipState {
  const b = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
  for (const q of b.parts) if (q.fn === 'cannon_pip') q.fn = fn;
  return createShipState(catalog, tuning, 1, b, 0);
}

const src: RingSources = { charge: FULL_CHARGE, ammoOf: () => null };

describe('weapon ring model', () => {
  it('reads a clip gun\'s rounds and reload', () => {
    const ship = shipWith('railgun_rail_driver');
    const m = new RingModel();
    const g = m.update(ship, src);
    expect(g).toHaveLength(1);
    expect(g[0].model).toBe('clip');
    expect(g[0].clip).toBe(4);
    expect(g[0].rounds).toBe(4);
    expect(g[0].reloading).toBe(false);
    for (const w of ship.derived.weapons) { ship.rounds[w.part] = 2; ship.reload[w.part] = 40; }
    const again = m.update(ship, src);
    expect(again[0]).toBe(g[0]);
    expect(again[0].rounds).toBe(2);
    expect(again[0].reloading).toBe(true);
  });

  it('reads a charge gun\'s charge as a fraction, and flashes at full', () => {
    const ship = shipWith('cannon_longbarrel');
    const m = new RingModel();
    for (const w of ship.derived.weapons) ship.charge[w.part] = 60;
    expect(m.update(ship, src)[0].charge).toBeCloseTo(0.5);
    for (const w of ship.derived.weapons) ship.charge[w.part] = 120;
    const g = m.update(ship, src)[0];
    expect(g.charge).toBe(1);
    expect(g.flash).toBe(1);
  });

  it('is empty without a ship', () => {
    expect(new RingModel().update(null, src)).toHaveLength(0);
  });
});

describe('gun sounds', () => {
  it('vents on the last round of another ship\'s clip, counted by fire events', () => {
    const played: string[] = [];
    const feel = new GunFeel((id) => { played.push(id); return null; });
    const ship = shipWith('railgun_rail_driver');
    const w = ship.derived.weapons[0];
    for (let i = 0; i < 3; i++) feel.otherRound(7, w, 100 + i * 12, { x: 0, y: 0 });
    expect(played).toEqual([]);
    feel.otherRound(7, w, 136, { x: 0, y: 0 });
    expect(played).toEqual(['gun_vent']);
  });

  it('starts a clip count over after an idle gap', () => {
    const played: string[] = [];
    const feel = new GunFeel((id) => { played.push(id); return null; });
    const w = shipWith('railgun_rail_driver').derived.weapons[0];
    for (let i = 0; i < 2; i++) feel.otherRound(7, w, 100 + i * 12, { x: 0, y: 0 });
    // (It reloaded the partial clip while out of sight: 4 more rounds are a whole clip)
    for (let i = 0; i < 3; i++) feel.otherRound(7, w, 400 + i * 12, { x: 0, y: 0 });
    expect(played).toEqual([]);
    feel.otherRound(7, w, 436, { x: 0, y: 0 });
    expect(played).toEqual(['gun_vent']);
  });
});
