/**
 * Generative ambient music. Each system has a mood (root, scale, chord
 * progression, tempo, timbre). Every bar a chord is voiced as a slow pad over
 * a drone, with sparse bell notes echoing through a delay into a synthesised
 * reverb. A combat layer (pulsing bass and quicker bells) fades in while you're
 * fighting. Changing system crossfades to the new mood at the next bar.
 *
 * A dread layer (setDread: nearing a boss's lair) creeps in over whatever's
 * playing, and the mood's own music sinks under it: a low beating drone of a
 * minor second and a tritone, a wind moaning through a slow filter, a
 * heartbeat, a few detuned bells out of a diminished scale, ringing a long
 * way, and now and then a metallic scrape swelling out of nowhere.
 */

import type { SystemVisualsData } from '@space-game/common';
import systemsData from '../../../data/systems.json';

export interface Mood {
  /** MIDI note of the tonic */
  root: number;
  /** Scale steps in semitones from the root */
  scale: number[];
  /** Chord roots as scale degrees (0-based), one per bar */
  progression: number[];
  /** Seconds per bar */
  bar: number;
  pad: OscillatorType;
  /** Pad filter cutoff, Hz */
  brightness: number;
  /** Bell notes per bar (average) */
  bells: number;
  /** Octave offset of the bells */
  bellOctave: number;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];

const SCALES: Record<string, number[]> = { major: MAJOR, lydian: LYDIAN, dorian: DORIAN, aeolian: AEOLIAN, phrygian: PHRYGIAN };

/** Home (Sol): warm and open. The mood of any system without its own. */
const DEFAULT_MOOD: Mood = { root: 50, scale: MAJOR, progression: [0, 4, 5, 3], bar: 9, pad: 'sawtooth', brightness: 900, bells: 2.2, bellOctave: 2 };

/** Each system's mood: data/systems.json `visuals.music` */
export const MOODS: Record<string, Mood> = { sol: DEFAULT_MOOD };
for (const s of (systemsData as unknown as { systems: { id: string; visuals?: SystemVisualsData }[] }).systems) {
  const m = s.visuals?.music;
  if (!m) continue;
  MOODS[s.id] = { ...m, scale: typeof m.scale === 'string' ? SCALES[m.scale] ?? MAJOR : m.scale };
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** The dread layer's own key (whatever the system's): its root, and a diminished scale (all minor thirds and seconds: nothing resolves) */
const DREAD_ROOT = 33;
const DREAD_SCALE = [0, 1, 3, 4, 6, 7, 9, 10];

export class MusicEngine {
  private out: GainNode;
  private reverb: ConvolverNode;
  private wet: GainNode;
  private echo: DelayNode;
  private drone: { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private mood: Mood = MOODS.sol;
  private nextBar = 0;
  private barIndex = 0;
  private timer = 0;
  private combat = 0;
  private combatTarget = 0;
  private dread = 0;
  private dreadTarget = 0;
  /** The dread layer's held sounds (the drone and the wind), made with the drone, silent until it's wanted */
  private dreadBed: { gain: GainNode; wind: GainNode } | null = null;
  private running = false;

  constructor(private ctx: AudioContext, destination: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.55;
    this.out.connect(destination);
    // Reverb from a synthesised impulse: 5 s of decaying stereo noise
    this.reverb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 5);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb.buffer = ir;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.7;
    this.reverb.connect(this.wet).connect(this.out);
    // Echo for bells (feedback delay into the reverb)
    this.echo = ctx.createDelay(2);
    this.echo.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2600;
    this.echo.connect(tone).connect(fb).connect(this.echo);
    tone.connect(this.reverb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextBar = this.ctx.currentTime + 0.3;
    this.startDrone();
    this.startDreadBed();
    this.timer = window.setInterval(() => this.schedule(), 250);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
  }

  /** Switch mood (takes effect at the next bar; the drone glides). */
  setSystem(systemId: string): void {
    const m = MOODS[systemId] ?? MOODS.sol;
    if (m === this.mood) return;
    this.mood = m;
    this.barIndex = 0;
    if (this.drone) {
      const t = this.ctx.currentTime;
      this.drone.osc.forEach((o, i) => o.frequency.setTargetAtTime(midiHz(m.root - 24 + (i === 2 ? 7 : 0)) * (i === 1 ? 1.003 : 1), t, 2.5));
      this.drone.filter.frequency.setTargetAtTime(m.brightness * 0.5, t, 3);
    }
  }

  /** 0 = none .. 1 = full dread (eases in and out over several seconds) */
  setDread(level: number): void {
    this.dreadTarget = Math.max(0, Math.min(1, level));
  }

  /** 0 = calm .. 1 = fighting (eases in and out) */
  setCombat(level: number): void {
    this.combatTarget = Math.max(0, Math.min(1, level));
  }

  private startDrone(): void {
    const ctx = this.ctx, m = this.mood;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 6);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = m.brightness * 0.5;
    filter.Q.value = 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lg = ctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(filter.frequency);
    lfo.start();
    const osc = [0, 1, 2].map((i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sine' : 'sawtooth';
      o.frequency.value = midiHz(m.root - 24 + (i === 2 ? 7 : 0)) * (i === 1 ? 1.003 : 1);
      o.connect(filter);
      o.start();
      return o;
    });
    filter.connect(gain);
    gain.connect(this.out);
    gain.connect(this.reverb);
    this.drone = { osc, gain, filter };
  }

  private startDreadBed(): void {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // The drone: the root, a minor second over it (beating against it), a tritone, all low and dark
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    for (const [st, type, amp] of [[0, 'sine', 0.5], [1, 'sine', 0.32], [6, 'triangle', 0.22], [-12, 'sine', 0.4]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = midiHz(DREAD_ROOT + st) * (1 + (Math.random() - 0.5) * 0.004);
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(lp);
      o.start();
    }
    lp.connect(gain);
    // The wind: noise through a narrow filter, wandering slowly up and down
    const len = this.ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 6;
    bp.frequency.value = 420;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 260;
    lfo.connect(lg).connect(bp.frequency);
    lfo.start();
    const wind = ctx.createGain();
    wind.gain.value = 0.5;
    src.connect(bp).connect(wind).connect(gain);
    src.start();
    gain.connect(this.out);
    gain.connect(this.reverb);
    this.dreadBed = { gain, wind };
  }

  private schedule(): void {
    if (!this.running) return;
    this.dread += (this.dreadTarget - this.dread) * 0.03;
    if (this.dreadBed) this.dreadBed.gain.gain.setTargetAtTime(0.32 * this.dread, this.ctx.currentTime, 0.8);
    this.combat += (this.combatTarget - this.combat) * 0.08;
    this.combatTarget *= 0.97; // decays unless refreshed
    while (this.nextBar < this.ctx.currentTime + 1.0) {
      this.playBar(this.nextBar);
      this.nextBar += this.mood.bar * (this.combat > 0.5 ? 0.75 : 1);
      this.barIndex++;
    }
  }

  private note(degree: number, octave: number): number {
    const s = this.mood.scale;
    const o = Math.floor(degree / s.length);
    return this.mood.root + 12 * (octave + o) + s[((degree % s.length) + s.length) % s.length];
  }

  private playBar(t: number): void {
    const m = this.mood;
    const bar = m.bar * (this.combat > 0.5 ? 0.75 : 1);
    const deg = m.progression[this.barIndex % m.progression.length];
    // Pad: root, third, fifth (+ the ninth sometimes), each a detuned pair, slow swell
    // (the mood's own music sinks under the dread)
    const calm = 1 - 0.85 * this.dread;
    const voices = [deg, deg + 2, deg + 4, ...(Math.random() < 0.5 ? [deg + 8] : [])];
    for (const v of voices) {
      const f = midiHz(this.note(v, 0));
      for (const det of [-6, 6]) this.padVoice(t, bar, f * Math.pow(2, det / 1200), (0.05 / voices.length * 3) * calm);
    }
    if (this.dread > 0.05) this.dreadBar(t, bar);
    // Bells: a few scale notes scattered across the bar
    const count = Math.round(m.bells * (1 + this.combat) * (0.6 + Math.random() * 0.8) * calm);
    for (let i = 0; i < count; i++) {
      const at = t + Math.random() * bar * 0.9;
      const d = deg + [0, 2, 4, 7, 9][Math.floor(Math.random() * 5)];
      this.bell(at, midiHz(this.note(d, m.bellOctave)), 0.05 + Math.random() * 0.04);
    }
    // Combat: pulsing bass on the chord root
    if (this.combat > 0.08) {
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        if (i % 4 === 3 && Math.random() < 0.5) continue;
        this.pulse(t + (i * bar) / steps, midiHz(this.note(deg, -2)), (0.09 * this.combat) * (i % 4 === 0 ? 1.3 : 1), bar / steps);
      }
    }
  }

  /** A bar of dread: a heartbeat, a few detuned bells ringing a long way, now and then a scrape */
  private dreadBar(t: number, bar: number): void {
    const k = this.dread;
    // The heartbeat: two low beats, slow at first, quicker as it nears (and in a fight)
    const beats = Math.max(2, Math.round(bar / (1.6 - 0.5 * k - 0.3 * this.combat)));
    for (let i = 0; i < beats; i++) {
      const at = t + (i * bar) / beats;
      this.heartbeat(at, 0.26 * k);
      this.heartbeat(at + 0.3, 0.17 * k);
    }
    // Bells: out of the diminished scale, each a detuned pair (they beat), high and far off
    const bells = Math.random() < 0.6 ? 1 + Math.floor(Math.random() * 2) : 0;
    for (let i = 0; i < bells; i++) {
      const at = t + Math.random() * bar * 0.8, st = DREAD_SCALE[Math.floor(Math.random() * DREAD_SCALE.length)];
      const f = midiHz(DREAD_ROOT + 36 + st);
      for (const det of [-22, 19]) this.bell(at, f * Math.pow(2, det / 1200), 0.035 * k);
    }
    // A scrape: metal on metal, swelling out of nothing and gone
    if (Math.random() < 0.35 * k) this.scrape(t + Math.random() * bar * 0.6, 2.5 + Math.random() * 2, 0.09 * k);
  }

  private heartbeat(t: number, amp: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.35);
  }

  private scrape(t: number, dur: number, amp: number): void {
    const ctx = this.ctx;
    const len = Math.ceil(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f0 = 900 + Math.random() * 1400;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 28;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.linearRampToValueAtTime(f0 * (Math.random() < 0.5 ? 0.82 : 1.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + dur * 0.6);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g);
    g.connect(this.reverb);
    g.connect(this.echo);
    src.start(t);
    src.stop(t + dur);
  }

  private padVoice(t: number, dur: number, f: number, amp: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = this.mood.pad;
    o.frequency.value = f;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.setValueAtTime(this.mood.brightness * 0.6, t);
    fl.frequency.linearRampToValueAtTime(this.mood.brightness * (1 + this.combat * 0.6), t + dur * 0.5);
    fl.frequency.linearRampToValueAtTime(this.mood.brightness * 0.6, t + dur * 1.3);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + dur * 0.35);
    g.gain.setValueAtTime(amp, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0.0001, t + dur * 1.45);
    o.connect(fl).connect(g);
    g.connect(this.out);
    g.connect(this.reverb);
    o.start(t);
    o.stop(t + dur * 1.5);
  }

  private bell(t: number, f: number, amp: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    for (const [mult, a] of [[1, 1], [2.76, 0.25], [5.4, 0.08]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 3.6);
    }
    g.connect(this.out);
    g.connect(this.echo);
    g.connect(this.reverb);
  }

  private pulse(t: number, f: number, amp: number, len: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.Q.value = 6;
    fl.frequency.setValueAtTime(900, t);
    fl.frequency.exponentialRampToValueAtTime(120, t + len * 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.95);
    o.connect(fl).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + len);
  }
}
