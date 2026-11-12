/**
 * @contract ships.modifiers.types
 * owns:       the shared shapes of weapon modifiers (docs/design/weapon-modifiers-2026-11.md): a gun's effects
 *             (GunFx), the modifier side of a ports layout (PortsMods), the tuning block (ModifierTuning), and the
 *             strength maths (fxTo, rapidRate). The numbers live in data/ships/tuning.json `modifiers`
 * needs:      nothing
 * invariants: an effect's id is its index in ModifierTuning.effects (wire order, append only); a gun carries at
 *             most FX_MAX effects, each at a strength step 1..FX_STEPS, static for a layout; a shot carries only a
 *             mask of which were live (bit i = gunFx[part][i]) — common/src/ships/power/portsMods.test.ts
 *             strength is continuous in the design; the steps are wire quantisation only —
 *             common/src/ships/modifiers/fxDef.test.ts
 * extend:     a new effect: a name appended to tuning.json modifiers.effects, its numbers typed in ModifierTuning,
 *             a case in modifiers/fxDef.ts and a client layer (rendering/weapons/fx/mods)
 */

/** The most effects one gun carries (the best line tier's count) */
export const FX_MAX = 4;
/** Strength steps: a gun's strength is q / FX_STEPS, q in 1..FX_STEPS */
export const FX_STEPS = 15;

/** One effect on a gun: its id (index in ModifierTuning.effects) and its strength step */
export interface GunFx { fx: number; q: number }

/** A special modifier's need, per E of gun energy it treats: a hopper material used up, or extra power */
export interface ModNeed { mat?: string; power?: number; per: number }

/** data/ships/tuning.json `modifiers` */
export interface ModifierTuning {
  effects: string[];
  say: Record<string, { name: string; color: string; say: string }>;
  kinds: Record<string, { effect: string; needs?: ModNeed }>;
  recipes: { parts: string[]; effect: string }[];
  /** By line tier (index 0 = tier I): effects one line part carries, most treated E a second */
  lines: { fx: number; cap: number }[];
  velocity: { speed: number; range: number };
  rapid: { rate: number; total: number };
  explosive: { direct: number; blast: number; radius: number[] };
  split: { shots: number; total: number; spreadDeg: number };
  pierce: { fracs: number[] };
  wave: { width: number; perTarget: number };
  chain: { jumps: number; frac: number; reach: number };
  heavy: { damage: number; speed: number };
  /**
   * `total` of the hit again over `secs`. `fire`: how that fire spreads (ships/fire.ts). With pierce or wave it lights
   * `layers` parts along the shot's line into each hull, each deeper one × `layerKeep`; with explosive each part in the
   * blast may catch (`blast`: its chance at the blast's middle, the fire's heat × `scale`, at most `max` parts a blast);
   * with chain each arc lights what it strikes, × `arc` of the arc's own share
   */
  burn: { total: number; secs: number; layers: number; layerKeep: number; blast: { chance: number; scale: number; max: number }; arc: number; fire: FireSpread };
  /** `beamRange`: a beam's reach × this (it has no speed to gain; default 1.3) */
  hyper: { speed: number; damage: number; beamRange?: number };
}

/** (ships/fire.ts FireSpread: here by shape, so this file needs nothing of it) */
type FireSpread = import('../fire.js').FireSpread;

/** A mount's or special block's part of the layout: what a shot it treats costs it (power/portsMods.ts) */
export interface ModFeed {
  /** The part whose `held` pays: a hopper (material) or the special block itself (its power buffer) */
  part: number;
  /** eu of that part's `held` used per eu of the gun's shot, × 4096 (integer maths) */
  per4096: number;
  /** Further hoppers of the same material on the block's network: they pay what `part` can't */
  more?: readonly number[];
}

/**
 * The modifier side of a ports layout (PortsLayout.mod; absent on a ship with no mounts, which then behaves exactly as
 * before). All static for the layout: only `held` (mount power, hoppers, buffers) decides what is live.
 */
export interface PortsMods {
  /** By part: a gun's effects, strongest claim first, or undefined */
  gunFx: readonly (readonly GunFx[] | undefined)[];
  /** By part, by effect slot: the mounts that must hold power for that effect to be live */
  gunMounts: readonly (readonly (readonly number[])[] | undefined)[];
  /** By part, by effect slot: what a shot uses up (specials), or an empty list */
  gunFeeds: readonly (readonly (readonly ModFeed[])[] | undefined)[];
  /** The mounts (part indices), and each one's upkeep in eu a tick while any socket is filled */
  mounts: readonly number[];
  upkeep: readonly number[];
  /** By part: 1 + the slot of a shot gun's Rapid (0: none), and what a shot then costs, × 4096 of its own (portsRapidShot) */
  rapid?: ArrayLike<number>;
  rapidCost?: ArrayLike<number>;
}

/** The strength (0..1) of a gun's effect slot */
export function fxStrength(g: GunFx): number {
  return g.q / FX_STEPS;
}

/** A change at strength k: from none (1) to its full value */
export function fxTo(full: number, k: number): number {
  return 1 + (full - 1) * k;
}

/** Rapid's rate multiplier at a strength step (a shot then costs 1/this of the gun's shot and comes this much sooner) */
export function rapidRate(mt: ModifierTuning, q: number): number {
  return fxTo(mt.rapid.rate, q / FX_STEPS);
}
