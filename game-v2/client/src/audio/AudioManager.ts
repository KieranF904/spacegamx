/**
 * Audio: sound effects positional around the listener, engine/boost loops, and
 * generative music (MusicEngine). Effects come from generated files in
 * /sfx (scripts/gen-sfx.mjs, listed in /sfx/index.json); any effect without a
 * file uses its synthesised version from sfx.ts. Browsers only allow audio
 * after a user gesture, so it starts on the first click or key press.
 *
 *   master ─ compressor ─ out
 *     ├ sfx   (effects, panned by world position)
 *     │  └ reverb send ─ convolver ─┘ (more of it the further away a sound is)
 *     └ music
 */

import { renderSfx, reverbImpulse, variantKey, LoopId, SFX_REVERB, SFX_VARIANTS } from './sfx';
import { MusicEngine } from './MusicEngine';
import { WEAPON_KIND_TYPE } from '@space-game/common';
import { SHIP_FUNCTIONS } from '../ships/shipFunctionData';

/** Each part function's sounds (data/ships/functions.json `sfx`, `sfxTurret`, `sfxLoop`), by its weapon kind */
const FN_SOUNDS = SHIP_FUNCTIONS;
/** Projectile type (WEAPON_KIND_TYPE, the wire's data[0]) → its shot sound, plain and from a turret */
const SHOT_SFX = new Map<number, { sfx: string; turret?: string }>();
for (const f of FN_SOUNDS) {
  const type = f.weapon !== undefined ? WEAPON_KIND_TYPE[f.weapon] : undefined;
  if (type !== undefined && f.sfx !== undefined) SHOT_SFX.set(type, { sfx: f.sfx, turret: f.sfxTurret });
}
// A prism's shards aren't a part's own shot: they're silent
SHOT_SFX.set(WEAPON_KIND_TYPE.prism_shard, { sfx: '' });
/** Beam weapon kind → the loop that plays while it fires */
const BEAM_LOOP = new Map<string, LoopId>(FN_SOUNDS.filter((f) => f.weapon && f.sfxLoop).map((f) => [f.weapon!, f.sfxLoop as LoopId]));
const BEAM_LOOPS = [...new Set(BEAM_LOOP.values())];

/** World units at which a sound fades out entirely, and the panning width */
const AUDIO_MAX_DISTANCE = 6000;
const AUDIO_REF_DISTANCE = 1200;

/** At most this many copies of one effect at once (turret batteries fire a lot) */
const MAX_VOICES: Record<string, number> = { shot: 10, turret_shot: 10, flak_shot: 8, railgun_shot: 4, hit: 8, explosion_small: 6, part_break: 6, disintegrate: 3, bump: 4, hive_launch: 3, prism_shot: 4, boss_roar: 1, laser_pulse: 5, mining_pulse: 4, boss_charge: 2, magma_charge: 4, magma_shot: 4, magma_burst: 5, boss_beam: 1, gun_charge: 3, gun_clack: 6, gun_vent: 4, gun_spin: 2 };
/** Effects that, at their cap, cut the oldest copy short rather than stay silent (a ship's lasers fire in turn: each pulse must be heard) */
const STEAL = new Set(['laser_pulse', 'mining_pulse']);

/**
 * Level of each generated effect after loudness matching, so the mix sits
 * right: weapons and blasts up front, interface sounds well back.
 */
const FILE_GAIN: Record<string, number> = {
  shot: 0.85, turret_shot: 0.6, hit: 0.5, hurt: 0.8, explosion_small: 0.8, explosion_large: 1,
  part_break: 0.55, armor_break: 0.6, generator_blast: 0.8, thruster_blast: 0.75, weapon_cookoff: 0.65, conduit_spark: 0.45,
  disintegrate: 0.45, bump: 0.32, repair_part: 0.5,
  gun_charge: 0.7, gun_clack: 0.6, gun_vent: 0.55, gun_spin: 0.6,
  jump_charge: 0.75, jump_launch: 0.85, jump_arrive: 0.75, jump_ready: 0.35, warp: 0.8, dock: 0.7, undock: 0.65,
  credits: 0.4, level_up: 0.5, error: 0.45, warning: 0.5,
  ui_click: 0.3, ui_hover: 0.15, ui_open: 0.35, ui_close: 0.35,
  engine: 0.9, boost: 0.9, mining: 0.7, scan_ping: 0.6, craft_done: 0.6, sell: 0.5,
  railgun_shot: 0.9, flak_shot: 0.6, missile_launch: 0.7, emp_shot: 0.7, laser_loop: 0.6, lance_loop: 0.7, shield_hit: 0.5,
  boss_roar: 0.9, hive_launch: 0.6, cinder_shot: 0.75, prism_shot: 0.6, phase_shot: 0.8, singularity_fire: 0.85,
};
/** Playback rate for generated effects that came out too bright (below 1 = deeper and slower) */
const FILE_PITCH: Record<string, number> = { bump: 0.85 };
/** Low-pass cutoff (Hz) for generated effects that must stay soft: no harsh highs */
const FILE_LOWPASS: Record<string, number> = {
  bump: 700, hit: 2500, railgun_shot: 4000, emp_shot: 3000, shield_hit: 2500, part_break: 1800, armor_break: 1800, weapon_cookoff: 1800, conduit_spark: 1800, disintegrate: 1200,
  generator_blast: 2500, explosion_small: 3000, thruster_blast: 3000, repair_part: 2500,
  boss_roar: 2200, hive_launch: 3000, cinder_shot: 2800, prism_shot: 3200, phase_shot: 2600, singularity_fire: 2200,
};
/** Reverb send for generated effects (they already carry some room of their own) */
const FILE_REVERB: Record<string, number> = { explosion_large: 0.35, explosion_small: 0.25, generator_blast: 0.25, thruster_blast: 0.25, shot: 0.15, turret_shot: 0.15, hit: 0.15, bump: 0.15 };

export type StopSound = () => void;

export class AudioManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  /** Variants per effect, and its reverb send (from the files when there are files) */
  private variants: Record<string, number> = { ...SFX_VARIANTS };
  private reverb: Record<string, number> = { ...SFX_REVERB };
  private pitch: Record<string, number> = {};
  private voices = new Map<string, number>();
  /** Copies of the STEAL effects playing, oldest first: how to fade each out */
  private stealable = new Map<string, (() => void)[]>();
  private loops = new Map<LoopId, { src: AudioBufferSourceNode; gain: GainNode }>();
  private music: MusicEngine | null = null;
  private pendingSystem = 'sol';

  private listenerX = 0;
  private listenerY = 0;

  private masterVolume = 1.0;
  private sfxVolume = 1.0;
  private musicVolume = 0.5;
  private enabled = true;
  private initialized = false;
  private starting = false;

  constructor() {
    // Browsers block audio until the user interacts with the page
    const unlock = () => {
      void this.initialize();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.starting) return;
    this.starting = true;
    try {
      const ctx = new AudioContext();
      this.context = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(comp);
      this.sfxGain = ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume;
      this.sfxGain.connect(this.masterGain);
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.masterGain);
      // Shared reverb: effects send to it, and it returns into the effects bus
      const verb = ctx.createConvolver();
      verb.buffer = reverbImpulse(ctx);
      const ret = ctx.createGain();
      ret.gain.value = 0.55;
      this.reverbIn = ctx.createGain();
      this.reverbIn.connect(verb).connect(ret).connect(this.sfxGain);

      this.buffers = await renderSfx(ctx);
      await this.loadFiles(ctx);
      this.music = new MusicEngine(ctx, this.musicGain);
      this.music.setSystem(this.pendingSystem);
      this.music.start();
      this.initialized = true;
    } catch (e) {
      console.warn('Audio unavailable:', e);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Generated effects: fetch and decode every file in /sfx/index.json, then
   * tidy each one (trim the silence before it starts, match loudness, and
   * crossfade loops so they join without a click). Anything that fails keeps
   * its synthesised version.
   */
  private async loadFiles(ctx: AudioContext): Promise<void> {
    let index: Record<string, { variants: number; loop?: boolean }>;
    try {
      const res = await fetch('/sfx/index.json');
      if (!res.ok) return;
      index = await res.json();
    } catch {
      return;
    }
    await Promise.all(Object.entries(index).map(async ([id, info]) => {
      try {
        const bufs = await Promise.all(Array.from({ length: info.variants }, async (_, v) => {
          const res = await fetch(`/sfx/${v === 0 ? id : `${id}_${v}`}.mp3`);
          if (!res.ok) throw new Error(String(res.status));
          return ctx.decodeAudioData(await res.arrayBuffer());
        }));
        bufs.forEach((b, v) => this.buffers.set(variantKey(id, v), prepare(ctx, b, !!info.loop, FILE_GAIN[id] ?? 0.6, FILE_LOWPASS[id])));
        this.variants[id] = bufs.length;
        this.reverb[id] = FILE_REVERB[id] ?? 0.08;
        if (FILE_PITCH[id]) this.pitch[id] = FILE_PITCH[id];
      } catch (e) {
        console.warn(`Sound ${id}: using the synthesised version`, e);
      }
    }));
  }

  /** Play an effect at a world position (quieter and panned with distance). */
  play(soundId: string, worldX: number, worldY: number, options: { volume?: number; pitch?: number } = {}): StopSound | null {
    const dx = worldX - this.listenerX, dy = worldY - this.listenerY;
    const attenuation = Math.max(0, 1 - Math.hypot(dx, dy) / AUDIO_MAX_DISTANCE);
    if (attenuation <= 0) return null;
    const volume = options.volume ?? 1;
    // The dry sound falls off faster than its reverb, so distant sounds sit further back
    const wet = volume * attenuation * (this.reverb[soundId] ?? 0) * (1 + 1.5 * (1 - attenuation));
    return this.start(soundId, volume * attenuation * attenuation, Math.max(-1, Math.min(1, dx / AUDIO_REF_DISTANCE)), options.pitch, wet);
  }

  /** Play an effect with no position (UI, your own ship's events). */
  playUI(soundId: string, volume = 1.0, pitch = 1): StopSound | null {
    return this.start(soundId, volume, 0, pitch, volume * (this.reverb[soundId] ?? 0));
  }

  /** Returns a function that fades the sound out early (e.g. an aborted jump charge). */
  private start(id: string, volume: number, pan: number, pitch = 1, wet = 0): StopSound | null {
    if (!this.enabled || !this.initialized || !this.context || !this.sfxGain) return null;
    // A random variant, so repeated sounds don't repeat exactly
    const buffer = this.buffers.get(variantKey(id, Math.floor(Math.random() * (this.variants[id] ?? 1))));
    if (!buffer) return null;
    let playing = this.voices.get(id) ?? 0;
    if (playing >= (MAX_VOICES[id] ?? 4)) {
      const oldest = STEAL.has(id) ? this.stealable.get(id)?.shift() : undefined;
      if (!oldest) return null;
      oldest();
      playing--;
    }
    const ctx = this.context;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pitch * (this.pitch[id] ?? 1);
    const g = ctx.createGain();
    g.gain.value = volume;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.sfxGain);
    if (wet > 0 && this.reverbIn) {
      const send = ctx.createGain();
      send.gain.value = wet / Math.max(1e-6, volume);
      p.connect(send).connect(this.reverbIn);
    }
    this.voices.set(id, playing + 1);
    let counted = true;
    const release = () => { if (counted) { counted = false; this.voices.set(id, Math.max(0, (this.voices.get(id) ?? 1) - 1)); } };
    const stop = () => {
      const t = ctx.currentTime;
      g.gain.setTargetAtTime(0, t, 0.05);
      try { src.stop(t + 0.3); } catch { /* already ended */ }
      // (A stolen voice frees its slot now)
      release();
    };
    const queue = STEAL.has(id) ? this.stealable.get(id) ?? (this.stealable.set(id, []), this.stealable.get(id)!) : undefined;
    queue?.push(stop);
    src.onended = () => { release(); if (queue) { const i = queue.indexOf(stop); if (i >= 0) queue.splice(i, 1); } };
    src.start();
    return stop;
  }

  /** Continuous sound (engine, boost): set its level 0..1 each frame; 0 is silent. */
  setLoop(id: LoopId, level: number, pitch = 1): void {
    if (!this.initialized || !this.context || !this.sfxGain) return;
    let loop = this.loops.get(id);
    if (!loop) {
      if (level <= 0) return;
      const src = this.context.createBufferSource();
      const buf = this.buffers.get(id);
      if (!buf) return; // no recording and no synthesised version
      src.buffer = buf;
      src.loop = true;
      const gain = this.context.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.sfxGain);
      src.start();
      loop = { src, gain };
      this.loops.set(id, loop);
    }
    const t = this.context.currentTime;
    loop.gain.gain.setTargetAtTime(this.enabled ? level * ({ engine: 0.35, boost: 0.25, mining: 0.4, laser_loop: 0.45, lance_loop: 0.5 } as Record<string, number>)[id] : 0, t, 0.08);
    loop.src.playbackRate.setTargetAtTime(pitch, t, 0.15);
  }

  /** The sound of a shot of projectile type `type` (data[0] on the wire), fired from a turret or not ('' for none) */
  shotSound(type: number, turret: boolean): string {
    const s = SHOT_SFX.get(type);
    if (!s) return turret ? 'turret_shot' : 'shot';
    return turret && s.turret ? s.turret : s.sfx;
  }

  /** The beam loop of the beam weapon (tuning kind) you're firing, null for none */
  setBeam(kind: string | null): void {
    const on = kind ? BEAM_LOOP.get(kind) : undefined;
    for (const id of BEAM_LOOPS) this.setLoop(id, on === id ? 1 : 0, 1);
  }

  /** Music mood follows the system you're in. */
  setMusicSystem(systemId: string): void {
    this.pendingSystem = systemId;
    this.music?.setSystem(systemId);
  }

  /** How near a dread point the music is (0 none .. 1 full): its ominous layer creeps in */
  setDread(level: number): void {
    this.music?.setDread(level);
  }

  /** Music intensity: call with 1 when fighting; it decays on its own. */
  bumpCombat(level = 1): void {
    this.music?.setCombat(level);
  }

  setListenerPosition(x: number, y: number): void {
    this.listenerX = x;
    this.listenerY = y;
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    if (this.masterGain && this.context) this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.05);
  }

  setSFXVolume(volume: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, volume));
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
  }

  setMusicVolume(volume: number): void {
    this.musicVolume = Math.max(0, Math.min(1, volume));
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) for (const id of this.loops.keys()) this.setLoop(id, 0);
  }

  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') await this.context.resume();
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Make a decoded file game-ready: mix to mono (low-passed if asked), trim the near-silence before it
 * starts (MP3 padding and slow starts make effects feel late), scale it so its
 * audible part sits at a common loudness (then by `gain`), and for loops trim
 * both ends and crossfade the tail into the head so the seam is seamless.
 */
function prepare(ctx: BaseAudioContext, src: AudioBuffer, loop: boolean, gain: number, lowpassHz?: number): AudioBuffer {
  const n = src.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const d = src.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / src.numberOfChannels;
  }
  if (lowpassHz) {
    // Three cascaded one-pole low-passes: an 18 dB/octave roll-off above the cutoff
    const a = 1 - Math.exp(-2 * Math.PI * lowpassHz / src.sampleRate);
    for (let pass = 0; pass < 3; pass++) {
      let y = 0;
      for (let i = 0; i < n; i++) { y += a * (mono[i] - y); mono[i] = y; }
    }
  }
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const gate = peak * 0.02;
  let start = 0;
  while (start < n - 1 && Math.abs(mono[start]) < gate) start++;
  start = Math.max(0, start - Math.round(0.004 * src.sampleRate)); // keep the attack itself
  let end = n;
  if (loop) while (end > start + 1 && Math.abs(mono[end - 1]) < gate) end--;
  let data = mono.subarray(start, end);

  if (loop) {
    // Overlap the last `f` samples onto the first ones with an equal-power fade
    const f = Math.min(Math.round(0.12 * src.sampleRate), Math.floor(data.length / 4));
    const out = new Float32Array(data.length - f);
    out.set(data.subarray(0, out.length));
    for (let i = 0; i < f; i++) {
      const t = i / f;
      out[i] = data[i] * Math.sin(t * Math.PI / 2) + data[out.length + i] * Math.cos(t * Math.PI / 2);
    }
    data = out;
  }

  // Loudness of the audible part (ignoring near-silence), matched to a common target
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) < gate) continue;
    sum += data[i] * data[i];
    count++;
  }
  const rms = Math.sqrt(sum / Math.max(1, count)) || 1e-6;
  let k = (0.16 / rms) * gain;
  let outPeak = 0;
  for (let i = 0; i < data.length; i++) outPeak = Math.max(outPeak, Math.abs(data[i]));
  if (outPeak * k > 0.98) k = 0.98 / outPeak;

  const buf = ctx.createBuffer(1, Math.max(1, data.length), src.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) d[i] = data[i] * k;
  return buf;
}
