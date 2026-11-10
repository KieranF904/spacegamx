/**
 * The build views' small view logic, through a stand-in DOM (fakeDom.testkit.ts): the detail switch, the stat chips and
 * card, the drag-paint walk, the parts-list hover card and the animated power-flow layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { Economy, partItemId, type ItemsFile, type PlacedPart, type RecipesFile } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/ships/createShipBridge';
import items from '../../../../data/items.json';
import recipes from '../../../../data/recipes.json';
import { FakeEl, installFakeDom } from '../../fakeDom.testkit';
import { detailToggle } from './detailToggleView';
import { resetDetailMode, setDetailMode, detailMode } from './detailMode';
import { applyChips, DeltaHover } from './statDeltaView';
import type { StatDelta } from './statDelta';
import { DragPaint } from './dragPaint';
import { PartHoverCard, type PartCardDeps } from './partHoverCard';
import { FlowCanvasLayer, type FlowFrame } from './powerFlowView';

let dom: ReturnType<typeof installFakeDom>;
beforeEach(() => { dom = installFakeDom(); resetDetailMode(); });
afterEach(() => { vi.unstubAllGlobals(); resetDetailMode(); });

describe('the switch shows the stored mode and follows changes made elsewhere', () => {
  it('paints the stored mode, repaints when the mode changes elsewhere, and stops listening once disposed', () => {
    setDetailMode('simple');
    const t = detailToggle();
    const [simple, advanced] = (t.el as unknown as FakeEl).children;
    expect(simple.attrs['aria-checked']).toBe('true');
    expect(advanced.attrs['aria-checked']).toBe('false');
    setDetailMode('advanced'); // another editor flips it
    expect(simple.attrs['aria-checked']).toBe('false');
    expect(advanced.attrs['aria-checked']).toBe('true');
    t.dispose();
    setDetailMode('simple');
    expect(advanced.attrs['aria-checked']).toBe('true'); // no longer listening
    // a click on a button sets the stored mode
    advanced.onclick!();
    expect(detailMode()).toBe('advanced');
  });
});

const delta = (over: Partial<StatDelta> = {}): StatDelta => ({
  kind: 'add', label: 'Pip', loose: false, cutOff: 0, powerNote: null, note: null,
  lines: [{ key: 'dps', label: 'Firepower', before: 10, after: 15, text: '+5', tone: 'good' }], ...over,
});

describe('a stats panel opts in by putting <span data-sd="KEY"> beside a stat; chips fill and clear without rebuilding the panel', () => {
  it('fills the opted-in spans from the delta and clears them with null, never replacing the elements', () => {
    const dps = Object.assign(new FakeEl('span'), { dataset: { sd: 'dps' } }), other = Object.assign(new FakeEl('span'), { dataset: { sd: 'hull' }, textContent: ' stale' });
    const root = { querySelectorAll: () => ({ forEach: (f: (e: unknown) => void) => [dps, other].forEach(f) }) } as unknown as ParentNode;
    applyChips(root, delta());
    expect(dps.textContent).toBe(' +5');
    expect(other.textContent).toBe(''); // a stat the delta does not touch is cleared
    applyChips(root, null);
    expect(dps.textContent).toBe('');
    expect(root.querySelectorAll('[data-sd]')).toBeDefined();
  });
});

describe('the card is hidden whenever there is no change under the cursor', () => {
  it('shown for a change, hidden (and the panel told) when the change goes', () => {
    const seen: (StatDelta | null)[] = [];
    const h = new DeltaHover(() => ({}) as never, (d) => seen.push(d));
    const d = delta();
    (h as unknown as { cache: unknown }).cache = { peek: () => d, get: () => d, lastMs: 0 };
    h.update({ rev: 'r1', bp: () => ({}) as never, change: { kind: 'add', part: { piece: 'sq', fn: 'hull', material: 'alloy', x: 0, y: 0, rot: 0, flip: false } } as never, x: 10, y: 10 });
    const card = dom.body.children.find((c) => 'data-stat-delta' in c.attrs)!;
    expect(card.style.display).toBe('block');
    expect(seen).toEqual([d]);
    h.update({ rev: 'r1', bp: () => ({}) as never, change: null, x: 10, y: 10 });
    expect(card.style.display).toBe('none');
    expect(seen).toEqual([d, null]);
    expect(h.current).toBeNull();
  });
});

describe('it only walks cells; whether a part can go or be taken there stays with each editor\'s own rules', () => {
  it('a drag takes and gives only points: the same path gives the same cells whatever the editor does with them', () => {
    const walk = () => { const d = new DragPaint([0.5, 0.5]); return [...d.visit([3.5, 0.5]), ...d.visit([3.5, 2.5])]; };
    const a = walk(), b = walk();
    expect(a).toEqual(b);
    expect(a.map((p) => `${Math.floor(p[0])},${Math.floor(p[1])}`)).toEqual(['1,0', '2,0', '3,0', '3,1', '3,2']);
    // (the press cell, already acted on, is never handed out, and an editor's own mirror cell can be struck off too)
    const d = new DragPaint([0.5, 0.5]);
    d.mark([1.5, 0.5]);
    expect(d.visit([2.5, 0.5]).map((p) => Math.floor(p[0]))).toEqual([2]);
  });
});

const bridge = createShipBridge(loadShipConfigCached(join(__dirname, '../../../../data')));
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, bridge.catalog, {});
const deps: PartCardDeps = { catalog: bridge.catalog, tuning: bridge.tuning, econ, have: () => 0, remaining: () => 0, canMake: () => true, level: () => 99, free: () => false };
const gun = partItemId({ uid: 0, piece: 'sq', fn: 'autocannon', material: 'steel', x: 0, y: 0, rot: 0, flip: false } as PlacedPart);
type Card = { bodyHtml(id: string): string; make(): void; hideNow(): void; onKey(e: unknown): void; current: string; preview: unknown; more: boolean | null; card: FakeEl | null };

describe('"More…" starts open in Advanced and closed in Simple; Shift or a click flips it', () => {
  it('follows the mode until it is flipped, then the pilot\'s choice wins', () => {
    const c = new PartHoverCard(new FakeEl('div') as never, deps) as unknown as Card;
    c.current = gun;
    setDetailMode('advanced');
    expect(c.bodyHtml(gun)).toContain('aria-expanded="true"');
    setDetailMode('simple');
    expect(c.bodyHtml(gun)).toContain('aria-expanded="false"');
    c.onKey({ key: 'Shift', repeat: false }); // Shift flips it (the card is showing: its render needs the card, so none here)
    expect(c.more).toBe(true);
    expect(c.bodyHtml(gun)).toContain('aria-expanded="true"');
    c.onKey({ key: 'Shift', repeat: true }); // a held key does not flip again
    expect(c.more).toBe(true);
    c.onKey({ key: 'a', repeat: false });
    expect(c.more).toBe(true);
  });
});

describe('one card and one preview per list, made on the first hover; the preview stops when the card hides', () => {
  it('make() twice gives one card; hiding stops the preview it holds', () => {
    const c = new PartHoverCard(new FakeEl('div') as never, deps) as unknown as Card;
    c.make();
    const first = c.card;
    c.make();
    expect(c.card).toBe(first);
    expect(dom.body.children.filter((e) => e.id === 'pc-card').length).toBe(1);
    const hide = vi.fn();
    c.preview = { hide };
    c.hideNow();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(first!.hidden).toBe(true);
  });
});

describe('the animated canvas layer runs its frame loop only while it has something to show', () => {
  it('a frame is asked for while shown, none after hide, and none is kept running twice', () => {
    const layer = new FlowCanvasLayer(new FakeEl('div') as never);
    const frame = { flow: { segments: [], marks: [], tints: [], ticks: 0, crosses: 0, short: 0 }, geoms: [], view: { w: 100, h: 100, cx: 0, cy: 0, px: 20, dpr: 1 } } as unknown as FlowFrame;
    expect(dom.frames.size).toBe(0); // nothing to show: no loop
    layer.show(frame);
    expect(dom.frames.size).toBe(1);
    layer.show(frame); // already looping
    expect(dom.frames.size).toBe(1);
    const [id, tick] = [...dom.frames.entries()][0];
    dom.frames.delete(id); tick(); // the loop carries on while shown
    expect(dom.frames.size).toBe(1);
    layer.hide();
    expect(dom.frames.size).toBe(0);
    layer.hide(); // idempotent
    expect(dom.frames.size).toBe(0);
  });
});
