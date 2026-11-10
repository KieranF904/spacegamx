/**
 * The palette's subcategories and weapon filters (paletteFilters.ts), the compact card's numbers (paletteCard.ts)
 * and the gun preview's plan and trigger beat (gunPreview/gunPlan.ts).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { loadShipConfigCached } from '../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../server/src/ships/createShipBridge';
import { COMP_TABS, guideRows } from '../ui/componentGuide';
import { PLATES } from '../ui/componentData';
import { paletteRows } from './paletteModel';
import { ALL, applyFilters, emptyFilters, loadFilters, saveFilters, subCounts, subOfFn, subsOf, usesAmmo, weaponRole } from './paletteFilters';
import { cardStats, fedFrom } from './paletteCard';
import { FireClock, flightTicks, gunPlan, segmentCircle } from './gunPreview/gunPlan';

const { catalog, tuning } = createShipBridge(loadShipConfigCached(join(__dirname, '../../../data')));
const rows = paletteRows(catalog, guideRows(catalog, PLATES));
const fn = (id: string) => catalog.functions.get(id)!;
const ids = (rs: { fn: string }[]) => rs.map((r) => r.fn);

describe('weapon roles', () => {
  it('reads each role from the data', () => {
    expect(weaponRole(fn('cannon_pip'), tuning)).toBe('direct');
    expect(weaponRole(fn('autocannon_stinger'), tuning)).toBe('burst');
    expect(weaponRole(fn('laser_cutter'), tuning)).toBe('beam');
    expect(weaponRole(fn('laser_glint'), tuning)).toBe('beam');
    expect(weaponRole(fn('missile_dart'), tuning)).toBe('guided');
    expect(weaponRole(fn('flak_burst'), tuning)).toBe('area');
    expect(weaponRole(fn('point_defence_turret'), tuning)).toBe('support');
    expect(weaponRole(fn('utility_repair_beam'), tuning)).toBe('support');
  });

  it('knows which guns fire ammunition items', () => {
    expect(usesAmmo(fn('missile_dart'))).toBe(true);
    expect(usesAmmo(fn('flak_burst'))).toBe(true);
    expect(usesAmmo(fn('cannon_pip'))).toBe(false);
    expect(usesAmmo(fn('railgun_rail_driver'))).toBe(false);
  });
});

describe('subcategories', () => {
  it('every tab with models splits into groups and each model lands in one', () => {
    for (const t of COMP_TABS) {
      const subs = subsOf(t.id);
      expect(subs.length, t.id).toBeGreaterThan(1);
      const tabRows = rows.filter((r) => r.tab === t.id && r.kind === 'model');
      const lost = tabRows.filter((r) => subOfFn(t.id, fn(r.fn), tuning) === null).map((r) => r.fn);
      expect(lost, `${t.id} models in no group`).toEqual([]);
    }
  });

  it('the group rows partition the tab: counts add up to All', () => {
    for (const t of COMP_TABS) {
      const tabRows = rows.filter((r) => r.tab === t.id);
      const counts = subCounts(tabRows, t.id, catalog, tuning);
      const sum = [...counts].filter(([k]) => k !== ALL).reduce((a, [, n]) => a + n, 0);
      expect(counts.get(ALL)).toBe(tabRows.length);
      expect(sum, t.id).toBeLessThanOrEqual(tabRows.length);
    }
  });

  it('filters by group, ammo and mount', () => {
    const weapons = rows.filter((r) => r.tab === 'weapons');
    const st = emptyFilters();
    expect(applyFilters(weapons, 'weapons', st, catalog, tuning)).toHaveLength(weapons.length);
    st.sub.weapons = 'beam';
    const beams = ids(applyFilters(weapons, 'weapons', st, catalog, tuning));
    expect(beams).toContain('laser_cutter');
    expect(beams).not.toContain('cannon_pip');
    st.sub.weapons = 'guided';
    expect(ids(applyFilters(weapons, 'weapons', st, catalog, tuning))).toContain('missile_dart');
    delete st.sub.weapons;
    st.ammo = 'ammo';
    const ammo = ids(applyFilters(weapons, 'weapons', st, catalog, tuning));
    expect(ammo).toContain('missile_dart');
    expect(ammo).not.toContain('cannon_pip');
    st.ammo = 'none';
    expect(ids(applyFilters(weapons, 'weapons', st, catalog, tuning))).not.toContain('missile_dart');
    st.ammo = 'any';
    st.mount = 'turret';
    const turrets = ids(applyFilters(weapons, 'weapons', st, catalog, tuning));
    expect(turrets).toContain('autocannon_rattler');
    expect(turrets).not.toContain('cannon_pip');
  });

  it('ammo and mount filters do not touch other tabs', () => {
    const power = rows.filter((r) => r.tab === 'power');
    const st = { ...emptyFilters(), ammo: 'ammo' as const, mount: 'fixed' as const };
    expect(applyFilters(power, 'power', st, catalog, tuning)).toHaveLength(power.length);
  });

  it('structure splits by function', () => {
    const structure = rows.filter((r) => r.tab === 'structure');
    const st = emptyFilters();
    st.sub.structure = 'armor';
    expect(ids(applyFilters(structure, 'structure', st, catalog, tuning))).toEqual(['armor']);
  });
});

describe('remembered choice', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('round-trips, and drops anything unknown', () => {
    const s = store();
    const st = emptyFilters();
    st.sub.weapons = 'beam';
    st.ammo = 'none';
    st.mount = 'fixed';
    saveFilters(st, s);
    expect(loadFilters(s)).toEqual(st);
    s.setItem('hangar.palette.filters.v1', JSON.stringify({ sub: { weapons: 'nope', bogus: 'x', power: 'store' }, ammo: 'x', mount: 7 }));
    expect(loadFilters(s)).toEqual({ sub: { power: 'store' }, ammo: 'any', mount: 'any' });
  });

  it('survives blocked or broken storage', () => {
    expect(loadFilters(null)).toEqual(emptyFilters());
    expect(loadFilters({ getItem: () => { throw new Error('blocked'); } })).toEqual(emptyFilters());
    expect(() => saveFilters(emptyFilters(), { setItem: () => { throw new Error('full'); } })).not.toThrow();
    expect(loadFilters({ getItem: () => '{not json' })).toEqual(emptyFilters());
  });
});

describe('compact card', () => {
  const card = (id: string) => {
    const f = fn(id);
    return cardStats(catalog, tuning, f, f.pieces === '*' ? 'sq' : f.pieces[0], f.material ?? 'alloy');
  };

  it('a gun gets damage, rate and reach bars between 0 and 1', () => {
    const c = card('cannon_pip');
    expect(c.bars.map((b) => b.id)).toEqual(['hit', 'rate', 'range']);
    for (const b of c.bars) { expect(b.frac).toBeGreaterThan(0); expect(b.frac).toBeLessThanOrEqual(1); expect(b.text).not.toBe(''); }
  });

  it('bars compare across guns: a hammer hits harder than a stinger, a stinger fires faster', () => {
    const hit = (id: string) => card(id).bars.find((b) => b.id === 'hit')!.frac;
    const rate = (id: string) => card(id).bars.find((b) => b.id === 'rate')!.frac;
    expect(hit('cannon_hammer')).toBeGreaterThan(hit('autocannon_stinger'));
    expect(rate('autocannon_rattler')).toBeGreaterThan(rate('cannon_longbarrel'));
  });

  it('a held beam shows damage a second and the held tag, not a rate', () => {
    const c = card('laser_cutter');
    expect(c.held).toBe(true);
    expect(c.bars.map((b) => b.id)).toEqual(['dps', 'range']);
  });

  it('ammo guns show the ammo item and rounds a shot; power guns show none', () => {
    expect(card('missile_dart').ammo).toEqual({ item: tuning.weapons!.missile.ammo!.item, per: fn('missile_dart').fire?.rounds ?? 1 });
    expect(card('cannon_pip').ammo).toBeNull();
    expect(card('railgun_rail_driver').ammo).toBeNull();
  });

  it('power: a gun draws, a reactor makes, a battery holds, with the side it is fed from', () => {
    const gun = card('cannon_pip').power;
    expect(gun?.kind).toBe('draw');
    expect(gun!.amount).toBeGreaterThan(0);
    expect(card('power_cell_reactor').power?.kind).toBe('make');
    expect(card('power_battery').power?.kind).toBe('hold');
    expect(card('missile_dart').power).toBeNull();
  });

  it('fedFrom names the in-port sides in plain words', () => {
    expect(fedFrom({ ports: [{ dir: 'in', side: 'S', rate: 10 }, { dir: 'out', side: 'N', rate: 10 }] })).toBe('back');
    expect(fedFrom({ ports: [{ dir: 'in', side: 'W', rate: 1 }, { dir: 'in', side: 'S', rate: 1 }] })).toBe('left, back');
    expect(fedFrom({})).toBe('');
  });

  it('non-weapons give one or two headline numbers', () => {
    const c = card('engine_plasma_drive');
    expect(c.bars).toEqual([]);
    expect(c.heads.length).toBeGreaterThan(0);
    expect(c.heads.length).toBeLessThanOrEqual(2);
  });
});

describe('gun preview plan', () => {
  it('reads the round and the beat from the data', () => {
    const p = gunPlan(catalog, tuning, fn('cannon_pip'))!;
    expect(p.beam).toBe(false);
    expect(p.fire.interval).toBe(fn('cannon_pip').fire!.interval);
    expect(p.speed).toBeGreaterThan(0);
    expect(p.range).toBeGreaterThan(0);
  });

  it('beams, pulses and seekers are told apart; support guns have their own', () => {
    expect(gunPlan(catalog, tuning, fn('laser_cutter'))!.beam).toBe(true);
    expect(gunPlan(catalog, tuning, fn('laser_glint'))!.pulse).not.toBeNull();
    expect(gunPlan(catalog, tuning, fn('missile_dart'))!.tracked).toBe(true);
    expect(gunPlan(catalog, tuning, fn('mortar_lobber'))!.lob).toBe(true);
    expect(gunPlan(catalog, tuning, fn('point_defence_turret'))!.support).toBe('pd');
    expect(gunPlan(catalog, tuning, fn('utility_repair_beam'))!.support).toBe('repair');
    expect(gunPlan(catalog, tuning, fn('engine_plasma_drive'))).toBeNull();
  });

  it('every weapon model that has a plan has a usable one', () => {
    for (const f of catalog.functions.values()) {
      if (!f.model || !f.weapon) continue;
      const p = gunPlan(catalog, tuning, f);
      if (!p) continue;
      expect(p.fire.interval, f.id).toBeGreaterThan(0);
      if (!p.beam && !p.support) expect(p.maxSpeed || p.speed, f.id).toBeGreaterThan(0);
    }
  });
});

describe('fire clock', () => {
  const fires = (clock: FireClock, ticks: number) => {
    const at: number[] = [];
    for (let t = 1; t <= ticks; t++) if (clock.step()) at.push(t);
    return at;
  };

  it('a cycle fires every interval, starting at once', () => {
    expect(fires(new FireClock({ model: 'cycle', interval: 20 }), 100)).toEqual([1, 21, 41, 61, 81]);
  });

  it('a clip fires its rounds then reloads', () => {
    const at = fires(new FireClock({ model: 'clip', interval: 10, clip: 3, reload: 60 }), 140);
    expect(at).toEqual([1, 11, 21, 91, 101, 111]);
  });

  it('a clip of multi-round shots counts shots, not rounds', () => {
    const at = fires(new FireClock({ model: 'clip', interval: 10, clip: 8, rounds: 4, reload: 30 }), 60);
    expect(at).toEqual([1, 11, 51]);
  });

  it('a charge gun charges, fires, and cools', () => {
    const at = fires(new FireClock({ model: 'charge', interval: 1, charge: 30, cooldown: 20 }), 120);
    expect(at).toEqual([30, 80]);
  });

  it('a spinning gun speeds up', () => {
    const at = fires(new FireClock({ model: 'cycle', interval: 20, spin: { from: 20, to: 5, up: 60, down: 30 } }), 200);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
  });

  it('a beam never fires; it is lit for a stretch then dark', () => {
    const c = new FireClock({ model: 'beam', interval: 1 }, true);
    expect(fires(c, 50)).toEqual([]);
    expect(c.lit()).toBe(true);
    for (let i = 0; i < FireClock.HOLD - 50; i++) c.step();
    expect(c.lit()).toBe(false);
  });
});

describe('flight maths', () => {
  it('flightTicks counts whole ticks, speeding up with accel', () => {
    expect(flightTicks(100, 10, 0, 10)).toBe(10);
    expect(flightTicks(100, 5, 5, 40)).toBeLessThan(flightTicks(100, 5, 0, 5));
    expect(flightTicks(0, 5, 0, 5)).toBe(1);
  });

  it('segmentCircle finds the first contact', () => {
    expect(segmentCircle(0, 0, 100, 0, 100, 0, 10)).toBeCloseTo(0.9);
    expect(segmentCircle(0, 0, 100, 0, 100, 50, 10)).toBeNull();
    expect(segmentCircle(0, 0, 50, 0, 100, 0, 10)).toBeNull();
    expect(segmentCircle(95, 0, 120, 0, 100, 0, 10)).toBe(0);
  });
});
