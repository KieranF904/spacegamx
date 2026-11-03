/**
 * Mining lasers on the ports core (ports.ts portsMineStep, energy.ts payMining; Kieran 2026-11-04), on the Wren (dev:
 * two Mining Lasers, each on a Cell Reactor; for the fulfilment, a copy whose right one has no reactor, only its own buffer): a press starts a pulse of a
 * fixed length that runs to its end; held, the pulses chain; while one runs the laser draws its rate every tick and cuts
 * by the share of it that arrives (its fulfilment); and a pilot rebuilt from the wire mid-pulse runs the same pulses.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlueprint } from '../blueprint.js';
import { createShipState } from '../state.js';
import { payMining, powerTick, type Charge } from '../energy.js';
import { SHIP_DATA_DIR } from '../testData.js';
import { catalog, tuning } from './testData.js';
import { PORTS_ROW, createPortsState, packPorts, portsDigest, portsMinePhase, portsMineStep, unpackPortsInto, type PortsState } from './ports.js';

const wren = (unfedRight = false) => {
  const bp = parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/dev/ports-wren.json'), 'utf8'));
  // (the reactor behind the right laser made plain hull)
  if (unfedRight) for (const p of bp.parts) if (p.fn === 'power_cell_reactor' && p.x === 4 && p.y === -2) p.fn = 'hull';
  return createShipState(catalog, tuning, 1, bp, 0);
};

function rig(ship = wren()) {
  const L = ship.derived.ports!;
  const miners = ship.derived.miners.map((m) => m.part).sort((a, b) => ship.blueprint.parts[a].x - ship.blueprint.parts[b].x);
  const [left, right] = miners;
  const box = { charge: { g: 100, b: [], e: createPortsState(L) } as Charge };
  let tick = 0;
  const step = (on: boolean) => {
    box.charge = powerTick(ship.derived, box.charge, { thrusting: false, boosting: false }, tuning).charge;
    const running = payMining(ship, on, tick++, box);
    const e = box.charge.e as PortsState;
    return { running, phase: portsMinePhase(L, e, left), fillL: e.sat[left] / 255, fillR: e.sat[right] / 255 };
  };
  return { ship, L, left, right, box, e: () => box.charge.e as PortsState, step };
}

describe('mining lasers on the ports core', () => {
  it('the Wren\'s lasers are miners with their pulse length from the data (Mining Laser 0.9 s)', () => {
    const { L, left, right } = rig();
    expect(L.miner[left]).toBe(1);
    expect(L.miner[right]).toBe(1);
    expect(L.minePulse[left]).toBe(54);
  });

  it('a press runs one pulse of exactly its length, let go at once (release doesn\'t cut it short)', () => {
    const r = rig(), T = r.L.minePulse[r.left];
    const on: boolean[] = [];
    on.push(r.step(true).running);
    for (let t = 0; t < 3 * T; t++) on.push(r.step(false).running);
    expect(on.filter(Boolean).length).toBe(T);
    expect(on.slice(0, T).every(Boolean)).toBe(true);
  });

  it('released mid-pulse it runs to its end and no other follows', () => {
    const r = rig(), T = r.L.minePulse[r.left];
    const on: boolean[] = [];
    for (let t = 0; t < 10; t++) on.push(r.step(true).running);
    for (let t = 0; t < 2 * T; t++) on.push(r.step(false).running);
    expect(on.filter(Boolean).length).toBe(T);
  });

  it('held, the pulses chain back to back, each starting on the tick the last ended', () => {
    const r = rig(), T = r.L.minePulse[r.left];
    const ph: number[] = [];
    for (let t = 0; t < 3 * T; t++) { const s = r.step(true); expect(s.running).toBe(true); ph.push(s.phase); }
    expect(ph[0]).toBe(0); expect(ph[T - 1]).toBe(T - 1); expect(ph[T]).toBe(0); expect(ph[2 * T]).toBe(0);
  });

  it('it cuts by its fulfilment: the fed laser gets all its draw; the unfed one empties its buffer, then gets nothing', () => {
    const r = rig(wren(true));
    const fillR: number[] = [];
    for (let t = 0; t < 200; t++) { const s = r.step(true); expect(s.fillL).toBe(1); fillR.push(s.fillR); }
    // (its buffer holds a second of its draw)
    expect(fillR.slice(0, 50).every((f) => f === 1)).toBe(true);
    expect(fillR.slice(70).every((f) => f === 0)).toBe(true);
    // A part of its draw: that share
    const e = r.e(), p = r.right;
    e.held[p] = Math.floor(r.L.rate[p] / 2);
    const f = portsMineStep(r.L, e, p, true);
    expect(f).toBeGreaterThan(0.45);
    expect(f).toBeLessThan(0.55);
  });

  it('a pilot rebuilt from the wire mid-pulse runs the same pulses, fulfilment and buffers as the server', () => {
    const server = rig(), L = server.L, T = L.minePulse[server.left];
    const input = (t: number) => t < T + 10 || (t > 2 * T + 20 && t < 2 * T + 25);
    const at = 30;
    let pilot: ReturnType<typeof rig> | null = null;
    const sLog: string[] = [], pLog: string[] = [];
    for (let t = 0; t < 4 * T; t++) {
      const s = server.step(input(t));
      if (t >= at) sLog.push(`${s.running}|${s.phase}|${s.fillL}|${s.fillR}|${portsDigest(L, server.e())}`);
      if (t === at - 1) {
        const row = new Array(PORTS_ROW.at).fill(0);
        const n = packPorts(L, server.e(), row);
        row[PORTS_ROW.sig] = L.sig; row[PORTS_ROW.count] = -n;
        const ship2 = wren();
        pilot = rig(ship2);
        expect(unpackPortsInto(ship2.derived.ports!, pilot.e(), row)).toBe(true);
      }
      if (pilot && t >= at) { const p = pilot.step(input(t)); pLog.push(`${p.running}|${p.phase}|${p.fillL}|${p.fillR}|${portsDigest(L, pilot.e())}`); }
    }
    expect(pLog).toEqual(sLog);
    expect(sLog.some((x) => x.startsWith('false'))).toBe(true);
  });
});
