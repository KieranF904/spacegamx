/**
 * Your station (data/station.json): chartered once, at one of a few sites; its
 * nine tracks each built up a tier at a time, from materials, over real time.
 * What a track's tiers give (perks) stacks: counts add up tier by tier, the
 * rest take the highest tier's value. Nothing here is a ship stat: it's what
 * you can make, keep and know.
 */

import type { Bag } from './stacks.js';

export interface TrackTier {
  name: string;
  cost: Bag;
  minutes: number;
  /** Job time × this */
  refineTime?: number;
  fabTime?: number;
  /** More plate a refining batch (0.1 = 10%) */
  refineYield?: number;
  /** Traces × this */
  traceMul?: number;
  /** Added to the unlocks */
  hangarSlots?: number;
  /** Taken off a gem cut's fail chance */
  cutFail?: number;
  /** Rounds only an armoury presses (its recipe still has to be learned: Quench Slugs, from Forgemaster Hale's job) */
  rounds?: string[];
  /** Rumours of hidden jobs from anywhere */
  rumours?: number;
}
export interface TrackDef { name: string; group: string; about: string; tiers: TrackTier[] }
export interface StationFile {
  charter: { level: number; credits: number; items: Bag };
  sites: { id: string; name: string; station: string }[];
  tracks: Record<string, TrackDef>;
}

/** A pilot's station: where, each track's tier, and what's building (one thing at a time) */
export interface Outpost {
  site: string;
  tracks: Record<string, number>;
  build?: { track: string; tier: number; readyAt: number };
}

export interface StationPerks {
  refineTime: number; fabTime: number; refineYield: number; traceMul: number;
  hangarSlots: number; cutFail: number; rounds: string[]; rumours: boolean;
}

const NONE: StationPerks = { refineTime: 1, fabTime: 1, refineYield: 0, traceMul: 1, hangarSlots: 0, cutFail: 0, rounds: [], rumours: false };

/** A track's colour, and the kind of plating that marks it */
const LOOK: Record<string, { paint: string; fn: string }> = {
  refinery: { paint: '#d9773a', fn: 'generator' }, fabricator: { paint: '#5aa7d9', fn: 'cargo' }, armoury: { paint: '#d9584a', fn: 'armor' },
  gem_cutter: { paint: '#b07ad9', fn: 'generator' }, hangar: { paint: '#8aa0b8', fn: 'cargo' }, storage: { paint: '#a08a5a', fn: 'cargo' },
  scanner: { paint: '#5ad9c0', fn: 'generator' }, market: { paint: '#d9c25a', fn: 'cargo' }, defences: { paint: '#c04040', fn: 'armor' },
};
const TIER_MATERIAL = ['alloy', 'steel', 'titanium', 'cobalt', 'neutronium'];

/**
 * A station track's structure at a tier: a square of plate around a core,
 * (2 × tier + 1) cells across, in better plate as it climbs, its track's
 * kind of fittings in a ring and its colour on the hull.
 */
export function trackStructure(track: string, tier: number): import('../ships/types.js').Blueprint {
  const look = LOOK[track] ?? { paint: '#8aa0b8', fn: 'cargo' };
  const r = Math.max(1, Math.min(5, tier));
  const mat = TIER_MATERIAL[r - 1];
  const parts: import('../ships/types.js').PlacedPart[] = [];
  let uid = 0;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const ring = Math.max(Math.abs(x), Math.abs(y));
      const fn = x === 0 && y === 0 ? 'core' : ring === r && (x + y) % 2 === 0 ? 'armor' : ring === 1 ? look.fn : 'hull';
      parts.push({ uid: uid++, piece: 'sq', fn, material: fn === 'core' ? 'alloy' : mat, x: x + r, y: y + r, rot: 0, flip: false });
    }
  }
  return { name: `${track} ${tier}`, catalogVersion: 1, parts, paint: look.paint };
}

let table: StationFile | null = null;

export function setStationTable(t: StationFile | undefined): void {
  table = t ?? null;
}

export function stationTable(): StationFile | null {
  return table;
}

/** What a pilot's station gives them (nothing, without one). `file`: the table (the client has its own copy) */
export function stationPerks(o: Outpost | undefined, file: StationFile | null = table): StationPerks {
  if (!o || !file) return NONE;
  const out = { ...NONE, rounds: [] as string[] };
  for (const [id, tier] of Object.entries(o.tracks)) {
    const tiers = file.tracks[id]?.tiers ?? [];
    for (let t = 0; t < Math.min(tier, tiers.length); t++) {
      const r = tiers[t];
      if (r.refineTime !== undefined) out.refineTime = r.refineTime;
      if (r.fabTime !== undefined) out.fabTime = r.fabTime;
      if (r.refineYield !== undefined) out.refineYield = r.refineYield;
      if (r.traceMul !== undefined) out.traceMul = r.traceMul;
      if (r.cutFail !== undefined) out.cutFail = r.cutFail;
      out.hangarSlots += r.hangarSlots ?? 0;
      out.rounds.push(...(r.rounds ?? []));
      if (r.rumours) out.rumours = true;
    }
  }
  return out;
}

/**
 * What a pilot can make of the recipes they've learned: a round only an
 * armoury presses (any tier's `rounds`) is theirs to make only once their own
 * station's armoury is built that far.
 */
export function stationLearned(recipes: string[], o: Outpost | undefined, file: StationFile | null = table): string[] {
  const pressed = new Set(Object.values(file?.tracks ?? {}).flatMap((t) => t.tiers.flatMap((r) => r.rounds ?? [])));
  if (!pressed.size) return recipes;
  const own = stationPerks(o, file).rounds;
  return recipes.filter((id) => !pressed.has(id) || own.includes(id));
}

/** Is this one of the rounds only an armoury presses */
export function armouryRound(id: string, file: StationFile | null = table): boolean {
  return Object.values(file?.tracks ?? {}).some((t) => t.tiers.some((r) => r.rounds?.includes(id)));
}
