/**
 * The power flow overlay's data: the starter's links tick, a reactor turned away from the core gets a cross, a gun moved
 * off the core is tinted as unfed; pulses stay on their line; the remembered choice defaults off.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { createShipState, portsLoadTestCached, PS_LINKED, type Blueprint } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/proto/createProtoServer';
import { powerFlow, pulsesOn, portTriangle, type FlowSegment } from './powerFlow';
import { ALL_LAYERS, drawFlow, flowLegend, type FlowSink } from './powerFlowView';
import { loadPowerFlow, savePowerFlow } from './powerFlowPref';

const cfg = loadShipConfigCached(join(__dirname, '../../../../data'));
const bridge = createShipBridge(cfg);
const { catalog, tuning } = bridge;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const flowOf = (bp: Blueprint) => {
  const d = createShipState(catalog, tuning, 0, bp, 0).derived;
  return powerFlow(d, portsLoadTestCached(d, 'both'));
};

describe('powerFlow', () => {
  it('the starter: every link ticks, no crosses, no tints, a port mark per port', () => {
    const f = flowOf(cfg.library!['sparrow-t'])!;
    expect(f.segments.length).toBeGreaterThan(0);
    expect(f.ticks).toBe(f.segments.length);
    expect(f.crosses).toBe(0);
    expect(f.tints.filter((t) => t.none)).toEqual([]);
    expect(f.marks.filter((m) => m.kind === 'port' && m.state === PS_LINKED).length).toBe(f.ticks * 2);
  });

  it('a reactor turned away from the core and a gun moved off it get crosses and an unfed tint', () => {
    const bp = clone(cfg.library!['sparrow-t']);
    const reactor = bp.parts.findIndex((p) => p.fn === 'power_cell_reactor' && p.x < 0);
    const pip = bp.parts.findIndex((p) => p.fn === 'cannon_pip' && p.x === 0);
    bp.parts[reactor].rot = 3;
    bp.parts[pip].x = -1;
    const f = flowOf(bp)!;
    expect(f.crosses).toBeGreaterThan(0);
    expect(f.tints.some((t) => t.part === pip && t.none)).toBe(true);
    expect(f.short).toBe(f.tints.length);
  });

  it('a design without ports shows nothing', () => {
    expect(powerFlow(null, null)).toBeNull();
  });

  it('pulses stay on their line and move with time; a dead link has none', () => {
    const s: FlowSegment = { id: 0, from: 0, to: 1, x0: 0, y0: 0, x1: 2, y1: 0, flow: 5, cap: 10, load: 0.5, live: true, aug: false, touch: false };
    const a = pulsesOn(s, 0), b = pulsesOn(s, 0.3);
    expect(a.length).toBeGreaterThan(0);
    for (const [x, y] of [...a, ...b]) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(2); expect(y).toBe(0); }
    expect(b[0][0]).not.toBe(a[0][0]);
    expect(pulsesOn({ ...s, live: false }, 1)).toEqual([]);
  });

  it('an out port points out of its edge, an in port into it', () => {
    const out = portTriangle({ x: 0, y: 0, side: 'E', dir: 1 }), inn = portTriangle({ x: 0, y: 0, side: 'E', dir: 0 });
    expect(out[0][0]).toBeGreaterThan(out[1][0]);
    expect(inn[0][0]).toBeLessThan(inn[1][0]);
  });

  it('the layers are independent', () => {
    const f = flowOf(cfg.library!['sparrow-t'])!;
    const calls = { line: 0, dot: 0, tri: 0, poly: 0 };
    const sink: FlowSink = { line: () => calls.line++, dot: () => calls.dot++, tri: () => calls.tri++, poly: () => calls.poly++ };
    drawFlow(sink, f, [], { pulses: true }, 0);
    expect(calls.line).toBe(0);
    expect(calls.tri).toBe(0);
    expect(calls.dot).toBeGreaterThan(0);
    drawFlow(sink, f, [], ALL_LAYERS, 0);
    expect(calls.tri).toBeGreaterThan(0);
    expect(calls.line).toBeGreaterThan(0);
  });

  it('the legend says "as designed" only when asked', () => {
    expect(flowLegend('U', true)[0]).toContain('as designed');
    expect(flowLegend('U', false)[0]).not.toContain('as designed');
  });
});

describe('powerFlowPref', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
  it('defaults off, remembers a choice, and survives a broken store', () => {
    const s = mem();
    expect(loadPowerFlow(s)).toBe(false);
    savePowerFlow(true, s);
    expect(loadPowerFlow(s)).toBe(true);
    savePowerFlow(false, s);
    expect(loadPowerFlow(s)).toBe(false);
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadPowerFlow(bad)).toBe(false);
    expect(() => savePowerFlow(true, bad)).not.toThrow();
  });
});
