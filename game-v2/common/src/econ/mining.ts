/**
 * Asteroid composition (data/mining.json), deterministic so server and client
 * agree: which ores an asteroid gives, how hard it is, whether it carries a
 * gem seam, and how much ore it holds. The client uses it for asteroid
 * colours, seams and the scanner; the server for what mining yields.
 */

import type { Bag } from './stacks.js';
import type { TraceDef } from './traces.js';
import { dpow } from '../math/detTrig.js';
import { hashString, mulberry32 } from '../math/rng.js';

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
   * and spawning `like` another type. density: ore units per size, times this (default 1).
   */
  types: Record<string, { hardness: number; ores: Bag; traceMul?: number; traceBoost?: Record<string, number>; name?: string; size?: [number, number]; like?: string; gas?: boolean; density?: number }>;
  /** The comet's passes (server/src/GameServer.ts) */
  comet?: { days: number; hours: number; systems: string[]; traceTier: number };
  /** Each belt's mix of rock types by weight (econ/rocks.ts) */
  fields?: Record<string, Record<string, number>>;
  oreHardness: Record<string, number>;
  danger: Record<string, { seamChance: number; boost: Bag }>;
  seams: { gem: string; hardness: number; minTier: number; weight: number }[];
  seamGemChance: number;
  /**
   * Mining lasers by gap = the laser's grade − the rock's tier (the system's Mk), clamped to +2: `work` scales how
   * fast it works the rock (so how often chunks come), `keep` the share of what it works that it keeps (the rest is
   * lost). No entry (a laser more than two grades behind): it can't mine the rock at all.
   */
  laserGap?: Record<string, { work: number; keep: number }>;
  /** Guns (tools that aren't mining tools: MiningTool.mining) on soft rock (econ docs: GunMining) */
  guns?: GunMining;
  /** The rare outsized rocks (asteroid/generation.ts rolls them; server/src/game/Mining.ts mines them down a stage at a time) */
  outliers?: OutlierTable;
  /** Rare traces found when their carrier ores are refined (econ/traces.ts) */
  traces?: Record<string, TraceDef>;
  /** By weapon kind (cannon shells: fixed, turret; mining lasers: miner, their hardness by material) */
  tools: {
    fixed: MiningToolDef;
    turret: MiningToolDef;
    miner: MiningToolDef;
    minerByMaterial: Record<string, number>;
  };
}

/**
 * A tool: rock units it works per damage (÷ damagePerUnit) and the hardest ore or gem seam it cracks. `mining`: a
 * mining tool (charges, the siphon) that keeps all it works; anything else is a gun (GunMining).
 */
export interface MiningToolDef {
  yield: number;
  hardness: number;
  mining?: boolean;
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
 * Guns on soft (hardness 1) rock; they can't touch anything harder. They work
 * the rock at a mining laser's sort of pace, normalised: damage × the tool's
 * yield ÷ damagePerUnit, and past `refDps` damage a second on the rock the pace
 * grows only with the square root of it (a big gunship works it faster, not
 * five times faster). They keep little of it: `keep` of the common ores,
 * `keepOther` times that of anything else (gems too), and `keepByTier` times
 * that again by the rock's tier (the system's Mk).
 */
export interface GunMining {
  refDps: number;
  keep: number;
  common: string[];
  keepOther: number;
  keepByTier: Record<string, number>;
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

/**
 * @param key anything unique and stable per asteroid (system + index + spawn tick)
 * @param tier the system's danger tier (1 safe .. 7 deadly)
 * @param stage an outlier's stage (undefined: an ordinary rock)
 */
export function asteroidComposition(table: MiningTable, type: string, key: string, size: number, tier: number, stage?: number): Composition {
  const t = table.types[type] ?? table.types.asteroid_metal;
  const d = table.danger[String(Math.max(1, Math.min(7, tier)))] ?? { seamChance: 0, boost: {} };
  const r = mulberry32(hashString(`${type}:${key}`));
  // Ore weights: the type's mix, boosted by danger, each jittered a little per rock
  const ores: Bag = {};
  let total = 0;
  // Most outliers are a great lump of the common stuff (rolled apart, so ordinary rocks keep their mixes)
  const o = stage !== undefined ? table.outliers : undefined;
  const lump = !!o && mulberry32(hashString(`outlier:${type}:${key}`))() < o.common;
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
  return { type, ores, primary, hardness: t.hardness, seam, units: Math.max(3, Math.round(size * table.unitsPerSize * (t.density ?? 1))), ...(o ? { stage: { at: stage!, of: o.stages.length } } : {}) };
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

/**
 * A tool's work rate and keep (of the common ores) on rock of `tier` (the system's Mk): a mining laser's by its grade
 * against it (laserGap; work and keep 0 where it can't mine the rock), a gun's (guns.keep × keepByTier), a mining
 * tool's all. Server (Mining.extract) and client (the progress ring: client/src/ships/MiningProgress.ts) read the same.
 */
export function toolKeep(table: MiningTable, tool: { grade?: number; mining?: boolean }, tier: number): { work: number; keep: number } {
  if (tool.grade !== undefined) {
    if (!table.laserGap) return { work: 1, keep: 1 };
    const g = table.laserGap[String(Math.min(2, tool.grade - tier))];
    return g ? { work: g.work, keep: g.keep } : { work: 0, keep: 0 };
  }
  if (tool.mining || !table.guns) return { work: 1, keep: 1 };
  return { work: 1, keep: table.guns.keep * (table.guns.keepByTier[String(tier)] ?? 1) };
}

/**
 * Rock units a tool keeping `keep` of what it works takes, on average, from one drop to the next. A chunk is due every
 * chunkUnits worked (rolled per chunk, lo..hi); one due with nothing kept yet waits for the next unit that is kept
 * (the carry, Mining.extract), so a want of w at a keep of p takes w + (1-p)^w / p units on average.
 */
export function unitsPerDrop(table: MiningTable, keep: number): number {
  if (keep <= 0) return Infinity;
  const [lo, hi] = table.chunkUnits;
  let sum = 0;
  for (let w = lo; w <= hi; w++) sum += keep >= 1 ? w : w + dpow(1 - keep, w) / keep;
  return sum / (hi - lo + 1);
}
