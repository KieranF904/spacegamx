/**
 * Generative ambient music. What plays comes from data (data/audio.json `music`, resolved by musicProfiles.ts): each
 * system has its own mood (key, mode, chord progression, tempo, timbre, rhythm and textures), with variations near
 * its planets, in its zones and regions, and situations laid over them (docked, a boss's arena, a boss fight).
 *
 * Every bar a chord is voiced as a slow pad over a drone, with bells (bell, glass, pluck, chime or anvil) echoing
 * through a delay into a synthesised reverb, and where the mood has them an arpeggio, percussion, a bass line, a
 * deep swell and textures underneath (wind, crackle, rumble, hiss). A combat layer (pulsing bass, the mood's own
 * fight percussion, a quicker bar) fades in while you're fighting. A new mood takes over at the next bar: the pads
 * overlap, the drone and textures glide, and the old rhythm fades out across that bar as the new one fades in.
 *
 * A dread layer (setDread: nearing a boss's lair) creeps in over whatever's playing, and the mood's own music sinks
 * under it (less so where the mood says: a boss fight's own music stays on top): a low beating drone of a minor
 * second and a tritone, a wind moaning through a slow filter, a heartbeat, a few detuned bells out of a diminished
 * scale, ringing a long way, and now and then a metallic scrape swelling out of nowhere.
 *
 * Runs on any BaseAudioContext: live (start: a timer schedules ahead) or offline (startManual, then pump with a
 * clock you advance: scripts/audio-preview renders previews that way).
 */

import audioData from '../../../data/audio.json';
import { resolveMood, patternHits, type MusicRegistry, type MusicPlace, type Mood, type PercVoice, type BassLine, type NoiseKind, type BellTone, type Wave } from './musicProfiles';

/** The music registry (data/audio.json `music`) */
export const MUSIC = (audioData as unknown as { music: MusicRegistry }).music;

/** Every system's own mood (no area or situation), by id */
export function systemMood(systemId: string): Mood {
  return resolveMood(MUSIC, { system: systemId });
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** The dread layer's own key (whatever the system's): its root, and a diminished scale (all minor thirds and seconds: nothing resolves) */
const DREAD_ROOT = 33;
const DREAD_SCALE = [0, 1, 3, 4, 6, 7, 9, 10];

/** Each bell tone's partials (× the note, level) and ring (s) */
const BELLS: Record<BellTone, { partials: [number, number][]; decay: number }> = {
  bell: { partials: [[1, 1], [2.76, 0.25], [5.4, 0.08]], decay: 3.5 },
  glass: { partials: [[1, 1], [2.0, 0.35], [3.01, 0.18], [4.98, 0.06]], decay: 5 },
  pluck: { partials: [[1, 1], [2, 0.3], [3, 0.12]], decay: 1.2 },
  chime: { partials: [[1, 1], [3.0, 0.28], [6.1, 0.08]], decay: 2.6 },
  anvil: { partials: [[1, 1], [2.4, 0.45], [4.1, 0.3], [6.7, 0.15]], decay: 1.8 },
};

/** Each texture's level at 1 */
const NOISE_GAIN: Record<NoiseKind, number> = { wind: 0.5, crackle: 0.5, rumble: 0.9, hiss: 0.05 };

export interface MusicEngineOptions {
  /** The time now on the context's clock (default its currentTime; an offline render advances its own) */
  clock?: () => number;
}

export class MusicEngine {
  private out: GainNode;
  private reverb: ConvolverNode;
  private wet: GainNode;
  private echo: DelayNode;
  private drone: { osc: OscillatorNode[]; gain: GainNode; saw: GainNode; filter: BiquadFilterNode } | null = null;
  private noise = new Map<NoiseKind, GainNode>();
  private noiseBuf: AudioBuffer;
  private mood: Mood = systemMood('sol');
  /** A mood waiting for the next bar */
  private pending: Mood | null = null;
  /** The mood the held sounds (drone, textures, reverb) were last set to */
  private held: Mood | null = null;
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
  private now: () => number;

  constructor(private ctx: BaseAudioContext, destination: AudioNode, opts: MusicEngineOptions = {}) {
    this.now = opts.clock ?? (() => ctx.currentTime);
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
    // White noise for percussion (one buffer, played from random offsets)
    const nl = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, nl, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nl; i++) nd[i] = Math.random() * 2 - 1;
  }

  start(): void {
    if (this.running) return;
    this.startManual();
    this.timer = window.setInterval(() => this.pump(), 250);
  }

  /** Start without a timer: call pump() as the clock advances (offline renders) */
  startManual(): void {
    if (this.running) return;
    this.running = true;
    this.nextBar = this.now() + 0.3;
    this.startDrone();
    this.startNoise();
    this.startDreadBed();
    this.applyHeld(this.now(), 0.05);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
  }

  /** Play the music of a place (it takes over at the next bar) */
  setPlace(place: MusicPlace): void {
    this.setMood(resolveMood(MUSIC, place));
  }

  /** Switch to a system's own mood (takes effect at the next bar) */
  setSystem(systemId: string): void {
    this.setPlace({ system: systemId });
  }

  /** Switch mood: at the next bar, crossfading (straight away before it starts) */
  setMood(m: Mood): void {
    if (!this.running) {
      this.mood = m;
      return;
    }
    this.pending = m;
  }

  /** The mood playing (and the one waiting for the next bar, if any) */
  get current(): { mood: Mood; pending: Mood | null } {
    return { mood: this.mood, pending: this.pending };
  }

  /** 0 = none .. 1 = full dread (eases in and out over several seconds) */
  setDread(level: number): void {
    this.dreadTarget = Math.max(0, Math.min(1, level));
  }

  /** 0 = calm .. 1 = fighting (eases in and out) */
  setCombat(level: number): void {
    this.combatTarget = Math.max(0, Math.min(1, level));
  }

  /** Schedule what's due in the next second (the live timer calls this every 250 ms) */
  pump(): void {
    if (!this.running) return;
    const now = this.now();
    this.dread += (this.dreadTarget - this.dread) * 0.03;
    if (this.dreadBed) this.dreadBed.gain.gain.setTargetAtTime(0.32 * this.dread * this.mood.dreadScale, now, 0.8);
    this.combat += (this.combatTarget - this.combat) * 0.08;
    this.combatTarget *= 0.97; // decays unless refreshed
    while (this.nextBar < now + 1.0) {
      const t = this.nextBar;
      let prev: Mood | null = null;
      if (this.pending) {
        prev = this.mood;
        this.mood = this.pending;
        this.pending = null;
        this.barIndex = 0;
        this.applyHeld(t, 2.5);
      }
      const bar = this.barLength();
      this.playBar(t, bar, prev);
      this.nextBar += bar;
      this.barIndex++;
    }
  }

  private barLength(): number {
    return this.mood.bar * (this.combat > 0.5 ? this.mood.combat.tempo ?? 0.75 : 1);
  }

  /** The held sounds follow the mood: the drone glides to its root, the textures, reverb and echo ease over */
  private applyHeld(t: number, tau: number): void {
    const m = this.mood, prev = this.held;
    this.held = m;
    // Each glide starts from where the last one was headed (anchored: a glide with nothing before it at its start
    // isn't safe to leave to the implementation), or before anything has played, straight to it
    const glide = (p: AudioParam, from: number, to: number, k = 1) => {
      if (!prev) { p.value = to; return; }
      p.setValueAtTime(from, t);
      p.setTargetAtTime(to, t, tau * k);
    };
    const was = prev ?? m;
    if (this.drone) {
      this.drone.osc.forEach((o, i) => {
        const hz = (x: Mood) => midiHz(x.root - 24 + (i === 2 ? 7 : 0)) * (i === 1 ? 1.003 : 1);
        glide(o.frequency, hz(was), hz(m));
      });
      glide(this.drone.filter.frequency, was.brightness * 0.5, m.brightness * 0.5, 1.2);
      glide(this.drone.saw.gain, was.droneSaw, m.droneSaw);
      // (The drone's own level fades in on its own at the start: startDrone)
      if (prev) glide(this.drone.gain.gain, 0.22 * was.droneLevel, 0.22 * m.droneLevel);
    }
    for (const [kind, g] of this.noise) glide(g.gain, NOISE_GAIN[kind] * (was.noise[kind] ?? 0), NOISE_GAIN[kind] * (m.noise[kind] ?? 0));
    glide(this.wet.gain, was.reverb, m.reverb);
    glide(this.echo.delayTime, was.echo, m.echo);
    glide(this.out.gain, 0.55 * was.level, 0.55 * m.level);
  }

  private startDrone(): void {
    const ctx = this.ctx, m = this.mood, t = this.now();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22 * m.droneLevel, t + 6);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = m.brightness * 0.5;
    filter.Q.value = 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lg = ctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(filter.frequency);
    lfo.start(t);
    // Two detuned sawtooths (through their own level: some moods want only the soft sine) and a sine on the fifth
    const saw = ctx.createGain();
    saw.gain.value = m.droneSaw;
    saw.connect(filter);
    const osc = [0, 1, 2].map((i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sine' : 'sawtooth';
      o.frequency.value = midiHz(m.root - 24 + (i === 2 ? 7 : 0)) * (i === 1 ? 1.003 : 1);
      o.connect(i === 2 ? filter : saw);
      o.start(t);
      return o;
    });
    filter.connect(gain);
    gain.connect(this.out);
    gain.connect(this.reverb);
    this.drone = { osc, gain, saw, filter };
  }

  /** The textures, all running silent until a mood wants them: wind, fire's crackle, a deep rumble, static's hiss */
  private startNoise(): void {
    const ctx = this.ctx, sr = ctx.sampleRate, t = this.now();
    const len = sr * 4;
    const make = (fill: (d: Float32Array) => void) => {
      const b = ctx.createBuffer(1, len, sr);
      fill(b.getChannelData(0));
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      src.start(t);
      return src;
    };
    const brown = (d: Float32Array, k: number) => { let last = 0; for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * k; } };
    const bed = (kind: NoiseKind, src: AudioNode, wet = 0.5) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(this.out);
      const send = ctx.createGain();
      send.gain.value = wet;
      g.connect(send).connect(this.reverb);
      this.noise.set(kind, g);
    };
    // Wind: brown noise through a band wandering slowly
    {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 4;
      bp.frequency.value = 700;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06;
      const lg = ctx.createGain();
      lg.gain.value = 320;
      lfo.connect(lg).connect(bp.frequency);
      lfo.start(t);
      make((d) => brown(d, 3.5)).connect(bp);
      bed('wind', bp, 0.6);
    }
    // Crackle: sparse little bursts (embers, dust) over a faint low hum of fire
    {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2800;
      make((d) => {
        brown(d, 0.6);
        let i = 0;
        while (i < d.length) {
          i += Math.floor(sr * (0.01 + Math.random() * 0.09));
          const n = Math.floor(sr * (0.002 + Math.random() * 0.006)), a = 0.2 + Math.random() * 0.6;
          for (let j = 0; j < n && i + j < d.length; j++) d[i + j] += (Math.random() * 2 - 1) * a * (1 - j / n);
        }
      }).connect(lp);
      bed('crackle', lp, 0.3);
    }
    // Rumble: brown noise, all low
    {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 140;
      make((d) => brown(d, 4)).connect(lp);
      bed('rumble', lp, 0.4);
    }
    // Hiss: high, faint static
    {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 5000;
      bp.Q.value = 0.7;
      make((d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }).connect(bp);
      bed('hiss', bp, 0.2);
    }
  }

  private startDreadBed(): void {
    const ctx = this.ctx, t = this.now();
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
      o.start(t);
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
    lfo.start(t);
    const wind = ctx.createGain();
    wind.gain.value = 0.5;
    src.connect(bp).connect(wind).connect(gain);
    src.start(t);
    gain.connect(this.out);
    gain.connect(this.reverb);
    this.dreadBed = { gain, wind };
  }

  private note(degree: number, octave: number, m: Mood = this.mood): number {
    const s = m.scale;
    const o = Math.floor(degree / s.length);
    return m.root + 12 * (octave + o) + s[((degree % s.length) + s.length) % s.length];
  }

  private playBar(t: number, bar: number, prev: Mood | null): void {
    const m = this.mood;
    const deg = m.progression[this.barIndex % m.progression.length];
    // Pad: root, third, fifth (+ the ninth sometimes), each a detuned pair, slow swell
    // (the mood's own music sinks under the dread)
    const dread = this.dread * m.dreadScale;
    const calm = 1 - 0.85 * dread;
    const voices = [deg, deg + 2, deg + 4, ...(Math.random() < 0.5 ? [deg + 8] : [])];
    for (const v of voices) {
      const f = midiHz(this.note(v, 0));
      for (const det of [-6, 6]) this.padVoice(t, bar, f * Math.pow(2, det / 1200), (0.05 / voices.length * 3) * calm * m.padLevel);
    }
    if (dread > 0.05) this.dreadBar(t, bar, dread);
    // Bells: a few scale notes scattered across the bar
    const count = Math.round(m.bells * (1 + this.combat) * (0.6 + Math.random() * 0.8) * calm);
    for (let i = 0; i < count; i++) {
      const at = t + Math.random() * bar * 0.9;
      const d = deg + [0, 2, 4, 7, 9][Math.floor(Math.random() * 5)];
      this.bell(at, midiHz(this.note(d, m.bellOctave)), 0.05 + Math.random() * 0.04, m.bellTone, (Math.random() * 2 - 1) * m.pan);
    }
    if (m.swell > 0) this.swell(t, bar, midiHz(Math.max(28, this.note(deg, -2) - 12)), 0.12 * m.swell * calm);
    // The rhythm (arpeggio, percussion, bass, the fight's layer): on a change, the old one fades out across this bar
    // as the new one fades in
    if (prev) {
      const pdeg = prev.progression[0];
      this.rhythm(prev, t, bar, pdeg, calm, this.fadeBus(t, bar, 1, 0));
      this.rhythm(m, t, bar, deg, calm, this.fadeBus(t, bar, 0, 1));
    } else this.rhythm(m, t, bar, deg, calm, this.out);
  }

  /** A bus for one bar that fades from `a` to `b` across it */
  private fadeBus(t: number, bar: number, a: number, b: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, a), t);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, b), t + bar * 0.9);
    g.connect(this.out);
    return g;
  }

  private rhythm(m: Mood, t: number, bar: number, deg: number, calm: number, dest: AudioNode): void {
    const combat = this.combat;
    // Arpeggio
    if (m.arp && Math.random() < (m.arp.chance ?? 1)) {
      const a = m.arp, step = bar / a.steps;
      for (let i = 0; i < a.steps; i++) {
        const f = midiHz(this.note(deg + a.pattern[i % a.pattern.length], a.octave, m));
        this.arpNote(t + i * step, f, a.level * calm, a.decay ?? 1, a.wave ?? 'triangle', (i % 2 ? 1 : -1) * m.pan * 0.6, dest);
      }
    }
    // Percussion: the mood's own, giving way to its fight percussion as the fighting builds
    const fightPerc = m.combat.perc;
    const calmK = fightPerc ? 1 - 0.75 * Math.min(1, combat * 1.4) : 1;
    if (m.perc && calmK > 0.05) for (const p of m.perc) this.percLine(p, t, bar, p.level * calmK * (0.5 + 0.5 * calm), dest);
    if (fightPerc && combat > 0.08) for (const p of fightPerc) this.percLine(p, t, bar, p.level * combat, dest);
    // Bass: the mood's line when calm; fighting, the fight's (by default pulsing sixteenths on the chord's root)
    if (m.bass) this.bassLine(m, m.bass, t, bar, deg, m.bass.level * (1 - 0.6 * combat) * calm, dest);
    if (combat > 0.08) {
      const fb = m.combat.bass;
      if (fb) this.bassLine(m, fb, t, bar, deg, fb.level * combat, dest);
      else if (fb === undefined) {
        const steps = 16;
        for (let i = 0; i < steps; i++) {
          if (i % 4 === 3 && Math.random() < 0.5) continue;
          this.pulse(t + (i * bar) / steps, midiHz(this.note(deg, -2, m)), (0.09 * combat) * (i % 4 === 0 ? 1.3 : 1), bar / steps, 'sawtooth', dest);
        }
      }
    }
  }

  private percLine(p: PercVoice, t: number, bar: number, level: number, dest: AudioNode): void {
    const hits = patternHits(p.pattern);
    const step = bar / hits.length;
    hits.forEach((h, i) => { if (h > 0) this.perc(p.kind, t + i * step, level * h, p.pitch ?? 1, dest); });
  }

  private bassLine(m: Mood, b: BassLine, t: number, bar: number, deg: number, level: number, dest: AudioNode): void {
    const chars = [...b.pattern], hits = patternHits(b.pattern), step = bar / chars.length;
    chars.forEach((c, i) => {
      if (!hits[i]) return;
      let n = this.note(deg, -2, m);
      if (c === '5') n = this.note(deg + 4, -2, m);
      else if (c === '8') n += 12;
      // Held until the next note
      let len = 1;
      while (i + len < chars.length && !hits[i + len]) len++;
      this.pulse(t + i * step, midiHz(n), level * hits[i], Math.min(step * len, step * 3), b.wave ?? 'triangle', dest);
    });
  }

  /** A bar of dread: a heartbeat, a few detuned bells ringing a long way, now and then a scrape */
  private dreadBar(t: number, bar: number, k: number): void {
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
      for (const det of [-22, 19]) this.bell(at, f * Math.pow(2, det / 1200), 0.035 * k, 'bell', 0);
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
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
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
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
  }

  private padVoice(t: number, dur: number, f: number, amp: number): void {
    const ctx = this.ctx, m = this.mood;
    const o = ctx.createOscillator();
    o.type = m.pad;
    o.frequency.value = f;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.setValueAtTime(m.brightness * 0.6, t);
    fl.frequency.linearRampToValueAtTime(m.brightness * (1 + this.combat * 0.6), t + dur * 0.5);
    fl.frequency.linearRampToValueAtTime(m.brightness * 0.6, t + dur * 1.3);
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

  private bell(t: number, f: number, amp: number, tone: BellTone, pan: number): void {
    const ctx = this.ctx, b = BELLS[tone];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + (tone === 'glass' ? 0.02 : 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t + b.decay);
    for (const [mult, a] of b.partials) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f * mult;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + b.decay + 0.1);
    }
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(this.out);
    p.connect(this.echo);
    p.connect(this.reverb);
  }

  private arpNote(t: number, f: number, amp: number, decay: number, wave: Wave, pan: number, dest: AudioNode): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = f;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = Math.min(4000, f * 4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(fl).connect(g).connect(p);
    p.connect(dest);
    p.connect(this.echo);
    o.start(t);
    o.stop(t + decay + 0.05);
  }

  /** A deep swell under the bar: a sub tone rising and sinking away */
  private swell(t: number, bar: number, f: number, amp: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 0.97, t);
    o.frequency.linearRampToValueAtTime(f, t + bar * 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(amp, t + bar * 0.45);
    g.gain.linearRampToValueAtTime(0.0001, t + bar);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + bar + 0.05);
  }

  /** One drum hit */
  private perc(kind: PercVoice['kind'], t: number, amp: number, pitch: number, dest: AudioNode): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(dest);
    const tone = (type: OscillatorType, f0: number, f1: number, sweep: number, len: number, a: number, into: AudioNode = g) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0 * pitch, t);
      o.frequency.exponentialRampToValueAtTime(f1 * pitch, t + sweep);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.linearRampToValueAtTime(a, t + 0.006);
      e.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(e).connect(into);
      o.start(t);
      o.stop(t + len + 0.05);
    };
    const noise = (type: BiquadFilterType, f: number, q: number, len: number, a: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const fl = ctx.createBiquadFilter();
      fl.type = type;
      fl.frequency.value = f;
      fl.Q.value = q;
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t);
      e.gain.linearRampToValueAtTime(a, t + 0.003);
      e.gain.exponentialRampToValueAtTime(0.0001, t + len);
      src.connect(fl).connect(e).connect(g);
      src.start(t, Math.random() * 0.8);
      src.stop(t + len + 0.05);
    };
    g.gain.value = amp;
    switch (kind) {
      case 'kick': tone('sine', 110, 42, 0.12, 0.4, 0.9); break;
      case 'tom': tone('sine', 150, 85, 0.25, 0.5, 0.8); tone('triangle', 300, 170, 0.08, 0.12, 0.15); break;
      case 'thump': {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 180;
        lp.connect(g);
        tone('sine', 70, 32, 0.2, 0.6, 1, lp);
        break;
      }
      case 'clank': {
        // Inharmonic metal, low and dulled: no ring above a few kHz
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 900 * pitch;
        bp.Q.value = 2.5;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2400;
        bp.connect(lp).connect(g);
        for (const k of [1, 1.47, 2.13]) tone('square', 220 * k, 210 * k, 0.2, 0.25, 0.18, bp);
        noise('bandpass', 1400, 1.5, 0.05, 0.25);
        break;
      }
      case 'shaker': noise('highpass', 5000, 0.7, 0.06, 0.5); break;
      case 'snare': noise('bandpass', 1500, 0.8, 0.18, 0.6); tone('triangle', 190, 160, 0.05, 0.1, 0.35); break;
    }
  }

  private pulse(t: number, f: number, amp: number, len: number, wave: Wave, dest: AudioNode): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = wave;
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
    o.connect(fl).connect(g).connect(dest);
    o.start(t);
    o.stop(t + len);
  }
}
