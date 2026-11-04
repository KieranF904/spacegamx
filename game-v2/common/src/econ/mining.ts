/**
 * Asteroid composition (data/mining.json), deterministic so server and client
 * agree: which ores an asteroid gives, how hard it is, whether it carries a
 * gem seam, and how much ore it holds. The client uses it for asteroid
 * colours, seams and the scanner; the server for what mining yields.
 */

import type { Bag } from './stacks.js';
import type { TraceDef } from './traces.js';

export interface MiningTable {
  respawnSeconds: number;
  unitsPerSize: number;
  damagePerUnit: number;
  chunkUnits: [number, number];
  breakFraction: number;
  xpPerUnit: number;
  /**
   * traceMul: this type's rocks carry their traces at that many times the rate
   * (the mega rocks); traceBoost: one trace more so (gem seams' voidglass).
   * name and size [min, max]: a rock type of its own (econ/rocks.ts), moving
   * and spawning `like` another type.
   */
  types: Record<string, { hardness: number; ores: Bag; traceMul?: number; traceBoost?: Record<string, number>; name?: string; size?: [number, number]; like?: string; gas?: boolean; crowd?: string }>;
  /** The comet's passes (server/src/GameServer.ts) */
  comet?: { days: number; hours: number; systems: string[]; traceTier: number };
  /** Each belt's mix of rock types by weight (econ/rocks.ts) */
  fields?: Record<string, Record<string, number>>;
  oreHardness: Record<string, number>;
  danger: Record<string, { seamChance: number; boost: Bag }>;
  seams: { gem: string; hardness: number; minTier: number; weight: number }[];
  seamGemChance: number;
  /** A mining laser's yield by (its grade − the rock's tier), clamped to ±2 */
  tierEfficiency?: Record<string, number>;
  /** Mining lasers sharing a rock (crowdFactor) */
  crowd?: CrowdTable;
  /** The rare outsized rocks (asteroid/generation.ts rolls them; server/src/game/Mining.ts mines them down a stage at a time) */
  outliers?: OutlierTable;
  /** Rare traces found when their carrier ores are refined (econ/traces.ts) */
  traces?: Record<string, TraceDef>;
  tools: {
    fixed: { yield: number; hardness: number };
    turret: { yield: number; hardness: number };
    miner: { yield: number; hardness: number };
    minerByMaterial: Record<string, number>;
  };
}

/**
 * Outliers: `chance` of a belt rock being `scale` times its size; it's mined
 * (or blasted) down through `stages` (sizes as fractions of its first), each
 * stage breaking away to leave a smaller rock, until the last breaks up.
 * `common` of them hold mostly common ore: each ore's weight x its `boost`
 * (any not listed x `rare`).
 */
export interface OutlierTable {
  chance: number;
  scale: [number, number];
  stages: number[];
  exclude?: string[];
  /** Systems where they're this many times as common */
  systems?: Record<string, number>;
  common: number;
  boost: Bag;
  rare: number;
}

/**
 * Mining lasers sharing a rock: each laser's extraction × crowdFactor(n, k,
 * sharp) × the profile's base, n being the mining lasers on the rock. A rock
 * type names its profile (`types[t].crowd`, else `default`). Lasers below the
 * rock's tier find its k `kByGap` times as high (clamped to -2).
 */
export interface CrowdTable {
  /** Ticks a laser counts towards n after its last cut (about a pulse) */
  window: number;
  default: string;
  profiles: Record<string, CrowdProfile>;
  kByGap?: Record<string, number>;
}

export interface CrowdProfile {
  /** The efficient number of lasers on it */
  k: number;
  /** How steeply each laser's share climbs towards k (a whole number, 2 or more) */
  sharp: number;
  /** Every laser's extraction on it × this */
  base: number;
  /** Shown to its miners (e.g. a hard rock's hint) */
  hint?: boolean;
}

/**
 * Each laser's efficiency with `n` on a rock whose efficient number is `k`:
 * g(n) = q·y^(q-1) / (1 + (q-1)·y^q), y = n/k, q = `sharp`. It peaks at
 * g(k) = 1, and the total n·g(n) only ever rises, towards k·q/(q-1) (2k for
 * q = 2: Kieran's 2kn / (k² + n²)). A higher q climbs more steeply to k and
 * gains less past it. Integer powers only (deterministic).
 */
export function crowdFactor(n: number, k: number, sharp: number): number {
  if (n <= 0 || k <= 0) return 1;
  const q = Math.max(2, Math.round(sharp));
  const y = n / k;
  let yq1 = 1;
  for (let i = 1; i < q; i++) yq1 *= y;
  return (q * yq1) / (1 + (q - 1) * yq1 * y);
}

/** A rock type's crowd profile for a laser `gap` grades from its tier (k raised for lasers below it) */
export function rockCrowd(table: MiningTable, type: string, gap: number): CrowdProfile | null {
  const c = table.crowd;
  if (!c) return null;
  const p = c.profiles[table.types[type]?.crowd ?? c.default] ?? c.profiles[c.default];
  if (!p) return null;
  const g = Math.max(-2, Math.min(0, Math.round(gap)));
  const kMul = g < 0 ? c.kByGap?.[String(g)] ?? 1 : 1;
  return { ...p, k: p.k * kMul };
}

export interface Composition {
  /** Asteroid definition id (asteroid_metal, comet, ...) */
  type: string;
  /** Ore weights (normalised to 1) */
  ores: Bag;
  /** The ore it gives most of */
  primary: string;
  /** Hardest tool needed for the rock itself (individual ores may be harder) */
  hardness: number;
  /** Gem seam, if any */
  seam: { gem: string; hardness: number } | null;
  /** Ore units it holds in all */
  units: number;
  /** An outlier: the stage it's at (0: whole), of how many */
  stage?: { at: number; of: number };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param key anything unique and stable per asteroid (system + index + spawn tick)
 * @param tier the system's danger tier (1 safe .. 7 deadly)
 * @param stage an outlier's stage (undefined: an ordinary rock)
 */
export function asteroidComposition(table: MiningTable, type: string, key: string, size: number, tier: number, stage?: number): Composition {
  const t = table.types[type] ?? table.types.asteroid_metal;
  const d = table.danger[String(Math.max(1, Math.min(7, tier)))] ?? { seamChance: 0, boost: {} };
  const r = rng(hash(`${type}:${key}`));
  // Ore weights: the type's mix, boosted by danger, each jittered a little per rock
  const ores: Bag = {};
  let total = 0;
  // Most outliers are a great lump of the common stuff (rolled apart, so ordinary rocks keep their mixes)
  const o = stage !== undefined ? table.outliers : undefined;
  const lump = !!o && rng(hash(`outlier:${type}:${key}`))() < o.common;
  for (const [id, w] of Object.entries(t.ores)) {
    const v = w * (d.boost[id] ?? 1) * (0.7 + 0.6 * r()) * (lump ? o!.boost[id] ?? o!.rare : 1);
    ores[id] = v;
    total += v;
  }
  let primary = '';
  for (const id of Object.keys(ores)) {
    ores[id] /= total || 1;
    if (!primary || ores[id] > ores[primary]) primary = id;
  }
  let seam: Composition['seam'] = null;
  if (r() < d.seamChance) {
    const options = table.seams.filter((s) => tier >= s.minTier);
    const sum = options.reduce((a, s) => a + s.weight, 0);
    let roll = r() * sum;
    for (const s of options) {
      roll -= s.weight;
      if (roll <= 0) { seam = { gem: s.gem, hardness: s.hardness }; break; }
    }
  }
  return { type, ores, primary, hardness: t.hardness, seam, units: Math.max(3, Math.round(size * table.unitsPerSize)), ...(o ? { stage: { at: stage!, of: o.stages.length } } : {}) };
}

/** Pick one ore from a composition's weights */
export function pickOre(c: Composition, roll: number): string {
  let acc = 0;
  for (const [id, w] of Object.entries(c.ores)) {
    acc += w;
    if (roll <= acc) return id;
  }
  return c.primary;
}
