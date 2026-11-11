/**
 * The Ship window shell: one tab per id in its order, open on a tab, toggle on the tab on show closes it, Esc is its
 * only key, a live tab redraws at its rate, and a full-screen view over the HUD closes it. The footer's key labels
 * follow the bindings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipCtx, ShipTab, ShipTabId } from './shipTabs';
import { SHIP_TAB_ORDER } from './tabs/index';
import { footerKey } from '../hud/FooterBar';

class El {
  children: El[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  className = '';
  textContent = '';
  title = '';
  id = '';
  scrollTop = 0;
  onclick: (() => void) | null = null;
  private cls = new Set<string>();
  classList = {
    add: (c: string) => { this.cls.add(c); },
    remove: (c: string) => { this.cls.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on ?? !this.cls.has(c)) this.cls.add(c); else this.cls.delete(c); },
    contains: (c: string) => this.cls.has(c),
  };
  append(...c: El[]): void { this.children.push(...c); }
  appendChild(c: El): El { this.children.push(c); return c; }
  replaceChildren(...c: El[]): void { this.children = [...c]; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  addEventListener(t: string, f: (e: unknown) => void): void { (this.listeners[t] ??= []).push(f); }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new El(), body: new El(), head: new El(), getElementById: () => null, activeElement: null });
  vi.stubGlobal('performance', { now: () => 0 });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const drawn: string[] = [];
  const tab = (id: ShipTabId, live = 0): ShipTab => ({ id, label: id, title: id, live, render: () => { drawn.push(id); }, hide: () => { drawn.push(`hide:${id}`); } });
  const sounds: string[] = [];
  const ctx = { sound: (s: string) => sounds.push(s), ship: () => null } as unknown as ShipCtx;
  return { drawn, sounds, ctx, tabs: [tab('status', 250), tab('power'), tab('kills')] };
}

describe('ShipWindow', () => {
  it('opens on a tab, shows another, and toggle on the tab on show closes it', async () => {
    const { ShipWindow } = await import('./ShipWindow');
    const { drawn, ctx, tabs } = setup();
    const w = new ShipWindow(ctx, tabs);
    expect(w.isOpen).toBe(false);
    w.open('power');
    expect(w.isOpen).toBe(true);
    expect(w.tab).toBe('power');
    w.toggle('kills');
    expect(w.isOpen).toBe(true);
    expect(w.tab).toBe('kills');
    expect(drawn).toEqual(['power', 'hide:power', 'kills']);
    w.toggle('kills');
    expect(w.isOpen).toBe(false);
    // (Its key with no tab: opens on the last one shown)
    w.toggle();
    expect(w.tab).toBe('kills');
  });

  it('only Esc is its key (flight keys pass on); a live tab redraws at its rate; a view over the HUD closes it', async () => {
    const { ShipWindow } = await import('./ShipWindow');
    const { drawn, ctx, tabs } = setup();
    const w = new ShipWindow(ctx, tabs);
    w.open('status');
    for (const k of ['KeyW', 'KeyA', 'Space', 'ShiftLeft', 'KeyM']) expect(w.onKey(k)).toBe(false);
    const n = drawn.length;
    w.update(100, false);
    expect(drawn.length).toBe(n);
    w.update(300, false);
    expect(drawn.length).toBe(n + 1);
    w.update(400, true);
    expect(w.isOpen).toBe(false);
    w.open();
    expect(w.onKey('Escape')).toBe(true);
    expect(w.isOpen).toBe(false);
    expect(w.onKey('Escape')).toBe(false);
  });

  it('the tab list: one tab per id, in SHIP_TAB_ORDER', () => {
    expect(SHIP_TAB_ORDER).toEqual(['status', 'power', 'weapons', 'pickup', 'refiner', 'fabricator', 'kills']);
    expect(new Set(SHIP_TAB_ORDER).size).toBe(SHIP_TAB_ORDER.length);
  });
});

describe('footer key labels', () => {
  it("show the action's bound key (rebinds follow), nothing for an unbound one", () => {
    const keys: Record<string, string> = { inventory: 'I', map: 'M', menu: 'Escape' };
    const name = (a: string) => keys[a] ?? '?';
    expect(footerKey('inventory', name)).toBe('I');
    keys.inventory = 'Tab';
    expect(footerKey('inventory', name)).toBe('Tab');
    expect(footerKey('', name)).toBe('');
    expect(footerKey('nothing', name)).toBe('');
  });
});
