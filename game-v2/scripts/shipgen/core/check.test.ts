import { describe, it, expect } from 'vitest';
import { loadContext } from './context';
import { check } from './check';
import { gridToBlueprint } from './grid';
import { SAMPLE_SHIPS, ship } from './testShips';

const ctx = loadContext();
/** What the review ships' write-ups (docs/panels/entries/2026-11-01-review-ships-*.md) recorded below full over 60 s
 *  (the Lance 77% and the Glints 30% then; 81% and 41% since the Heavy Bank holds 450 a cell, 2026-11-04 energy audit) */
const HELD: Record<string, Record<string, number>> = { 'samples/review-heron': { Lance: 81, Glint: 41 } };

describe('shipgen check', () => {
  for (const path of SAMPLE_SHIPS) {
    it(`finds ${path} valid, every consumer powered, guns and engines at full, and scores it well`, () => {
      const r = check(ctx, ship(path));
      expect(r.errors).toEqual([]);
      expect(r.valid).toBe(true);
      const p = r.power!;
      expect(p.unpowered).toEqual([]);
      expect(p.weapons.length).toBeGreaterThan(0);
      for (const c of p.consumers) {
        expect(c.fed && c.linked, `${c.name} at ${c.row},${c.col}`).toBe(true);
        expect(c.pct, `${c.name} at ${c.row},${c.col}`).toBeGreaterThanOrEqual(95);
        // (held for 60 s: full, but for the Heron's beams, which its review recorded as the Lance 77% (81% with the deeper Heavy Banks), the Glints 30% (41%))
        const known = HELD[path]?.[c.name];
        if (known !== undefined) expect(Math.abs(c.pctLong - known), `${c.name} at ${c.row},${c.col}: ${c.pctLong}`).toBeLessThanOrEqual(3);
        else expect(c.pctLong, `${c.name} at ${c.row},${c.col}`).toBeGreaterThanOrEqual(95);
      }
      expect(p.thrust.cruisePct).toBeGreaterThanOrEqual(95);
      expect(p.thrust.boostPct).toBeGreaterThanOrEqual(95);
      expect(p.generation).toBeGreaterThan(0);
      expect(r.scores.power).toBeGreaterThanOrEqual(0.9);
      expect(r.scores.symmetry).toBeGreaterThanOrEqual(0.95);
      expect(r.scores.enginesAft).toBeGreaterThanOrEqual(0.9);
      expect(r.scores.gunsOut).toBeGreaterThanOrEqual(0.9);
      expect(r.scores.armourOutside).toBeGreaterThan(0.5);
      expect(r.scores.compactness).toBeGreaterThan(0.4);
      expect(r.score).toBeGreaterThanOrEqual(85);
      expect(r.stats.mass).toBeGreaterThan(0);
      expect(r.stats.cost).toBeGreaterThan(0);
      expect(r.stats.thrustToMass).toBeGreaterThan(0);
    });
  }

  it('scores a ship that is mostly power plant down (lean), measures the role\'s targets (fit), and reads compactness by row fill', () => {
    const kestrel = ship('samples/review-kestrel');
    // Kestrel with a capacitor bank bolted on under it: the same guns and engines, three times the stores
    const cap = kestrel.parts.find((p) => p.fn === 'power_capacitor')!;
    const ys = kestrel.parts.map((p) => p.y), y0 = Math.max(...ys) + 1;
    const extra = [];
    for (let y = y0; y < y0 + 4; y++) for (let x = -3; x <= 3; x++) extra.push({ ...cap, uid: 1000 + extra.length, x, y, facing: undefined });
    const padded = { ...kestrel, parts: [...kestrel.parts, ...extra] };
    const a = check(ctx, kestrel, { weights: { symmetry: 0 } }), b = check(ctx, padded, { weights: { symmetry: 0 } });
    expect(a.scores.lean).toBe(1);
    expect(b.scores.lean).toBeLessThan(0.7);
    expect(b.score).toBeLessThan(a.score);
    // Fit: the targets measured, each capped at 1; none asked: null
    expect(a.scores.fit).toBeNull();
    const t = check(ctx, kestrel, { targets: { weaponShare: 0.05, thrustToMass: 0.5 } });
    expect(t.fit.map((f) => f.key)).toEqual(['weaponShare', 'thrustToMass']);
    expect(t.fit[0].share).toBe(1);
    expect(t.fit[1].share).toBeLessThan(0.5);
    expect(t.scores.fit).toBeCloseTo((1 + t.fit[1].share) / 2, 2);
    // Compactness: a wing on a spine fills its rows; a hollow row doesn't
    const spine = gridToBlueprint(ctx, 'name: s\ngrid:\n   -2 -1 0 1 2\n0  HA HA CA HA HA\n1  .. .. HA .. ..\n2  .. .. HA .. ..\nend').bp!;
    const hollow = gridToBlueprint(ctx, 'name: h\ngrid:\n   -2 -1 0 1 2\n0  HA HA CA HA HA\n1  HA .. HA .. HA\n2  HA HA HA HA HA\nend').bp!;
    expect(check(ctx, spine).scores.compactness).toBe(1);
    expect(check(ctx, hollow).scores.compactness).toBeLessThan(1);
  });

  it('points a rule broken at its cell, and scores the broken design down', () => {
    const good = [
      'name: Tiny', 'grid:',
      '    -1   0   1   2',
      ' -1 ..  HAt4 HAt1 ..',
      '  0 PI^ CA  ca  PI^',
      '  1 HA  CR  BT  HA',
      '  2 ..  IDv IDv ..',
      'end',
    ].join('\n');
    const r = check(ctx, gridToBlueprint(ctx, good).bp!);
    expect(r.valid).toBe(true);
    // (a Pip facing back into the core: its edge is blocked)
    const bad = check(ctx, gridToBlueprint(ctx, good.replace(' -1 ..  HAt4 HAt1 ..', ' -1 ..  HAt4 PIv ..')).bp!);
    expect(bad.valid).toBe(false);
    const e = bad.errors.find((x) => x.code === 'facingBlocked')!;
    expect(e.message).toMatch(/\(PI at row -1 col 1\)/);
    expect([e.row, e.col]).toEqual([-1, 1]);
    expect(r.score).toBeGreaterThan(bad.score);
  });

  it('finds a gun walled in by hull unpowered', () => {
    const text = ['name: Walled', 'grid:', '  0 PI^ HA CA', '  1 HA HA CR', '  2 .. IDv IDv', 'end'].join('\n');
    const d = gridToBlueprint(ctx, text);
    expect(d.errors).toEqual([]);
    const r = check(ctx, d.bp!);
    expect(r.power!.unpowered.map((u) => [u.code, u.row, u.col])).toContainEqual(['PI', 0, 0]);
    const pip = r.power!.consumers.find((c) => c.row === 0 && c.col === 0)!;
    expect([pip.fed, pip.pct]).toEqual([false, 0]);
    expect(r.scores.power).toBeLessThan(1);
  });
});
