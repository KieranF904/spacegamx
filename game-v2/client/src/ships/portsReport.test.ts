/**
 * The hangar's power report for a ports design: the starter is fully routed, and taking a reactor away (or turning
 * one) shows up as an unfed part or a wasted line.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, type Blueprint } from '@space-game/common';
import { loadShipConfigFromDisk } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import { portsReport, portsWarnings } from './portsReport';

const cfg = loadShipConfigFromDisk(join(__dirname, '../../../data'));
const bridge = createShipBridge(cfg);
const { catalog, tuning } = bridge;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const report = (bp: Blueprint) => portsReport(createShipState(catalog, tuning, 0, bp, 0).derived.ports!);
const name = (bp: Blueprint) => (i: number) => catalog.functions.get(bp.parts[i].fn)?.name ?? bp.parts[i].fn;

describe('portsReport', () => {
  it('the starter (a ports design) has every gun and engine fed', () => {
    const bp = cfg.library!['sparrow-t'];
    expect(bp.power).toBe('ports');
    const r = report(bp);
    expect(r.unfed).toEqual([]);
    expect(r.partly).toEqual([]);
    expect(r.wasting).toEqual([]);
    expect(r.supply).toBe(70);
  });

  it('a gun moved off the core is unfed; a reactor turned away from the core wastes its line', () => {
    const bp = clone(cfg.library!['sparrow-t']);
    // (The left reactor feeds the core's left side; the left Pip sits on the core's nose)
    const reactor = bp.parts.findIndex((p) => p.fn === 'power_cell_reactor' && p.x < 0);
    const pip = bp.parts.findIndex((p) => p.fn === 'cannon_pip' && p.x === 0);
    bp.parts[reactor].rot = 3;
    bp.parts[pip].x = -1;
    const r = report(bp);
    expect(r.unfed).toEqual([pip]);
    expect(r.wasting).toEqual([reactor]);
    expect(portsWarnings(r, name(bp))).toEqual(['Pip has no power: nothing feeds its in port', 'Cell Reactor gives into nothing on one side: that line is wasted']);
  });
});
