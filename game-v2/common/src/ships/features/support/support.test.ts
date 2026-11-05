import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseBlueprint } from '../../blueprint.js';
import { createShipState } from '../../state.js';
import { readShipJson, testCatalog, SHIP_DATA_DIR } from '../../testData.js';
import type { ShipTuning } from '../../tuning.js';
import { stepGuns } from '../../guns.js';
import { blueprintGeometry } from '../../blueprint.js';
import { partStats } from '../../partStats.js';
import { mountingOf } from '../../mounting.js';
import { repairAt, interceptHits, isPointDefence, isRepairBeam, stepPointDefenceAim, pointDefenceOf } from './support.js';
import { damagePart } from '../../state.js';

const catalog = testCatalog();
const tuning: ShipTuning = readShipJson('tuning.json');
const sparrowBp = () => parseBlueprint(readFileSync(join(SHIP_DATA_DIR, 'blueprints/sparrow-t.json'), 'utf-8'));
/** The Sparrow with a Repair Beam on its right shoulder and a Point Defence Turret in place of its left gun */
const warden = () => {
  const bp = sparrowBp();
  bp.parts = bp.parts.filter((p) => p.uid !== 2);
  bp.parts.push(
    { uid: 2, piece: 'sq', fn: 'point_defence_turret', material: 'steel', x: 0, y: -1, rot: 0, flip: false, facing: 'N' } as never,
    { uid: 50, piece: 'rect2', fn: 'utility_repair_beam', material: 'steel', x: 2, y: -1, rot: 0, flip: false, facing: 'N' } as never,
  );
  return createShipState(catalog, tuning, 1, bp, 0);
};
const pose = { x: 0, y: 0, angle: -Math.PI / 2 };

describe('support weapons: the models', () => {
  it('are turret models in their bands (Repair Beam L16-23, point defence L8-15), and count nothing to firepower', () => {
    const rb = catalog.functions.get('utility_repair_beam')!, pd = catalog.functions.get('point_defence_turret')!;
    expect(rb.unlock!.level).toBeGreaterThanOrEqual(16);
    expect(rb.unlock!.level).toBeLessThanOrEqual(23);
    expect(pd.unlock!.level).toBeGreaterThanOrEqual(8);
    expect(pd.unlock!.level).toBeLessThanOrEqual(15);
    expect(mountingOf(catalog, rb)!.mount).toBe('turret');
    expect(mountingOf(catalog, pd)!.mount).toBe('turret');
    expect(isRepairBeam(tuning, rb.weapon!)).toBe(true);
    expect(isPointDefence(tuning, pd.weapon!)).toBe(true);
    const sr = partStats(catalog, tuning, { fn: rb.id, material: 'steel', piece: 'rect2' })!;
    expect(sr.heal).toBeGreaterThan(30);
    expect(sr.dps).toBe(0);
    expect(sr.firepower).toBe(0);
    expect(sr.draw).toBeCloseTo(28);
    const sp = partStats(catalog, tuning, { fn: pd.id, material: 'steel', piece: 'sq' })!;
    expect(sp.intercept).toEqual({ perSec: 5, range: pointDefenceOf(tuning.weapons!.point_defence).range });
    expect(sp.firepower).toBe(0);
  });

  it('only missiles, torpedoes, mortar shells and seekers can be shot down; shells and orbs can\'t', () => {
    const w = tuning.weapons!;
    expect(Object.keys(w).filter((k) => interceptHits(w[k]) > 0).sort()).toEqual(['heart_seeker', 'hive', 'missile', 'mortar', 'seam_seeker', 'torpedo']);
    expect(interceptHits(w.torpedo)).toBe(3);
  });
});

describe('support weapons: the guns step', () => {
  it('never fires point defence on the trigger or turns it to the aim, but reloads it (drawing power)', () => {
    const s = warden();
    const pd = s.derived.weapons.find((w) => w.kind === 'point_defence')!;
    expect(pd).toBeDefined();
    s.cooldown[pd.part] = 6;
    let fired = false;
    for (let t = 0; t < 30; t++) {
      const r = stepGuns(s, pose, { firing: true, aimWorld: 0.3, aimDist: 400 }, t, tuning);
      if (r.shots.some((x) => x.w.part === pd.part) || r.beams.some((x) => x.part === pd.part)) fired = true;
    }
    expect(fired).toBe(false);
    expect(s.aim[pd.part]).toBe(0);
    expect(s.cooldown[pd.part]).toBeLessThanOrEqual(0);
  });

  it('holds the Repair Beam on while the trigger is', () => {
    const s = warden();
    const rb = s.derived.weapons.find((w) => w.kind === 'repair')!;
    let on = 0;
    for (let t = 0; t < 60; t++) on += stepGuns(s, pose, { firing: true, aimWorld: -Math.PI / 2, aimDist: 300 }, t, tuning).beams.filter((w) => w === rb).length;
    expect(on).toBeGreaterThan(50);
  });

  it('a point-defence turret slews fast and rests when there is nothing', () => {
    const s = warden();
    const pd = s.derived.weapons.find((w) => w.kind === 'point_defence')!;
    const win = pd.window!;
    let off = 0, n = 0;
    for (; n < 30; n++) { const r = stepPointDefenceAim(win, off, win.center - 1.2, tuning, 3); off = r.offset; if (r.canFire) break; }
    expect(n).toBeLessThan(Math.ceil(1.2 / (tuning.turret.slewRate * 3)) + 2);
    const rest = stepPointDefenceAim(win, off, undefined, tuning, 3);
    expect(rest.canFire).toBe(false);
    expect(Math.abs(rest.offset)).toBeLessThan(Math.abs(off));
  });
});

describe('repairAt', () => {
  it('mends the damaged parts nearest the point, nearest first, at most three, never a destroyed one', () => {
    const s = createShipState(catalog, tuning, 1, sparrowBp(), 0);
    const geoms = blueprintGeometry(catalog, s.blueprint);
    // The right reactor (uid 13, at 2,0), its neighbour the hull (uid 8, at 2,1), and the left gun far away (uid 2)
    const idx = (uid: number) => s.blueprint.parts.findIndex((p) => p.uid === uid);
    for (const u of [13, 8, 2]) damagePart(s, idx(u), s.maxHp[idx(u)] * 0.5, tuning);
    damagePart(s, idx(12), Infinity, tuning);
    const before = [...s.hp];
    const got = repairAt(s, geoms, 2.5, 0.5, 5, tuning);
    expect(got).toBeCloseTo(5, 6);
    expect(s.hp[idx(13)]).toBeCloseTo(before[idx(13)] + 5, 6);
    // More than the nearest needs: on to the next nearest
    const need = s.maxHp[idx(13)] - s.hp[idx(13)];
    const more = repairAt(s, geoms, 2.5, 0.5, need + 3, tuning);
    expect(more).toBeCloseTo(need + 3, 6);
    expect(s.hp[idx(13)]).toBeCloseTo(s.maxHp[idx(13)], 6);
    expect(s.hp[idx(8)]).toBeCloseTo(before[idx(8)] + 3, 6);
    expect(s.hp[idx(2)]).toBe(before[idx(2)]);
    expect(s.hp[idx(12)]).toBe(0);
    // Nothing to mend near or far beyond three parts: what's left is left
    expect(repairAt(s, geoms, 2.5, 0.5, 1e6, tuning)).toBeLessThan(1e6);
    expect(s.hp[idx(12)]).toBe(0);
  });
});

describe('support weapons: on the wire', () => {
  it('an intercept goes as a compact row (protocol 26) and comes back whole', async () => {
    const { encodeServerMessage, serverFrame, decodeServerFrame, COMPACT_TYPES } = await import('../../../network/protocol.js');
    expect(COMPACT_TYPES).toContain('intercept');
    const msg = { type: 'intercept' as const, bodyId: 12, part: 3, proj: 4071, x: -1520, y: 880, fx: -1490, fy: 1300, down: true };
    expect(decodeServerFrame(serverFrame([encodeServerMessage(msg)]))).toEqual([msg]);
  });
});
