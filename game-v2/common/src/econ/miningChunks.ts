/**
 * @contract common.econ.mining-chunks
 * owns:       WHEN a mined chunk drops: a rock's public mining seed, each chunk's size (chunkUnits) and which worked units
 *             are kept (so count towards the drop, the carry included), all from integer hashes of what server and client
 *             both know; and a tool's keep chance on a rock (its odds per ore, from the rock's public composition)
 * needs:      econ/mining (MiningTable, Composition, GunMining), math/rng (hashString, hashUnit); no I/O, no Math.random
 * invariants: the server (Mining.extract) and your client's progress ring (MiningProgress) step the same units to the same
 *             drops from the same seed, and the seed says nothing of what a kept unit is — client/src/ships/miningProgress.test.ts
 * extend:     a new public input to the drop's timing is one more key to hashUnit here (never anything from the payout dice)
 */

import type { MiningTable, Composition, GunMining } from './mining.js';
import { hashString, hashUnit } from '../math/rng.js';

/**
 * Public and secret, split (docs/areas/economy-quests.md "the progress ring"):
 *
 * - Public (here): a chunk's size, and whether each unit worked into it is kept. Both come from the rock's mining seed
 *   (its type, its composition key: system, belt index, spawn tick, and its outlier stage), the chunk's number and the
 *   unit's number, and from the tool's keep chance, worked out from the rock's composition, which every client already
 *   derives for its looks and the scanner. So a client knows the unit its drop comes at, and it knows how many units a
 *   chunk holds (the average was public all along).
 * - Secret (server payoutDice.ts): what each kept unit is (which ore, or the seam's gem: drawn by its odds given it was
 *   kept, keepOdds), the mining skill's bonus unit, where the chunk flies, what a broken rock spills, the traces it
 *   carries. Nothing of value reads the public dice, and the public dice read nothing secret: a kept unit is kept at
 *   the tool's one keep chance whatever it turns out to be.
 *
 * The odds are the old rules': a unit is a gem (the seam's chance, for a tool hard enough) or an ore by the rock's
 * mix (one too hard for the tool is its softest), kept at the tool's keep (guns: keepOther times it off their common
 * ores). Drawing "kept" first at the average of those and then the ore by its share of what's kept gives each
 * (ore, kept) pair exactly the chance it had.
 */

/** How a tool takes a rock's units: its keep (of the common ores), the gun's rule if a gun, the hardest it cracks */
export interface UnitRule {
  keep: number;
  gun: GunMining | undefined;
  hardness: number;
}

/** A tool's odds on a rock: each thing a unit can be, its chance of being that and kept; and the keep chance in all */
export interface KeepOdds {
  ids: string[];
  /** P(unit is ids[i] and kept) */
  kept: number[];
  /** P(kept): exactly 1 when every outcome is kept */
  keep: number;
}

/** A miner's place in their chunks on a rock (each miner's own): all of it public, worked out alike on both sides */
export interface ChunkState {
  /** Chunks dropped so far: this chunk's number */
  chunk: number;
  /** Whole rock units worked into this chunk */
  worked: number;
  /** The fraction of the next unit worked */
  owed: number;
  /** Something kept in this chunk so far (it can drop) */
  kept: boolean;
}

/** workUnit's result flags: the unit was kept; the chunk dropped on it */
export const UNIT_KEPT = 1, UNIT_DROP = 2;

/** How far ahead chunkDue looks for a kept unit (a tool keeping almost nothing) */
export const DUE_AHEAD = 512;

const SALT_SIZE = 0x51, SALT_KEEP = 0x4b;

/** A rock's mining seed: from its type, its composition key (system:index:spawnTick) and its outlier stage, all public */
export function mineSeed(type: string, key: string, stage?: number): number {
  return hashString(`mine:${type}:${key}:${stage ?? -1}`);
}

/** Rock units chunk `chunk` of a rock wants worked (chunkUnits lo..hi, evenly) */
export function chunkWant(table: MiningTable, seed: number, chunk: number): number {
  const [lo, hi] = table.chunkUnits;
  return lo + Math.floor(hashUnit(seed, chunk, SALT_SIZE) * (hi - lo + 1));
}

/** Is unit `unit` (from the chunk's start) of chunk `chunk` kept, by a tool keeping `keep` (keepOdds().keep) */
export function unitKept(seed: number, chunk: number, unit: number, keep: number): boolean {
  return keep >= 1 || (keep > 0 && hashUnit(seed, chunk, unit, SALT_KEEP) < keep);
}

/** The most common ore in a rock that a tool of `hardness` cracks (else its primary) */
export function softestOre(table: MiningTable, c: Composition, hardness: number): string {
  let best = '', w = -1;
  for (const [id, v] of Object.entries(c.ores)) {
    if ((table.oreHardness[id] ?? 1) <= hardness && v > w) { best = id; w = v; }
  }
  return best || c.primary;
}

/** A tool's odds on a rock (see the top): what a unit can be and its chance of being that and kept */
export function keepOdds(table: MiningTable, c: Composition, rule: UnitRule): KeepOdds {
  const ids: string[] = [], kept: number[] = [], all: number[] = [];
  let full = rule.keep >= 1;
  const add = (id: string, chance: number): void => {
    const p = Math.min(1, rule.gun && !rule.gun.common.includes(id) ? rule.keep * rule.gun.keepOther : rule.keep);
    if (p < 1) full = false;
    let i = ids.indexOf(id);
    if (i < 0) { i = ids.push(id) - 1; kept.push(0); all.push(0); }
    kept[i] += chance * Math.max(0, p);
    all[i] += chance;
  };
  const seam = c.seam && rule.hardness >= c.seam.hardness ? table.seamGemChance : 0;
  if (seam > 0) add(c.seam!.gem, seam);
  for (const [id, w] of Object.entries(c.ores)) add((table.oreHardness[id] ?? 1) > rule.hardness ? softestOre(table, c, rule.hardness) : id, (1 - seam) * w);
  let k = 0, t = 0;
  for (let i = 0; i < ids.length; i++) { k += kept[i]; t += all[i]; }
  return { ids, kept, keep: full ? 1 : t > 0 ? k / t : 0 };
}

/** A fresh miner on a rock: chunk 0, nothing worked */
export function freshChunk(): ChunkState {
  return { chunk: 0, worked: 0, owed: 0, kept: false };
}

/**
 * Work one whole unit into a miner's chunk (the caller takes it off `owed`): kept or not (public), and the chunk drops
 * on it when it's at or past its size with something kept (the carry: one due with nothing kept waits for the next
 * kept unit). A drop starts the next chunk. Returns UNIT_KEPT | UNIT_DROP flags
 */
export function workUnit(table: MiningTable, seed: number, s: ChunkState, keep: number): number {
  const kept = unitKept(seed, s.chunk, s.worked, keep);
  s.worked++;
  if (kept) s.kept = true;
  if (!s.kept || s.worked < chunkWant(table, seed, s.chunk)) return kept ? UNIT_KEPT : 0;
  s.chunk++;
  s.worked = 0;
  s.kept = false;
  return (kept ? UNIT_KEPT : 0) | UNIT_DROP;
}

/**
 * The unit (counted from the chunk's start) the chunk drops at if the tool keeping `keep` works on: the first at or
 * past its size with something kept by then. No further than DUE_AHEAD units on (a tool keeping almost nothing)
 */
export function chunkDue(table: MiningTable, seed: number, s: ChunkState, keep: number): number {
  const want = chunkWant(table, seed, s.chunk);
  let kept = s.kept;
  for (let i = s.worked; i < s.worked + DUE_AHEAD; i++) {
    if (!kept) kept = unitKept(seed, s.chunk, i, keep);
    if (kept && i + 1 >= want) return i + 1;
  }
  return s.worked + DUE_AHEAD;
}

/**
 * A miner's part-worked chunk on a rock, as told to their client on entering the system (asteroidSeed/asteroidSpawn
 * `mine`): four numbers, [rock, chunk, worked × 2 + kept, owed]. Fresh work (chunk 0, nothing worked) isn't told
 */
export function packChunk(rock: number, s: ChunkState): number[] {
  return [rock, s.chunk, s.worked * 2 + (s.kept ? 1 : 0), s.owed];
}

/** packChunk's lists read back: by rock */
export function unpackChunks(mine: readonly number[]): Map<number, ChunkState> {
  const out = new Map<number, ChunkState>();
  for (let i = 0; i + 3 < mine.length; i += 4) out.set(mine[i], { chunk: mine[i + 1], worked: mine[i + 2] >> 1, owed: mine[i + 3], kept: (mine[i + 2] & 1) === 1 });
  return out;
}
