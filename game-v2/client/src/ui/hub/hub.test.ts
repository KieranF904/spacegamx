/**
 * The side panel's pure parts: where it fits in the left column (hubLayout), what it remembers (hubPrefs), the tab
 * registry (hubTabs) and the Pilot tab's readout (pilotShipHtml).
 */
import { describe, it, expect } from 'vitest';
import { hubLayout, HUB_BODY_FLOOR, type HubColumn, type HubWant } from './hubLayout';
import { loadFolded, loadHeight, loadTab, saveFolded, saveHeight, saveTab, type PrefStore } from './hubPrefs';
import { HubTabs, type HubTab } from './hubTabs';
import { pilotShipHtml } from './tabs/pilotTab';

// A 1280x1080 column: the readout's bottom at 408 (+8), the chat box's top at 844 (cargo floor 838), the cargo panel's least 94
const col = (o: Partial<HubColumn> = {}): HubColumn => ({ floor: 838, cargoMin: 94, ceiling: 416, lift: 266, gap: 8, ...o });
const want = (o: Partial<HubWant> = {}): HubWant => ({ chrome: 30, body: 240, minBody: 96, folded: false, summoned: false, lift: false, ...o });

describe('hubLayout', () => {
  it('takes what it wants when there is room, and leaves the cargo panel the rest', () => {
    const p = hubLayout(col(), want());
    expect(p).toMatchObject({ hidden: false, lifted: false, total: 270, body: 240 });
    // The cargo panel's ceiling is the hub's lowest top plus its height: it can never grow into the hub
    expect(p.cargoCeiling).toBe(416 + 270);
  });

  it('shrinks to the room, never under the cargo panel least', () => {
    const p = hubLayout(col({ floor: 700 }), want({ body: 400 }));
    // room = 700 - 94 - 8 - 416 = 182
    expect(p.total).toBe(182);
    expect(p.body).toBe(152);
    expect(p.lifted).toBe(false);
    expect(700 - p.cargoCeiling - 8).toBeGreaterThanOrEqual(94);
  });

  it('in a short column (1280x800) shows its tab bar until the pilot opens a tab, then lifts over the readout', () => {
    // chat top 544: floor 538, room = 538 - 94 - 8 - 416 = 20, up to the readout's top: 170
    const idle = hubLayout(col({ floor: 538 }), want());
    expect(idle).toMatchObject({ hidden: false, body: 0, total: 30 });
    const p = hubLayout(col({ floor: 538 }), want({ lift: true }));
    expect(p.lifted).toBe(true);
    expect(p.total).toBe(170);
    // Its top stays below the ship panel (the readout's top)
    expect(538 - 94 - 8 - p.total).toBeGreaterThanOrEqual(266);
    // ...and the cargo panel keeps exactly its least
    expect(538 - p.cargoCeiling - 8).toBe(94);
  });

  it('squeezes under the readout when there is a useful body of room, without lifting', () => {
    const p = hubLayout(col({ floor: 416 + 8 + 94 + 30 + 60 }), want());
    expect(p).toMatchObject({ lifted: false, body: 60, total: 90 });
  });

  it('shows the tab bar alone when even lifting leaves no useful body, and hides when not even that fits', () => {
    const tight = hubLayout(col({ floor: 266 + 94 + 8 + 30 + HUB_BODY_FLOOR - 1 }), want({ lift: true }));
    expect(tight).toMatchObject({ hidden: false, body: 0, total: 30 });
    const none = hubLayout(col({ floor: 300 }), want());
    expect(none.hidden).toBe(true);
    // Hidden, the cargo panel keeps the old gap under the readout
    expect(none.cargoCeiling).toBe(416 - 8);
  });

  it('called up with its key, it shows whatever the room', () => {
    expect(hubLayout(col({ floor: 300 }), want({ summoned: true })).hidden).toBe(false);
    expect(hubLayout(col({ floor: 300 }), want({ folded: true, summoned: true })).hidden).toBe(false);
  });

  it('folded, it is the tab bar', () => {
    const p = hubLayout(col(), want({ folded: true }));
    expect(p).toMatchObject({ hidden: false, body: 0, total: 30, lifted: false });
  });

  it('with the cargo panel off screen (docked, called up) it sits on the floor', () => {
    const p = hubLayout(col({ cargoMin: 0 }), want());
    expect(p.total).toBe(270);
    expect(p.cargoCeiling).toBe(416 + 270);
  });
});

class Mem implements PrefStore {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}
const broken: PrefStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };

describe('hubPrefs', () => {
  it('keeps the tab per pilot, case-insensitively, and drops tabs that are gone', () => {
    const s = new Mem();
    saveTab('Wren', 'pilot', s);
    saveTab('Sora', 'components', s);
    expect(loadTab('wren', ['social', 'pilot'], s)).toBe('pilot');
    expect(loadTab('Sora', ['social', 'pilot'], s)).toBe(null);
    expect(loadTab('Nobody', ['social'], s)).toBe(null);
  });

  it('keeps the fold and the height', () => {
    const s = new Mem();
    expect(loadFolded(s)).toBe(false);
    saveFolded(true, s);
    expect(loadFolded(s)).toBe(true);
    expect(loadHeight(96, s)).toBe(null);
    saveHeight(180.4, s);
    expect(loadHeight(96, s)).toBe(180);
    saveHeight(20, s);
    expect(loadHeight(96, s)).toBe(null);
  });

  it('starts on its defaults with no storage, or storage that throws', () => {
    expect(loadTab('Wren', ['social'], null)).toBe(null);
    expect(() => saveTab('Wren', 'social', broken)).not.toThrow();
    expect(loadTab('Wren', ['social'], broken)).toBe(null);
    expect(loadFolded(broken)).toBe(false);
    expect(loadHeight(96, broken)).toBe(null);
  });
});

describe('HubTabs', () => {
  const tab = (id: string): HubTab => ({ id, label: id, title: id, render: () => {} });

  it('keeps tabs in order, refuses a second of one id, and steps round with the arrow keys', () => {
    const t = new HubTabs();
    for (const id of ['social', 'party', 'pilot', 'components']) t.add(tab(id));
    expect(t.ids()).toEqual(['social', 'party', 'pilot', 'components']);
    expect(() => t.add(tab('party'))).toThrow();
    expect(t.step('social', 1)).toBe('party');
    expect(t.step('social', -1)).toBe('components');
    expect(t.step('components', 1)).toBe('social');
  });
});

describe('pilotShipHtml', () => {
  const pilot = { name: 'Wren <3', level: 4, xp: 120, xpToNext: 300, credits: 12500, system: 'Sol System', sector: 'Core sector', admin: false };
  const ship = {
    name: 'Gunship', parts: 24, mass: 310, topSpeed: 6.2, accel: 0.081, turn: 0.0312, radius: 70, coreHp: 250, coreMax: 300,
    guns: 3, turrets: 1, engines: 2, power: { supply: 90, demand: 70 }, controls: 'helm' as const,
    jump: { phase: 'cooldown', progress: 0.4, cooldownSecs: 12, distance: 63000 },
  };

  it('reads out the pilot and ship (escaped), with the dock button in a ring', () => {
    const html = pilotShipHtml(pilot, ship, 'Helios Station', 'R');
    expect(html).toContain('Wren &lt;3');
    expect(html).toContain('12,500');
    expect(html).toContain('250 / 300');
    expect(html).toContain('Cooling · 12s');
    expect(html).toContain('(1 turrets)');
    expect(html).toContain('about 63k units');
    expect(html).toContain('data-a="dock"');
    expect(html).toContain('Dock at Helios Station');
  });

  it('with no ship, says how to respawn with the bound key', () => {
    const html = pilotShipHtml({ ...pilot, owner: true, admin: true }, null, null, 'F');
    expect(html).toContain('<kbd>F</kbd> to respawn');
    expect(html).toContain('owner');
    expect(html).not.toContain('data-a="dock"');
  });
});
