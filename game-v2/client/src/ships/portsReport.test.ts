/**
 * The hangar's power report for a ports design: the starter is fully routed, and taking a reactor away (or turning
 * one) shows up as an unfed part or a wasted line.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { createShipState, parseBlueprint, portsLoadTest, portsView, PORTS_SCENARIOS, PS_LINKED, PS_WASTE, type Blueprint } from '@space-game/common';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/proto/createProtoServer';
import { loadRow, portTipHtml, portsReport, portsWarnings } from './portsReport';
import { ghostHint, glyphCentre, portNear } from './portsOverlay';

const cfg = loadShipConfigCached(join(__dirname, '../../../data'));
const bridge = createShipBridge(cfg);
const { catalog, tuning } = bridge;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const report = (bp: Blueprint) => portsReport(createShipState(catalog, tuning, 0, bp, 0).derived.ports!);
const name = (bp: Blueprint) => (i: number) => catalog.functions.get(bp.parts[i].fn)?.name ?? bp.parts[i].fn;

describe('portsReport', () => {
  it('the starter (a ports design) has every gun and engine fed', () => {
    const bp = cfg.library!['sparrow-t'];
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

describe('the ports overlay and load test, in words', () => {
  const derive = (bp: Blueprint) => createShipState(catalog, tuning, 0, bp, 0).derived;
  const uidAt = (bp: Blueprint, uid: number) => bp.parts.findIndex((p) => p.uid === uid);
  // (The first ports starter, kept as a fixture: a reactor under each Pip. The library's starter now feeds its Pips from the core hub)
  const starter = () => parseBlueprint(readFileSync(join(__dirname, '../../../data/ships/blueprints/fixtures/sparrow-t-reactors.json'), 'utf8'));

  it('two reactors giving into each other: a clash warning naming both', () => {
    const bp = starter();
    bp.parts[uidAt(bp, 4)].rot = 1; bp.parts[uidAt(bp, 13)].rot = 3;
    expect(portsWarnings(report(bp), name(bp))).toContain('Cell Reactor and Cell Reactor clash: two outs face each other and nothing crosses');
  });

  it('loadRow: the starter holds; a turned reactor leaves its Pip short almost at once', () => {
    const ok = starter(), d = derive(ok);
    for (const s of PORTS_SCENARIOS) expect(loadRow(portsLoadTest(d, s, 4)!, name(ok)).tone).toBe('ok');
    const bp = starter();
    bp.parts[uidAt(bp, 7)].rot = 2;
    const row = loadRow(portsLoadTest(derive(bp), 'fire', 4)!, name(bp));
    expect(row.tone).toBe('bad');
    expect(row.text).toMatch(/^full power 0\.\d s, Pip short first; then guns 0%$/);
    expect(loadRow(portsLoadTest(derive(bp), 'boost', 4)!, name(bp)).text).toBe('full power for 4 s+');
  });

  it('portNear finds the glyph under the mouse; portTipHtml says what it links to and its flow', () => {
    const bp = starter(), d = derive(bp), v = portsView(d.ports!);
    const k = v.ports.findIndex((p) => p.part === uidAt(bp, 7) && p.dir === 1);
    const p = v.ports[k], c = glyphCentre(p.x, p.y, p.side);
    expect(portNear(v, c[0] + 0.05, c[1])).toBe(k);
    expect(portNear(v, p.x + 0.5, p.y + 0.5)).toBe(-1);
    const html = portTipHtml(v, k, { name: name(bp), scenario: 'Firing', flow: () => 7.5 });
    for (const s of ['Out port', 'Gives to', 'Pip', '7.5 E/s']) expect(html).toContain(s);
  });

  it('ghostHint: what the part in hand would link to, or what it would waste', () => {
    const n = (i: number) => ['Core', 'Pip'][i] ?? '?';
    expect(ghostHint([{ dir: 1, x: 0, y: 0, side: 'N', rate: 35, aug: 0, state: PS_LINKED, to: 1, blocked: false }], n)).toEqual({ text: 'links to Pip', tone: 'ok' });
    expect(ghostHint([{ dir: 1, x: 0, y: 0, side: 'S', rate: 35, aug: 0, state: PS_WASTE, to: -1, blocked: true }], n)).toEqual({ text: '1 line wasted', tone: 'bad' });
    expect(ghostHint([], n)).toBeNull();
  });
});
