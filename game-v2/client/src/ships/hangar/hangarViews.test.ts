/**
 * The hangar's panel modules (ships/hangar), through the stand-in DOM: tooltips rebuild only when their key changes, the
 * Simple stats carry their stat-delta spans, renderStats rebuilds the panel and rebinds its buttons, a save or delete
 * that would lose a design asks first, and the modules reach the editor only through HangarHost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import { Economy, blueprintGeometry, cloneJson, createShipState, type Blueprint, type ItemsFile, type RecipesFile } from '@space-game/common';
import type { HangarUI } from '../HangarUI';
import { remove } from './hangarEdit';
import items from '../../../../data/items.json';
import recipes from '../../../../data/recipes.json';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import { FakeEl, installFakeDom } from '../../fakeDom.testkit';
import { setDetailMode, resetDetailMode } from '../build/detailMode';
import { showTip, hideTip } from './hangarTips';
import { simpleSummaryHtml } from './hangarStatsSimple';
import { renderStats } from './hangarStats';
import { renderDesigns, saveDesign, deleteDesign } from './hangarDesigns';
import type { HangarHost } from './host';

vi.mock('../../ui/itemIcons', () => ({ shipIcon: () => 'data:', itemIcon: () => 'data:' }));

beforeEach(() => { installFakeDom(); resetDetailMode(); vi.stubGlobal('innerWidth', 1200); vi.stubGlobal('innerHeight', 800); });
afterEach(() => { vi.unstubAllGlobals(); resetDetailMode(); });

describe('tooltip contents rebuild only when the key changes', () => {
  it('the same key builds once; a new key builds again; after hiding the same key builds afresh', () => {
    const host = { tip: new FakeEl('div'), tipKey: '' } as unknown as HangarHost & { tip: FakeEl };
    let built = 0;
    const html = () => `<b>${++built}</b>`;
    showTip(host, 'g:1', html, 10, 10);
    showTip(host, 'g:1', html, 40, 40); // the mouse moved: the box follows, its contents stay
    expect(built).toBe(1);
    expect(host.tip.innerHTML).toBe('<b>1</b>');
    expect(host.tip.style.left).not.toBe('');
    showTip(host, 'g:2', html, 40, 40);
    expect(built).toBe(2);
    hideTip(host);
    expect(host.tip.style.display).toBe('none');
    showTip(host, 'g:2', html, 40, 40);
    expect(built).toBe(3);
  });
});

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));

describe('every row carries its data-sd span, so the stat-delta chips fill in as in Advanced', () => {
  it('each Simple stat row has a data-sd span, and the same count as rows', () => {
    const ship = createShipState(bridge.catalog, bridge.tuning, 1, bridge.library.get('hauler')!, 0);
    const host = {
      deps: { catalog: bridge.catalog, tuning: bridge.tuning, econ: new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, bridge.catalog, {}) },
      bp: ship.blueprint, derived: ship.derived, overlays: { energy: false }, deltaNow: null,
    } as unknown as HangarHost;
    const html = simpleSummaryHtml(host);
    const rows = (html.match(/justify-content:space-between; gap:8px/g) ?? []).length;
    const spans = (html.match(/data-sd="[A-Za-z0-9]+"/g) ?? []).length;
    expect(rows).toBeGreaterThanOrEqual(4);
    expect(spans).toBe(rows);
    for (const key of ['topSpeed', 'turn180', 'dps', 'hull', 'power']) expect(html).toContain(`data-sd="${key}"`);
  });
});

describe('renderStats rebuilds the panel and rebinds its buttons', () => {
  it('every call writes the sections afresh and binds the buttons after, so none is left on the old panel', () => {
    const order: string[] = [];
    let n = 0;
    const stats = Object.assign(new FakeEl('div'), { querySelectorAll: () => ({ forEach: () => {} }) });
    const host = {
      derived: null, stats, bp: { parts: [] }, errors: [], unreachable: new Set(), deltaNow: null,
      deps: { tuning: { maxParts: 60 }, econ: { rebuildBill: () => ({}), items: { name: (s: string) => s } } },
      buildHtml: () => `<i>build${++n}</i>`, ammoHtml: () => '', powerHtml: () => '', summaryHtml: () => '',
      bindBuildButtons: () => order.push(`bind:${stats.innerHTML.includes(`build${n}`)}`),
    } as unknown as HangarHost;
    setDetailMode('advanced');
    renderStats(host);
    expect(stats.innerHTML).toContain('build1');
    renderStats(host);
    expect(stats.innerHTML).toContain('build2');
    expect(stats.innerHTML).not.toContain('build1');
    expect(order).toEqual(['bind:true', 'bind:true']);
  });
});

function designsHost(designs: (Blueprint | null)[]) {
  const sent: unknown[] = [];
  const panel = new FakeEl('div');
  const host: Record<string, unknown> = {
    designPanel: panel, designAsk: null, bp: { name: 'Mine', parts: [] }, deps: { send: (m: unknown) => sent.push(m), econ: {} },
    designs: () => designs, status: () => {},
    renderDesigns: () => { panel.children = []; renderDesigns(host as unknown as HangarHost); },
    saveDesign: (i: number) => saveDesign(host as unknown as HangarHost, i),
    deleteDesign: (i: number) => deleteDesign(host as unknown as HangarHost, i),
    loadDesign: () => {},
  };
  renderDesigns(host as unknown as HangarHost);
  const buttons = (row: number) => panel.children[row].children;
  const click = (row: number, text: string) => buttons(row).find((b) => b.textContent === text)!.onclick!();
  return { host, sent, click, buttons, panel };
}
const bp = (name: string): Blueprint => ({ name, catalogVersion: 1, parts: [] });

describe('a save or delete that would lose a design asks first', () => {
  it('saving over a kept design or deleting one only asks; the confirm sends, cancel drops the question', () => {
    const t = designsHost([bp('Old'), null]);
    t.click(0, 'Save here');
    expect(t.sent).toEqual([]); // asked, not sent
    expect(t.host.designAsk).toEqual({ slot: 0, kind: 'save' });
    t.click(0, 'Cancel');
    expect(t.host.designAsk).toBeNull();
    t.click(0, '✕');
    expect(t.sent).toEqual([]);
    expect(t.host.designAsk).toEqual({ slot: 0, kind: 'delete' });
    t.click(0, 'Delete');
    expect(t.sent).toEqual([{ type: 'designDelete', slot: 0 }]);
    t.click(0, 'Save here');
    t.click(0, 'Replace');
    expect(t.sent.map((m) => (m as { type: string }).type)).toEqual(['designDelete', 'designSave']);
  });
  it('an empty slot loses nothing: it saves at once', () => {
    const t = designsHost([bp('Old'), null]);
    t.click(1, 'Save here');
    expect(t.sent.map((m) => (m as { type: string; slot: number }).slot)).toEqual([1]);
    expect(t.host.designAsk).toBeNull();
  });
});

describe('the hangar edits a copy of the blueprint until Save', () => {
  it('removing a part changes the editor\'s copy (ui.bp) and never the stored design it was cloned from', () => {
    const stored = bridge.library.get('hauler')!;
    const before = JSON.stringify(stored);
    const copy = cloneJson(stored);
    const geoms = blueprintGeometry(bridge.catalog, copy);
    const target = geoms[geoms.length - 1];
    const ui = { geoms, bp: copy, aids: { edit: (f: () => void) => f(), mirrorOf: () => null }, refresh: () => {} } as unknown as HangarUI;
    const n = copy.parts.length;
    remove(ui, [target.centroid[0], target.centroid[1]]);
    expect(ui.bp.parts.length).toBe(n - 1);
    expect(JSON.stringify(stored)).toBe(before);
    expect(stored.parts.length).toBe(n);
  });
});

describe('modules reach the editor only through this interface', () => {
  it('no hangar module but hangarEdit (which edits the editor\'s own fields) mentions HangarUI outside comments, and none imports it as a value', () => {
    for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      const lines = readFileSync(join(__dirname, f), 'utf8').split('\n');
      const imports = lines.filter((l) => /^\s*import\b/.test(l) && /HangarUI/.test(l));
      for (const l of imports) expect(l, f).toMatch(/import type/);
      if (f !== 'hangarEdit.ts') expect(imports, f).toEqual([]);
    }
  });
});
