import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { Economy, placeGeometry, overlapsAny, validateBlueprint, nextFreeUid, type Blueprint, type PlacedPart, type ItemsFile, type RecipesFile } from '@space-game/common';
import { loadShipConfigCached } from '../../../../server/src/ships/loadShipConfig';
import { createShipBridge } from '../../../../server/src/proto/createProtoServer';
import items from '../../../../data/items.json';
import recipes from '../../../../data/recipes.json';
import { DeltaCache, changeFor, diffMeasures, measure, type Change, type Measure } from './statDelta';

const config = loadShipConfigCached(join(__dirname, '../../../../data'));
const { catalog, tuning } = createShipBridge(config);
const econ = new Economy(items as unknown as ItemsFile, recipes as unknown as RecipesFile, catalog, {});
const ctx = { catalog, tuning, econ };
const base: Blueprint = (config.library as Record<string, Blueprint>).arrow;

const hull = (uid: number, x: number, y: number): PlacedPart => ({ uid, piece: 'sq', fn: 'hull', material: 'alloy', x, y, rot: 0, flip: false });

/** A hull cell that joins the ship, and one that joins nothing */
function cells(bp: Blueprint): { joined: PlacedPart; loose: PlacedPart } {
  const geoms = bp.parts.map((p) => placeGeometry(catalog, p));
  const uid = nextFreeUid(bp);
  let joined: PlacedPart | null = null;
  for (let y = -12; y <= 12 && !joined; y++) for (let x = -12; x <= 12 && !joined; x++) {
    const p = hull(uid, x, y);
    if (overlapsAny(placeGeometry(catalog, p), geoms)) continue;
    const r = validateBlueprint(catalog, { ...bp, parts: [...bp.parts, p] }, tuning, null);
    if (!r.unreachable.includes(uid) && !r.errors.length) joined = p;
  }
  return { joined: joined!, loose: hull(uid, 60, 60) };
}

describe('stat deltas on a real design', () => {
  const { joined, loose } = cells(base);
  const add = (part: PlacedPart): Change => ({ kind: 'add', part, label: 'Hull' });

  it('a hull plate adds mass and cost, which is amber/bad for mass', () => {
    const d = new DeltaCache(() => ctx).get('r1', base, add(joined));
    const mass = d.lines.find((l) => l.key === 'mass')!;
    expect(mass.after).toBeGreaterThan(mass.before);
    expect(mass.tone).toBe('bad');
    expect(mass.text.startsWith('+')).toBe(true);
    expect(d.lines.find((l) => l.key === 'cost')!.tone).toBe('flat');
    expect(d.loose).toBe(false);
  });

  it('a part that joins nothing shows no ship stat, only points and cost', () => {
    const d = new DeltaCache(() => ctx).get('r1', base, add(loose));
    expect(d.loose).toBe(true);
    expect(d.lines.every((l) => l.key === 'points' || l.key === 'cost')).toBe(true);
  });

  it('removing a gun lowers firepower (bad) and the power it drew', () => {
    const gun = base.parts.find((p) => catalog.functions.get(p.fn)?.weapon)!;
    expect(gun).toBeTruthy();
    const d = new DeltaCache(() => ctx).get('r1', base, { kind: 'remove', uid: gun.uid, label: 'Gun' });
    const dps = d.lines.find((l) => l.key === 'dps')!;
    expect(dps.after).toBeLessThan(dps.before);
    expect(dps.tone).toBe('bad');
    const mass = d.lines.find((l) => l.key === 'mass')!;
    expect(mass.tone).toBe('good');
  });

  it('derives a design once and each change once, then serves the memo', () => {
    const cache = new DeltaCache(() => ctx);
    cache.get('r1', base, add(joined));
    const n = cache.derives;
    cache.get('r1', base, add(joined));
    expect(cache.derives).toBe(n);
    expect(cache.peek('r1', add(joined))).toBeTruthy();
    cache.get('r1', base, add(loose));
    expect(cache.derives).toBe(n + 1); // (the design itself is not derived again)
    cache.get('r2', base, add(joined));
    expect(cache.derives).toBe(n + 3); // (a new revision: the design and the change)
  });

  it('measures power made and drawn', () => {
    const m = measure(ctx, base);
    expect(m.summary).not.toBeNull();
    expect(m.made).toBeGreaterThan(0);
  });
});

describe('diffMeasures (hand-made numbers)', () => {
  const summary = (over: Record<string, number>) => ({ mass: 10, accel: 100, topSpeed: 50, turn180: 2, shield: 0, hull: 100, dps: 10, ...over }) as unknown as Measure['summary'];
  const m = (over: Partial<Measure> & { s?: Record<string, number> } = {}): Measure => ({ summary: summary(over.s ?? {}), made: 100, drawn: 60, gens: 2, points: 10, cost: 100, ...over });
  const c: Change = { kind: 'add', part: hull(1, 0, 0), label: 'X' };

  it('colours by stat direction and drops what did not move', () => {
    const d = diffMeasures(m(), m({ s: { mass: 12, accel: 90, hull: 150, topSpeed: 50 }, points: 11, cost: 130 }), c);
    const by = Object.fromEntries(d.lines.map((l) => [l.key, l.tone]));
    expect(by).toMatchObject({ mass: 'bad', accel: 'bad', hull: 'good', points: 'flat', cost: 'flat' });
    expect(by.topSpeed).toBeUndefined();
    expect(by.turn180).toBeUndefined();
  });

  it('says how many generators short when the net goes negative', () => {
    const d = diffMeasures(m(), m({ made: 100, drawn: 160 }), c);
    expect(d.powerNote).toBe('2 generators short');
    expect(d.lines.find((l) => l.key === 'power')!.tone).toBe('bad');
    expect(diffMeasures(m(), m({ made: 100, drawn: 150 }), c).powerNote).toBe('1 generator short');
    expect(diffMeasures(m(), m(), c).powerNote).toBeNull();
  });

  it('flags build points over the budget as bad', () => {
    expect(diffMeasures(m(), m({ points: 14 }), c, { budget: 12 }).lines.find((l) => l.key === 'points')!.tone).toBe('bad');
    expect(diffMeasures(m(), m({ points: 14 }), c, { budget: 20 }).lines.find((l) => l.key === 'points')!.tone).toBe('flat');
  });

  it("a ship that can no longer turn reads as can't turn", () => {
    const d = diffMeasures(m(), m({ s: { turn180: Infinity } }), c);
    expect(d.lines.find((l) => l.key === 'turn180')!.text).toBe("can't turn");
  });

  it('notes a design that will not derive', () => {
    expect(diffMeasures(m(), m({ summary: null }), c).note).toMatch(/not build/);
  });
});

describe('changeFor', () => {
  const name = () => 'N';
  const p = hull(1, 0, 0), core = { ...hull(2, 1, 0), fn: 'core' };
  it('adds when the hand fits, else removes what is under the cursor, never the core', () => {
    expect(changeFor({ candidate: p, problem: null, under: null, name })?.kind).toBe('add');
    expect(changeFor({ candidate: p, problem: 'overlaps another part', under: hull(3, 0, 0), name })).toMatchObject({ kind: 'remove', uid: 3 });
    expect(changeFor({ candidate: null, problem: null, under: hull(3, 0, 0), name })?.kind).toBe('remove');
    expect(changeFor({ candidate: null, problem: null, under: core, name })).toBeNull();
    expect(changeFor({ candidate: p, problem: 'x', under: null, name })).toBeNull();
  });
});
