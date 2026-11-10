// Pins the contract invariants of the small client/app modules (chargeGauge, hudReadouts, rockTables, sceneSounds, staffPanels,
// versionOverlay, worldQueries, zoneHud) with a minimal fake DOM and fake hosts (the vitest environment is node)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { asteroidRegistry, EntityType } from '@space-game/common';
import miningTable from '../../../data/mining.json';

/** A fake element: counts how often its text and each style property are written */
class FakeEl {
  writes = { text: 0, style: 0 };
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  classList = { add: () => {}, remove: () => {} };
  offsetWidth = 0;
  dataset: Record<string, string> = {};
  id = '';
  listeners: Record<string, () => void> = {};
  private _text = '';
  private _style: Record<string, string> = {};
  style: Record<string, string> & { cssText: string } = new Proxy({ cssText: '' } as Record<string, string> & { cssText: string }, {
    set: (t, k: string, v: string) => { if (k !== 'cssText') this.writes.style++; t[k] = v; this._style[k] = v; return true; },
  });
  get textContent(): string { return this._text; }
  set textContent(v: string) { this.writes.text++; this._text = v; }
  innerHTML = '';
  querySelector(sel: string): FakeEl | null {
    const m = /data-k="(\w+)"/.exec(sel);
    if (m) return this.kids[m[1]] ?? (this.kids[m[1]] = new FakeEl());
    return this.kids.button ?? (this.kids.button = new FakeEl());
  }
  kids: Record<string, FakeEl> = {};
  addEventListener(ev: string, fn: () => void): void { this.listeners[ev] = fn; }
  appendChild(c: FakeEl): void { this.children.push(c); c.parentElement = this; }
}

let created: FakeEl[] = [];
let byId = new Map<string, FakeEl>();
function installDom(): void {
  created = [];
  byId = new Map();
  const body = new FakeEl();
  vi.stubGlobal('document', {
    body,
    createElement: () => { const e = new FakeEl(); created.push(e); return e; },
    getElementById: (id: string) => {
      const found = [...byId.values()].find((e) => e.id === id);
      if (found) return found;
      return null;
    },
  });
  vi.stubGlobal('location', { reload: vi.fn() });
}

beforeEach(() => installDom());
afterEach(() => vi.unstubAllGlobals());

describe('client.app.charge-gauge', () => {
  it('makes its element on first use and writes a value only when it changes', async () => {
    const { ChargeGauge } = await import('./chargeGauge');
    const g = new ChargeGauge();
    g.update({ charge: 0.5, ready: 1, total: 2 }, true);
    expect(created).toHaveLength(1);
    const el = created[0];
    const t = el.kids.t, f = el.kids.f;
    const before = { text: t.writes.text, fill: f.writes.style, root: el.writes.style };
    g.update({ charge: 0.5, ready: 1, total: 2 }, true);
    g.update({ charge: 0.5, ready: 1, total: 2 }, true);
    expect(created).toHaveLength(1);
    expect({ text: t.writes.text, fill: f.writes.style, root: el.writes.style }).toEqual(before);
    expect(t.textContent).toBe('LASERS CHARGING · 1/2 READY');
    g.update({ charge: 0.75, ready: 1, total: 2 }, true);
    expect(f.style.width).toBe('75%');
    expect(f.writes.style).toBeGreaterThan(before.fill);
    // Hidden once charged or off-screen
    g.update({ charge: 1, ready: 2, total: 2 }, true);
    expect(el.style.display).toBe('none');
  });
});

describe('client.app.hud-readouts', () => {
  it('writes each element only when its value changes', async () => {
    for (const id of ['xpFill', 'xpBar', 'boostFill', 'level', 'xp', 'xpToNext', 'credits', 'systemInfo']) {
      const e = new FakeEl(); e.id = id; byId.set(id, e);
    }
    const { HudReadouts } = await import('./hudReadouts');
    const host = {
      state: { boostFuel: 50, maxBoostFuel: 100, level: 3, credits: 1234, systemId: 'sol' },
      pilot: { profile: { xp: 150, xpLevel: 100, xpNext: 200, level: 3 } },
      shipClient: { myShip: null },
      systemNames: new Map([['sol', 'Sol']]),
    };
    const h = new HudReadouts(host as never);
    h.update();
    const snap = () => [...byId.values()].map((e) => e.writes.text + e.writes.style);
    const first = snap();
    expect(byId.get('credits')!.textContent).toBe((1234).toLocaleString());
    expect(byId.get('systemInfo')!.textContent).toBe('Sol');
    expect(byId.get('xpFill')!.style.width).toBe('50.0%');
    h.update(); h.update();
    expect(snap()).toEqual(first);
    // A changed value rewrites just its element
    host.state.credits = 99;
    h.update();
    expect(byId.get('credits')!.textContent).toBe('99');
    expect(byId.get('credits')!.writes.text).toBe(2);
    expect(byId.get('level')!.writes.text).toBe(1);
  });
});

describe('client.app.rock-tables', () => {
  it('registers every named rock type and belt mix from data/mining.json (the table the server registers)', async () => {
    await import('./rockTables');
    const types = (miningTable as unknown as { types: Record<string, { name?: string; size?: [number, number] }> }).types;
    let named = 0;
    for (const [id, t] of Object.entries(types)) {
      if (!t.name || !t.size) continue;
      named++;
      const def = asteroidRegistry.get(id);
      expect(def?.name, id).toBe(t.name);
      expect([def?.size.min, def?.size.max], id).toEqual(t.size);
    }
    expect(named).toBeGreaterThan(0);
    const fields = (miningTable as unknown as { fields: Record<string, Record<string, number>> }).fields;
    for (const [fid, mix] of Object.entries(fields)) {
      const got = asteroidRegistry.getField(fid)?.asteroidTypes.map((a) => [a.id, a.weight]);
      expect(got, fid).toEqual(Object.entries(mix).filter(([k]) => !k.startsWith('_')));
    }
  });
});

describe('client.app.scene-sounds', () => {
  async function make(litBeams: () => unknown[]) {
    const { SceneSounds } = await import('./sceneSounds');
    const audio = {
      setLoop: vi.fn(), play: vi.fn(), playUI: vi.fn(), setBeams: vi.fn(), setMusicPlace: vi.fn(), setDread: vi.fn(),
    };
    const combatSounds = { frame: vi.fn() };
    const host = {
      state: { entities: new Map([[1, { vx: 0, vy: 0, renderX: 0, renderY: 0 }]]), playerId: 1, boostFuel: 0, systemId: 'sol', getRawServerTick: () => 0 },
      audio, combatSounds,
      input: { isKeyDown: () => false },
      shipClient: { hangarOpen: false, litBeams, horizonDanger: () => 0, setPlanetHint: vi.fn() },
      musicPlace: { update: () => null },
      objectives: { update: vi.fn() },
      world: { currentSystem: () => undefined, pocketWayIn: () => null, planetBelow: () => null },
      loggedIn: true, menuOpen: false, stationOpen: false, bossId: null, systemArrivedAt: 0,
      updateZone: vi.fn(),
    };
    return { s: new SceneSounds(host as never), audio, combatSounds };
  }

  it('hears a beam light once, however many frames it stays lit', async () => {
    const beam = { owner: 5, part: 2, model: 'lance_lance', kind: 'lance', x: 10, y: 20, own: false };
    let lit: unknown[] = [beam];
    const { s, audio } = await make(() => lit);
    s.update(1000); s.update(1016); s.update(1032);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.play.mock.calls[0][0]).toBe('lance_fire');
    // Out, then lit again: heard again
    lit = []; s.update(1048);
    lit = [beam]; s.update(1064);
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it('plays no shot or impact sound itself: only the combat sounds frame is called for them', async () => {
    const { s, audio, combatSounds } = await make(() => []);
    s.update(5000);
    expect(combatSounds.frame).toHaveBeenCalledWith(true);
    expect(audio.play).not.toHaveBeenCalled();
    expect(audio.playUI).not.toHaveBeenCalled();
    // Fresh arrival: the shells already flying are not played
    const fresh = await make(() => []);
    fresh.s.update(1000);
    expect(fresh.combatSounds.frame).toHaveBeenCalledWith(false);
  });
});

describe('client.app.staff-panels', () => {
  const made = { admin: 0, contrib: 0, destroyed: 0 };
  beforeEach(() => {
    made.admin = made.contrib = made.destroyed = 0;
    vi.resetModules();
    vi.doMock('../ui/AdminPanel', () => ({ AdminPanel: class { constructor() { made.admin++; } destroy() { made.destroyed++; } update() {} } }));
    vi.doMock('../ui/ContributorPanel', () => ({ ContributorPanel: class { constructor() { made.contrib++; } destroy() { made.destroyed++; } update() {} } }));
  });
  afterEach(() => { vi.doUnmock('../ui/AdminPanel'); vi.doUnmock('../ui/ContributorPanel'); });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const host = (admin: boolean) => ({
    state: {}, pilot: { econ: {} }, renderer: {}, input: {}, w: { systemMapUI: {} }, isAdmin: () => admin,
    send: vi.fn(), flyTo: vi.fn(), chat: vi.fn(),
  });

  it('makes the admin panel once, never for a non-admin, and not after sign-out while it loaded', async () => {
    const { StaffPanels } = await import('./staffPanels');
    const a = new StaffPanels(host(true) as never);
    a.startAdmin(); a.startAdmin();
    await flush();
    a.startAdmin();
    expect(made.admin).toBe(1);
    const n = new StaffPanels(host(false) as never);
    n.startAdmin(); await flush();
    expect(made.admin).toBe(1);
    expect(n.adminPanel).toBeNull();
    // Signed out while the chunk loaded
    let admin = true;
    const h = host(true); h.isAdmin = () => admin;
    const late = new StaffPanels(h as never);
    late.startAdmin(); admin = false; await flush();
    expect(late.adminPanel).toBeNull();
    a.stopAdmin();
    expect(a.adminPanel).toBeNull();
    expect(made.destroyed).toBe(1);
  });

  it('makes the notes panel once, and not after a stop while it loaded', async () => {
    const { StaffPanels } = await import('./staffPanels');
    const c = new StaffPanels(host(false) as never);
    c.startContrib(); c.startContrib(); await flush();
    expect(made.contrib).toBe(1);
    const s = new StaffPanels(host(false) as never);
    s.startContrib(); s.stopContrib(); await flush();
    expect(s.contribPanel).toBeNull();
    expect(made.contrib).toBe(1);
  });
});

describe('client.app.version-overlay', () => {
  it('shows the notice once per page', async () => {
    const { showVersionOverlay } = await import('./versionOverlay');
    // Once it is in the page (found by its id) a second call adds nothing
    showVersionOverlay();
    expect(created).toHaveLength(1);
    expect(created[0].id).toBe('version-overlay');
    byId.set('version-overlay', created[0]);
    showVersionOverlay(); showVersionOverlay();
    expect(created).toHaveLength(1);
  });
});

describe('client.app.world-queries', () => {
  it('looks the current system up once per system, not per frame', async () => {
    const { WorldQueries } = await import('./worldQueries');
    // (The same module instance the code under test reads: modules were reset above)
    const fresh = (await import('../../../data/systems.json')).default;
    const systems = (fresh as unknown as { systems: { id: string }[] }).systems;
    expect(systems.length).toBeGreaterThan(1);
    const state = { systemId: systems[0].id, entities: new Map(), playerId: 0 };
    const w = new WorldQueries(state as never);
    const find = vi.spyOn(systems, 'find');
    for (let i = 0; i < 50; i++) expect(w.currentSystem()).toBe(systems[0]);
    expect(find).toHaveBeenCalledTimes(1);
    state.systemId = systems[1].id;
    expect(w.currentSystem()).toBe(systems[1]);
    expect(w.currentSystem()).toBe(systems[1]);
    expect(find).toHaveBeenCalledTimes(2);
    find.mockRestore();
  });
});

describe('client.app.zone-hud', () => {
  // The server's inPvpZone (server/src/gameServer/rules.ts): outer mode safe within safeRadius (3000) of a station, otherwise
  // within max(station radius + 1500, 2200); no pvp block means nothing to be unsafe from
  async function zone(sys: unknown, me: { x: number; y: number }, stations: { x: number; y: number; r: number }[]): Promise<boolean> {
    const { updateZone } = await import('./zoneHud');
    const entities = new Map<number, unknown>([[1, { renderX: me.x, renderY: me.y }]]);
    stations.forEach((s, i) => entities.set(10 + i, { type: EntityType.Station, renderX: s.x, renderY: s.y, data: { 8: s.r } }));
    let safe: boolean | undefined;
    updateZone({
      state: { entities, playerId: 1, threats: {}, regionThreats: {} },
      world: { currentSystem: () => sys },
      shipClient: { myRating: () => 0 },
      regionUI: { current: () => null, update: () => {} },
      w: { systemMapUI: {}, pilotHud: { setZone: (_n: string, _d: number, _p: boolean, s: boolean) => { safe = s; }, setRating: () => {} } },
    } as never);
    return safe!;
  }
  const base = { name: 'Test System', danger: 1 };

  it('a system without pvp is always safe', async () => {
    expect(await zone(base, { x: 99999, y: 0 }, [])).toBe(true);
  });
  it('outer mode: safe inside safeRadius (default 3000) of a station only', async () => {
    const sys = { ...base, pvp: { mode: 'outer' } };
    expect(await zone(sys, { x: 2999, y: 0 }, [{ x: 0, y: 0, r: 100 }])).toBe(true);
    expect(await zone(sys, { x: 3001, y: 0 }, [{ x: 0, y: 0, r: 100 }])).toBe(false);
    expect(await zone({ ...base, pvp: { mode: 'outer', safeRadius: 500 } }, { x: 600, y: 0 }, [{ x: 0, y: 0, r: 100 }])).toBe(false);
  });
  it('other modes: safe within max(station radius + 1500, 2200)', async () => {
    const sys = { ...base, pvp: { mode: 'inner' } };
    expect(await zone(sys, { x: 2199, y: 0 }, [{ x: 0, y: 0, r: 100 }])).toBe(true);
    expect(await zone(sys, { x: 2201, y: 0 }, [{ x: 0, y: 0, r: 100 }])).toBe(false);
    expect(await zone(sys, { x: 3499, y: 0 }, [{ x: 0, y: 0, r: 2000 }])).toBe(true);
    expect(await zone(sys, { x: 3501, y: 0 }, [{ x: 0, y: 0, r: 2000 }])).toBe(false);
    // With no station at all a pvp system is unsafe everywhere
    expect(await zone(sys, { x: 0, y: 0 }, [])).toBe(false);
  });
});
