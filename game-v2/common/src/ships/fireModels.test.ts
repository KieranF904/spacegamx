/**
 * The shared firing models (guns.ts stepGuns; docs/design/rework-2026-11.md §3): clip, reload on idle, regrow,
 * charge (auto-fire, cooldown, an early release), spin-up, and a beam's windup and brownout sputter, with the energy
 * each draws (energy.ts gunDraw).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState, type ShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { stepGuns, gunInterval, windupScale, CHARGE_DRAIN, CLIP_IDLE, packGunState, gunStateAt, applyGunState, gunStateValue, GUN_STATE_RELOADING } from './guns.js';
import { gunDraw, gunLoad, PILOT_ROW, CHARGE_GROUPS_AT, type Charge } from './energy.js';
import { PILOT_EXTRAS } from './features/plan.js';
import type { ShipTuning } from './tuning.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const UP = -Math.PI / 2;
const pose = { x: 0, y: 0, angle: UP };

/** A Sparrow with one gun of this model where its left Pip was (the right one plated over) */
function armed(model: string): ShipState {
  const b = parseBlueprint(sparrowText);
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = model;
  pips[1].fn = 'hull';
  delete pips[1].facing;
  const s = createShipState(catalog, tuning, 1, b, 0);
  expect(s.derived.weapons).toHaveLength(1);
  return s;
}

/** Step the guns `n` ticks (fire held by `held(t)`), from tick `from`; the ticks a shot left */
function run(s: ShipState, n: number, held: (t: number) => boolean, from = 1, energy?: { charge: Charge }) {
  const shots: number[] = [], starts: number[] = [], cancels: number[] = [], beams: number[] = [];
  for (let t = from; t < from + n; t++) {
    const r = stepGuns(s, pose, { firing: held(t), aimWorld: UP, aimDist: 0, energy }, t, tuning);
    if (r.shots.length) shots.push(t);
    if (r.beams.length) beams.push(t);
    for (const x of r.tells) (x.start ? starts : cancels).push(t);
  }
  return { shots, starts, cancels, beams };
}

describe('firing models', () => {
  it('every weapon model carries a fire block through WeaponInfo, and no gun keeps heat', () => {
    const s = armed('railgun_rail_driver');
    const w = s.derived.weapons[0];
    expect(w.fire).toMatchObject({ model: 'clip', clip: 6, reload: 90, reloadE: 48, interval: 10 });
    expect(s.rounds[w.part]).toBe(6);
    for (const k of ['heat', 'overheated']) expect(Object.keys(s)).not.toContain(k);
    for (const m of catalog.functions.values()) if (m.model && m.weapon) expect(m.fire?.model, m.id).toBeDefined();
  });

  it('clip: fires its rounds at its beat, then reloads for its reload and fires again', () => {
    const s = armed('railgun_rail_driver');
    const w = s.derived.weapons[0];
    const { shots } = run(s, 300, () => true);
    // Six shots ten ticks apart, the last one empties it; reloading 90 ticks from the next, then six more
    expect(shots.slice(0, 6)).toEqual([1, 11, 21, 31, 41, 51]);
    expect(shots[6]).toBe(51 + 1 + w.fire.reload!);
    expect(shots.slice(6, 12).map((t, i) => t - shots[6] - i * 10)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('clip: a partly spent clip reloads a second after the last shot, drawing its missing share of reloadE', () => {
    const s = armed('railgun_rail_driver');
    const w = s.derived.weapons[0];
    const { shots } = run(s, 15, (t) => t <= 15);
    expect(shots).toEqual([1, 11]);
    expect(s.rounds[w.part]).toBe(4);
    let drawn = 0, t = 16, startedAt = -1;
    for (; t < 400 && s.rounds[w.part] < 6; t++) {
      drawn += gunDraw(s, w, 0) / 60;
      stepGuns(s, pose, { firing: false, aimWorld: UP, aimDist: 0 }, t, tuning);
      if (startedAt < 0 && s.reload[w.part] > 0) startedAt = t;
    }
    // (The last shot at 11: idle for CLIP_IDLE ticks from there)
    expect(startedAt).toBe(11 + CLIP_IDLE);
    expect(s.rounds[w.part]).toBe(6);
    expect(drawn).toBeCloseTo(w.fire.reloadE! * 2 / 6, 6);
  });

  it('clip: short of power it reloads at its share; the energy is what a whole reload draws', () => {
    const s = armed('railgun_rail_driver');
    const w = s.derived.weapons[0];
    // (The sixth shot at 51 empties it; its reload starts on the next tick)
    run(s, 51, () => true);
    expect(s.rounds[w.part]).toBe(0);
    const L = s.derived.power!;
    const half: Charge = { g: 100, b: [], gun: L.feeds.map(() => 0.5), eng: L.feeds.map(() => 1) };
    let n = 0;
    while (s.reload[w.part] > 0 || s.rounds[w.part] === 0) { stepGuns(s, pose, { firing: false, aimWorld: UP, aimDist: 0, energy: { charge: half } }, 52 + n, tuning); n++; if (n > 1000) break; }
    expect(n).toBe(1 + 2 * w.fire.reload!);
  });

  it('regrow: a round back at a time, each drawing reloadE / clip', () => {
    const s = armed('legendary_hive');
    const w = s.derived.weapons[0];
    expect(w.fire).toMatchObject({ model: 'clip', clip: 8, regrow: 45, rounds: 4 });
    const { shots } = run(s, w.interval + 1, () => true);
    expect(shots).toHaveLength(2);
    expect(s.rounds[w.part]).toBeLessThan(4);
    const before = s.rounds[w.part];
    let drawn = 0;
    for (let t = 0; t < 45 * 3; t++) {
      drawn += gunDraw(s, w, 0) / 60;
      stepGuns(s, pose, { firing: false, aimWorld: UP, aimDist: 0 }, 500 + t, tuning);
    }
    expect(s.rounds[w.part]).toBe(before + 3);
    expect(drawn).toBeCloseTo((w.fire.reloadE! / 8) * 3, 6);
  });

  it('charge: held, it fires itself at full charge, then cools down before the next charge', () => {
    const s = armed('cannon_longbarrel');
    const w = s.derived.weapons[0];
    expect(w.fire).toMatchObject({ model: 'charge', charge: 120, cooldown: 90 });
    const { shots, starts, cancels } = run(s, 600, () => true);
    // (Its charge counts the tick it starts: full on its 120th. The cooldown's 90 ticks run from the shot's)
    expect(shots[0]).toBe(120);
    expect(shots[1]).toBe(120 + 90 + 119);
    expect(starts).toEqual([1, 120 + 90, 120 + 90 + 119 + 90]);
    expect(cancels).toEqual([]);
  });

  it('charge: let go early, nothing fires, the charge drains away over 15 ticks and the energy drawn is spent', () => {
    const s = armed('cannon_longbarrel');
    const w = s.derived.weapons[0];
    let drawn = 0;
    const shots: number[] = [], cancels: number[] = [];
    for (let t = 1; t <= 150; t++) {
      drawn += gunDraw(s, w, 0) / 60;
      const r = stepGuns(s, pose, { firing: t <= 114, aimWorld: UP, aimDist: 0 }, t, tuning);
      if (r.shots.length) shots.push(t);
      for (const x of r.tells) if (!x.start) cancels.push(t);
      if (t === 115) expect(s.charge[w.part]).toBeLessThan(0);
      if (t === 115 + CHARGE_DRAIN - 1) expect(s.charge[w.part]).toBeLessThan(0);
      if (t === 115 + CHARGE_DRAIN) expect(s.charge[w.part]).toBe(0);
    }
    expect(shots).toEqual([]);
    expect(cancels).toEqual([115]);
    // (Its charge's energy, spread over the charge: drawn from the tick after it started, through the tick it was let go)
    expect(drawn).toBeCloseTo((w.fire.chargeE! * 114) / 120, 6);
    // Held again: a fresh charge, a whole charge long
    const again = run(s, 200, () => true, 151);
    expect(again.starts[0]).toBe(151);
    expect(again.shots[0]).toBe(151 + 119);
  });

  it('spin: the beat quickens from spin.from to spin.to over spin.up ticks held, and slows over spin.down after', () => {
    const s = armed('autocannon_chainsaw');
    const w = s.derived.weapons[0];
    const sp = w.fire.spin!;
    expect(gunInterval(s, w)).toBeCloseTo((w.interval * sp.from) / w.fire.interval, 9);
    const { shots } = run(s, 240, () => true);
    expect(s.spin[w.part]).toBe(1);
    expect(gunInterval(s, w)).toBeCloseTo((w.interval * sp.to) / w.fire.interval, 9);
    const early = shots.filter((t) => t <= 60).length, late = shots.filter((t) => t > 180).length;
    expect(late).toBeGreaterThan(early * 2);
    run(s, sp.down, () => false, 241);
    expect(s.spin[w.part]).toBeCloseTo(0, 9);
  });

  it('autocannon and flak numbers: Chainsaw 4/s to 16/s, Stinger clip of 12, Cloudmaker splash r250 / 26', () => {
    const cs = armed('autocannon_chainsaw'), w = cs.derived.weapons[0];
    expect(60 / gunInterval(cs, w)).toBeCloseTo(4, 6);
    run(cs, 60, () => true);
    expect(60 / gunInterval(cs, w)).toBeCloseTo(16, 6);
    const st = armed('autocannon_stinger').derived.weapons[0];
    expect(st.fire).toMatchObject({ model: 'clip', clip: 12, reload: 72, reloadE: 20 });
    expect(st.interval).toBeCloseTo(7.5, 6);
    const cm = armed('flak_cloudmaker').derived.weapons[0];
    expect(cm.fire).toMatchObject({ model: 'clip', clip: 4, reload: 150, reloadE: 30 });
    expect(cm.ammo).toBeFalsy();
  });

  it('beam: no heat (lit as long as it is held), a windup ramps its damage in, and short of power it sputters evenly', () => {
    const s = armed('lance_lance');
    const w = s.derived.weapons[0];
    expect(w.fire).toMatchObject({ model: 'beam', windup: 18 });
    const scale: number[] = [];
    let lit = 0;
    for (let t = 1; t <= 900; t++) {
      if (stepGuns(s, pose, { firing: true, aimWorld: UP, aimDist: 0 }, t, tuning).beams.length) lit++;
      scale.push(windupScale(s, w));
    }
    expect(lit).toBe(900);
    expect(scale[0]).toBeCloseTo(1 / 18, 9);
    expect(scale[17]).toBe(1);
    // Let go, it winds up again from nothing
    run(s, 1, () => false, 901);
    expect(windupScale(s, w)).toBe(0);
    // Half the power it asks for: it burns half the ticks, evenly spread
    const L = s.derived.power!;
    const half: Charge = { g: 0, b: [], gun: L.feeds.map(() => 0.5), eng: L.feeds.map(() => 1) };
    const { beams } = run(s, 120, () => true, 1000, { charge: half });
    expect(beams.length).toBe(60);
    const gaps = new Set(beams.slice(1).map((t, i) => t - beams[i]));
    expect([...gaps]).toEqual([2]);
  });

  it('ammo: a beat with no energy drawn', () => {
    const s = armed('flak_burst');
    const w = s.derived.weapons[0];
    const { shots } = run(s, 100, () => true);
    expect(shots).toEqual([1, 1 + w.interval, 1 + 2 * w.interval]);
    expect(gunDraw(s, w, 100)).toBe(0);
    expect((gunLoad(s, 50) ?? []).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('the gun-state slot carries clip and charge guns after the part features, and round-trips', () => {
    const s = armed('railgun_rail_driver');
    const w = s.derived.weapons[0];
    run(s, 60, () => true);
    run(s, 5, () => false, 61);
    expect(s.reload[w.part]).toBeGreaterThan(0);
    const data: number[] = new Array(CHARGE_GROUPS_AT).fill(0);
    data[PILOT_ROW.groups] = 1;
    data.push(100);
    for (let i = 0; i < PILOT_EXTRAS; i++) data.push(0);
    expect(gunStateAt(data)).toBe(data.length);
    packGunState(s, data);
    const at = gunStateAt(data);
    expect(data.slice(at, at + 2)).toEqual([1, w.part]);
    // 0 rounds + the reloading flag + one flag step per eighth of the reload done
    expect(data[at + 2] % GUN_STATE_RELOADING).toBe(0);
    expect(data[at + 2]).toBeGreaterThanOrEqual(GUN_STATE_RELOADING);
    const fresh = armed('railgun_rail_driver');
    applyGunState(fresh, fresh.derived.weapons[0], data[at + 2]);
    expect(gunStateValue(fresh, fresh.derived.weapons[0])).toBe(data[at + 2]);
    expect(fresh.rounds[w.part]).toBe(0);
  });
});
