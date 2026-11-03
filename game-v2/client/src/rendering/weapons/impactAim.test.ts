import { describe, expect, it } from 'vitest';
import { SurfaceProbe, hitAge, offSurface, throwAngle } from './impactAim';
import { weaponStyle } from './weaponStyles';
import { WeaponType } from '@space-game/common';
import '../../ships/energyLooks';
import tuning from '../../../../data/ships/tuning.json';
import models from '../../../../data/ships/models.json';

const deg = (a: number) => Math.round(((a * 180) / Math.PI + 360) % 360);

/** A box's four edges, either winding */
function box(p: SurfaceProbe, x0: number, y0: number, x1: number, y1: number, ccw = true): void {
  const pts: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  if (!ccw) pts.reverse();
  for (let i = 0; i < 4; i++) p.edge(pts[i][0], pts[i][1], pts[(i + 1) % 4][0], pts[(i + 1) % 4][1]);
}

describe('the struck surface', () => {
  it('is the first edge the shell line crosses, its normal facing the shell, whatever the winding', () => {
    for (const ccw of [true, false]) {
      // A shell flying down-right into a box's top face (y = 0, the box below it)
      const p = new SurfaceProbe().begin(-40, -40, 10, 10, 0, 0, 5);
      box(p, -100, 0, 100, 60, ccw);
      const n = p.result({ nx: 0, ny: 0 })!;
      expect(n.nx).toBeCloseTo(0);
      expect(n.ny).toBeCloseTo(-1);
    }
  });

  it('tells whose surface it is: the owner of the edge crossed first (the impact rides it)', () => {
    const p = new SurfaceProbe().begin(-40, -40, 10, 10, 0, 0, 5);
    // a far box (id 3) behind a near one (id 9) on the line
    p.edge(-100, 20, 100, 20, 3);
    p.edge(-100, 0, 100, 0, 9);
    const out = { nx: 0, ny: 0, target: -1 };
    p.result(out);
    expect(out.target).toBe(9);
    expect(new SurfaceProbe().begin(0, 0, 1, 1, 500, 500, 5).result(out)).toBeNull();
    expect(out.target).toBe(-1);
  });

  it('falls back to the nearest edge within reach when the line misses (a drawn pose a little off the server one)', () => {
    // The hit reported 3 units above the face, the line stopping short of it
    const p = new SurfaceProbe().begin(-30, -33, -2, -5, 0, -3, 5);
    box(p, -100, 0, 100, 60);
    expect(p.result({ nx: 0, ny: 0 })!.ny).toBeCloseTo(-1);
    const far = new SurfaceProbe().begin(-30, -63, -2, -35, 0, -33, 5);
    box(far, -100, 0, 100, 60);
    expect(far.result({ nx: 0, ny: 0 })).toBeNull();
  });
});

describe('which way a hit throws', () => {
  // A shell flying down-right at 45 degrees onto a floor (normal up, -y)
  const dx = Math.SQRT1_2, dy = Math.SQRT1_2, nx = 0, ny = -1;
  it('reflect mirrors the line off the surface (a ricochet), normal leaves straight out, back goes up the line', () => {
    expect(deg(throwAngle('reflect', dx, dy, nx, ny))).toBe(315);
    expect(deg(throwAngle('normal', dx, dy, nx, ny))).toBe(270);
    expect(deg(throwAngle('back', dx, dy, nx, ny))).toBe(225);
  });

  it('with no surface known (the reversed line as normal) all three go straight back', () => {
    for (const m of ['reflect', 'normal', 'back'] as const) expect(deg(throwAngle(m, dx, dy, -dx, -dy))).toBe(225);
  });

  it('a spark aimed into the surface is mirrored out of it', () => {
    // straight down into the floor comes back straight up; one along it is left alone
    expect(deg(offSurface(Math.PI / 2, nx, ny))).toBe(270);
    expect(deg(offSurface(0, nx, ny))).toBe(0);
    expect(deg(offSurface(-Math.PI / 4, nx, ny))).toBe(315);
  });
});

describe('a hit along a shell line', () => {
  it('is the ticks into its flight where the shell reaches it', () => {
    expect(hitAge(100, 50, 110, 0, 430, 50)).toBeCloseTo(3);
    expect(hitAge(0, 0, 30, 40, 150, 200)).toBeCloseTo(5);
  });
});

describe('impacts choose their throw by kind', () => {
  it('slugs and rails ricochet, bolts of light splash back out, explosives throw back up their line', () => {
    expect(weaponStyle(WeaponType.Cannon, 1, 'cannon_bastion').hitThrow).toBe('reflect');
    expect(weaponStyle(WeaponType.Railgun, 1, 'railgun_spear').hitThrow).toBe('reflect');
    expect(weaponStyle(WeaponType.Autocannon, 1, 'autocannon_chainsaw').hitThrow).toBe('reflect');
    expect(weaponStyle(WeaponType.Pulse, 1, 'pulse_strobe').hitThrow).toBe('normal');
    expect(weaponStyle(WeaponType.Arc, 1, 'arc_spark').hitThrow).toBe('normal');
    for (const t of [WeaponType.Flak, WeaponType.Missile, WeaponType.Torpedo, WeaponType.Mortar]) expect(weaponStyle(t).hitThrow ?? 'back').toBe('back');
  });

  it('the Spark is a long bolt that leaves the barrel, not a line its whole flight long', () => {
    const s = weaponStyle(WeaponType.Arc, 1, 'arc_spark');
    // (a tracer as long as its life stays pinned to the barrel the whole flight: the old bug)
    const model = (models as unknown as { models: { id: string; weaponMods?: { mul?: { life?: number } } }[] }).models.find((m) => m.id === 'arc_spark')!;
    const life = tuning.weapons.arc.life * (1 + (model.weaponMods?.mul?.life ?? 0));
    expect(s.tracerTicks).toBeLessThanOrEqual(life / 3);
    expect(s.tracerTicks).toBeGreaterThanOrEqual(4);
    expect(s.hit?.flare).toBeDefined();
  });
});
