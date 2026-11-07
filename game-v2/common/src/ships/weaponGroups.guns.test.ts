/**
 * Weapon groups in the firing step (ships/guns.ts stepGuns, sim/guns.ts gunControls): each gun fires on its own trigger,
 * from the trigger word and last tick's; with both selections "all" it is what it was before groups.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from './blueprint.js';
import { createShipState, type ShipState } from './state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from './testData.js';
import { stepGuns, type GunOrders } from './guns.js';
import type { ShipTuning } from './tuning.js';
import { packGroupSel, trigWord } from './weaponGroups.js';
import { gunControls } from '../sim/guns.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8');
const corsairText = readFileSync(join(SHIP_DATA_DIR, 'blueprints/fixtures/corsair.json'), 'utf-8');
const UP = -Math.PI / 2;
const pose = { x: 0, y: 0, angle: UP };

/** A Sparrow with both Pips made `model`, the first in groups `a`, the second in `b` (masks) */
function pair(model: string, a: number, b: number): ShipState {
  const bp = parseBlueprint(sparrowText);
  const pips = bp.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = model; pips[1].fn = model;
  const set = (p: typeof pips[0], m: number) => { if (m === 1) delete p.wg; else p.wg = m; };
  set(pips[0], a); set(pips[1], b);
  return createShipState(catalog, tuning, 1, bp, 0);
}

/** What `sel` fires with the buttons as given, tick by tick: the parts that fired each tick */
function run(s: ShipState, ticks: number, input: (t: number) => { left: boolean; right: boolean; sel: number }, orders: Partial<GunOrders> = {}): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let t = 1; t <= ticks; t++) {
    const i = input(t), c = gunControls(s, i.left, i.right, false, i.sel);
    const r = stepGuns(s, pose, { firing: c.firing, word: c.word, aimWorld: UP, aimDist: 0, ...orders }, t, tuning);
    for (const sh of r.shots) out.set(t, [...(out.get(t) ?? []), sh.w.part]);
  }
  return out;
}
const firedParts = (m: Map<number, number[]>): Set<number> => new Set([...m.values()].flat());

describe('weapon groups: which guns fire', () => {
  it('with both selections on all, every gun fires on the left button, as before groups', () => {
    const s = pair('cannon_pip', 1, 1);
    expect(firedParts(run(s, 60, () => ({ left: true, right: false, sel: 0 }))).size).toBe(2);
  });

  it('a group fires only its members', () => {
    const s = pair('cannon_pip', 1, 2);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    expect([...firedParts(run(s, 60, () => ({ left: true, right: false, sel: packGroupSel(1, 0) })))]).toEqual([p0]);
    const s2 = pair('cannon_pip', 1, 2);
    expect([...firedParts(run(s2, 60, () => ({ left: true, right: false, sel: packGroupSel(2, 0) })))]).toEqual([p1]);
    // (a group nothing is in fires nothing)
    const s3 = pair('cannon_pip', 1, 2);
    expect(run(s3, 60, () => ({ left: true, right: false, sel: packGroupSel(4, 0) })).size).toBe(0);
  });

  it('a weapon in several groups fires from each', () => {
    for (const g of [1, 2]) {
      const s = pair('cannon_pip', 3, 4);
      const [p0] = s.derived.weapons.map((w) => w.part);
      expect([...firedParts(run(s, 60, () => ({ left: true, right: false, sel: packGroupSel(g, 0) })))]).toEqual([p0]);
    }
  });

  it('the right button fires its own group, and the left its own, together', () => {
    const s = pair('cannon_pip', 1, 2);
    const both = run(s, 60, () => ({ left: true, right: true, sel: packGroupSel(1, 2) }));
    expect(firedParts(both).size).toBe(2);
    const s2 = pair('cannon_pip', 1, 2);
    const only = run(s2, 60, () => ({ left: false, right: true, sel: packGroupSel(1, 2) }));
    expect([...firedParts(only)]).toEqual([s2.derived.weapons[1].part]);
  });

  it('the right button on a group, on a ship with mining lasers: it fires that group and does not mine', () => {
    const miners = { derived: { miners: [{ part: 0 }] } } as unknown as Pick<ShipState, 'derived'>;
    const noMiners = { derived: { miners: [] } } as unknown as Pick<ShipState, 'derived'>;
    // (all: the right button mines, as before)
    expect(gunControls(miners, false, true, false, 0)).toMatchObject({ firing: false, mining: true });
    // (a group: the right button fires it, the lasers are off)
    expect(gunControls(miners, false, true, false, packGroupSel(0, 2))).toMatchObject({ firing: true, mining: false });
    // (the left button never mines; a ship without lasers fires on the right either way)
    expect(gunControls(miners, true, false, false, packGroupSel(0, 2))).toMatchObject({ firing: true, mining: false });
    expect(gunControls(noMiners, false, true, false, 0)).toMatchObject({ firing: true, mining: false });
    expect(gunControls(miners, false, true, true, packGroupSel(0, 2))).toMatchObject({ firing: false, mining: false });
  });

  it('the trigger word carries the buttons (none while stopped) and the selection', () => {
    const d = { derived: { miners: [] } } as unknown as Pick<ShipState, 'derived'>;
    expect(gunControls(d, true, true, false, 0x21).word).toBe(trigWord(true, true, 0x21));
    expect(gunControls(d, true, true, true, 0x21).word).toBe(trigWord(false, false, 0x21));
  });
});

describe('weapon groups: per-gun semi-automatic clicks', () => {
  it('a semi-automatic gun answers its own click: changing the group while held clicks the newly selected gun only', () => {
    const s = pair('railgun_rail_driver', 1, 2);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    const sel = (t: number) => packGroupSel(t < 40 ? 1 : 2, 0);
    const fired = run(s, 120, (t) => ({ left: true, right: false, sel: sel(t) }));
    const by = (p: number) => [...fired.entries()].filter(([, ps]) => ps.includes(p)).map(([t]) => t);
    // (held on group 1: its gun fires once; group 2's gun not at all until the selection moves to it, then once; the first not again)
    expect(by(p0)).toHaveLength(1);
    expect(by(p0)[0]).toBeLessThan(10);
    expect(by(p1)).toHaveLength(1);
    expect(by(p1)[0]).toBeGreaterThanOrEqual(40);
    expect(by(p1)[0]).toBeLessThan(50);
  });

  it('a gun held through a group change that adds another gun is not clicked again (no extra shot)', () => {
    // (the first gun in groups 1 and 2, the second in group 2: held on 1, then on 2, which only the second's trigger goes down for)
    const s = pair('railgun_rail_driver', 0b011, 0b010);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    const fired = run(s, 120, (t) => ({ left: true, right: false, sel: packGroupSel(t < 40 ? 1 : 2, 0) }));
    const by = (p: number) => [...fired.entries()].filter(([, ps]) => ps.includes(p)).map(([t]) => t);
    expect(by(p0)).toHaveLength(1);
    expect(by(p0)[0]).toBeLessThan(10);
    expect(by(p1)).toHaveLength(1);
    expect(by(p1)[0]).toBeGreaterThanOrEqual(40);
    expect(s.clickMasks).toBeUndefined();
  });

  it('a group change back and forth while held fires no extra shot from a gun held through it', () => {
    // (the first gun in group 2, the second in groups 1 and 2. Held on 2: the first takes the click (the pair takes turns).
    // A dip to group 1 and back: only the first's trigger goes down again, and it is still busy; the second, held all
    // along and ready, must not fire for it)
    const s = pair('railgun_rail_driver', 0b010, 0b011);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    const fired = run(s, 40, (t) => ({ left: true, right: false, sel: packGroupSel(t === 5 || t === 6 ? 1 : 2, 0) }));
    const by = (p: number) => [...fired.entries()].filter(([, ps]) => ps.includes(p)).map(([t]) => t);
    expect(by(p0)).toEqual([1]);
    expect(by(p1)).toEqual([]);
  });

  it('the other button pressed while one is held clicks only its own group\'s guns', () => {
    // (left on group 1 fires the first gun; the right button on group 2 pressed later: only the second answers)
    const s = pair('railgun_rail_driver', 0b011, 0b010);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    const fired = run(s, 120, (t) => ({ left: true, right: t >= 40, sel: packGroupSel(1, 2) }));
    const by = (p: number) => [...fired.entries()].filter(([, ps]) => ps.includes(p)).map(([t]) => t);
    expect(by(p0)).toHaveLength(1);
    expect(by(p1)).toHaveLength(1);
    expect(by(p1)[0]).toBeGreaterThanOrEqual(40);
  });

  it('a left click is not answered by a gun only in the right button\'s group', () => {
    const s = pair('railgun_rail_driver', 0b001, 0b010);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    const fired = run(s, 60, (t) => ({ left: t % 20 < 3, right: false, sel: packGroupSel(1, 2) }));
    expect(firedParts(fired).has(p0)).toBe(true);
    expect(firedParts(fired).has(p1)).toBe(false);
  });

  it('a click waiting on a reloading gun is still answered when it is ready; a gun not clicked is not', () => {
    // (the first gun's click comes while it is mid-cycle: it fires once ready, within the click's few ticks)
    const s = pair('railgun_rail_driver', 0b011, 0b010);
    const [p0, p1] = s.derived.weapons.map((w) => w.part);
    // (fire the first, release, then press again 2 ticks before its next shot is ready: interval from the gun)
    const w0 = s.derived.weapons[0];
    const again = 1 + Math.ceil(w0.interval) - 2;
    const fired = run(s, 60, (t) => ({ left: t === 1 || (t >= again && t < again + 1), right: false, sel: packGroupSel(1, 0) }));
    const by = (p: number) => [...fired.entries()].filter(([, ps]) => ps.includes(p)).map(([t]) => t);
    expect(by(p0)).toHaveLength(2);
    expect(by(p0)[1]).toBeGreaterThan(again);
    expect(by(p1)).toHaveLength(0);
  });

  it('with the default selection a held trigger fires one shot a click for a pair of semi-automatic guns, as before groups', () => {
    const s = pair('railgun_rail_driver', 1, 1);
    const fired = run(s, 120, () => ({ left: true, right: false, sel: 0 }));
    // (one shot a click for each kind: the pair takes turns)
    expect([...fired.values()].flat()).toHaveLength(1);
  });
});

describe('weapon groups: per-gun turret slew', () => {
  it('a turret outside the group points at the aim at once while the group fires; one in it slews', () => {
    const bp = parseBlueprint(corsairText);
    const s0 = createShipState(catalog, tuning, 1, bp, 0);
    const tw = s0.derived.weapons.filter((w) => w.mount === 'turret' && w.window);
    expect(tw.length).toBeGreaterThan(1);
    // (the first turret goes to group 2, the rest stay in group 1)
    const first = bp.parts[tw[0].part];
    first.wg = 2;
    const s = createShipState(catalog, tuning, 1, bp, 0);
    const w0 = s.derived.weapons.find((w) => w.part === tw[0].part)!, w1 = s.derived.weapons.find((w) => w.part === tw[1].part)!;
    const win0 = w0.window!, win1 = w1.window!;
    const world = (local: number) => local + Math.PI / 2;
    const far = (w: typeof win0) => w.center + w.half * 0.8, near = (w: typeof win0) => w.center - w.half * 0.8;
    const sel = packGroupSel(1, 0);
    const step = (t: number, aim: number) => {
      const c = gunControls(s, true, false, false, sel);
      stepGuns(s, { x: 0, y: 0, angle: 0 }, { firing: c.firing, word: c.word, aimWorld: aim, aimDist: 0 }, t, tuning);
    };
    // (both aimed far on the trigger-down tick, then the aim swings across while held)
    step(1, world(far(win0)));
    step(2, world(far(win0)));
    const a0 = s.aim[w0.part], a1 = s.aim[w1.part];
    step(3, world(near(win0)));
    // (turret 1, in the fired group: slewing, a limited step from where it was; turret 0, outside it: straight on the aim)
    const moved1 = Math.abs(s.aim[w1.part] - a1);
    expect(moved1).toBeLessThanOrEqual(tuning.turret.slewRate + 1e-9);
    const moved0 = Math.abs(s.aim[w0.part] - a0);
    expect(moved0).toBeGreaterThan(tuning.turret.slewRate + 1e-9);
  });
});
