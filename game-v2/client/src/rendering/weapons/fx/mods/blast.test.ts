// Pins the contract invariants of the explosive modifier's blast (fx/mods: blast, index isModBlast / modBlast) with a real field and fake textures
import { describe, it, expect, vi } from 'vitest';
import { WeaponType } from '@space-game/common';

vi.mock('../../../fxTextures', async (orig) => {
  const mk = (name: string) => () => ({ name }) as never;
  return {
    ...(await orig<Record<string, unknown>>()),
    disc: mk('disc'), ring: mk('ring'), softDot: mk('dot'), streak: mk('streak'), petal: mk('petal'), puff: mk('puff'), glowBall: mk('ball'),
    petalScale: () => ({ x: 1, y: 1 }),
  };
});

import { Container } from 'pixi.js';
import { FxField } from '../FxField';
import { weaponStyle } from '../../weaponStyles';
import { isModBlast, modBlast, modFrame, modImpact, modMarkCount, type ModFx } from './index';
import { BLAST_LINGER, BLAST_MARKS, CAP_BLAST, blastSpots } from './blast';
import { stateOf } from './kit';
import { CAP_IMPACT, EFFECTS, MECH } from './looks';

const EXPLOSIVE = EFFECTS.indexOf('explosive'), PIERCE = EFFECTS.indexOf('pierce');
const [LO, HI] = MECH.blast;

function field() {
  const f = new FxField(new Container());
  const draws: { x: number; y: number }[] = [];
  for (const pool of [f.glow, f.smokeG, f.extraG, f.hitG]) vi.spyOn(pool, 'take').mockImplementation(((_t: unknown, x: number, y: number) => { draws.push({ x, y }); }) as never);
  vi.spyOn(f, 'line').mockImplementation((() => undefined) as never);
  return { f, draws };
}

/** The particles a blast throws (what the budget counts) */
const thrown = (f: FxField): number => f.sparks.length + f.smoke.length + f.hitGlows.length + f.frags.length + f.flares.length;

const shot = (fx: readonly ModFx[] | undefined, splash = 0, id = 5) => ({
  id, owner: 1, type: WeaponType.Cannon, spawnX: 0, spawnY: 0, vx: 10, vy: 0, power: 1, size: 1, splash, ended: false, fx,
  style: weaponStyle(WeaponType.Cannon),
}) as never;

describe('client.weapon-fx.mods.blast', () => {
  it('only a gun\'s detonation with a way out, or no wider than the explosive modifier\'s widest blast, is a modifier\'s blast', () => {
    expect(isModBlast('autocannon', LO)).toBe(true);
    expect(isModBlast('laser', HI)).toBe(true);
    // (a gun's own bursts: a burst with no splash is told as 40, the narrowest splash is 60)
    expect(isModBlast('railgun', 40)).toBe(false);
    expect(isModBlast('flak', 150)).toBe(false);
    expect(isModBlast('missile', 90)).toBe(false);
    // (... unless it is a way out of a hull)
    expect(isModBlast('missile', 90, 180)).toBe(true);
    expect(isModBlast('cannon', 40, 0)).toBe(true);
    // (not a gun's: a boss's vent, a drone; an arc carries where it leapt from)
    expect(isModBlast('eruption', 20)).toBe(false);
    expect(isModBlast('mob_burst', 20)).toBe(false);
    expect(isModBlast('arc', 30, undefined, [0, 0])).toBe(false);
    expect(isModBlast('cannon', 0)).toBe(false);
  });

  it('a shell with no explosive effect throws no blast: no ring, nothing hanging', () => {
    for (const fx of [undefined, [], [{ fx: EXPLOSIVE, k: 0 }], [{ fx: PIERCE, k: 1 }]]) {
      const { f } = field();
      modImpact(f, shot(fx), 90, 0, Math.PI, true, 1, 0, 1);
      expect(f.shocks).toHaveLength(0);
      expect(blastSpots(stateOf(f).marks)).toBe(0);
    }
  });

  it('an explosive shell\'s hit throws a ring as wide as its blast, inside the shot\'s budget, and leaves one spot hanging over a second', () => {
    const { f } = field();
    modImpact(f, shot([{ fx: EXPLOSIVE, k: 1 }], HI), 90, 0, Math.PI, true, 1, 0, 1);
    expect(Math.max(...f.shocks.map((s) => s.size))).toBe(HI);
    expect(thrown(f)).toBeLessThanOrEqual(CAP_IMPACT[1]);
    const marks = stateOf(f).marks;
    expect(blastSpots(marks)).toBe(1);
    expect(BLAST_LINGER).toBeGreaterThanOrEqual(60);
    // (its embers: sparks that cool, alive past a second)
    expect(f.sparks.filter((s) => s.cool !== undefined && s.max >= 45).length).toBeGreaterThan(0);
    expect(Math.max(...f.smoke.map((s) => s.max))).toBeGreaterThanOrEqual(60);
    // The spot is still drawn a second on, and gone when its time is up
    for (let i = 0; i < 60; i++) modFrame(f, 1);
    expect(blastSpots(marks)).toBe(1);
    for (let i = 0; i < BLAST_LINGER; i++) modFrame(f, 1);
    expect(blastSpots(marks)).toBe(0);
  });

  it('the server\'s word of a shell\'s blast adds nothing to the one its hit drew; a blast told alone is drawn', () => {
    const a = field();
    modImpact(a.f, shot([{ fx: EXPLOSIVE, k: 1 }], HI), 90, 0, Math.PI, true, 1, 0, 1);
    const before = thrown(a.f) + a.f.shocks.length;
    expect(modBlast(a.f, 91, 1, HI)).toBe(false);
    expect(thrown(a.f) + a.f.shocks.length).toBe(before);
    expect(modMarkCount(a.f)).toBe(1);
    const b = field();
    expect(modBlast(b.f, 91, 1, HI)).toBe(true);
    expect(Math.max(...b.f.shocks.map((s) => s.size))).toBe(HI);
    expect(thrown(b.f)).toBeGreaterThan(10);
    expect(thrown(b.f)).toBeLessThanOrEqual(CAP_BLAST);
    expect(blastSpots(stateOf(b.f).marks)).toBe(1);
  });

  it('a blast grows with its radius: more thrown at the widest than at the narrowest', () => {
    const count = (r: number) => { const { f } = field(); modBlast(f, 0, 0, r); return thrown(f); };
    expect(count(LO)).toBeGreaterThan(0);
    expect(count(HI)).toBeGreaterThan(count(LO));
  });

  it('a way out throws along its heading and nothing behind, and differs from the burst going in', () => {
    for (const out of [0, 2.2, -1.9]) {
      const { f, draws } = field();
      expect(modBlast(f, 100, 50, 30, out)).toBe(true);
      const ux = Math.cos(out), uy = Math.sin(out);
      const fast = f.sparks.filter((s) => s.cool === undefined);
      expect(fast.length).toBeGreaterThan(6);
      // (every spark, ember, fragment and streak leaves forward of the hull)
      for (const s of [...f.sparks, ...f.frags]) expect(s.vx * ux + s.vy * uy).toBeGreaterThan(0);
      for (const s of fast) expect((s.vx * ux + s.vy * uy) / Math.hypot(s.vx, s.vy)).toBeGreaterThan(Math.cos(0.55));
      expect(f.flares.length).toBeGreaterThanOrEqual(2);
      for (const fl of f.flares) expect(Math.cos(fl.a - out)).toBeGreaterThan(0.95);
      // (its ring is small and pushed ahead, not the blast's own round the point)
      expect(f.shocks).toHaveLength(1);
      expect(f.shocks[0].size).toBeLessThan(30);
      expect((f.shocks[0].x - 100) * ux + (f.shocks[0].y - 50) * uy).toBeGreaterThan(0);
      // What hangs is carried down the heading: nothing of it is drawn behind the point
      draws.length = 0;
      for (let i = 0; i < 40; i++) modFrame(f, 1);
      const embers = draws.filter((d) => Math.hypot(d.x - 100, d.y - 50) > 30);
      expect(embers.length).toBeGreaterThan(0);
      for (const d of embers) expect((d.x - 100) * ux + (d.y - 50) * uy).toBeGreaterThan(0);
    }
    // (the burst going in: a full ring round the point, sparks all round, no lance)
    const { f } = field();
    modBlast(f, 100, 50, 30);
    expect(f.flares).toHaveLength(0);
    expect(f.shocks.some((s) => s.size === 30 && s.x === 100 && s.y === 50)).toBe(true);
    expect(f.sparks.some((s) => s.vx < 0)).toBe(true);
    expect(f.sparks.some((s) => s.vx > 0)).toBe(true);
  });

  it('blasts landing together on one spot draw once; one landing on a spot still burning feeds it at half the particles', () => {
    const { f } = field();
    modBlast(f, 0, 0, HI);
    const first = thrown(f);
    // (a wave's or a fan's shells in the same frame)
    for (let i = 0; i < 8; i++) expect(modBlast(f, i, 0, HI)).toBe(false);
    expect(thrown(f)).toBe(first);
    // (a beam's next damage step)
    for (let i = 0; i < 10; i++) modFrame(f, 1);
    expect(modBlast(f, 2, 0, HI)).toBe(true);
    expect(thrown(f) - first).toBeLessThanOrEqual(Math.ceil(first * 0.6));
    expect(blastSpots(stateOf(f).marks)).toBe(1);
  });

  it('many blasts at once thin as the load climbs, and never more than BLAST_MARKS spots hang', () => {
    const { f } = field();
    let firstMade = 0, lastMade = 0;
    for (let frame = 0; frame < 40; frame++) {
      for (let i = 0; i < 12; i++) {
        const before = thrown(f);
        modBlast(f, (frame * 12 + i) * 200, 0, HI, i % 3 === 0 ? 1 : undefined);
        if (frame === 0 && i === 0) firstMade = thrown(f) - before;
        lastMade = thrown(f) - before;
        expect(thrown(f) - before).toBeLessThanOrEqual(CAP_BLAST);
      }
      modFrame(f, 1);
      expect(blastSpots(stateOf(f).marks)).toBeLessThanOrEqual(BLAST_MARKS);
    }
    expect(lastMade).toBeLessThan(firstMade * 0.5);
  });

  it('is deterministic: the same blasts make the same particles, with no Math.random', () => {
    const run = () => { const { f } = field(); modBlast(f, 10, 20, 28); modBlast(f, 300, 20, 20, 1.2); return JSON.stringify(f.sparks.map((s) => [s.vx, s.vy, s.max])); };
    const rnd = vi.spyOn(Math, 'random');
    expect(run()).toBe(run());
    expect(rnd).not.toHaveBeenCalled();
    rnd.mockRestore();
  });
});
