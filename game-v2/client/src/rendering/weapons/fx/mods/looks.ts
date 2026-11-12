/**
 * @contract client.weapon-fx.mods.looks
 * owns:       the weapon modifier layers' numbers: each effect's accent colour (tuning `modifiers.say`), the mechanic's own
 *             sizes its layers are drawn to (blast radius, wave width, chain reach, burn time, split fan) and the shared budgets
 * needs:      data/ships/tuning.json (modifiers, the weapons' kinds)
 * invariants: every effect in `modifiers.effects` has a look, in wire order — client/src/rendering/weapons/fx/mods/mods.test.ts
 * extend:     a new effect's numbers are one row in LOOK (its colour comes with its `say` row in tuning.json)
 */

import tuning from '../../../../../../data/ships/tuning.json';

interface ModData {
  effects: string[];
  say: Record<string, { color: string }>;
  explosive: { radius: number[] };
  split: { spreadDeg: number };
  wave: { width: number };
  chain: { jumps: number; reach: number };
  burn: { secs: number };
}
const M = (tuning as unknown as { modifiers: ModData }).modifiers;

/** Every gun's kind (tuning `weapons`): what a detonation of a gun's is told as */
export const GUN_KINDS: ReadonlySet<string> = new Set(Object.keys((tuning as unknown as { weapons: Record<string, unknown> }).weapons));

/** Effect names by id (the wire order) */
export const EFFECTS: readonly string[] = M.effects;

/** What the mechanic itself gives the layers to draw to (world units, frames) */
export const MECH = {
  /** An explosive shot's blast radius at strength 0 and 1 */
  blast: M.explosive.radius as readonly number[],
  /** The split fan's whole angle (radians) */
  fan: (M.split.spreadDeg * Math.PI) / 180,
  /** x a wave shot's width at full strength */
  wave: M.wave.width,
  /** How far the forks drawn off a chain hit are thrown (the look's own: the real arcs to other ships are drawn where they land) */
  chainReach: 64,
  chainJumps: M.chain.jumps,
  /** Frames a burn lasts */
  burnFrames: M.burn.secs * 60,
};

/** One effect's look: its accent, a second colour its layers mix towards, and its own numbers (read by its layer file only) */
export interface ModLook { color: number; hot: number; n: Record<string, number> }

const hex = (name: string): number => parseInt((M.say[name]?.color ?? '#ffffff').slice(1), 16);
const row = (name: string, hot: number, n: Record<string, number>): ModLook => ({ color: hex(name), hot, n });

/**
 * Per effect: `hot` is what its light burns to at its brightest, `n` its counts and sizes at full strength (each scaled
 * by the strength k in its layer). Lengths are in flash sizes (muzzle), impact sizes (impact) or shell sizes (flight).
 * `share`: x the particle budget of a shot that carries it (a split or rapid gun makes more shots).
 */
export const LOOK: Record<string, ModLook> = {
  velocity: row('velocity', 0xffffff, { streaks: 12, cone: 0.24, reach: 3.2, wake: 2, punch: 16, punchSpeed: 22 }),
  rapid: row('rapid', 0xfff6d0, { pops: 5, brass: 6, flecks: 9, echoes: 4, pepper: 9, share: 0.6 }),
  explosive: row('explosive', 0xffe2a0, { embers: 6, drip: 0.55, core: 1.5, balls: 6, frags: 7, smoke: 7 }),
  split: row('split', 0xffffff, { hue: 46, fork: 0.34, glints: 10, sliver: 1.5, splinters: 3, share: 0.5 }),
  pierce: row('pierce', 0xffffff, { needle: 5, tip: 3, depth: 30, jet: 16, jetSpeed: 20 }),
  wave: row('wave', 0xeef2ff, { base: 2.2, bow: 0.4, echoes: 2, wash: 3, mist: 12 }),
  chain: row('chain', 0xffffff, { arcs: 4, reach: 1.1, orbit: 4.2, bolts: 4, forkAt: 0.55, ground: 0.42 }),
  heavy: row('heavy', 0xffc890, { smoke: 18, dust: 10, body: 1.5, wake: 1.6, chunks: 8, pall: 8 }),
  burn: row('burn', 0xffd27a, { licks: 5, tongue: 1.5, drip: 0.6, cling: 6, soot: 0.16 }),
  hyper: row('hyper', 0xffffff, { crack: 2.6, glint: 3, vapour: 9, trail: 900, after: 26 }),
};

/** A shot's layers together add at most this many particles at its muzzle and at a hit, by how many effects it carries (index 1..4) */
export const CAP_MUZZLE = [0, 40, 28, 22, 18], CAP_IMPACT = [0, 58, 40, 32, 27];
/** ... and this many a frame in flight, each effect */
export const CAP_FLIGHT = 3;
/** Layer particles made lately (decaying a tenth a frame) past which every layer thins its counts in proportion */
export const SOFT_LOAD = 260;
/** Marks (a layer's drawn shapes that outlive the frame) live at most; the oldest go first */
export const MARK_CAP = 160;
