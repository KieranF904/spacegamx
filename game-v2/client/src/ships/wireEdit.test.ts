/**
 * The hangar's wire tool: a drag lays an unbroken run of neighbouring segments (only over the hull), erasing takes
 * out what it passes, a part taken away takes its wire, the spool bill matches the server's, and the power overlay
 * gives each network its own colour and names what's left without power, and where.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { autoWire, createShipState, isNeighbour, placeGeometry, wireCells, cellKey, type Blueprint, type WireSeg } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import { DEAD_NET, NET_COLORS, eraseRun, layRun, powerReport, pruneWires, stepCells, whereOnShip, wireBill, type Cell } from './wireEdit';

const bridge = createShipBridge(loadShipConfigFromDisk(join(__dirname, '../../../data')));
const { catalog, tuning } = bridge;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const onHullOf = (bp: Blueprint) => {
  const cells = wireCells(catalog, bp, bp.parts.map((p) => placeGeometry(catalog, p)));
  return (x: number, y: number) => cells.has(cellKey(x, y));
};
const report = (bp: Blueprint) => {
  const d = createShipState(catalog, tuning, 0, bp, 0).derived;
  const geoms = bp.parts.map((p) => placeGeometry(catalog, p));
  return powerReport(catalog, bp, d, geoms, (i) => catalog.functions.get(bp.parts[i].fn)?.name ?? bp.parts[i].fn);
};

/** A generator in the middle, a gun at the left wing's tip, an engine at the tail, hull between */
function testShip(): Blueprint {
  const at = (uid: number, fn: string, x: number, y: number, facing?: string) => ({ uid, piece: 'sq', fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as const, flip: false, ...(facing ? { facing } : {}) });
  return {
    name: 'Wire test', catalogVersion: catalog.version,
    parts: [
      at(0, 'core', 0, 0), at(1, 'power_cell_reactor', 0, 1),
      at(2, 'hull', -1, 0), at(3, 'hull', -2, 0), at(4, 'cannon_pip', -3, 0, 'N'),
      at(5, 'hull', 0, 2), at(6, 'engine_ion_drive', 0, 3, 'S'),
    ],
  } as Blueprint;
}

describe('laying wire', () => {
  it('a drag steps cell by cell, every step a neighbour', () => {
    for (const [a, b] of [[[0, 0], [5, 2]], [[3, -4], [-2, 1]], [[0, 0], [0, 0]], [[1, 1], [-6, 1]]] as [Cell, Cell][]) {
      const run = stepCells(a, b);
      expect(run[0]).toEqual(a);
      expect(run[run.length - 1]).toEqual(b);
      for (let i = 1; i < run.length; i++) expect(isNeighbour(run[i - 1][0], run[i - 1][1], run[i][0], run[i][1])).toBe(true);
    }
  });

  it('lays segments only over the hull, each once, and erases what a drag passes', () => {
    const bp = testShip(), onHull = onHullOf(bp);
    const run: Cell[] = [[0, 1], ...stepCells([0, 0], [-3, 0])];
    let w = layRun([], run, onHull);
    expect(w.length).toBe(4);
    expect(layRun(w, run, onHull)).toBe(w);
    // (a run that strays off the hull lays only what's on it: (0,1) to (-1,1) is off)
    expect(layRun([], stepCells([0, 1], [-3, 0]), onHull).length).toBe(1);
    // (off the hull: nothing)
    expect(layRun(w, [[5, 5], [6, 5]], onHull)).toBe(w);
    w = layRun(w, [[0, 1], [0, 2], [0, 3]], onHull);
    expect(w.length).toBe(6);
    const cut = eraseRun(w, [[0, 2]]);
    expect(cut.length).toBe(4);
    expect(cut.some(([x0, y0, x1, y1]) => (x0 === 0 && y0 === 2) || (x1 === 0 && y1 === 2))).toBe(false);
    expect(eraseRun(w, [[9, 9]])).toBe(w);
  });

  it('a part taken away takes the wire laid over it', () => {
    const bp = testShip();
    bp.wires = layRun([], [[0, 1], [0, 2], [0, 3]], onHullOf(bp));
    bp.parts = bp.parts.filter((p) => p.uid !== 6);
    expect(pruneWires(bp.wires, onHullOf(bp))).toEqual([[0, 1, 0, 2]]);
  });

  it('bills spools as the server does: explicit segments against the saved design', () => {
    const w = (n: number) => Array.from({ length: n }, (_, i) => [i, 0, i + 1, 0] as WireSeg);
    expect(wireBill(undefined, undefined).spools).toBe(0);
    expect(wireBill(undefined, w(5)).spools).toBe(2);
    expect(wireBill(w(4), w(8)).spools).toBe(1);
    expect(wireBill(w(9), w(4)).spools).toBe(-2);
  });
});

describe('the power overlay', () => {
  it('an auto-wired design has every power part on a powered network, in the first colour', () => {
    const bp = testShip();
    const r = report(bp);
    expect(r.warnings).toEqual([]);
    expect(r.nets.filter((n) => n.powered).map((n) => n.color)).toEqual([NET_COLORS[0]]);
    expect(r.nets[0].generators.length).toBe(1);
    expect(r.seg.every((c) => c === NET_COLORS[0])).toBe(true);
    expect(autoWire(bp, catalog).length).toBe(r.seg.length);
  });

  it('a gun out on a wing with its wire gone has no power, and says where', () => {
    const bp = testShip();
    bp.wires = autoWire(bp, catalog).filter(([x0, , x1]) => x0 > -2 && x1 > -2);
    const r = report(bp);
    const gun = bp.parts.findIndex((p) => p.fn === 'cannon_pip');
    expect(r.part[gun]).toBe('unpowered');
    expect(r.warnings).toContain('Pip on the left wing has no power');
  });

  it('two generators wired apart make two networks, each its own colour; one with no generator is grey', () => {
    const bp = testShip();
    bp.parts.push({ uid: 7, piece: 'sq', fn: 'power_cell_reactor', material: 'alloy', x: -3, y: 1, rot: 0, flip: false });
    bp.wires = [[0, 1, 0, 2], [0, 2, 0, 3]];
    const r = report(bp);
    const powered = r.nets.filter((n) => n.powered);
    expect(powered.length).toBe(2);
    expect(new Set(powered.map((n) => n.color)).size).toBe(2);
    // (the second generator sits beside the gun: plugged straight in)
    const gun = bp.parts.findIndex((p) => p.fn === 'cannon_pip');
    expect(r.part[gun]).toBe('powered');
    // A battery wired to nothing but itself: no generator to charge it
    bp.parts.push({ uid: 8, piece: 'sq', fn: 'power_battery', material: 'alloy', x: 1, y: 0, rot: 0, flip: false });
    bp.parts.push({ uid: 9, piece: 'sq', fn: 'hull', material: 'alloy', x: 2, y: 0, rot: 0, flip: false });
    bp.wires = [...bp.wires, [1, 0, 2, 0]];
    const r2 = report(bp);
    const bat = bp.parts.findIndex((p) => p.fn === 'power_battery');
    expect(r2.part[bat]).toBe('stranded');
    expect(r2.nets.some((n) => !n.powered && n.color === DEAD_NET)).toBe(true);
  });

  it('names places as a pilot would', () => {
    expect(whereOnShip([-5, 0], [0, 0], [6, 6])).toBe('on the left wing');
    expect(whereOnShip([5, 1], [0, 0], [6, 6])).toBe('on the right wing');
    expect(whereOnShip([0, -5], [0, 0], [6, 6])).toBe('at the nose');
    expect(whereOnShip([0, 5], [0, 0], [6, 6])).toBe('at the tail');
    expect(whereOnShip([0.5, 0.5], [0, 0], [6, 6])).toBe('amidships');
  });

  it('the starter plans power everything they carry, auto-wired', () => {
    for (const name of ['sparrow-t', 'corsair']) {
      const bp = clone(bridge.library.get(name)!);
      expect(report(bp).warnings, name).toEqual([]);
    }
  });
});

describe('off-grid bank pods in the power overlay', () => {
  const pod = (withDynamo: boolean): Blueprint => {
    const at = (uid: number, fn: string, x: number, y: number, facing?: string) => ({ uid, piece: 'sq', fn, material: catalog.functions.get(fn)?.material ?? 'alloy', x, y, rot: 0 as const, flip: false, ...(facing ? { facing } : {}) });
    const bp = {
      name: 'Pod', catalogVersion: catalog.version,
      parts: [at(0, 'core', 0, 0), at(1, 'power_cell_reactor', 0, 1), at(2, 'hull', -1, 0), at(3, 'power_capacitor', -2, 0), at(4, 'cannon_pip', -3, 0, 'N'), ...(withDynamo ? [at(5, 'power_pulse_dynamo', -2, 1)] : [])],
    } as Blueprint;
    bp.wires = [[0, 0, 0, 1]];
    return bp;
  };
  it('a Capacitor with a Pulse Dynamo and the gun it feeds read as powered with no wire', () => {
    const r = report(pod(true));
    expect(r.part[3]).toBe('powered');
    expect(r.part[4]).toBe('powered');
    expect(r.warnings.join('|')).not.toMatch(/no power/);
  });
  it('one that can never refill is grey and says so, not "no power"', () => {
    const r = report(pod(false));
    expect(r.part[3]).toBe('stranded');
    expect(r.warnings.join('|')).toMatch(/never refills/);
    expect(r.warnings.join('|')).not.toMatch(/Capacitor.*no power/);
  });
});
