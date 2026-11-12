/**
 * What a weapon modifier's effects do to a gun's tuning (modifiers/fxDef.ts): each effect's maths at no strength, part
 * way and full, the one order they compose in, and the cache (a steady gun gets the same object every shot).
 */
import { describe, it, expect } from 'vitest';
import { readShipJson } from '../testData.js';
import type { ShipTuning, WeaponTuning } from '../tuning.js';
import { gunDef } from '../launch.js';
import { FX_STEPS, fxTo, type GunFx } from './types.js';
import { fxDef, fxList, fxMarks, fxStep, fxColor, fxTint, arcRadius, arcStrength, ARC_RADIUS } from './fxDef.js';

const tuning: ShipTuning = readShipJson('tuning.json');
const mt = tuning.modifiers!;
const id = (name: string) => mt.effects.indexOf(name);
/** A gun's effect list: names with their strength steps */
const list = (...fx: [string, number][]): GunFx[] => fx.map(([name, q]) => ({ fx: id(name), q }));
/** A plain shell gun, a held beam, a pulsed beam and a zapping one: nothing of an effect's on any of them already */
const shell: WeaponTuning = { type: 'projectile', damage: 20, speed: 40, life: 100, spread: 2, size: 1 };
const beam: WeaponTuning = { type: 'beam', dps: 60, range: 500, width: 4 };
const MID = 9, kMid = MID / FX_STEPS;
/** `def` with one effect at step q */
const one = (def: WeaponTuning, name: string, q: number) => fxDef(def, mt, list([name, q]), 1);

describe('fxDef: no effects', () => {
  it('no mask, no list, no tuning, or an effect at no strength: the same def object', () => {
    const fx = list(['velocity', 15], ['split', 15]);
    expect(fxDef(shell, mt, fx, 0)).toBe(shell);
    expect(fxDef(shell, mt, fx, undefined)).toBe(shell);
    expect(fxDef(shell, mt, undefined, 3)).toBe(shell);
    expect(fxDef(shell, undefined, fx, 3)).toBe(shell);
    // (bits past the gun's own list mean nothing)
    expect(fxDef(shell, mt, fx, 4)).toBe(shell);
    for (const name of mt.effects) {
      expect(one(shell, name, 0), name).toBe(shell);
      expect(one(beam, name, 0), name).toBe(beam);
    }
    expect(fxList(mt, fx, 0)).toHaveLength(0);
    expect(fxMarks(fx, 0)).toBeUndefined();
    expect(fxMarks(list(['velocity', 0]), 1)).toBeUndefined();
  });

  it('the seam (launch.ts gunDef) gives a gun without a mask the def it always had', () => {
    const kind = Object.keys(tuning.weapons!)[0];
    const plain = gunDef(tuning, kind, {});
    expect(gunDef(tuning, kind, { gunFx: list(['heavy', 15]), fx: 0 })).toEqual(plain);
    expect(gunDef(tuning, kind, { fx: 1 })).toEqual(plain);
    expect(gunDef(tuning, kind, { gunFx: list(['heavy', 15]), fx: 1 }).damage).toBeCloseTo((plain.damage ?? 14) * mt.heavy.damage, 9);
  });

  it('a mending beam and point defence are left alone', () => {
    const fx = list(['heavy', 15], ['pierce', 15]);
    const mend: WeaponTuning = { ...beam, heal: true }, pd: WeaponTuning = { ...shell, pointDefence: true } as WeaponTuning;
    expect(fxDef(mend, mt, fx, 3)).toBe(mend);
    expect(fxDef(pd, mt, fx, 3)).toBe(pd);
  });
});

describe('fxDef: each effect on a shell, part way and full', () => {
  for (const [q, k] of [[MID, kMid], [FX_STEPS, 1]] as const) {
    it(`velocity at ${q}: faster and further`, () => {
      const d = one(shell, 'velocity', q), speed = fxTo(mt.velocity.speed, k), reach = fxTo(mt.velocity.range, k);
      expect(d.speed).toBeCloseTo(40 * speed, 9);
      expect(d.life).toBe(Math.round((100 * reach) / speed));
      // (its reach: speed × life, to the tick's rounding)
      expect(d.speed! * d.life!).toBeGreaterThan(40 * 100 * reach - d.speed!);
      expect(d.damage).toBe(20);
    });

    it(`heavy and hyper at ${q}: damage and speed, the reach kept`, () => {
      const h = one(shell, 'heavy', q), y = one(shell, 'hyper', q);
      expect(h.damage).toBeCloseTo(20 * fxTo(mt.heavy.damage, k), 9);
      expect(h.speed).toBeCloseTo(40 * fxTo(mt.heavy.speed, k), 9);
      expect(h.life).toBe(Math.round(100 / fxTo(mt.heavy.speed, k)));
      expect(y.damage).toBeCloseTo(20 * fxTo(mt.hyper.damage, k), 9);
      expect(y.speed).toBeCloseTo(40 * fxTo(mt.hyper.speed, k), 9);
      expect(y.life).toBe(Math.max(1, Math.round(100 / fxTo(mt.hyper.speed, k))));
    });

    it(`rapid at ${q}: each shot a smaller one, the lot more`, () => {
      const d = one(shell, 'rapid', q);
      expect(d.damage).toBeCloseTo((20 * fxTo(mt.rapid.total, k)) / fxTo(mt.rapid.rate, k), 9);
      expect(d.speed).toBe(40);
      expect(fxStep(mt, list(['rapid', q]), 1, 'rapid')).toBe(q);
      expect(fxStep(mt, list(['rapid', q]), 0, 'rapid')).toBe(0);
    });

    it(`split at ${q}: a fan of shells sharing the shot by place`, () => {
      const d = one(shell, 'split', q), n = mt.split.shots, total = fxTo(mt.split.total, k);
      expect(d.burst).toBe(n);
      expect(d.spread).toBeCloseTo((mt.split.spreadDeg * (n - 1)) / 2, 9);
      expect(d.jitter).toBe(2);
      expect(d.burstShare).toHaveLength(n);
      // (the sides k/n of it each, the middle, last, the rest: all of it at no strength)
      expect(d.burstShare![0]).toBeCloseTo((k / n) * total, 9);
      expect(d.burstShare![n - 1]).toBeCloseTo((1 - ((n - 1) * k) / n) * total, 9);
      expect(d.burstShare!.reduce((a, b) => a + b, 0)).toBeCloseTo(total, 9);
      expect(d.damage).toBe(20);
    });

    it(`explosive at ${q}: less direct, a blast around it`, () => {
      const d = one(shell, 'explosive', q);
      expect(d.damage).toBeCloseTo(20 * fxTo(mt.explosive.direct, k), 9);
      expect(d.splash!.damage).toBeCloseTo(20 * mt.explosive.blast * k, 9);
      expect(d.splash!.radius).toBeCloseTo(mt.explosive.radius[0] + (mt.explosive.radius[1] - mt.explosive.radius[0]) * k, 9);
    });

    it(`pierce at ${q}: on through, each hull its share`, () => {
      const d = one(shell, 'pierce', q), f = mt.pierce.fracs;
      expect(d.pierce).toBe(f.length - 1);
      expect(d.pierceFracs![0]).toBeCloseTo(1 - (1 - f[0]) * k, 9);
      for (let i = 1; i < f.length; i++) expect(d.pierceFracs![i]).toBeCloseTo(f[i] * k, 9);
      expect(d.damage).toBe(20);
    });

    it(`wave at ${q}: wide, through everything, each for less`, () => {
      const d = one(shell, 'wave', q);
      expect(d.size).toBeCloseTo(fxTo(mt.wave.width, k), 9);
      expect(d.pierce).toBeGreaterThanOrEqual(16);
      expect(d.pierceFracs).toEqual([fxTo(mt.wave.perTarget, k)]);
    });

    it(`chain at ${q}: arcs on, each a share of the last`, () => {
      expect(one(shell, 'chain', q).chain).toEqual({ count: mt.chain.jumps, radius: mt.chain.reach, falloff: mt.chain.frac * k, fx: q });
    });

    it(`burn at ${q}: a share of the hit again, over its time`, () => {
      const d = one(shell, 'burn', q), ticks = Math.round(mt.burn.secs * 60);
      expect(d.ignite!.ticks).toBe(ticks);
      expect((d.ignite!.dps * ticks) / 60).toBeCloseTo(20 * mt.burn.total * k, 9);
      expect(d.damage).toBe(20);
    });
  }
});

describe('fxDef: beams', () => {
  it('reach and burn: velocity and hyper reach further, the damage effects go on its burn', () => {
    expect(one(beam, 'velocity', 15).range).toBeCloseTo(500 * mt.velocity.range, 9);
    expect(one(beam, 'velocity', MID).range).toBeCloseTo(500 * fxTo(mt.velocity.range, kMid), 9);
    expect(one(beam, 'hyper', 15).range).toBeCloseTo(500 * (mt.hyper.beamRange ?? 1.3), 9);
    expect(one(beam, 'hyper', 15).dps).toBeCloseTo(60 * mt.hyper.damage, 9);
    expect(one(beam, 'heavy', MID).dps).toBeCloseTo(60 * fxTo(mt.heavy.damage, kMid), 9);
    expect(one(beam, 'rapid', 15).dps).toBeCloseTo(60 * mt.rapid.total, 9);
    // (a split beam is a fan of beams from the one muzzle, sharing its burn as a split's shells share the shot)
    for (const q of [15, MID]) {
      const s = one(beam, 'split', q), k = q / 15, n = mt.split.shots, total = fxTo(mt.split.total, k), fan = s.beamFan!;
      expect(s.dps).toBe(60);
      expect(s.burst).toBeUndefined();
      expect(s.burstShare).toBeUndefined();
      expect(fan.off.length).toBe(n);
      expect(fan.share.reduce((a, b) => a + b, 0)).toBeCloseTo(total, 9);
      expect(fan.off[0]).toBeCloseTo(-fan.off[n - 1], 12);
      expect(fan.off[1] - fan.off[0]).toBeCloseTo((mt.split.spreadDeg * Math.PI) / 180, 12);
      const mid = (n - 1) >> 1;
      expect(fan.off[mid]).toBeCloseTo(0, 12);
      expect(fan.share[mid]).toBeCloseTo((1 - ((n - 1) * k) / n) * total, 9);
      expect(fan.share[0]).toBeCloseTo((k / n) * total, 9);
    }
    const ramped: WeaponTuning = { ...beam, ramp: { ticks: 60, to: 3 } } as WeaponTuning;
    expect(one(ramped, 'heavy', 15).ramp!.to).toBeCloseTo(3 * mt.heavy.damage, 9);
  });

  it('a pulse: rapid makes each a smaller one', () => {
    const pulse = { ...beam, dps: undefined, damage: 90, pulse: { ticks: 12 } } as unknown as WeaponTuning;
    expect(one(pulse, 'rapid', 15).damage).toBeCloseTo((90 * mt.rapid.total) / mt.rapid.rate, 9);
    expect(one(pulse, 'heavy', MID).damage).toBeCloseTo(90 * fxTo(mt.heavy.damage, kMid), 9);
  });

  it('where it ends: a blast, arcs, a fire; pierce and wave carry it on through', () => {
    const e = one(beam, 'explosive', MID);
    expect(e.dps).toBeCloseTo(60 * fxTo(mt.explosive.direct, kMid), 9);
    expect(e.beamEnd!.blast!.frac).toBeCloseTo(mt.explosive.blast * kMid, 9);
    expect(one(beam, 'chain', 15).beamEnd!.chain).toEqual({ count: mt.chain.jumps, radius: mt.chain.reach, falloff: mt.chain.frac, fx: 15 });
    expect(one(beam, 'chain', 15).chain).toBeUndefined();
    expect(one(beam, 'burn', 15).beamEnd!.burn).toEqual({ frac: mt.burn.total, ticks: Math.round(mt.burn.secs * 60), fire: mt.burn.fire });
    const p = one(beam, 'pierce', 15);
    expect(p.pierceFracs).toEqual(mt.pierce.fracs);
    expect(p.pierce).toBe(mt.pierce.fracs.length - 1);
    const w = one(beam, 'wave', 15);
    expect(w.width).toBeCloseTo(4 * mt.wave.width, 9);
    expect(w.pierceFracs).toEqual([mt.wave.perTarget]);
    // (a zapping beam arcs as it always has: the chain is its own)
    const zap = { ...beam, zap: { every: 10 } } as unknown as WeaponTuning;
    expect(one(zap, 'chain', 15).chain).toBeDefined();
    expect(one(zap, 'chain', 15).beamEnd).toBeUndefined();
  });
});

describe('fxDef: composition and the cache', () => {
  it('one order whatever the gun\'s list says: the same numbers either way round', () => {
    const names = ['burn', 'chain', 'wave', 'pierce', 'explosive', 'split', 'rapid', 'hyper', 'heavy', 'velocity'];
    const a = list(...names.map((n, i): [string, number] => [n, 3 + i])), b = [...a].reverse();
    const all = (1 << a.length) - 1;
    expect(fxDef(shell, mt, a, all)).toEqual(fxDef(shell, mt, b, all));
    expect(fxDef(beam, mt, a, all)).toEqual(fxDef(beam, mt, b, all));
    // (and a part of the list: the same effects by their own bits)
    expect(fxDef(shell, mt, a, 0b1000010001)).toEqual(fxDef(shell, mt, b, 0b1000100001));
  });

  it('later steps read what earlier ones made', () => {
    // Heavy then explosive: the blast is of the heavier shot
    const he = fxDef(shell, mt, list(['explosive', 15], ['heavy', 15]), 3), hit = 20 * mt.heavy.damage;
    expect(he.damage).toBeCloseTo(hit * mt.explosive.direct, 9);
    expect(he.splash!.damage).toBeCloseTo(hit * mt.explosive.blast, 9);
    // Explosive then burn: the fire is of what still strikes the part
    const eb = fxDef(shell, mt, list(['burn', 15], ['explosive', 15]), 3);
    expect((eb.ignite!.dps * eb.ignite!.ticks) / 60).toBeCloseTo(20 * mt.explosive.direct * mt.burn.total, 9);
    // Pierce then wave: every share for less, and through everything
    const pw = fxDef(shell, mt, list(['wave', 15], ['pierce', 15]), 3);
    expect(pw.pierceFracs).toEqual(mt.pierce.fracs.map((x) => x * mt.wave.perTarget));
    expect(pw.pierce).toBeGreaterThan(mt.pierce.fracs.length);
    // Rapid then split: the smaller shot, shared
    const rs = fxDef(shell, mt, list(['split', 15], ['rapid', 15]), 3);
    expect(rs.damage).toBeCloseTo((20 * mt.rapid.total) / mt.rapid.rate, 9);
    expect(rs.burstShare!.reduce((x, y) => x + y, 0)).toBeCloseTo(mt.split.total, 9);
    // Velocity and hyper: the speeds multiply, only velocity's reach
    const vy = fxDef(shell, mt, list(['hyper', 15], ['velocity', 15]), 3);
    expect(vy.speed).toBeCloseTo(40 * mt.velocity.speed * mt.hyper.speed, 9);
    expect(vy.life).toBe(Math.round((100 * mt.velocity.range) / (mt.velocity.speed * mt.hyper.speed)));
  });

  it('an effect listed twice counts once, at its strongest', () => {
    expect(fxDef(shell, mt, list(['heavy', 6], ['heavy', 15]), 3)).toEqual(one(shell, 'heavy', 15));
  });

  it('a gun that already bursts, passes through, blasts or burns keeps its own', () => {
    const shot: WeaponTuning = { ...shell, burst: 4, pierce: 1, pierceKeep: 0.5, splash: { radius: 50, damage: 10 }, ignite: { dps: 5, ticks: 120, radius: 0 } } as WeaponTuning;
    const s = one(shot, 'split', 15);
    expect(s.burst).toBe(4 * mt.split.shots);
    expect(s.burstShare).toBeUndefined();
    expect(s.damage).toBeCloseTo((20 * mt.split.total) / mt.split.shots, 9);
    expect(s.splash!.damage).toBeCloseTo((10 * mt.split.total) / mt.split.shots, 9);
    const p = one(shot, 'pierce', 15);
    expect(p.pierceFracs![0]).toBe(1);
    expect(p.pierceFracs![1]).toBe(Math.max(mt.pierce.fracs[1], 0.5));
    const e = one(shot, 'explosive', 15);
    expect(e.splash!.radius).toBe(50);
    expect(e.splash!.damage).toBeCloseTo(10 + mt.explosive.blast * 30, 9);
    const b = one(shot, 'burn', 15);
    expect(b.ignite!.ticks).toBe(120);
    expect(b.ignite!.dps).toBeCloseTo(5 + (mt.burn.total * 20) / 2, 9);
  });

  it('cached: the same gun, list and mask give the same object; another mask or list its own', () => {
    const fx = list(['velocity', 15], ['split', 9]);
    const d = fxDef(shell, mt, fx, 3);
    expect(fxDef(shell, mt, fx, 3)).toBe(d);
    expect(fxDef(shell, mt, fx, 1)).toBe(fxDef(shell, mt, fx, 1));
    expect(fxDef(shell, mt, fx, 1)).not.toBe(d);
    expect(fxDef(shell, mt, list(['velocity', 15], ['split', 9]), 3)).not.toBe(d);
    expect(fxDef(shell, mt, list(['velocity', 15], ['split', 9]), 3)).toEqual(d);
    expect(fxMarks(fx, 3)).toBe(fxMarks(fx, 3));
    expect(fxMarks(fx, 2)).toEqual([{ fx: id('split'), k: 9 / FX_STEPS }]);
    expect(fxList(mt, fx, 3)).toEqual([{ name: 'velocity', k: 1 }, { name: 'split', k: 9 / FX_STEPS }]);
    expect(shell).toEqual({ type: 'projectile', damage: 20, speed: 40, life: 100, spread: 2, size: 1 });
  });

  it('a shot\'s children (a Prism\'s shards) carry its effects without rapid and split, cached apart from the shot\'s own', () => {
    const fx = list(['explosive', 15], ['rapid', 15], ['split', 15], ['burn', 15]);
    const kid = fxDef(shell, mt, fx, 15, true);
    expect(fxDef(shell, mt, fx, 15, true)).toBe(kid);
    expect(kid).not.toBe(fxDef(shell, mt, fx, 15));
    expect(kid).toEqual(fxDef(shell, mt, list(['explosive', 15], ['burn', 15]), 3));
    expect(kid.burst ?? 1).toBe(1);
    // (nothing left once those two are out: the def itself)
    expect(fxDef(shell, mt, list(['rapid', 15], ['split', 15]), 3, true)).toBe(shell);
    expect(fxDef(shell, mt, fx, 0, true)).toBe(shell);
  });

  it('split on a gun whose shot breaks up of itself: more shards in its fan, no volley', () => {
    const prism: WeaponTuning = { ...shell, split: { count: 5, arc: 40, kind: 'prism_shard' } };
    const d = one(prism, 'split', FX_STEPS);
    expect(d.split).toEqual({ count: 5 + mt.split.shots - 1, arc: 40, kind: 'prism_shard' });
    expect(d.burst).toBeUndefined();
    expect(d.burstShare).toBeUndefined();
    expect(d.damage).toBe(prism.damage);
    expect(one(prism, 'split', MID).split!.count).toBe(5 + Math.round((mt.split.shots - 1) * kMid));
    expect(prism.split!.count).toBe(5);
  });

  it('burn\'s fire: it spreads by tuning\'s rules (weaker part way), and takes what the gun\'s other effects give it', () => {
    const b = one(shell, 'burn', FX_STEPS).ignite!;
    expect(b.fire).toBe(mt.burn.fire);
    expect([b.layers, b.blast, b.arc]).toEqual([undefined, undefined, undefined]);
    const half = one(shell, 'burn', MID).ignite!.fire!;
    expect(half.base).toBeCloseTo(mt.burn.fire.base * kMid, 9);
    expect(half.per).toBeCloseTo(mt.burn.fire.per * kMid, 9);
    expect({ ...half, base: 0, per: 0, survive: 0 }).toEqual({ ...mt.burn.fire, base: 0, per: 0, survive: 0 });
    // Pierce or wave: layers along the shot's line; explosive: the blast lights; chain: the arcs light
    for (const through of ['pierce', 'wave']) {
      const d = fxDef(shell, mt, list(['burn', 15], [through, 15]), 3).ignite!;
      expect([d.layers, d.layerKeep], through).toEqual([mt.burn.layers, mt.burn.layerKeep]);
      expect(fxDef(beam, mt, list(['burn', 15], [through, 15]), 3).beamEnd!.burn!.layers, through).toBe(mt.burn.layers);
    }
    expect(fxDef(shell, mt, list(['burn', MID], ['pierce', 15]), 3).ignite!.layers).toBe(1 + Math.round((mt.burn.layers - 1) * kMid));
    expect(fxDef(shell, mt, list(['burn', 15], ['explosive', 15]), 3).ignite!.blast).toEqual(mt.burn.blast);
    expect(fxDef(beam, mt, list(['burn', 15], ['explosive', 15]), 3).beamEnd!.burn!.blast).toEqual(mt.burn.blast);
    expect(fxDef(shell, mt, list(['burn', 15], ['chain', 15]), 3).ignite!.arc).toBe(mt.burn.arc);
    expect(fxDef(beam, mt, list(['burn', 15], ['chain', 15]), 3).beamEnd!.burn!.arc).toBe(mt.burn.arc);
    // (a gun that sets fires of its own: its fire spreads too, and is as long as its own)
    const own = one({ ...shell, ignite: { dps: 5, ticks: 120, radius: 1 } }, 'burn', FX_STEPS).ignite!;
    expect(own.fire).toBe(mt.burn.fire);
    expect([own.ticks, own.radius]).toEqual([120, 1]);
    // (and a gun without the effect has none of it)
    expect(one(shell, 'pierce', 15).ignite).toBeUndefined();
  });

  it('an effect\'s colour is tuning\'s', () => {
    expect(fxColor(mt, 'burn')).toBe(mt.say.burn.color);
    expect(fxTint(mt, 'burn')).toBe(parseInt(mt.say.burn.color.slice(1), 16));
    expect(fxTint(mt, 'nothing')).toBe(0xffffff);
  });
});

describe('a chain\'s strength on an arc\'s detonation radius', () => {
  it('the step the server sends is the strength the client reads; a gun\'s own arc carries none', () => {
    for (let q = 1; q <= FX_STEPS; q++) expect(arcStrength(arcRadius(q)) * FX_STEPS, `step ${q}`).toBeCloseTo(q, 9);
    expect(arcStrength(arcRadius(FX_STEPS))).toBe(1);
    expect(ARC_RADIUS).toBe(30);
    expect(arcRadius(undefined)).toBe(30);
    expect(arcRadius(0)).toBe(30);
    expect(arcStrength(30)).toBe(0);
    // (a step past the top, or a radius off either end, is held to the range)
    expect(arcRadius(99)).toBe(30 + FX_STEPS);
    expect(arcStrength(29)).toBe(0);
    expect(arcStrength(999)).toBe(1);
  });
});
