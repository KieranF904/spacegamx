/**
 * The music's registry (data/audio.json `music`), and choosing what plays: pure functions, no Web Audio.
 *
 * Each system has a profile (its key, mode, tempo, timbre, rhythm and textures); a profile may `extend` others
 * (presets, or another system's: a surface is a variation of its system's). Inside a system, a region, a zone ring
 * or the planet you're near layers its own variation over the system's (`regions`, `zones`, `planets`), and then a
 * situation over that: docked, inside a boss's arena (`arena`, `arena:<boss id>`) or fighting a boss
 * (`boss`, `boss:<boss id>`). Every field left out keeps what's under it; `null` takes a layer out; `mul` scales
 * numbers already set.
 *
 * MusicDirector decides when to switch: a new place must hold for a moment (longer when leaving a boss fight)
 * before the music moves, so edges don't thrash. The engine then changes at its next bar, crossfading.
 */

export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

/**
 * A rhythm over a bar: one character a step ('x' accent, 'o' normal, '?' half the time, '.' rest; for a bass line
 * '5' the fifth and '8' the octave over the chord's root).
 */
export type Pattern = string;

export type PercKind = 'kick' | 'tom' | 'thump' | 'clank' | 'shaker' | 'snare';

export interface PercVoice { kind: PercKind; pattern: Pattern; level: number; pitch?: number }
export interface ArpLayer {
  /** Scale degrees over the chord's root, played in turn */
  pattern: number[];
  /** Steps in a bar */
  steps: number;
  level: number;
  octave: number;
  wave?: Wave;
  /** Chance a bar has it (default 1) */
  chance?: number;
  /** Each note's ring, seconds */
  decay?: number;
}
export interface BassLine { pattern: Pattern; level: number; wave?: Wave }
export type NoiseKind = 'wind' | 'crackle' | 'rumble' | 'hiss';
export type BellTone = 'bell' | 'glass' | 'pluck' | 'chime' | 'anvil';

export interface CombatLayer {
  /** × bar length while fighting (default 0.75: quicker) */
  tempo?: number;
  perc?: PercVoice[] | null;
  /** The fight's bass (default: the pulsing sixteenths on the chord's root) */
  bass?: BassLine | null;
}

/** A resolved mood: everything the engine needs */
export interface Mood {
  /** MIDI note of the tonic */
  root: number;
  /** Scale steps in semitones from the root */
  scale: number[];
  /** Chord roots as scale degrees (0-based), one per bar */
  progression: number[];
  /** Seconds per bar */
  bar: number;
  pad: Wave;
  /** Pad filter cutoff, Hz */
  brightness: number;
  padLevel: number;
  /** Bell notes per bar (average) */
  bells: number;
  /** Octave offset of the bells */
  bellOctave: number;
  bellTone: BellTone;
  /** The held drone's level, and how much of it is the buzzy sawtooth pair (0: only the soft sine) */
  droneLevel: number;
  droneSaw: number;
  /** A deep swell under each bar (0 none) */
  swell: number;
  /** Stereo spread of bells and arpeggios (0 centred .. 1 wide) */
  pan: number;
  /** Reverb level, and the echo's delay (s) */
  reverb: number;
  echo: number;
  arp: ArpLayer | null;
  perc: PercVoice[] | null;
  bass: BassLine | null;
  /** Textures under it all, each kind's level (0 none) */
  noise: Partial<Record<NoiseKind, number>>;
  combat: CombatLayer;
  /** How far the ominous dread layer (nearing a lair) may take over (1 all of it; a boss fight's own music less) */
  dreadScale: number;
  /** Overall level */
  level: number;
}

type Numeric = 'bar' | 'brightness' | 'padLevel' | 'bells' | 'droneLevel' | 'swell' | 'reverb' | 'level';

/** A profile as written in data: any part of a mood, with a named scale allowed */
export interface MusicProfile extends Partial<Omit<Mood, 'scale' | 'arp' | 'perc' | 'bass' | 'combat'>> {
  scale?: string | number[];
  arp?: ArpLayer | null;
  perc?: PercVoice[] | null;
  bass?: BassLine | null;
  combat?: CombatLayer;
  /** Profiles (presets or systems) this one starts from, in order */
  extends?: string | string[];
  /** × numbers already set */
  mul?: Partial<Record<Numeric, number>>;
  regions?: Record<string, MusicProfile>;
  zones?: Record<string, MusicProfile>;
  planets?: Record<string, MusicProfile>;
}

export interface MusicRegistry {
  scales: Record<string, number[]>;
  defaults: MusicProfile;
  presets?: Record<string, MusicProfile>;
  systems: Record<string, MusicProfile>;
  situations: Record<string, MusicProfile>;
}

/** Where you are and what's happening, as the music sees it */
export interface MusicPlace {
  system: string;
  region?: string | null;
  zone?: string | null;
  planet?: string | null;
  docked?: boolean;
  /** Inside a boss's arena: its boss id (or '' for one with none named) */
  arena?: string | null;
  /** A boss fight in view: the boss id */
  boss?: string | null;
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Lay `over` on `base`: fields given replace, `null` clears, `mul` scales, area maps merge by key */
export function mergeProfile(base: MusicProfile, over: MusicProfile): MusicProfile {
  const out: MusicProfile = { ...base };
  for (const [k, v] of Object.entries(over) as [keyof MusicProfile, unknown][]) {
    if (k === 'extends' || k === 'mul') continue;
    if (k === 'noise' && v && base.noise) out.noise = { ...base.noise, ...(v as Mood['noise']) };
    else if (k === 'combat' && v && base.combat) out.combat = { ...base.combat, ...(v as CombatLayer) };
    else if ((k === 'regions' || k === 'zones' || k === 'planets') && v && base[k]) out[k] = { ...base[k], ...(v as Record<string, MusicProfile>) };
    else (out as Record<string, unknown>)[k] = v;
  }
  if (over.mul) for (const [k, m] of Object.entries(over.mul) as [Numeric, number][]) {
    if (typeof out[k] === 'number') out[k] = (out[k] as number) * m;
  }
  return out;
}

/** A named profile (a preset, else a system's) and what it extends, bottom first */
export function profileChain(reg: MusicRegistry, id: string, seen: Set<string> = new Set()): MusicProfile[] {
  const p = reg.presets?.[id] ?? reg.systems[id];
  if (!p || seen.has(id)) return [];
  seen.add(id);
  return [...[p.extends ?? []].flat().flatMap((e) => profileChain(reg, e, seen)), p];
}

/** A system's profile with everything it extends merged in (for its area maps) */
function systemProfile(reg: MusicRegistry, id: string): MusicProfile {
  return reg.systems[id] ? profileChain(reg, id).reduce(mergeProfile, {}) : {};
}

/** An area's or situation's profile, with what it extends under it */
function withExtends(reg: MusicRegistry, p: MusicProfile): MusicProfile[] {
  return [...[p.extends ?? []].flat().flatMap((e) => profileChain(reg, e)), p];
}

/** The profile layers for a place, bottom first: defaults, the system's, its region, zone, planet, then the situation */
export function placeLayers(reg: MusicRegistry, place: MusicPlace): MusicProfile[] {
  const sys = systemProfile(reg, place.system);
  const layers: MusicProfile[] = [reg.defaults, ...(reg.systems[place.system] ? profileChain(reg, place.system) : [])];
  if (place.region && sys.regions?.[place.region]) layers.push(...withExtends(reg, sys.regions[place.region]));
  if (place.zone && sys.zones?.[place.zone]) layers.push(...withExtends(reg, sys.zones[place.zone]));
  if (place.planet && sys.planets?.[place.planet]) layers.push(...withExtends(reg, sys.planets[place.planet]));
  const sit = situationKeys(place);
  for (const k of sit) if (reg.situations[k]) layers.push(...withExtends(reg, reg.situations[k]));
  return layers;
}

/** The situation keys that apply, general before particular (a boss fight wins over its arena, the arena over docking) */
export function situationKeys(place: MusicPlace): string[] {
  if (place.boss) return ['boss', `boss:${place.boss}`];
  if (place.arena !== undefined && place.arena !== null) return place.arena ? ['arena', `arena:${place.arena}`] : ['arena'];
  if (place.docked) return ['docked'];
  return [];
}

/** Turn a merged profile into a full mood (every field filled, named scales looked up) */
export function toMood(reg: MusicRegistry, p: MusicProfile): Mood {
  const scale = typeof p.scale === 'string' ? reg.scales[p.scale] ?? MAJOR : p.scale ?? MAJOR;
  return {
    root: p.root ?? 50, scale, progression: p.progression?.length ? p.progression : [0], bar: Math.max(2, p.bar ?? 9),
    pad: p.pad ?? 'sawtooth', brightness: p.brightness ?? 900, padLevel: p.padLevel ?? 1,
    bells: p.bells ?? 2, bellOctave: p.bellOctave ?? 2, bellTone: p.bellTone ?? 'bell',
    droneLevel: p.droneLevel ?? 1, droneSaw: p.droneSaw ?? 1, swell: p.swell ?? 0, pan: p.pan ?? 0,
    reverb: p.reverb ?? 0.7, echo: p.echo ?? 0.42,
    arp: p.arp ?? null, perc: p.perc ?? null, bass: p.bass ?? null, noise: { ...(p.noise ?? {}) },
    combat: { tempo: 0.75, ...(p.combat ?? {}) }, dreadScale: p.dreadScale ?? 1, level: p.level ?? 1,
  };
}

/** The mood for a place */
export function resolveMood(reg: MusicRegistry, place: MusicPlace): Mood {
  return toMood(reg, placeLayers(reg, place).reduce(mergeProfile, {}));
}

/** A place's identity: the music changes only when this does (and only the parts it has music for count) */
export function placeKey(reg: MusicRegistry, place: MusicPlace): string {
  const sys = systemProfile(reg, place.system);
  const has = (m: Record<string, MusicProfile> | undefined, id: string | null | undefined) => (id && m?.[id] ? id : '');
  return [place.system, has(sys.regions, place.region), has(sys.zones, place.zone), has(sys.planets, place.planet), situationKeys(place).join('+')].join('|');
}

/**
 * Hysteresis for a nearby area: you enter it within `enter`, and stay in it until beyond `exit` (wider), so hovering
 * on an edge doesn't flip back and forth. Of the areas you could enter, the nearest (by distance over its reach).
 */
export function pickArea(areas: { id: string; d: number; enter: number; exit: number }[], current: string | null): string | null {
  const cur = current ? areas.find((a) => a.id === current) : undefined;
  if (cur && cur.d <= cur.exit) return cur.id;
  let best: { id: string; k: number } | null = null;
  for (const a of areas) {
    if (a.d > a.enter) continue;
    const k = a.d / Math.max(1, a.enter);
    if (!best || k < best.k) best = { id: a.id, k };
  }
  return best?.id ?? null;
}

/** How long a new place must hold before the music follows (ms) */
export function holdFor(from: MusicPlace | null, to: MusicPlace): number {
  if (!from || from.system !== to.system) return 0; // a jump: straight away (the next bar)
  if (to.boss && !from.boss) return 700; // a fight starting
  if (from.boss && !to.boss) return 6000; // a fight ending (or the bar flickering at the edge of its range)
  if (!!from.docked !== !!to.docked) return 300;
  return 2500;
}

/** Follows the place; reports a change only once a new one has held long enough */
export class MusicDirector {
  private current: MusicPlace | null = null;
  private currentKey = '';
  private candidateKey = '';
  private since = 0;

  constructor(private reg: MusicRegistry) {}

  /** The place playing now (null before the first update) */
  get place(): MusicPlace | null {
    return this.current;
  }

  /** Returns the new place when the music should change, else null */
  update(place: MusicPlace, nowMs: number): MusicPlace | null {
    const key = placeKey(this.reg, place);
    if (key === this.currentKey) {
      this.candidateKey = '';
      return null;
    }
    if (key !== this.candidateKey) {
      this.candidateKey = key;
      this.since = nowMs;
    }
    if (nowMs - this.since < holdFor(this.current, place)) return null;
    this.current = place;
    this.currentKey = key;
    this.candidateKey = '';
    return place;
  }
}

/** Which step of a pattern sounds, and how strongly (0 rest, 1 normal, 1.35 accent); `rnd` decides the '?' steps */
export function patternHits(p: Pattern, rnd: () => number = Math.random): number[] {
  return [...p].map((c) => (c === 'x' ? 1.35 : c === 'o' || c === '5' || c === '8' ? 1 : c === '?' ? (rnd() < 0.5 ? 1 : 0) : 0));
}
