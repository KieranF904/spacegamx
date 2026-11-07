/**
 * A weapon-group selection change mid-burst agrees on every end that steps a ship's guns: the server's pilot step
 * (gunControls + gunsTick on its ShipState), the pilot's own prediction (stepShipGuns on the input's selection) and
 * another client's lane for that pilot (lanePilot on the gun row's trigger word). The selection rides input state at a
 * tick like a held key, so the three see it on the same tick and fire the same shells.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../ships/blueprint.js';
import { createShipState, type ShipState } from '../ships/state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../ships/testData.js';
import type { ShipTuning } from '../ships/tuning.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { NO_FIELDS } from '../ships/jumpFields.js';
import { packGroupSel, trigWord, TRIG_LEFT, TRIG_RIGHT } from '../ships/weaponGroups.js';
import { newSimShip, simAim, simAimQ, NO_INPUT, stepShipGuns, gunsTick, gunControls, seedOwnExtras, lanePilot, laneOf, ownStructure, packGunSync, unpackGunSync, type SimEnv, type SimEvent, type SimInput } from './index.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const UP = -Math.PI / 2;
const envAt = (t: number): SimEnv => ({ tick: t, tuning, gravity: null, fields: NO_FIELDS, terrain: null });

/** A Sparrow: the first Pip in group 2, the second in groups 1 and 3 */
function rig(): ShipState {
  const bp = parseBlueprint(sparrowText);
  const pips = bp.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].wg = 2;
  pips[1].wg = 0b0101;
  return createShipState(catalog, tuning, 7, bp, 0);
}

/** The pilot's script: buttons held in bursts, the selection changing mid-burst (and the right button on a group for a while) */
const script = (t: number) => ({
  left: t % 90 < 70,
  right: t >= 150 && t < 190,
  sel: t < 60 ? packGroupSel(1, 0) : t < 110 ? packGroupSel(2, 0) : t < 170 ? packGroupSel(0, 0) : packGroupSel(3, 2),
  q: simAimQ(UP + 0.2 * Math.sin(t / 30)),
  dist: 600,
});

const firedAt = (evs: SimEvent[], t: number): number[] => evs.filter((e) => e.k === 'fire' && e.tick === t).map((e) => (e as { slot: number }).slot).sort((a, b) => a - b);

const TICKS = 260;

describe('a selection change mid-burst: server, own prediction and another client\'s lane fire alike', () => {
  const pose = { x: 0, y: 0, angle: UP };
  const body = () => ({ x: 0, y: 0, vx: 0, vy: 0, angle: UP, angVel: 0, jump: 0, cargo: 0 });

  // The server: its ShipState, the trigger by gunControls and the word, aimed on the one aim rule
  const server: SimEvent[] = [];
  const srv = rig();
  for (let t = 1; t <= TICKS; t++) {
    const i = script(t), c = gunControls(srv, i.left, i.right, false, i.sel);
    gunsTick(srv, 7, pose, { firing: c.firing, word: c.word, aimWorld: simAim(i.q), aimDist: i.dist, hold: true }, t, tuning, server);
  }

  // The pilot's own prediction: the step's gun phase on its SimShipState, the input carrying the selection
  const own: SimEvent[] = [];
  const ship = rig();
  const st = newSimShip({ id: 7, derived: ship.derived, ship, body: body(), charge: FULL_CHARGE, accounted: false });
  for (let t = 1; t <= TICKS; t++) {
    const i = script(t);
    const input: SimInput = { ...NO_INPUT, q: i.q, fire: i.left, fireAlt: i.right, aimDist: i.dist, sel: i.sel };
    stepShipGuns(st, input, envAt(t), own);
  }

  // Another client's lane: the gun row's bits (the trigger word) and distance, stepped by lanePilot
  const lane: SimEvent[] = [];
  const lship = rig();
  const structure = ownStructure(lship.derived, lship);
  let x = seedOwnExtras(lship);
  for (let t = 1; t <= TICKS; t++) {
    const i = script(t);
    x = lanePilot(7, x, body(), body(), 0, i.q, { bits: trigWord(i.left, i.right, i.sel), dist: i.dist }, structure, envAt(t), lane);
  }

  it('the same shells on the same ticks', () => {
    const slots = (evs: SimEvent[]) => { const o: number[][] = []; for (let t = 1; t <= TICKS; t++) o.push(firedAt(evs, t)); return o; };
    const a = slots(server);
    expect(slots(own)).toEqual(a);
    expect(slots(lane)).toEqual(a);
    // (and the script really fires: both guns, each in the windows its group is selected)
    const parts = srv.derived.weapons.map((w) => w.part);
    const fired = (p: number) => a.filter((s) => s.includes(p)).length;
    expect(fired(parts[0])).toBeGreaterThan(1);
    expect(fired(parts[1])).toBeGreaterThan(1);
    // (group 1 only the second gun: the first fires in no tick of 1..59)
    expect(a.slice(0, 59).every((s) => !s.includes(parts[0]))).toBe(true);
    // (group 2 only the first: the second is quiet from 60 to 109)
    expect(a.slice(60, 109).every((s) => !s.includes(parts[1]))).toBe(true);
  });

  it('the same gun state at the end, trigger word included', () => {
    const view = (g: { cooldown: number[]; rounds: number[]; reload: number[]; charge: number[]; spin: number[]; aim: number[]; trig?: number; triggerHeld: boolean }) =>
      ({ cooldown: g.cooldown.map((v) => Math.round(v * 1e6)), rounds: g.rounds, reload: g.reload, charge: g.charge, spin: g.spin, aim: g.aim, trig: g.trig ?? 0, held: g.triggerHeld });
    expect(view(st.guns)).toEqual(view(srv));
    expect(view(x.guns)).toEqual(view(srv));
    expect(srv.trig).toBe(trigWord(script(TICKS).left, script(TICKS).right, script(TICKS).sel));
  });

  it('a lane started from a gunSync carries the trigger word on', () => {
    // (mid-burst, on a selection: the sync packs it and the lane that unpacks it steps on as the server does)
    const mid = rig();
    const ex = laneOf({ cooldown: [...mid.cooldown], rounds: [...mid.rounds], reload: [...mid.reload], charge: [...mid.charge], spin: [...mid.spin], aim: [...mid.aim], triggerHeld: true, clickAt: -1, trig: trigWord(true, false, packGroupSel(2, 0)) }, FULL_CHARGE);
    const back = unpackGunSync(packGunSync(7, 100, ex, { bits: trigWord(true, false, packGroupSel(2, 0)), dist: 600 }));
    expect(back.x.guns.trig).toBe(trigWord(true, false, packGroupSel(2, 0)));
    expect(back.k.bits & (TRIG_LEFT | TRIG_RIGHT)).toBe(TRIG_LEFT);
  });
});
