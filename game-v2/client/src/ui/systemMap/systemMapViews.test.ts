/**
 * The system map's modules (ui/systemMap): hits are pushed in draw order and the nearest wins (an earlier one keeps an
 * exact tie), labels make way for each other by priority, the tooltip shows the hovered hit, the galaxy view pushes one
 * hit per system, drawSystem's layer order, and modules reach the map only through MapHost.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { nearestHit, type Hit } from './types';
import { placeLabels } from './marks';
import { updateTooltip } from './tooltip';
import { drawGalaxy } from './galaxyView';
import { sink, FakeEl } from '../../fakeDom.testkit';
import type { MapHost } from './host';

const at = (kind: 'station' | 'wreck', sx: number, sy: number, name: string): Hit => ({ kind, name, x: 0, y: 0, sx, sy });

describe('layers push hits in draw order, so the hover takes the nearest and an earlier hit keeps an exact tie', () => {
  it('nearest within 22 px; equal distances go to the one drawn first; band edges give way to anything on them', () => {
    const hits: Hit[] = [at('station', 100, 100, 'first'), at('wreck', 100, 100, 'second')];
    expect((nearestHit(hits, 105, 100) as { name: string }).name).toBe('first');
    expect(nearestHit([at('station', 100, 100, 'a'), at('wreck', 108, 100, 'b')], 107, 100)).toMatchObject({ name: 'b' });
    expect(nearestHit(hits, 200, 200)).toBeNull();
    const zone = { kind: 'zone', zone: {}, sx: 100, sy: 100 } as unknown as Hit;
    expect(nearestHit([zone, at('wreck', 110, 100, 'on it')], 101, 100)).toMatchObject({ name: 'on it' });
  });
});

describe('label priority decides who keeps a spot', () => {
  it('of two names on the same spot the higher priority keeps it, the other goes to the far side of its marker, a third is left out', () => {
    const drawn: { text: string; y: number }[] = [];
    const host = {
      labelQueue: [
        { text: 'low', x: 100, y: 50, color: '#fff', pri: 1, my: 60 },
        { text: 'high', x: 100, y: 50, color: '#fff', pri: 9, my: 60 },
        { text: 'lowest', x: 100, y: 50, color: '#fff', pri: 0, my: 60 },
      ],
      hover: null, labelWidths: new Map(),
      drawLabel: (_c: unknown, text: string, _x: number, y: number) => drawn.push({ text, y }),
    } as unknown as MapHost;
    const ctx = { measureText: () => ({ width: 40 }), font: '' } as unknown as CanvasRenderingContext2D;
    placeLabels(host, ctx, null);
    expect(drawn.map((d) => d.text)).toEqual(['high', 'low']);
    expect(drawn[0].y).toBe(50); // its usual spot
    expect(drawn[1].y).toBe(2 * 60 - 50 + 7); // the other side of the marker
    expect(host.labelQueue).toBeNull(); // queue closed: later labels draw at once
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('the tooltip shows the nearest hit\'s details', () => {
  it('the hovered hit\'s name is in the tooltip, and no hit hides it', () => {
    vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800 });
    const tooltip = new FakeEl('div');
    const host = { hover: at('station', 0, 0, 'Harbour Ring') as Hit | null, tooltip, byId: new Map(), state: {}, canvas: { clientWidth: 800, clientHeight: 600, offsetTop: 0, offsetLeft: 0 }, mouse: { x: 10, y: 10 } } as unknown as MapHost;
    updateTooltip(host);
    expect(tooltip.innerHTML).toContain('Harbour Ring');
    host.hover = null;
    updateTooltip(host);
    expect(tooltip.style.display).toBe('none');
  });
});

describe('one hit per system, pushed as it is drawn', () => {
  it('every system gets exactly one system hit, in the order the systems come', () => {
    const sys = (id: string, x: number) => ({ id, name: id, position: { x, y: 0 }, sector: 'a', portals: [], rifts: [], stations: [], hazards: [], danger: 2, planets: [] });
    const systems = [sys('s1', 0), sys('s2', 100000), sys('s3', 200000)];
    const hits: Hit[] = [];
    const base = {
      systems, byId: new Map(systems.map((s) => [s.id, s])), sectorColor: new Map([['a', '#336699']]), hits,
      canvas: { clientWidth: 800, clientHeight: 600 }, state: { systemId: 's1', threats: {} }, hover: null, party: () => [],
      drawGalaxyPin: () => {},
    };
    const host = new Proxy(base, { get: (t, k) => (k in t ? (t as never)[k] : sink()) }) as unknown as MapHost;
    drawGalaxy(host, sink(), (x) => x * 0.001 + 400, (y) => y * 0.001 + 300, { x: 100000, y: 0, scale: 0.001 }, 0);
    expect(hits.map((h) => h.kind)).toEqual(['system', 'system', 'system']);
    expect(hits.map((h) => (h as { sys: { id: string } }).sys.id)).toEqual(['s1', 's2', 's3']);
  });
});

describe('drawn over the scenery and traffic, under your own ship', () => {
  it('drawSystem calls the guide layers after the traffic layers and before your own ship\'s marker', () => {
    const src = readFileSync(join(__dirname, '../SystemMapUI.ts'), 'utf8');
    const body = src.slice(src.indexOf('private drawSystem('));
    const at = (s: string) => body.indexOf(s);
    expect(at('drawComets(this, sc)')).toBeGreaterThan(0);
    expect(at('drawComets(this, sc)')).toBeLessThan(at('drawPilots(this, sc)'));
    expect(at('drawPilots(this, sc)')).toBeLessThan(at('drawBossLairs(this, sc)'));
    expect(at('drawGuideMarks(sc)')).toBeLessThan(at('this.drawYou('));
  });
});

describe('modules reach the map only through this interface', () => {
  it('no systemMap module imports SystemMapUI (they take the MapHost interface)', () => {
    for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const code = readFileSync(join(__dirname, f), 'utf8').split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
      expect(code, f).not.toMatch(/SystemMapUI/);
    }
  });
});
