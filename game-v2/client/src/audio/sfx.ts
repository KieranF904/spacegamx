/**
 * Every sound effect, synthesised: each recipe builds a small Web Audio graph
 * in an OfflineAudioContext and renders it to a buffer once at startup. No
 * sound files; tweak a recipe to change a sound.
 *
 * The aim is weighty and physical rather than arcade: sounds are layers of a
 * sharp transient, a saturated noise body, a sub-bass thump, inharmonic
 * metal resonances and debris grains, with no pitch-swept "pew" tones.
 * Frequent sounds render several variants (seeded), picked at random on play,
 * and sfxMeta.ts says how many variants each has and how much of the shared
 * reverb it sends to.
 */

import { hashString, mulberry32 } from '@space-game/common';
import { SFX_TABLE, variantKey } from './sfxMeta';

const SR = 44100;

type Rand = () => number;
type Recipe = {
  duration: number;
  build(ctx: OfflineAudioContext, out: AudioNode, rnd: Rand): void;
};

/** White or brown (deep, rumbly) noise, peak-normalised */
function noiseBuffer(ctx: BaseAudioContext, seconds: number, rnd: Rand, color: 'white' | 'brown' = 'white'): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.max(1, Math.ceil(seconds * ctx.sampleRate)), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let y = 0, peak = 1e-9;
  for (let i = 0; i < d.length; i++) {
    const w = rnd() * 2 - 1;
    if (color === 'brown') { y = (y + 0.02 * w) / 1.02; d[i] = y; } else d[i] = w;
    peak = Math.max(peak, Math.abs(d[i]));
  }
  for (let i = 0; i < d.length; i++) d[i] /= peak;
  return buf;
}

function noise(ctx: OfflineAudioContext, seconds: number, rnd: Rand, color: 'white' | 'brown' = 'white'): AudioBufferSourceNode {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx, seconds, rnd, color);
  return n;
}

/** Gain with an attack/decay envelope starting at t0 */
function env(ctx: OfflineAudioContext, t0: number, peak: number, attack: number, decay: number, curve: 'exp' | 'lin' = 'exp'): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  else g.gain.linearRampToValueAtTime(0, t0 + attack + decay);
  return g;
}

function osc(ctx: OfflineAudioContext, type: OscillatorType, f0: number, f1?: number, t1 = 0, t0 = 0): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if (f1 !== undefined) o.frequency.exponentialRampToValueAtTime(f1, t0 + t1);
  return o;
}

function filter(ctx: OfflineAudioContext, type: BiquadFilterType, f0: number, q = 0.7, f1?: number, t1 = 0, t0 = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t0);
  if (f1 !== undefined) f.frequency.exponentialRampToValueAtTime(f1, t0 + t1);
  return f;
}

/** Soft saturation: thickens and roughens, like an overdriven mic on a hull */
function drive(ctx: OfflineAudioContext, k: number): WaveShaperNode {
  const s = ctx.createWaveShaper();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  s.curve = curve;
  s.oversample = '4x';
  return s;
}

function chain(...nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
}

/** Struck metal: decaying sine partials (inharmonic ratios), optionally bending down as it settles */
function modal(ctx: OfflineAudioContext, out: AudioNode, t0: number, parts: [freq: number, amp: number, decay: number][], bend = 1): void {
  for (const [f, a, d] of parts) {
    const o = osc(ctx, 'sine', f, bend !== 1 ? f * bend : undefined, d, t0);
    chain(o, env(ctx, t0, a, 0.0015, d), out);
    o.start(t0);
  }
}

/** Plain noise burst: source -> filters -> envelope -> out */
function burst(ctx: OfflineAudioContext, out: AudioNode, rnd: Rand, t0: number, peak: number, attack: number, decay: number,
  filters: AudioNode[], color: 'white' | 'brown' = 'white'): void {
  const n = noise(ctx, attack + decay + 0.05, rnd, color);
  chain(n, ...filters, env(ctx, t0, peak, attack, decay), out);
  n.start(t0);
}

/** A falling sine thump (the punch you feel) */
function thump(ctx: OfflineAudioContext, out: AudioNode, t0: number, f0: number, f1: number, peak: number, decay: number, k = 1.5): void {
  const o = osc(ctx, 'sine', f0, f1, decay * 0.8, t0);
  chain(o, drive(ctx, k), env(ctx, t0, peak, 0.002, decay), out);
  o.start(t0);
}

/**
 * Debris and crackle: many tiny noise clicks over `span` seconds, band-limited
 * to lo..hi. Dense early and thinning out (or the reverse with `rising`).
 */
function grains(ctx: OfflineAudioContext, out: AudioNode, rnd: Rand, t0: number, span: number, count: number,
  lo: number, hi: number, peak: number, rising = false): void {
  const buf = ctx.createBuffer(1, Math.ceil((span + 0.05) * SR), SR);
  const d = buf.getChannelData(0);
  for (let k = 0; k < count; k++) {
    const u = rnd();
    const pos = rising ? Math.sqrt(u) : Math.pow(u, 1.8);
    const start = Math.floor(pos * span * SR);
    const len = Math.floor((0.0015 + rnd() * 0.012) * SR);
    const fade = rising ? 0.3 + 0.7 * pos : Math.pow(1 - pos, 1.2);
    const amp = peak * (0.25 + 0.75 * rnd()) * fade;
    for (let i = 0; i < len && start + i < d.length; i++) d[start + i] += (rnd() * 2 - 1) * amp * Math.pow(1 - i / len, 2);
  }
  const s = ctx.createBufferSource();
  s.buffer = buf;
  chain(s, filter(ctx, 'highpass', lo), filter(ctx, 'lowpass', hi), out);
  s.start(t0);
}

/** Heavy docking clamp: a low metal clunk with a thud under it */
function clunk(ctx: OfflineAudioContext, out: AudioNode, rnd: Rand, t0: number, k: number, amp = 1): void {
  modal(ctx, out, t0, [[118 * k, 0.28 * amp, 0.3], [187 * k, 0.2 * amp, 0.22], [309 * k, 0.12 * amp, 0.16], [547 * k, 0.07 * amp, 0.1], [911 * k, 0.04 * amp, 0.06]]);
  burst(ctx, out, rnd, t0, 0.8 * amp, 0.001, 0.09, [filter(ctx, 'lowpass', 1100), drive(ctx, 2.5)]);
  thump(ctx, out, t0, 75 * k, 42 * k, 0.6 * amp, 0.18);
}

/** Pneumatic/servo swish for panels opening and closing */
function swish(ctx: OfflineAudioContext, out: AudioNode, rnd: Rand, f0: number, f1: number, dur: number, peak: number): void {
  const n = noise(ctx, dur + 0.05, rnd);
  chain(n, filter(ctx, 'bandpass', f0, 1.4, f1, dur), env(ctx, 0, peak, dur * 0.35, dur * 0.65), out);
  n.start();
}

const RECIPES: Record<string, Recipe> = {
  // Ship cannon (a heavy kinetic autocannon heard through the hull): a hard
  // crack, a saturated boom, a sub thump, the barrel ringing and the breech cycling
  shot: { duration: 0.55, build(ctx, out, r) {
    const k = 0.92 + r() * 0.16;
    burst(ctx, out, r, 0, 0.85, 0.0005, 0.03, [filter(ctx, 'highpass', 1800), drive(ctx, 3)]);
    burst(ctx, out, r, 0, 0.9, 0.001, 0.2, [filter(ctx, 'lowpass', 1500 * k, 0.9, 220, 0.18), drive(ctx, 2.6)]);
    // The bark: a mid-range blast so it cuts through instead of thudding
    burst(ctx, out, r, 0, 0.75, 0.001, 0.07, [filter(ctx, 'bandpass', 1100 * k, 1.1, 700, 0.07), drive(ctx, 3)]);
    thump(ctx, out, 0, 98 * k, 40, 1.0, 0.17, 1.8);
    modal(ctx, out, 0.002, [[312 * k, 0.1, 0.1], [527 * k, 0.07, 0.07], [869 * k, 0.04, 0.05]]);
    const tc = 0.055 + r() * 0.025;
    modal(ctx, out, tc, [[1240 * k, 0.045, 0.04], [1987 * k, 0.035, 0.035], [3150 * k, 0.025, 0.025]]);
    burst(ctx, out, r, tc, 0.12, 0.0005, 0.02, [filter(ctx, 'bandpass', 2600, 1.5)]);
  } },
  // A round striking a hull: a sharp impact, crunch, a clang of plate at
  // irregular pitches, and fragments skittering off
  hit: { duration: 0.6, build(ctx, out, r) {
    const k = 0.9 + r() * 0.2;
    burst(ctx, out, r, 0, 0.7, 0.0005, 0.015, [filter(ctx, 'highpass', 2500), drive(ctx, 3)]);
    burst(ctx, out, r, 0, 0.6, 0.001, 0.12, [filter(ctx, 'bandpass', 1200 * k, 0.8), drive(ctx, 2)]);
    thump(ctx, out, 0, 150 * k, 60, 0.5, 0.1);
    const b = 520 + r() * 520;
    modal(ctx, out, 0, [1, 1.593, 2.136, 2.83, 3.61].map((m, i) => [b * m * (0.98 + r() * 0.04), [0.15, 0.11, 0.08, 0.055, 0.035][i], [0.34, 0.27, 0.2, 0.14, 0.1][i] * (0.8 + r() * 0.4)] as [number, number, number]));
    grains(ctx, out, r, 0.01, 0.3, 10, 1500, 7000, 0.35);
  } },
  // A working hit of yours on rock (ShipClient.mineTick, throttled): light and dry, rock not metal: a soft chip of
  // stone (a short low-mid knock), a trickle of grit falling off the face, nothing ringing
  mine_tick: { duration: 0.28, build(ctx, out, r) {
    const k = 0.85 + r() * 0.3;
    burst(ctx, out, r, 0, 0.32, 0.0008, 0.035, [filter(ctx, 'bandpass', 900 * k, 1.1), drive(ctx, 1.6)]);
    thump(ctx, out, 0, 210 * k, 120 * k, 0.18, 0.05);
    grains(ctx, out, r, 0.012, 0.16, 7, 2200, 6500, 0.16);
  } },
  // A mining laser's pulse (MiningBeamFx: 54 ticks, its peak 0.4 of the way in,
  // ~0.36 s; the next starts as it ends, ~0.9 s): the pulse laser's low
  // end, softer and deeper, nothing at the top: a sub gathering, a round thoom
  // at the peak, a short low rumble trailing off
  mining_pulse: { duration: 1.3, build(ctx, out, r) {
    const k = 0.96 + r() * 0.08, peak = 0.36;
    const swell = (amp: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(amp * 0.3, peak * 0.6);
      g.gain.exponentialRampToValueAtTime(amp, peak);
      g.gain.exponentialRampToValueAtTime(0.0001, peak + 0.06);
      return g;
    };
    const sub = osc(ctx, 'sine', 40 * k, 50 * k, peak, 0);
    chain(sub, drive(ctx, 1.4), swell(0.34), out);
    sub.start(0); sub.stop(peak + 0.08);
    const hum = noise(ctx, peak + 0.1, r, 'brown');
    chain(hum, filter(ctx, 'lowpass', 200, 0.7), swell(0.16), out);
    hum.start(0);
    thump(ctx, out, peak, 74 * k, 30 * k, 0.75, 0.45, 2.0);
    const o = osc(ctx, 'sawtooth', 62 * k, 55 * k, 0.3, peak);
    chain(o, filter(ctx, 'lowpass', 300, 0.9, 140, 0.3, peak), drive(ctx, 2.2), env(ctx, peak, 0.12, 0.006, 0.3), out);
    o.start(peak); o.stop(peak + 0.4);
    burst(ctx, out, r, peak + 0.02, 0.28, 0.04, 0.75, [filter(ctx, 'lowpass', 240, 0.7, 110, 0.7, peak)], 'brown');
    const tail = osc(ctx, 'sine', 56 * k, 42 * k, 0.7, peak);
    chain(tail, env(ctx, peak + 0.02, 0.2, 0.04, 0.7), out);
    tail.start(peak); tail.stop(peak + 0.85);
  } },
  // A boss's beam gathering (its lance's charge, BossFx: played sped up when the charge is shorter): a sub-bass
  // swell rising out of nothing, a growl under it climbing and roughening, a brown rumble thickening, and at the
  // end, where the beam lets go, a deep thoom
  boss_charge: { duration: 3.2, build(ctx, out, r) {
    const k = 0.97 + r() * 0.06, fire = 2.7;
    const rise = (amp: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(amp * 0.15, fire * 0.45);
      g.gain.exponentialRampToValueAtTime(amp, fire);
      g.gain.exponentialRampToValueAtTime(0.0001, fire + 0.08);
      return g;
    };
    const sub = osc(ctx, 'sine', 26 * k, 52 * k, fire, 0);
    chain(sub, drive(ctx, 1.6), rise(0.42), out);
    sub.start(0); sub.stop(fire + 0.1);
    const growl = osc(ctx, 'sawtooth', 34 * k, 70 * k, fire, 0);
    chain(growl, filter(ctx, 'lowpass', 90, 1.2, 520, fire, 0), drive(ctx, 2.6), rise(0.2), out);
    growl.start(0); growl.stop(fire + 0.1);
    const rumble = noise(ctx, fire + 0.2, r, 'brown');
    chain(rumble, filter(ctx, 'lowpass', 120, 0.8, 380, fire, 0), rise(0.22), out);
    rumble.start(0);
    thump(ctx, out, fire, 70 * k, 24 * k, 0.9, 0.5, 2.4);
    burst(ctx, out, r, fire, 0.32, 0.01, 0.45, [filter(ctx, 'lowpass', 300, 0.7, 90, 0.4, fire)], 'brown');
  } },
  // A ball of magma swelling on a boss's turret (~0.85 s to the throw): a low gurgle bubbling up and
  // opening out, a sub rising under it, popping blisters getting thicker
  magma_charge: { duration: 1.1, build(ctx, out, r) {
    const k = 0.95 + r() * 0.1, end = 0.85;
    const rise = (amp: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(amp * 0.3, end * 0.5);
      g.gain.exponentialRampToValueAtTime(amp, end);
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.15);
      return g;
    };
    const gurgle = noise(ctx, end + 0.2, r, 'brown');
    chain(gurgle, filter(ctx, 'bandpass', 110 * k, 2.5, 420 * k, end, 0), drive(ctx, 2.2), rise(0.5), out);
    gurgle.start(0);
    const sub = osc(ctx, 'sine', 30 * k, 58 * k, end, 0);
    chain(sub, drive(ctx, 1.5), rise(0.35), out);
    sub.start(0); sub.stop(end + 0.2);
    // Blisters popping: little resonant plops, closer together as it swells
    for (let i = 0; i < 9; i++) {
      const t = end * Math.sqrt((i + r() * 0.6) / 9.6), f = (160 + r() * 140) * (1 + t);
      const o = osc(ctx, 'sine', f * 1.6, f, 0.06, t);
      chain(o, env(ctx, t, 0.12 + 0.18 * (t / end), 0.003, 0.07), out);
      o.start(t); o.stop(t + 0.1);
    }
  } },
  // A ball of magma hurled from a boss's turret: a deep heavy thoom, a wet tearing glorp, a hiss trailing off
  magma_shot: { duration: 1.5, build(ctx, out, r) {
    const k = 0.95 + r() * 0.1;
    thump(ctx, out, 0, 78 * k, 30 * k, 1.0, 0.6, 2.6);
    burst(ctx, out, r, 0, 0.7, 0.004, 0.5, [filter(ctx, 'lowpass', 700, 0.8, 140, 0.45), drive(ctx, 2.4)], 'brown');
    const glorp = noise(ctx, 0.5, r);
    chain(glorp, filter(ctx, 'bandpass', 700 * k, 4, 160 * k, 0.35, 0), env(ctx, 0.01, 0.35, 0.01, 0.35), out);
    glorp.start(0);
    burst(ctx, out, r, 0.05, 0.12, 0.05, 1.1, [filter(ctx, 'highpass', 2600), filter(ctx, 'lowpass', 7000)]);
    grains(ctx, out, r, 0.02, 0.8, 26, 900, 5000, 0.18);
  } },
  // A ball of magma bursting: a splatting crunch, a deep thud, molten gobbets spattering, a long sizzle
  magma_burst: { duration: 2.0, build(ctx, out, r) {
    const k = 0.95 + r() * 0.1;
    thump(ctx, out, 0, 64 * k, 26 * k, 0.9, 0.7, 2.4);
    burst(ctx, out, r, 0, 0.85, 0.002, 0.45, [filter(ctx, 'lowpass', 1600, 0.8, 200, 0.4), drive(ctx, 2.8)]);
    burst(ctx, out, r, 0, 0.5, 0.004, 0.6, [filter(ctx, 'lowpass', 400, 0.7, 90, 0.6)], 'brown');
    grains(ctx, out, r, 0.03, 1.0, 50, 700, 4500, 0.3);
    burst(ctx, out, r, 0.1, 0.14, 0.15, 1.6, [filter(ctx, 'highpass', 3000), filter(ctx, 'lowpass', 8000)]);
  } },
  // A boss's lance burning (played for its sweep, stopped at its end): a crack as it lights, then a driven
  // roar held under a fluttering burn, a thin sizzle over it, dying away when it's cut
  boss_beam: { duration: 3.2, build(ctx, out, r) {
    const k = 0.97 + r() * 0.06, hold = 2.6;
    const held = (amp: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(amp, 0.06);
      g.gain.setValueAtTime(amp, hold);
      g.gain.exponentialRampToValueAtTime(0.0001, hold + 0.5);
      return g;
    };
    thump(ctx, out, 0, 90 * k, 36 * k, 0.9, 0.5, 2.6);
    burst(ctx, out, r, 0, 0.6, 0.002, 0.3, [filter(ctx, 'lowpass', 2400, 0.8, 300, 0.3), drive(ctx, 2.6)]);
    for (const f of [55, 82.5, 110.8]) {
      const o = osc(ctx, 'sawtooth', f * k, f * 0.97 * k, hold, 0);
      chain(o, filter(ctx, 'lowpass', 420, 1.2), drive(ctx, 3), held(0.12), out);
      o.start(0); o.stop(hold + 0.6);
    }
    const burn = noise(ctx, hold + 0.6, r, 'brown');
    const flutter = filter(ctx, 'bandpass', 380, 1.4);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9 + r() * 4;
    const depth = ctx.createGain();
    depth.gain.value = 160;
    lfo.connect(depth).connect(flutter.frequency);
    lfo.start(0); lfo.stop(hold + 0.6);
    chain(burn, flutter, drive(ctx, 1.8), held(0.5), out);
    burn.start(0);
    const sizzle = noise(ctx, hold + 0.6, r);
    chain(sizzle, filter(ctx, 'highpass', 4200), held(0.06), out);
    sizzle.start(0);
  } },
  // A pulse laser's pulse (common/src/ships/pulse.ts: 84 ticks, its peak 0.42 of
  // the way in, ~0.59 s), in step with it and all low end, nothing whippy: a sub
  // swell and a growl gathering out of nothing (slow, narrow drifts, never a
  // sweep), a heavy thoom at the peak with a distorted low growl over it and
  // only a breath of sizzle, then a low rumble dying away
  laser_pulse: { duration: 2.1, build(ctx, out, r) {
    const k = 0.97 + r() * 0.06, peak = 0.59;
    /** A gain swelling out of nothing to `amp` at the peak, gone just after */
    const swell = (amp: number, cut = 0.05) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(amp * 0.25, peak * 0.6);
      g.gain.exponentialRampToValueAtTime(amp, peak);
      g.gain.exponentialRampToValueAtTime(0.0001, peak + cut);
      return g;
    };
    // Ramp: the sub (48 to 60 Hz, barely moving), a saw growl round 55 Hz opening up a little, a low rumble of charge
    const sub = osc(ctx, 'sine', 48 * k, 60 * k, peak, 0);
    chain(sub, drive(ctx, 1.6), swell(0.42, 0.06), out);
    sub.start(0); sub.stop(peak + 0.08);
    const growl = osc(ctx, 'sawtooth', 55 * k, 62 * k, peak, 0);
    chain(growl, filter(ctx, 'lowpass', 170, 0.9, 320, peak), swell(0.16), out);
    growl.start(0); growl.stop(peak + 0.08);
    const hum = noise(ctx, peak + 0.1, r, 'brown');
    chain(hum, filter(ctx, 'lowpass', 260, 0.7), swell(0.22, 0.04), out);
    hum.start(0);
    // Peak: the thoom (a falling sub, driven), a distorted low growl (two detuned saws, 82 and 110 Hz), a dull blast, a breath of sizzle
    thump(ctx, out, peak, 92 * k, 34 * k, 1.0, 0.55, 2.4);
    for (const f of [82, 110.5]) {
      const o = osc(ctx, 'sawtooth', f * k, f * 0.9 * k, 0.4, peak);
      chain(o, filter(ctx, 'lowpass', 520, 1.1, 180, 0.4, peak), drive(ctx, 3.2), env(ctx, peak, 0.2, 0.004, 0.4), out);
      o.start(peak); o.stop(peak + 0.5);
    }
    burst(ctx, out, r, peak, 0.75, 0.003, 0.42, [filter(ctx, 'lowpass', 900, 0.8, 160, 0.4, peak), drive(ctx, 2.6)], 'brown');
    burst(ctx, out, r, peak, 0.06, 0.001, 0.05, [filter(ctx, 'highpass', 3500)]);
    // Tail: a low rumble and the sub settling (70 to 50 Hz, slowly) as it dies away
    burst(ctx, out, r, peak + 0.03, 0.4, 0.05, 1.25, [filter(ctx, 'lowpass', 300, 0.7, 120, 1.2, peak)], 'brown');
    const tail = osc(ctx, 'sine', 70 * k, 50 * k, 1.1, peak);
    chain(tail, drive(ctx, 1.4), env(ctx, peak + 0.02, 0.28, 0.04, 1.1), out);
    tail.start(peak); tail.stop(peak + 1.3);
  } },
  // Your own hull taking a hit: a thud you feel, crunch, and the frame groaning
  hurt: { duration: 1.2, build(ctx, out, r) {
    thump(ctx, out, 0, 72, 32, 1.0, 0.5, 2);
    burst(ctx, out, r, 0, 0.8, 0.001, 0.35, [filter(ctx, 'lowpass', 1800, 0.8, 250, 0.4), drive(ctx, 2.5)]);
    const g = noise(ctx, 1.1, r);
    chain(g, filter(ctx, 'bandpass', 330 + r() * 40, 14, 170, 0.9), env(ctx, 0.05, 2.6, 0.08, 0.9), out);
    g.start();
    modal(ctx, out, 0, [[173, 0.15, 0.7], [289, 0.1, 0.55], [452, 0.07, 0.4]], 0.97);
    grains(ctx, out, r, 0.01, 0.5, 14, 800, 5000, 0.3);
  } },
  // Parts shot off / a small craft breaking up
  explosion_small: { duration: 2.2, build(ctx, out, r) {
    burst(ctx, out, r, 0, 0.9, 0.0005, 0.06, [filter(ctx, 'highpass', 1200), drive(ctx, 4)]);
    burst(ctx, out, r, 0, 1.0, 0.003, 1.7, [filter(ctx, 'lowpass', 3200, 0.7, 160, 1.6), drive(ctx, 2)], 'brown');
    thump(ctx, out, 0, 62, 26, 1.0, 1.1, 2);
    grains(ctx, out, r, 0.02, 1.6, 40, 1000, 8000, 0.4);
    const b = 900 + r() * 900;
    modal(ctx, out, 0.01, [[b, 0.04, 0.3], [b * 1.71, 0.03, 0.22], [b * 2.43, 0.02, 0.16]]);
  } },
  // A ship's core going: blast, a second deeper blast, long rumble, a rain of
  // debris and the structure groaning as it fails
  explosion_large: { duration: 5, build(ctx, out, r) {
    burst(ctx, out, r, 0, 1.0, 0.0005, 0.09, [filter(ctx, 'highpass', 900), drive(ctx, 4)]);
    burst(ctx, out, r, 0, 1.0, 0.002, 0.8, [filter(ctx, 'lowpass', 4000, 0.7, 300, 0.6), drive(ctx, 2.5)], 'brown');
    burst(ctx, out, r, 0.15, 1.0, 0.01, 3.2, [filter(ctx, 'lowpass', 2000, 0.7, 120, 2.5), drive(ctx, 2.5)], 'brown');
    thump(ctx, out, 0, 50, 18, 1.0, 3.0, 2.2);
    // Rumble with a slow, slowing tremble
    const n = noise(ctx, 4.5, r, 'brown');
    const trem = ctx.createGain();
    trem.gain.value = 0.7;
    const lfo = osc(ctx, 'sine', 3.3, 0.8, 3.5);
    const depth = ctx.createGain();
    depth.gain.value = 0.3;
    chain(lfo, depth, trem.gain as unknown as AudioNode);
    chain(n, filter(ctx, 'lowpass', 180), trem, env(ctx, 0.2, 0.9, 0.4, 3.8), out);
    n.start(); lfo.start();
    grains(ctx, out, r, 0.05, 3.5, 90, 600, 7000, 0.45);
    modal(ctx, out, 0.3, [[96, 0.12, 2.2], [151, 0.09, 1.8], [233, 0.06, 1.4]], 0.85);
  } },
  // Jump drive spooling (about the charge time): capacitors whining up,
  // a building drone, electrical crackle getting denser
  jump_charge: { duration: 1.6, build(ctx, out, r) {
    const swell = (peak: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(peak, 1.45);
      g.gain.linearRampToValueAtTime(0, 1.58);
      return g;
    };
    const w = swell(0.13);
    for (const m of [1, 2.01]) {
      const o = osc(ctx, 'sine', 220 * m, 3200 * m, 1.5);
      chain(o, w);
      o.start();
    }
    chain(w, filter(ctx, 'lowpass', 6000), out);
    const n = noise(ctx, 1.6, r, 'brown');
    chain(n, filter(ctx, 'lowpass', 90, 3, 500, 1.5), swell(0.8), out);
    n.start();
    const sub = osc(ctx, 'sine', 38, 70, 1.5);
    chain(sub, swell(0.55), out);
    sub.start();
    grains(ctx, out, r, 0, 1.5, 70, 2000, 9000, 0.28, true);
  } },
  // A charge gun gathering (about the Longbarrel's second): a thin whine rising and brightening, a swelling hum under it
  gun_charge: { duration: 1.4, build(ctx, out, r) {
    const swell = (peak: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(peak, 1.25);
      g.gain.linearRampToValueAtTime(0, 1.38);
      return g;
    };
    for (const m of [1, 1.503]) {
      const o = osc(ctx, 'sine', 300 * m, 2600 * m, 1.3);
      chain(o, swell(0.09), filter(ctx, 'lowpass', 7000), out);
      o.start();
    }
    const hum = osc(ctx, 'sawtooth', 60, 150, 1.3);
    chain(hum, filter(ctx, 'lowpass', 300, 0.8, 900, 1.3), swell(0.12), out);
    hum.start();
    grains(ctx, out, r, 0.2, 1.1, 40, 3000, 9000, 0.14, true);
  } },
  // A clip gun's reload seating: a short metal clack
  gun_clack: { duration: 0.35, build(ctx, out, r) {
    modal(ctx, out, 0, [[640, 0.2, 0.12], [1130, 0.14, 0.08], [2210, 0.07, 0.05]]);
    burst(ctx, out, r, 0, 0.7, 0.0008, 0.03, [filter(ctx, 'highpass', 1800), drive(ctx, 2)]);
    thump(ctx, out, 0.015, 130, 70, 0.4, 0.1);
  } },
  // The last round gone: the reload vent, a hiss of vented heat
  gun_vent: { duration: 0.7, build(ctx, out, r) {
    burst(ctx, out, r, 0, 0.45, 0.01, 0.5, [filter(ctx, 'bandpass', 5200, 0.9, 2400, 0.5)]);
    modal(ctx, out, 0.02, [[420, 0.12, 0.14], [880, 0.08, 0.1]]);
  } },
  // The Chainsaw's barrels spinning up: a motor winding from a growl to a whir
  gun_spin: { duration: 1.2, build(ctx, out, r) {
    const swell = (peak: number) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(peak, 1.0);
      g.gain.linearRampToValueAtTime(0, 1.15);
      return g;
    };
    const m = osc(ctx, 'sawtooth', 45, 340, 1.0);
    chain(m, drive(ctx, 3), filter(ctx, 'lowpass', 500, 1, 2600, 1.0), swell(0.2), out);
    m.start();
    const n = noise(ctx, 1.2, r, 'brown');
    chain(n, filter(ctx, 'bandpass', 200, 1.2, 1800, 1.0), swell(0.5), out);
    n.start();
    grains(ctx, out, r, 0, 1.1, 60, 1500, 6000, 0.2, true);
  } },
  // The jump itself: a deep boom and the air of the hull tearing away
  jump_launch: { duration: 2.6, build(ctx, out, r) {
    burst(ctx, out, r, 0, 0.9, 0.0005, 0.07, [filter(ctx, 'highpass', 1000), drive(ctx, 4)]);
    thump(ctx, out, 0, 72, 20, 1.0, 1.6, 2.2);
    burst(ctx, out, r, 0, 0.8, 0.003, 1.2, [filter(ctx, 'lowpass', 1500, 0.7, 100, 1.1), drive(ctx, 2)], 'brown');
    burst(ctx, out, r, 0, 0.9, 0.01, 2.2, [filter(ctx, 'bandpass', 4000, 0.8, 150, 2.0)]);
  } },
  // Dropping out of a jump: a rushing swell into a thump
  jump_arrive: { duration: 1.6, build(ctx, out, r) {
    const n = noise(ctx, 0.45, r);
    chain(n, filter(ctx, 'bandpass', 200, 1.2, 3000, 0.35), env(ctx, 0, 0.6, 0.32, 0.08), out);
    n.start();
    thump(ctx, out, 0.35, 82, 30, 0.9, 0.7, 2);
    burst(ctx, out, r, 0.35, 0.7, 0.002, 0.9, [filter(ctx, 'lowpass', 1200, 0.7, 150, 0.8), drive(ctx, 2)], 'brown');
  } },
  // Jump gates and rifts: a sub hit, a beating low drone and a rising-falling rush
  warp: { duration: 2.8, build(ctx, out, r) {
    thump(ctx, out, 0, 56, 30, 0.8, 1.4);
    for (const f of [62, 65.5, 124.5]) {
      const o = osc(ctx, 'sawtooth', f);
      chain(o, filter(ctx, 'lowpass', 300), env(ctx, 0, f > 100 ? 0.06 : 0.12, 0.4, 2.2), out);
      o.start();
    }
    const n = noise(ctx, 2.8, r);
    const f = filter(ctx, 'bandpass', 200, 2);
    f.frequency.exponentialRampToValueAtTime(2600, 0.9);
    f.frequency.exponentialRampToValueAtTime(300, 2.6);
    chain(n, f, env(ctx, 0, 0.7, 0.6, 2.0), out);
    n.start();
    grains(ctx, out, r, 0.2, 2.0, 40, 5000, 12000, 0.12);
  } },
  // Docking clamps engaging, pressure equalising, a quiet confirm tone
  dock: { duration: 2.0, build(ctx, out, r) {
    clunk(ctx, out, r, 0, 1);
    clunk(ctx, out, r, 0.32, 0.92);
    burst(ctx, out, r, 0.45, 0.22, 0.05, 0.9, [filter(ctx, 'highpass', 2500)]);
    for (const f of [880, 1320]) {
      const o = osc(ctx, 'sine', f);
      chain(o, filter(ctx, 'lowpass', 2500), env(ctx, 1.1, f > 1000 ? 0.035 : 0.06, 0.01, 0.35), out);
      o.start(1.1);
    }
  } },
  // Clamps releasing: a hiss of venting pressure, the clamp letting go, servos
  undock: { duration: 1.6, build(ctx, out, r) {
    burst(ctx, out, r, 0, 0.3, 0.01, 0.6, [filter(ctx, 'highpass', 3500, 0.7, 1500, 0.6)]);
    clunk(ctx, out, r, 0.18, 1.1, 0.7);
    const o = osc(ctx, 'sawtooth', 180, 260, 0.6, 0.3);
    chain(o, filter(ctx, 'lowpass', 900), env(ctx, 0.3, 0.05, 0.1, 0.6), out);
    o.start(0.3);
  } },
  // Credits in: two soft, short data tones
  credits: { duration: 0.7, build(ctx, out) {
    [1568, 2093].forEach((f, i) => {
      for (const [m, a] of [[1, 0.18], [2, 0.03]] as const) {
        const o = osc(ctx, 'sine', f * m);
        chain(o, env(ctx, i * 0.07, a, 0.003, 0.25), out);
        o.start(i * 0.07);
      }
    });
  } },
  // Level up: a warm chord swelling in, with a little air on top
  level_up: { duration: 3.0, build(ctx, out, r) {
    [220, 329.6, 440, 554.4, 659.3].forEach((f, i) => {
      for (const det of [-4, 4]) {
        const o = osc(ctx, 'sine', f * Math.pow(2, det / 1200));
        chain(o, env(ctx, i * 0.06, 0.045, 0.5, 2.3), out);
        o.start(i * 0.06);
      }
    });
    burst(ctx, out, r, 0.3, 0.05, 0.6, 1.8, [filter(ctx, 'highpass', 6000)]);
  } },
  // Refused: a low, muted double knock
  error: { duration: 0.45, build(ctx, out) {
    for (const t of [0, 0.15]) {
      for (const [f, a] of [[196, 0.35], [392, 0.1]] as const) {
        const o = osc(ctx, 'sine', f);
        chain(o, filter(ctx, 'lowpass', 700), env(ctx, t, a, 0.004, 0.11), out);
        o.start(t);
      }
    }
  } },
  // Cockpit master caution: two flat-topped tones
  warning: { duration: 0.6, build(ctx, out) {
    for (const t of [0, 0.2]) {
      for (const [f, a] of [[1046, 0.14], [2092, 0.035]] as const) {
        const o = osc(ctx, 'sine', f);
        chain(o, env(ctx, t, a, 0.004, 0.14, 'lin'), out);
        o.start(t);
      }
    }
  } },
  // Interface: small mechanical ticks and servo swishes, not blips
  ui_click: { duration: 0.05, build(ctx, out, r) {
    burst(ctx, out, r, 0, 0.35, 0.0003, 0.012, [filter(ctx, 'bandpass', 3200, 1.2)]);
    const o = osc(ctx, 'sine', 1800);
    chain(o, env(ctx, 0, 0.04, 0.0005, 0.02), out);
    o.start();
  } },
  ui_hover: { duration: 0.03, build(ctx, out, r) {
    burst(ctx, out, r, 0, 0.4, 0.0003, 0.008, [filter(ctx, 'bandpass', 5000, 2)]);
  } },
  ui_open: { duration: 0.4, build(ctx, out, r) {
    swish(ctx, out, r, 600, 2400, 0.25, 0.18);
    thump(ctx, out, 0, 160, 90, 0.25, 0.06, 1);
    burst(ctx, out, r, 0.24, 0.25, 0.0003, 0.012, [filter(ctx, 'bandpass', 3200, 1.2)]);
  } },
  ui_close: { duration: 0.35, build(ctx, out, r) {
    swish(ctx, out, r, 2400, 500, 0.22, 0.16);
    thump(ctx, out, 0.21, 140, 80, 0.25, 0.06, 1);
  } },
  // The jump drive's charged again: two soft rising tones over a hum settling
  jump_ready: { duration: 0.9, build(ctx, out, r) {
    thump(ctx, out, 0, 110, 70, 0.2, 0.25, 1);
    for (const [t, f] of [[0.02, 660], [0.14, 990]] as const) {
      const o = osc(ctx, 'sine', f);
      chain(o, filter(ctx, 'lowpass', 2400), env(ctx, t, 0.07, 0.01, 0.5), out);
      o.start(t);
    }
    burst(ctx, out, r, 0.12, 0.12, 0.002, 0.3, [filter(ctx, 'bandpass', 5000, 1.5)]);
  } },
};

/** One-pole lowpass made cyclic (run twice), so loops have no seam */
function cyclicLowpass(src: Float32Array, cut: number): Float32Array {
  const out = new Float32Array(src.length);
  let y = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < src.length; i++) {
      y += cut * (src[i] - y);
      if (pass === 1) out[i] = y;
    }
  }
  return out;
}

function normalise(d: Float32Array): Float32Array {
  let peak = 1e-9;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < d.length; i++) d[i] /= peak;
  return d;
}

/**
 * Engine: a deep rumble with a slow wobble and a low drive hum. Boost: a
 * band-limited roar fluttering like an afterburner. Built sample by sample;
 * every component is cyclic over the buffer (filters run twice, hum at whole
 * numbers of cycles), so the loop point is seamless.
 */
function loopBuffer(ctx: BaseAudioContext, kind: 'engine' | 'boost'): AudioBuffer {
  const seconds = 4;
  const n = seconds * SR;
  const buf = ctx.createBuffer(1, n, SR);
  const d = buf.getChannelData(0);
  const r = mulberry32(kind === 'engine' ? 61 : 67);
  const white = () => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = r() * 2 - 1; return w; };
  const w1 = white(), w2 = white();
  if (kind === 'engine') {
    const rumble = normalise(cyclicLowpass(w1, 0.006));
    const lo = cyclicLowpass(w1, 0.01), hi = cyclicLowpass(w1, 0.05);
    const mid = normalise(hi.map((v, i) => v - lo[i]));
    const wobble = normalise(cyclicLowpass(cyclicLowpass(w2, 0.0004), 0.0004));
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      d[i] = 0.62 * rumble[i] + 0.22 * mid[i] * (0.75 + 0.25 * wobble[i])
        + 0.12 * Math.sin(2 * Math.PI * 41 * t) + 0.05 * Math.sin(2 * Math.PI * 82.5 * t + 1.3);
    }
  } else {
    const lo = cyclicLowpass(w1, 0.03), hi = cyclicLowpass(w1, 0.35);
    const roar = normalise(hi.map((v, i) => v - lo[i]));
    const body = normalise(cyclicLowpass(w1, 0.01));
    const flutter = normalise(cyclicLowpass(w2, 0.01));
    for (let i = 0; i < n; i++) d[i] = 0.55 * roar[i] * (0.6 + 0.4 * Math.abs(flutter[i])) + 0.4 * body[i];
  }
  normalise(d);
  for (let i = 0; i < n; i++) d[i] *= 0.8;
  return buf;
}

/** Render every effect variant (in parallel) plus the loops. */
export async function renderSfx(ctx: BaseAudioContext): Promise<Map<string, AudioBuffer>> {
  const out = new Map<string, AudioBuffer>();
  const jobs: Promise<void>[] = [];
  for (const [id, recipe] of Object.entries(RECIPES)) {
    for (let v = 0; v < (SFX_TABLE[id]?.[0] ?? 1); v++) {
      jobs.push((async () => {
        const off = new OfflineAudioContext(1, Math.ceil(recipe.duration * SR), SR);
        const master = off.createGain();
        master.connect(off.destination);
        recipe.build(off, master, mulberry32(hashString(id) + v * 7919));
        const buf = await off.startRendering();
        // Layers can stack past full scale; keep each effect just under it
        const d = buf.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        if (peak > 0.95) for (let i = 0; i < d.length; i++) d[i] *= 0.95 / peak;
        out.set(variantKey(id, v), buf);
      })());
    }
  }
  await Promise.all(jobs);
  out.set('engine', loopBuffer(ctx, 'engine'));
  out.set('boost', loopBuffer(ctx, 'boost'));
  return out;
}

/**
 * The shared reverb's impulse: a short pre-delay, then stereo noise decaying
 * over about two seconds and darkening as it goes (a big metal interior).
 */
export function reverbImpulse(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const n = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  const pre = Math.floor(0.012 * ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const r = mulberry32(101 + ch);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / ctx.sampleRate;
      const c = 0.6 * Math.exp(-t / 0.8) + 0.04;
      y += c * ((r() * 2 - 1) - y);
      d[i] = y * Math.exp(-t / 0.55);
    }
    normalise(d);
  }
  return buf;
}
