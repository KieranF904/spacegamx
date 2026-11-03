/**
 * Beams in pieces (ports.ts portsBeamStep, Kieran 2026-11-04), on the Heron's Cutter (3 pieces): a press spends one whole
 * piece and burns exactly a third of the buffer's burn time whatever the trigger does; held, the next follows on the same
 * tick; a part-filled piece never fires and is thrown away when a whole one is spent; after a pulse or a chain the ports
 * stay shut for the cooldown; the damage spikes at each piece's centre; and a pilot's prediction rebuilt from the wire
 * runs the very same pulses as the server.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlueprint } from '../blueprint.js';
import { createShipState, type ShipState } from '../state.js';
import { stepGuns } from '../guns.js';
import { powerTick, type Charge } from '../energy.js';
import { SHIP_DATA_DIR } from '../testData.js';
import { catalog, tuning } from './testData.js';
import {
  PF_LIT, createPortsState, packPorts, portsBeamStep, portsDamageMul, portsDigest, portsPiecePhase, portsPieceSpike, portsPiecesHeld,
  unpackPortsInto, PORTS_ROW, type PortsLayout, type PortsState,
} from './ports.js';

const heron = () => createShipState(catalog, tuning, 1, parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev/ports-heron.json'), 'utf8')), 0);
const POSE = { x: 0, y: 0, angle: -Math.PI / 2 };

/** A ship and its ports charge, stepped a tick at a time with the trigger as given; records each tick's beam and phase */
function rig(ship = heron()) {
  const L = ship.derived.ports!, cutter = ship.blueprint.parts.findIndex((p) => p.fn === 'laser_cutter');
  let c: Charge = { g: 100, b: [], e: createPortsState(L) };
  let tick = 0;
  const step = (firing: boolean) => {
    c = powerTick(ship.derived, c, { thrusting: false, boosting: false }, tuning).charge;
    const out = stepGuns(ship, POSE, { firing, aimWorld: -Math.PI / 2, aimDist: 0, energy: { charge: c } }, tick++, tuning);
    const e = c.e as PortsState;
    return { lit: out.beams.some((w) => w.part === cutter), phase: portsPiecePhase(L, e, cutter), held: e.held[cutter] };
  };
  return { ship, L, cutter, e: () => c.e as PortsState, setCharge: (x: Charge) => { c = x; }, charge: () => c, step, tick: () => tick };
}

describe('beams in pieces: the layout', () => {
  it('the Heron\'s Cutter is 3 pieces, each a third of its buffer and a third of its burn time, its spike at the centre', () => {
    const { L, cutter } = rig();
    expect(L.pieces[cutter]).toBe(3);
    expect(L.pieceE[cutter]).toBe(Math.floor(L.cap[cutter] / 3));
    const whole = L.cap[cutter] / L.shot[cutter];
    expect(Math.abs(L.pieceT[cutter] * 3 - whole)).toBeLessThanOrEqual(1.5);
    const T = L.pieceT[cutter];
    expect((L.spikeLo[cutter] + L.spikeHi[cutter]) / 2).toBeCloseTo(T / 2, 0);
    expect(L.spikeHi[cutter]).toBeGreaterThan(L.spikeLo[cutter]);
    expect(L.rest[cutter]).toBe(30);
  });
});

describe('beams in pieces: firing', () => {
  it('held from full: three pieces back to back, each exactly a third of the burn time, each spending one piece; then out', () => {
    const r = rig(), { L, cutter } = r, T = L.pieceT[cutter];
    // (charged: let the buffer settle full first)
    for (let t = 0; t < 30; t++) r.step(false);
    expect(portsPiecesHeld(L, r.e(), cutter)).toBe(3);
    const lit: boolean[] = [], phases: number[] = [], held: number[] = [];
    for (let t = 0; t < 4 * T + 10; t++) { const s = r.step(true); lit.push(s.lit); phases.push(s.phase); held.push(s.held); }
    // Lit for exactly 3T ticks from the press, then dark however long it is held
    expect(lit.slice(0, 3 * T).every(Boolean)).toBe(true);
    expect(lit.slice(3 * T).some(Boolean)).toBe(false);
    // Each piece starts on ticks 0, T, 2T (a chain: no gap) and counts 0..T-1
    for (let k = 0; k < 3; k++) {
      expect(phases[k * T]).toBe(0);
      expect(phases[k * T + T - 1]).toBe(T - 1);
      // (its energy is spent when it starts: one piece less each time)
      expect(held[k * T]).toBe((2 - k) * L.pieceE[cutter]);
    }
  });

  it('a press let go at once still burns its whole piece, and only that one', () => {
    const r = rig(), { L, cutter } = r, T = L.pieceT[cutter];
    for (let t = 0; t < 30; t++) r.step(false);
    let lit = 0;
    const first = r.step(true);
    expect(first.lit).toBe(true);
    lit++;
    for (let t = 0; t < 3 * T; t++) if (r.step(false).lit) lit++;
    expect(lit).toBe(T);
    expect(portsPiecesHeld(L, r.e(), cutter)).toBeGreaterThanOrEqual(2);
  });

  it('released mid-piece: the piece runs to its end, and the next does not follow', () => {
    const r = rig(), { L, cutter } = r, T = L.pieceT[cutter];
    for (let t = 0; t < 30; t++) r.step(false);
    const lit: boolean[] = [];
    for (let t = 0; t < T / 2; t++) lit.push(r.step(true).lit);
    for (let t = 0; t < 2 * T; t++) lit.push(r.step(false).lit);
    expect(lit.filter(Boolean).length).toBe(T);
    expect(lit.slice(0, T).every(Boolean)).toBe(true);
  });

  it('a part-filled piece never fires; spending a whole one throws the part-filled one away', () => {
    const { L, cutter } = rig();
    const e = createPortsState(L), pe = L.pieceE[cutter];
    // One piece not quite full: nothing
    e.held[cutter] = pe - 4 * L.passive[cutter] - 50; e.closed[cutter] = 0; e.flags[cutter] = 0;
    expect(portsPiecesHeld(L, e, cutter)).toBe(0);
    expect(portsBeamStep(L, e, cutter, true)).toBe(0);
    expect(e.flags[cutter] & PF_LIT).toBe(0);
    expect(e.held[cutter]).toBe(pe - 4 * L.passive[cutter] - 50);
    // Two whole and a half: a press spends one, and the half goes with it
    e.held[cutter] = 2 * pe + Math.floor(pe / 2);
    expect(portsPiecesHeld(L, e, cutter)).toBe(2);
    expect(portsBeamStep(L, e, cutter, true)).toBeGreaterThan(0);
    expect(e.held[cutter]).toBe(pe);
    expect(e.flags[cutter] & PF_LIT).toBe(PF_LIT);
  });

  it('after a pulse the ports stay shut for the cooldown, then it charges again', () => {
    const r = rig(), { L, cutter } = r, T = L.pieceT[cutter];
    for (let t = 0; t < 30; t++) r.step(false);
    r.step(true);
    for (let t = 1; t < T; t++) r.step(false);
    // The piece's last tick is past: the tick it ends sets the cooldown
    const end = r.step(false);
    expect(end.lit).toBe(false);
    const atEnd = end.held;
    // (its rest, as its material shapes it: 0.5 s plain)
    const R = r.e().closed[cutter];
    expect(R).toBeGreaterThanOrEqual(L.rest[cutter] / 2);
    for (let t = 0; t < R; t++) expect(r.step(false).held).toBe(atEnd);
    // Then it fills again (its plant has plenty)
    let after = atEnd;
    for (let t = 0; t < 10; t++) after = r.step(false).held;
    expect(after).toBeGreaterThan(atEnd);
  });

  it('the damage spikes at each piece\'s centre and a piece deals what the same burn did before', () => {
    const r = rig(), { L, cutter } = r, T = L.pieceT[cutter];
    let sum = 0, peakAt = -1, peak = 0;
    for (let ph = 0; ph < T; ph++) { const k = portsPieceSpike(L, cutter, ph); sum += k; if (k > peak) { peak = k; peakAt = ph; } }
    expect(sum).toBeCloseTo(T, 6);
    expect(peak).toBeGreaterThan(1.5);
    expect(peakAt).toBe(L.spikeLo[cutter]);
    expect(Math.abs((L.spikeLo[cutter] + L.spikeHi[cutter]) / 2 - T / 2)).toBeLessThanOrEqual(0.5);
    // In the game: portsDamageMul carries it, tick by tick through a held piece
    for (let t = 0; t < 30; t++) r.step(false);
    const base = portsDamageMul(L, r.e(), cutter);
    const muls: number[] = [];
    for (let t = 0; t < T; t++) { r.step(true); muls.push(portsDamageMul(L, r.e(), cutter)); }
    const mid = Math.floor((L.spikeLo[cutter] + L.spikeHi[cutter]) / 2);
    expect(muls[mid]).toBeGreaterThan(muls[0] * 2);
    expect(muls[0]).toBeLessThan(base);
  });
});

describe('beams in pieces: the same on every machine', () => {
  it('a pilot\'s prediction rebuilt from the wire mid-chain runs the same pulses, tick for tick, as the server', () => {
    const server = rig(), { L, cutter } = server, T = L.pieceT[cutter];
    for (let t = 0; t < 30; t++) server.step(false);
    // A burst of input: press, hold through a piece and a half, let go, press again after the cooldown
    const input = (t: number) => (t < Math.floor(1.5 * T)) || (t >= 3 * T && t < 3 * T + 5);
    const at = Math.floor(T * 1.2);
    const sLog: string[] = [], pLog: string[] = [];
    let pilot: ReturnType<typeof rig> | null = null;
    for (let t = 0; t < 5 * T; t++) {
      const s = server.step(input(t));
      if (t >= at) sLog.push(`${s.lit}|${s.phase}|${s.held}|${portsDigest(L, server.e())}`);
      if (t === at - 1) {
        // The pilot row after this tick: the pilot's ship picks it up from there (ShipClient's ensurePortsCharge)
        const row = new Array(PORTS_ROW.at).fill(0);
        const n = packPorts(L, server.e(), row);
        row[PORTS_ROW.sig] = L.sig; row[PORTS_ROW.count] = -n;
        const ship2 = heron();
        pilot = rig(ship2);
        const e2 = createPortsState(ship2.derived.ports!);
        expect(unpackPortsInto(ship2.derived.ports!, e2, row)).toBe(true);
        const c = server.charge();
        pilot.setCharge({ ...c, e: e2 });
        copyGuns(server.ship, ship2);
      }
      if (pilot && t >= at) { const p = pilot.step(input(t)); pLog.push(`${p.lit}|${p.phase}|${p.held}|${portsDigest(L, pilot.e())}`); }
    }
    expect(pLog).toEqual(sLog);
    // (and it did pulse: lit, out, lit again)
    expect(sLog.some((x) => x.startsWith('true'))).toBe(true);
    expect(sLog.some((x) => x.startsWith('false'))).toBe(true);
  });
});

/** The gun state the pilot's own client keeps (guns.ts: cooldowns, aims, the trigger's last press) */
function copyGuns(a: ShipState, b: ShipState): void {
  for (let i = 0; i < a.cooldown.length; i++) { b.cooldown[i] = a.cooldown[i]; b.aim[i] = a.aim[i]; b.charge[i] = a.charge[i]; }
  b.triggerHeld = a.triggerHeld; b.clickAt = a.clickAt;
}
void ({} as PortsLayout);
