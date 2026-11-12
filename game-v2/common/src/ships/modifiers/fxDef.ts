/**
 * @contract ships.modifiers.fx-def
 * owns:       what a weapon modifier's effects do to a shot: the tuning a gun fires with (launch.ts gunDef), changed
 *             by the effects live when the shot was spent; the effects on a shot as a list (fxList, fxMarks)
 * needs:      tuning.ts WeaponTuning, modifiers/types; nothing of power or ports (a gun's effects and the shot's mask
 *             come in from outside)
 * invariants: no effects live (mask 0, no list, no tuning, an effect at no strength) returns `def` itself, so a ship
 *             without modifiers fires exactly what it did — common/src/ships/modifiers/fxDef.test.ts
 *             pure and cached: the same (def, mt, gunFx list, mask) gives the same object every time, so a steady
 *             gun allocates nothing a shot — common/src/ships/modifiers/fxDef.test.ts
 *             one fixed order whatever the list's: velocity, heavy, hyper, rapid (the scalars), then split,
 *             explosive, pierce, wave, chain, burn; an effect listed twice counts once, at its strongest —
 *             common/src/ships/modifiers/fxDef.test.ts
 *             a volley rebuilt from a record with its mask is the one fired, a split's count and shares too —
 *             common/src/ships/modifiers/shots.test.ts
 *             a shot's children (`child`: a Prism's shards) carry its effects without rapid and split, cached apart;
 *             split on a gun whose shot breaks up of itself (def.split) adds to its fan and makes no volley —
 *             common/src/ships/modifiers/fxDef.test.ts
 * extend:    a new effect is a step in build(), its numbers in tuning.json `modifiers`; it sets only fields the
 *             server's shells and beams already act on, or one made for it in tuning.ts (as pierceFracs, burstShare,
 *             beamFan, beamEnd), so the hit rules and volley builders need no effect names
 */

/**
 * What a weapon modifier's effects do to a shot (docs/design/weapon-modifiers-2026-11.md). The numbers are tuning.json
 * `modifiers`; each live effect acts at its strength k = q / FX_STEPS (fxTo: none at 0, its full value at 1). Later
 * steps read what the earlier ones made.
 */
import type { WeaponTuning, FireFx } from '../tuning.js';
import { FX_STEPS, fxStrength, fxTo, type GunFx, type ModifierTuning } from './types.js';

/** What a passing shell keeps after `i` passes (keep to the i, by multiplying: no pow in shared maths) */
function keepAt(keep: number, i: number): number {
  let k = 1;
  for (let j = 0; j < i; j++) k *= keep;
  return k;
}

/** A live effect on a shot: its name (ModifierTuning.effects) and strength (0..1) */
export interface FxLive { name: string; k: number }

/** Shells a volley may have (sim/events.ts SHOT_ID_BARRELS: a shot id's barrel field) */
const MAX_SHELLS = 32;
/** Beams a split beam's fan may have (the server keeps each one's ramp and end by its place: bridge/beamFx.ts gunRay) */
export const MAX_RAYS = 8;
/** A wave's shell passes through this many ships (every one it crosses) */
const WAVE_PASSES = 32;
/** Hyper on a beam: its reach × this at full strength, unless tuning says (modifiers.hyper.beamRange) */
const HYPER_BEAM_RANGE = 1.3;

const NONE: readonly FxLive[] = Object.freeze([]);

/** An arc's detonation radius as the server sends it: a gun's own arc's (a Tesla's, a Spark's) */
export const ARC_RADIUS = 30;
/** An arc's detonation radius, a chain modifier's strength step `fx` riding on it (none: the plain arc's, as ever) */
export const arcRadius = (fx: number | undefined): number => ARC_RADIUS + (fx && fx > 0 ? Math.min(FX_STEPS, Math.round(fx)) : 0);
/** The chain modifier's strength (0..1) an arc's detonation radius carries (0: a gun's own arc) */
export const arcStrength = (radius: number): number => Math.max(0, Math.min(FX_STEPS, Math.round(radius - ARC_RADIUS))) / FX_STEPS;

/** The effects live on a shot, in the gun's own order: `mask` bit i = gunFx[i] (one at no strength isn't live) */
export function fxList(mt: ModifierTuning | undefined, gunFx: readonly GunFx[] | undefined, mask: number | undefined): readonly FxLive[] {
  if (!mt || !gunFx || !mask) return NONE;
  let out: FxLive[] | undefined;
  for (let i = 0; i < gunFx.length; i++) {
    const name = mask & (1 << i) ? mt.effects[gunFx[i].fx] : undefined;
    if (name && gunFx[i].q > 0) (out ??= []).push({ name, k: fxStrength(gunFx[i]) });
  }
  return out ?? NONE;
}

/** A live effect by its id (its place in ModifierTuning.effects) and strength (0..1): what a client's drawn shot or beam carries */
export interface FxMark { readonly fx: number; readonly k: number }

const marks = new WeakMap<readonly GunFx[], (readonly FxMark[] | undefined)[]>();

/** The effects live on a shot or beam by id, in the gun's own order (cached: the same list for the same gun and mask); undefined: none */
export function fxMarks(gunFx: readonly GunFx[] | undefined, mask: number | undefined): readonly FxMark[] | undefined {
  if (!gunFx || !mask) return undefined;
  mask &= (1 << gunFx.length) - 1;
  if (!mask) return undefined;
  let by = marks.get(gunFx);
  if (!by) marks.set(gunFx, (by = []));
  const made = (by[mask] ??= gunFx.filter((g, i) => mask! & (1 << i) && g.q > 0).map((g) => ({ fx: g.fx, k: fxStrength(g) })));
  return made.length ? made : undefined;
}

/** Bit i of a gun's mask whose effect is `name`, as its strength step q (0: the gun has none, or it isn't live) */
export function fxStep(mt: ModifierTuning | undefined, gunFx: readonly GunFx[] | undefined, mask: number | undefined, name: string): number {
  if (!mt || !gunFx || !mask) return 0;
  let q = 0;
  for (let i = 0; i < gunFx.length; i++) if (mask & (1 << i) && mt.effects[gunFx[i].fx] === name && gunFx[i].q > q) q = gunFx[i].q;
  return q;
}

/** An effect's colour as tuning has it ('#rrggbb'), and as a number (white for one tuning doesn't name) */
export function fxColor(mt: ModifierTuning | undefined, name: string): string {
  return mt?.say[name]?.color ?? '#ffffff';
}

export function fxTint(mt: ModifierTuning | undefined, name: string): number {
  const n = parseInt(fxColor(mt, name).slice(1), 16);
  return n >= 0 ? n : 0xffffff;
}

interface Cached { mt: ModifierTuning; byMask: (WeaponTuning | undefined)[]; child?: (WeaponTuning | undefined)[] }
const cache = new WeakMap<WeaponTuning, WeakMap<readonly GunFx[], Cached>>();

/**
 * A gun's tuning with a shot's live effects on it (see the header). `gunFx` must be the layout's own list (its
 * identity keys the cache); `mask` says which of them the shot carries. `child`: `def` is a shot its gun's shot broke
 * into (a Prism's shard, tuning.ts split.kind): it carries the gun's effects but for the ones that are the volley's
 * (CHILD_SKIP), so a shard never fans or breaks again.
 */
export function fxDef(def: WeaponTuning, mt: ModifierTuning | undefined, gunFx: readonly GunFx[] | undefined, mask: number | undefined, child = false): WeaponTuning {
  if (!mt || !gunFx || !mask) return def;
  mask &= (1 << gunFx.length) - 1;
  if (!mask) return def;
  let byList = cache.get(def);
  if (!byList) cache.set(def, (byList = new WeakMap()));
  let c = byList.get(gunFx);
  if (!c || c.mt !== mt) byList.set(gunFx, (c = { mt, byMask: [] }));
  if (child) return ((c.child ??= [])[mask] ??= build(def, mt, fxList(mt, gunFx, mask).filter((f) => !CHILD_SKIP.includes(f.name))));
  return (c.byMask[mask] ??= build(def, mt, fxList(mt, gunFx, mask)));
}

/** The effects a shot's children leave out: rapid is the gun's cycle (the shot they broke from was the smaller one already), split the volley's */
const CHILD_SKIP: readonly string[] = ['rapid', 'split'];

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

function build(def: WeaponTuning, mt: ModifierTuning, live: readonly FxLive[]): WeaponTuning {
  // (A mending beam and point defence are tools: nothing here is theirs)
  if (!live.length || def.heal || def.pointDefence) return def;
  const k = (name: string): number => { let m = 0; for (const f of live) if (f.name === name && f.k > m) m = f.k; return m; };
  const kv = k('velocity'), kh = k('heavy'), ky = k('hyper'), kr = k('rapid'), ks = k('split'), ke = k('explosive'), kp = k('pierce'), kw = k('wave'), kc = k('chain'), kb = k('burn');
  const beam = def.type === 'beam';
  const d: WeaponTuning = { ...def };

  // 1-4 The scalars. Speed and reach: a faster shell lives less long, so only velocity changes how far it goes
  const speed = fxTo(mt.velocity.speed, kv) * fxTo(mt.heavy.speed, kh) * fxTo(mt.hyper.speed, ky);
  const reach = fxTo(mt.velocity.range, kv);
  // (rapid: each shot is a smaller one, 1/rate of the gun's, and the lot comes to `total`; the gun cycles `rate` times as fast, guns.ts)
  const rate = fxTo(mt.rapid.rate, kr);
  let dmg = fxTo(mt.heavy.damage, kh) * fxTo(mt.hyper.damage, ky) * fxTo(mt.rapid.total, kr);
  if (beam) {
    const far = reach * fxTo(mt.hyper.beamRange ?? HYPER_BEAM_RANGE, ky);
    if (far !== 1) d.range = (def.range ?? 800) * far;
    // (explosive's change to the hit itself goes on its burn; a split's is its fan's shares, step 5)
    dmg *= fxTo(mt.explosive.direct, ke);
    if (def.pulse) { if (dmg !== rate) d.damage = ((def.damage ?? 0) * dmg) / rate; }
    else if (dmg !== 1) {
      d.dps = (def.dps ?? 50) * dmg;
      if (def.ramp) d.ramp = { ...def.ramp, to: def.ramp.to * dmg };
    }
  } else {
    if (speed !== 1 || reach !== 1) {
      d.speed = (def.speed ?? 48) * speed;
      d.life = Math.max(1, Math.round(((def.life ?? 150) * reach) / speed));
      if (def.maxSpeed !== undefined) d.maxSpeed = def.maxSpeed * speed;
      if (def.accel !== undefined) d.accel = def.accel * speed;
    }
    dmg /= rate;
    if (dmg !== 1) {
      d.damage = (def.damage ?? 14) * dmg;
      // (its own burst and fire are part of its hit)
      if (def.splash) d.splash = { ...def.splash, damage: def.splash.damage * dmg };
      if (def.ignite) d.ignite = { ...def.ignite, dps: def.ignite.dps * dmg };
    }
  }

  // 5 Split (a shell that breaks into shots of its own, a Prism's): more of them in its fan, and no volley of it
  if (ks > 0 && !beam && def.split) d.split = { ...def.split, count: Math.min(MAX_SHELLS, def.split.count + Math.max(0, Math.round((mt.split.shots - 1) * ks))) };
  // 5 Split (shells): the shot as a fan of `shots`, the middle one keeping most of it
  else if (ks > 0 && !beam) {
    const total = fxTo(mt.split.total, ks), own = Math.max(1, Math.round(def.burst ?? 1));
    if (own > 1) {
      // A gun that already fires a burst throws `shots` times the shells in its own fan, the shot's damage shared between them
      const n = Math.max(1, Math.min(mt.split.shots, Math.floor(MAX_SHELLS / own)));
      d.burst = own * n;
      scaleHit(d, total / n);
    } else {
      const n = Math.max(1, Math.min(MAX_SHELLS, Math.round(mt.split.shots)));
      if (n > 1) {
        d.burst = n;
        // (the fan is exact, `spreadDeg` between neighbours; each shell keeps the gun's own scatter)
        d.jitter = def.spread ?? 1.8;
        d.spread = (mt.split.spreadDeg * (n - 1)) / 2;
        const side = (ks / n) * total, share: number[] = [];
        for (let i = 0; i < n - 1; i++) share.push(side);
        share.push((1 - ((n - 1) * ks) / n) * total);
        d.burstShare = share;
      } else scaleHit(d, total);
    }
  }

  // 5 Split (beams): the beam as a fan of `shots` from the one muzzle, sharing its burn as a split's shells do
  if (ks > 0 && beam) {
    const total = fxTo(mt.split.total, ks), n = Math.max(1, Math.min(MAX_RAYS, Math.round(mt.split.shots)));
    if (n > 1) {
      const step = (mt.split.spreadDeg * Math.PI) / 180, mid = (n - 1) >> 1, off: number[] = [], share: number[] = [];
      for (let i = 0; i < n; i++) {
        off.push((i - (n - 1) / 2) * step);
        share.push(i === mid ? (1 - ((n - 1) * ks) / n) * total : (ks / n) * total);
      }
      d.beamFan = { off, share };
    } else if (def.pulse) d.damage = (d.damage ?? 0) * total;
    else {
      d.dps = (d.dps ?? 50) * total;
      if (d.ramp) d.ramp = { ...d.ramp, to: d.ramp.to * total };
    }
  }

  // 6 Explosive: less into the part it strikes, a blast of the shot's damage around it
  if (ke > 0) {
    const radius = lerp(mt.explosive.radius[0], mt.explosive.radius[1], ke), frac = mt.explosive.blast * ke;
    if (beam) d.beamEnd = { ...d.beamEnd, blast: { radius, frac } };
    else {
      const hit = d.damage ?? 14;
      d.damage = hit * fxTo(mt.explosive.direct, ke);
      // (a gun with a burst of its own: the blast is of its whole shot, on its own burst, as wide as the wider)
      d.splash = d.splash ? { radius: Math.max(d.splash.radius, radius), damage: d.splash.damage + frac * (hit + d.splash.damage) } : { radius, damage: frac * hit };
    }
  }

  // 7 Pierce: on through `fracs.length` targets, each taking its share (a gun that passes through already keeps the better of the two each time)
  if (kp > 0) {
    const f = mt.pierce.fracs, own = Math.max(0, Math.round(def.pierce ?? 0)), keep = def.pierceKeep ?? 0.75;
    const n = Math.max(own + 1, f.length), fracs: number[] = [];
    for (let i = 0; i < n; i++) {
      const mine = i < f.length ? (i ? f[i] * kp : 1 - (1 - f[0]) * kp) : 0;
      fracs.push(own > 0 && i <= own ? Math.max(mine, keepAt(keep, i)) : mine);
    }
    d.pierce = n - 1;
    d.pierceFracs = fracs;
  }

  // 8 Wave: wide, and through every ship it crosses, each for `perTarget` (of what pierce left it there)
  if (kw > 0) {
    const per = fxTo(mt.wave.perTarget, kw), wide = fxTo(mt.wave.width, kw);
    if (beam) d.width = (def.width ?? 0) * wide;
    else d.size = (def.size ?? 1) * wide;
    // (a gun that passes through already, with no pierce effect: what it kept each pass, then on at its last)
    const own = Math.max(0, Math.round(def.pierce ?? 0)), base = d.pierceFracs ?? Array.from({ length: own + 1 }, (_, i) => keepAt(def.pierceKeep ?? 0.75, i));
    d.pierceFracs = base.map((x) => x * per);
    d.pierce = WAVE_PASSES;
  }

  // 9 Chain: arcs on from what it hits, each `frac` of the last
  if (kc > 0) {
    const add = { count: Math.max(1, Math.round(mt.chain.jumps)), radius: mt.chain.reach, falloff: mt.chain.frac * kc, fx: Math.max(1, Math.round(kc * FX_STEPS)) };
    // (a held beam arcs from where it ends, each damage step; a shell or a zapping beam as the Tesla's does. One that arcs already: further, and more)
    if (beam && !def.zap) d.beamEnd = { ...d.beamEnd, chain: add };
    else d.chain = def.chain ? { count: def.chain.count + Math.max(1, Math.round(add.count * kc)), radius: Math.max(def.chain.radius, add.radius), falloff: Math.max(def.chain.falloff, add.falloff), fx: add.fx } : add;
  }

  // 10 Burn: `total` of the hit again, over `secs`, on the part it struck (a gun that sets fires already: a hotter one, as long as its own)
  // (its fire spreads over the hull, ships/fire.ts; and with the gun's other effects: a sharing shot lights `layers` parts
  // along its line into each hull, a blast lights parts it reaches, an arc lights what it strikes)
  if (kb > 0) {
    const frac = mt.burn.total * kb, ticks = Math.max(1, Math.round(mt.burn.secs * 60));
    const f = mt.burn.fire, more: FireFx = { fire: kb >= 1 ? f : { ...f, base: f.base * kb, per: f.per * kb, survive: f.survive * kb } };
    if (d.pierceFracs) { more.layers = 1 + Math.round((mt.burn.layers - 1) * kb); more.layerKeep = mt.burn.layerKeep; }
    if (ke > 0) more.blast = { chance: mt.burn.blast.chance * kb, scale: mt.burn.blast.scale, max: mt.burn.blast.max };
    if (kc > 0) more.arc = mt.burn.arc;
    if (beam) d.beamEnd = { ...d.beamEnd, burn: { frac, ticks, ...more } };
    else {
      const again = frac * (d.damage ?? 14);
      d.ignite = d.ignite ? { ...d.ignite, dps: d.ignite.dps + again / (d.ignite.ticks / 60), ...more } : { dps: again / (ticks / 60), ticks, radius: 0, ...more };
    }
  }
  return d;
}

/** A shell's whole hit (its damage, its own burst and fire) × m */
function scaleHit(d: WeaponTuning, m: number): void {
  d.damage = (d.damage ?? 14) * m;
  if (d.splash) d.splash = { ...d.splash, damage: d.splash.damage * m };
  if (d.ignite) d.ignite = { ...d.ignite, dps: d.ignite.dps * m };
}
