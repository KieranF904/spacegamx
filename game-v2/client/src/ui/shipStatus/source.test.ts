/**
 * The ship status source (source.ts): the derived numbers the panel shows, against the ship's own derived data.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, fullPortsCharge, parseBlueprint, type Charge, type ShipState } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { RingModel } from '../../ships/gunHud';
import { readStatus, newMemory, type StatusInput } from './source';

const catalog = testCatalog();
const tuning = readShipJson('tuning.json');
const load = (path: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', path), 'utf-8'));

/** The Sunspear: engines, shields, a beam, cycle guns and point defence */
function ship(): ShipState {
  return createShipState(catalog, tuning, 1, load('sunspear.json'), 0);
}

/** A Sparrow T with a clip gun for its cannons */
function clipShip(): ShipState {
  const b = load('sparrow-t.json');
  for (const q of b.parts) if (q.fn === 'cannon_pip') q.fn = 'railgun_rail_driver';
  return createShipState(catalog, tuning, 1, b, 0);
}

const full = (s: ShipState): Charge => fullPortsCharge(s.derived);

function input(s: ShipState, charge: Charge, over: Partial<StatusInput> = {}): StatusInput {
  return {
    ship: s, charge, shieldPct: 100, thrust: { on: false, boost: false }, tick: 0, tuning,
    groups: new RingModel().update(s, { charge, ammoOf: () => null }), features: [],
    nameOf: (fn) => catalog.functions.get(fn)?.name ?? fn, now: 0, ...over,
  };
}

describe('ship status source', () => {
  it('reads generation, steady loads and the gauge from the derived energy', () => {
    const s = ship(), d = s.derived;
    const st = readStatus(input(s, full(s)), newMemory());
    expect(st.energy.gen).toBeCloseTo(d.energy.supply);
    expect(st.energy.steady).toBeCloseTo(Math.min(d.energy.supply, d.energy.demand));
    // Idle: the draw is the steady loads
    expect(st.energy.draw).toBeCloseTo(st.energy.steady);
    // Every part full: the ports gauge
    expect(st.energy.pct).toBeCloseTo(100);
    expect(st.energy.brownout).toBe(false);
  });

  it('counts the hull: parts lost and integrity', () => {
    const s = ship();
    let st = readStatus(input(s, full(s)), newMemory());
    expect(st.hull).toMatchObject({ parts: s.blueprint.parts.length, intact: s.blueprint.parts.length, lost: 0 });
    expect(st.hull.integrity).toBeCloseTo(1);
    s.detached[4] = true;
    s.hp[1] = s.maxHp[1] / 2;
    st = readStatus(input(s, full(s)), newMemory());
    expect(st.hull.lost).toBe(1);
    const max = s.maxHp.reduce((a, b) => a + b, 0);
    expect(st.hull.integrity).toBeCloseTo((max - s.maxHp[4] - s.maxHp[1] / 2) / max);
  });

  it('holds the shield waiting after a hit, then regenerating', () => {
    const s = ship(), d = s.derived, mem = newMemory();
    expect(d.shieldMax).toBeGreaterThan(0);
    expect(readStatus(input(s, full(s), { shieldPct: 100, now: 0 }), mem).shield.state).toBe('full');
    const hit = readStatus(input(s, full(s), { shieldPct: 60, now: 100 }), mem).shield;
    expect(hit.cur).toBeCloseTo(d.shieldMax * 0.6);
    if (d.shieldDelay > 0) {
      expect(hit.state).toBe('wait');
      expect(hit.wait).toBeCloseTo(d.shieldDelay / 60);
    }
    const later = readStatus(input(s, full(s), { shieldPct: 62, now: 100 + (d.shieldDelay / 60) * 1000 + 50 }), mem).shield;
    expect(later.state).toBe('regen');
  });

  it('reads a clip gun empty and reloading', () => {
    const s = clipShip();
    for (const w of s.derived.weapons) { s.rounds[w.part] = 0; s.reload[w.part] = 30; }
    const st = readStatus(input(s, full(s)), newMemory());
    expect(st.weapons).toHaveLength(1);
    expect(st.weapons[0]).toMatchObject({ state: 'RELOAD', clip: 4, rounds: 0, count: s.derived.weapons.length });
  });

  it('reads beams lit or resting, and cycle guns cycling', () => {
    const s = ship();
    let st = readStatus(input(s, full(s)), newMemory());
    const beam = st.weapons.find((w) => w.model === 'beam')!, cyc = st.weapons.find((w) => w.model === 'cycle')!;
    expect(beam.state).toBe('RESTING');
    expect(cyc.state).toBe('READY');
    for (const w of s.derived.weapons) s.cooldown[w.part] = Math.max(1, Math.floor(w.interval / 2));
    st = readStatus(input(s, full(s)), newMemory());
    expect(st.weapons.find((w) => w.model === 'beam')!.state).toBe('LIT');
    expect(st.weapons.find((w) => w.model === 'cycle')!.state).toBe('CYCLING');
  });

  it('reads each part for the schematic: gun reload, engine glow', () => {
    const s = clipShip();
    for (const w of s.derived.weapons) { s.rounds[w.part] = 2; }
    const st = readStatus(input(s, full(s), { thrust: { on: true, boost: true } }), newMemory());
    expect(st.parts).toHaveLength(s.blueprint.parts.length);
    for (const w of s.derived.weapons) expect(st.parts[w.part]).toMatchObject({ kind: 'weapon', fill: 0.5, clip: 4 });
    const eng = s.derived.thrusters.find((t) => t.force[0] || t.force[1])!;
    expect(st.parts[eng.part]).toMatchObject({ kind: 'engine', glow: 1 });
  });

  it('is empty without a ship', () => {
    const s = ship();
    expect(readStatus({ ...input(s, full(s)), ship: null }, newMemory()).has).toBe(false);
  });
});
