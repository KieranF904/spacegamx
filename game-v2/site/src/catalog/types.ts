/**
 * The catalog: the game's parts, items, ships, bosses and stations as plain facts (numbers and ids, no prose).
 * This file is the contract. The site's own snapshot (site/catalog/catalog.json, made by scripts/build-catalog.ts)
 * has this shape, and so does the file or endpoint the game provides later (docs/game-integration.md, section 1).
 *
 * Nothing here carries the game's descriptions, intros, titles, factions or codex text: the site writes its own
 * chart text from these fields (text.ts). The one exception is `blurb`, which the game may fill in later.
 */

export type PartCategory = 'weapons' | 'engines' | 'power' | 'shields' | 'utility' | 'structure' | 'core';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface PortInfo { dir: 'in' | 'out'; side: 'N' | 'E' | 'S' | 'W'; rate: number; /** Which cell of a larger part (0: the first) */ cell?: number }

export interface CatalogPart {
  id: string;
  name: string;
  category: PartCategory;
  /** The model family it belongs to ("cannon", "ion", "reactor"), or null */
  family: string | null;
  rarity: Rarity;
  /** "Mk I" */
  mark: string;
  grade: number;
  /** Material id ("alloy", "steel") the part is made of */
  material: string;
  /** "Small" / "Medium" / "Large" / "Heavy", or '' */
  size: string;
  /** Cells it covers */
  cells: number;
  /** Shape ids it can be built in */
  shapes: string[];
  /** Pilot level that opens it (null: always) */
  unlock: number | null;
  hp: number;
  mass: number;
  weapon?: { mount: 'fixed' | 'turret' | null; dps: number; range: number; damageType?: string; pen?: number; interval?: number };
  /** Energy per second it uses / makes; what it holds; engine push; shield strength; hold space */
  draw?: number;
  supply?: number;
  store?: number;
  thrust?: number;
  boost?: number;
  shield?: number;
  cargo?: number;
  ports?: PortInfo[];
  /** What the fabricator needs (item id -> count) and how long it takes */
  craft?: { inputs: Record<string, number>; seconds: number };
  /** Plain chart text from the game, if it ever supplies one (the site writes its own otherwise) */
  blurb?: string;
}

export interface RecipeInfo {
  kind: 'refine' | 'craft';
  inputs: Record<string, number>;
  /** Units made per batch */
  out: number;
  seconds: number;
  /** Pilot level that opens it, if any */
  level?: number;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  rarity: Rarity;
  /** Base value in credits */
  value: number;
  tier?: number;
  mass?: number;
  color?: string;
  /** Rock types it comes out of, with their weight in the rock's ore mix (percent of the mix) */
  foundIn: { rock: string; name: string; share: number }[];
  /** Recipes that make it */
  madeBy: RecipeInfo[];
  /** What it goes into: recipes (by output item) and parts */
  usedIn: { kind: 'item' | 'part'; id: string; name: string }[];
  /** Stations that sell it; stations that pay extra for it (× the usual price) */
  soldAt: string[];
  paidMoreAt: { station: string; mult: number }[];
  /** Bosses that can drop it (chance 0..1) */
  droppedBy: { boss: string; chance: number }[];
  blurb?: string;
}

/** A part as placed in a plan: what the drawing needs */
export interface PlanPart { fn: string; piece: string; x: number; y: number; rot: number; flip?: boolean }

export interface ShipStats {
  parts: number;
  cells: number;
  mass: number;
  hp: number;
  /** Energy per second made, and used by everything at once */
  gen: number;
  draw: number;
  thrust: number;
  shield: number;
  cargo: number;
  guns: { fixed: number; turret: number };
}

export interface CatalogShip {
  id: string;
  name: string;
  stats: ShipStats;
  /** Grid size in cells */
  size: { w: number; h: number };
  /** 'ports' for designs on the newer power system */
  power: 'ports' | 'pool';
  plan: PlanPart[];
  /** Stations that sell the plan */
  soldAt: string[];
  blurb?: string;
}

export interface CatalogBoss {
  id: string;
  name: string;
  system: string;
  level: number;
  /** How many health thresholds start a new phase */
  phases: number;
  xp: number;
  credits: number;
  /** 0: no timer given */
  respawnSeconds: number;
  loot: { item: string; chance: number; min: number; max: number }[];
  blurb?: string;
}

export interface CatalogStation {
  id: string;
  name: string;
  system: string;
  services: string[];
  repairCostPerHp: number;
  refuelCostPerUnit: number;
  sells: { items: string[]; plans: string[]; parts: { part: string; material: string; label: string }[] };
  pays: { item: string; mult: number }[];
  blurb?: string;
}

/** A ribbon's name, for the pilot page (the profile only keeps ids) */
export interface CatalogRibbon { id: string; name: string }

export interface CatalogSystem { id: string; name: string; danger: number; hazards: string[]; stations: string[] }

/** How a plan is drawn: each shape's outline in cell units (8 variants: rotation 0-3, then the same flipped), and a colour per function */
export interface RenderData {
  shapes: Record<string, string[]>;
  colors: Record<string, string>;
}

export interface CatalogFile {
  version: 1;
  builtAt: string;
  /** Where the numbers came from (the data folder's last commit); null when the game supplied the file */
  source: { commit: string; date: string; dirty: boolean } | null;
  parts: CatalogPart[];
  items: CatalogItem[];
  ships: CatalogShip[];
  bosses: CatalogBoss[];
  stations: CatalogStation[];
  systems: CatalogSystem[];
  /** Optional: ribbon names by id (a game-written file may leave it out) */
  ribbons?: CatalogRibbon[];
  render: RenderData;
}

export const CATALOG_KINDS = ['parts', 'items', 'ships', 'bosses', 'stations'] as const;
export type CatalogKind = typeof CATALOG_KINDS[number];
