/**
 * The ship status source (source.ts): the derived numbers the panel shows, against the ship's own derived data.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createShipState, parseBlueprint, energyTuning, BROWNOUT, type Charge, type ShipState } from '@space-game/common';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../../../common/src/ships/testData';
import { RingModel } from '../../ships/gunHud';
import { readStatus, newMemory, type StatusInput } from './source';

const catalog = testCatalog();
const tuning = readShipJson('tuning.json');
const load = (path: string) => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints', path), 'utf-8'));

/** Review: Heron: engines, a shield, two Capacitor banks, a beam and cycle guns */
function ship(): ShipState {
  return createShipState(catalog, tuning, 1, load('dev/review-heron.json'), 0);
}

/** A Sparrow with a clip gun for its cannons */
function clipShip(): ShipState {
  const b = load('sparrow-t.json');
  for (const q of b.parts) if (q.fn === 'cannon_pip') q.fn = 'railgun_rail_driver';
  return createShipState(catalog, tuning, 1, b, 0);
}

function input(s: ShipState, charge: Charge, over: Partial<StatusInput> = {}): StatusInput {
  return {
    ship: s, charge, shieldPct: 100, thrust: { on: false, boost: false }, tick: 0, tuning,
    groups: new RingModel().update(s, { charge, ammoOf: () => null }), features: [],
    nameOf: (fn) => catalog.functions.get(fn)?.name ?? fn, now: 0, ...over,
  };
}

describe('ship status source', () => {
  it('reads generation, steady loads and stores from the derived energy', () => {
    const s = ship(), d = s.derived, L = d.power!;
    expect(L.banks.some((b) => b.kind === 'cap')).toBe(true);
    const st = readStatus(input(s, { g: 50, b: [] }), newMemory());
    const dyn = L.banks.reduce((n, b) => n + b.dynamo, 0);
    expect(st.energy.gen).toBeCloseTo(d.energy.supply + dyn);
    expect(st.energy.steady).toBeCloseTo(Math.max(0, d.energy.supply - L.spare));
    // Idle (full clip, nothing thrusting): the draw is the steady loads
    expect(st.energy.draw).toBeCloseTo(st.energy.steady);
    // The pool at half, the bank full: held and the total %
    const cap = L.pool.cap + L.banks.reduce((n, b) => n + b.cap, 0);
    const held = L.pool.cap / 2 + L.banks.reduce((n, b) => n + b.cap, 0);
    expect(st.energy.cap).toBeCloseTo(cap);
    expect(st.energy.held).toBeCloseTo(held);
    expect(st.energy.pct).toBeCloseTo((held / cap) * 100);
    expect(st.energy.stores[0]).toMatchObject({ kind: 'pool', pct: 50 });
    expect(st.energy.stores.some((x) => x.kind === 'cap' && x.pct === 100)).toBe(true);
    expect(st.energy.brownout).toBe(false);
  });

  it('adds the engines while thrusting, more while boosting', () => {
    const s = ship(), L = s.derived.power!;
    const idle = readStatus(input(s, { g: 100, b: [] }), newMemory()).energy.draw;
    const thrust = readStatus(input(s, { g: 100, b: [] }, { thrust: { on: true, boost: false } }), newMemory()).energy.draw;
    const boost = readStatus(input(s, { g: 100, b: [] }, { thrust: { on: true, boost: true } }), newMemory()).energy.draw;
    const engines = s.derived.thrusters.filter((t) => t.force[0] || t.force[1]).reduce((n, t) => n + L.draw[t.part], 0);
    expect(engines).toBeGreaterThan(0);
    expect(thrust - idle).toBeCloseTo(engines);
    const bd = energyTuning(tuning).boostDraw;
    const boosted = s.derived.thrusters.filter((t) => t.force[0] || t.force[1]).reduce((n, t) => n + L.draw[t.part] * (1 + bd * L.boostDrain[t.part]), 0);
    expect(boost - idle).toBeCloseTo(boosted);
  });

  it('measures the net rate from the stores, and warns of a brownout from the feed shares', () => {
    const s = ship(), L = s.derived.power!, mem = newMemory();
    readStatus(input(s, { g: 100, b: [] }, { now: 0 }), mem);
    // Over a second the pool loses 40%: the smoothed net is negative, and points at the store running dry
    let st = readStatus(input(s, { g: 60, b: [] }, { now: 1000 }), mem);
    expect(st.energy.net).toBeCloseTo((-0.4 * L.pool.cap));
    expect(st.energy.empty).toBeGreaterThan(0);
    expect(Number.isFinite(st.energy.empty)).toBe(true);
    // The guns' feed got less than it asked
    const shares = L.feeds.map(() => 1), gun = L.feeds.map(() => BROWNOUT - 0.2);
    st = readStatus(input(s, { g: 60, b: [], eng: shares, gun }, { now: 1100 }), mem);
    expect(st.energy.brownout).toBe(true);
    expect(st.energy.short).toBe('guns');
    // Held a moment after the last short tick (an empty-store boost is short every other tick), with the engines' joining it
    const eng = L.feeds.map(() => BROWNOUT - 0.2);
    st = readStatus(input(s, { g: 60, b: [], eng, gun: shares }, { now: 1200 }), mem);
    expect(st.energy.short).toBe('engines+guns');
    st = readStatus(input(s, { g: 60, b: [], eng: shares, gun: shares }, { now: 1400 }), mem);
    expect(st.energy.brownout).toBe(true);
    st = readStatus(input(s, { g: 60, b: [], eng: shares, gun: shares }, { now: 1800 }), mem);
    expect(st.energy.brownout).toBe(false);
    expect(st.energy.short).toBe('');
  });

  it('says how long until the stores are full while they fill', () => {
    const s = ship(), L = s.derived.power!, mem = newMemory();
    readStatus(input(s, { g: 40, b: [] }, { now: 0 }), mem);
    const st = readStatus(input(s, { g: 60, b: [] }, { now: 1000 }), mem);
    expect(st.energy.net).toBeCloseTo(0.2 * L.pool.cap);
    expect(st.energy.full).toBeCloseTo((0.4 * L.pool.cap) / st.energy.net);
    expect(st.energy.empty).toBe(Infinity);
  });

  it('counts the hull: parts lost and integrity', () => {
    const s = ship();
    let st = readStatus(input(s, { g: 100, b: [] }), newMemory());
    expect(st.hull).toMatchObject({ parts: s.blueprint.parts.length, intact: s.blueprint.parts.length, lost: 0 });
    expect(st.hull.integrity).toBeCloseTo(1);
    s.detached[4] = true;
    s.hp[1] = s.maxHp[1] / 2;
    st = readStatus(input(s, { g: 100, b: [] }), newMemory());
    expect(st.hull.lost).toBe(1);
    const max = s.maxHp.reduce((a, b) => a + b, 0);
    expect(st.hull.integrity).toBeCloseTo((max - s.maxHp[4] - s.maxHp[1] / 2) / max);
  });

  it('holds the shield waiting after a hit, then regenerating', () => {
    const s = ship(), d = s.derived, mem = newMemory();
    expect(d.shieldMax).toBeGreaterThan(0);
    expect(readStatus(input(s, { g: 100, b: [] }, { shieldPct: 100, now: 0 }), mem).shield.state).toBe('full');
    const hit = readStatus(input(s, { g: 100, b: [] }, { shieldPct: 60, now: 100 }), mem).shield;
    expect(hit.cur).toBeCloseTo(d.shieldMax * 0.6);
    if (d.shieldDelay > 0) {
      expect(hit.state).toBe('wait');
      expect(hit.wait).toBeCloseTo(d.shieldDelay / 60);
    }
    const later = readStatus(input(s, { g: 100, b: [] }, { shieldPct: 62, now: 100 + (d.shieldDelay / 60) * 1000 + 50 }), mem).shield;
    expect(later.state).toBe('regen');
  });

  it('reads a clip gun empty and reloading', () => {
    const s = clipShip();
    for (const w of s.derived.weapons) { s.rounds[w.part] = 0; s.reload[w.part] = 30; }
    const st = readStatus(input(s, { g: 100, b: [] }), newMemory());
    expect(st.weapons).toHaveLength(1);
    expect(st.weapons[0]).toMatchObject({ state: 'RELOAD', clip: 6, rounds: 0, count: s.derived.weapons.length });
    // Reloading draws: the draw is over the steady loads
    expect(st.energy.draw).toBeGreaterThan(st.energy.steady);
  });

  it('reads beams lit or resting, cycle guns cycling, and boost by stored charge', () => {
    const s = ship();
    let st = readStatus(input(s, { g: 100, b: [] }), newMemory());
    const beam = st.weapons.find((w) => w.model === 'beam')!, cyc = st.weapons.find((w) => w.model === 'cycle')!;
    expect(beam.state).toBe('RESTING');
    expect(cyc).toMatchObject({ state: 'READY', count: 2 });
    for (const w of s.derived.weapons) s.cooldown[w.part] = Math.max(1, Math.floor(w.interval / 2));
    st = readStatus(input(s, { g: 100, b: [] }), newMemory());
    expect(st.weapons.find((w) => w.model === 'beam')!.state).toBe('LIT');
    expect(st.weapons.find((w) => w.model === 'cycle')!.state).toBe('CYCLING');
    expect(st.thrust.boost).toBe('ready');
    expect(st.thrust.engines).toBeGreaterThan(0);
    const empty = readStatus(input(s, { g: 0, b: s.derived.power!.banks.map(() => 0) }), newMemory());
    expect(empty.thrust.boost).toBe('empty');
  });

  it('reads each part for the schematic: store levels, gun reload, engine glow, brownout', () => {
    const s = clipShip();
    const L = s.derived.power!;
    for (const w of s.derived.weapons) { s.rounds[w.part] = 3; }
    let st = readStatus(input(s, { g: 40, b: L.banks.map(() => 70) }, { thrust: { on: true, boost: true } }), newMemory());
    expect(st.parts).toHaveLength(s.blueprint.parts.length);
    const core = s.blueprint.parts.findIndex((p) => p.fn === 'core');
    expect(st.parts[core]).toMatchObject({ kind: 'store', fill: 0.4 });
    for (const w of s.derived.weapons) expect(st.parts[w.part]).toMatchObject({ kind: 'weapon', fill: 0.5, clip: 6 });
    const eng = s.derived.thrusters.find((t) => t.force[0] || t.force[1])!;
    expect(st.parts[eng.part]).toMatchObject({ kind: 'engine', glow: 1 });
    st = readStatus(input(s, { g: 40, b: [], gun: L.feeds.map(() => 0.1) }), newMemory());
    expect(st.parts[s.derived.weapons[0].part].brown).toBe(true);
  });

  it('is empty without a ship', () => {
    const s = ship();
    expect(readStatus({ ...input(s, { g: 100, b: [] }), ship: null }, newMemory()).has).toBe(false);
  });
});
