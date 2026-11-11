/**
 * @contract common.econ.hold-ghosts
 * owns:       what a ship picks up by itself: ore in mining mode (but blacklisted ores) and the items its hold has a ghost of; the space ghosts reserve; manual takes and their warning; templates of ghosts; the saved shapes' cleaning
 * needs:      econ/stacks (Stack, Bag, countOf, addTo); no I/O (the server's pickup and the client's panel and hold run the same rules)
 * invariants: ore and other auto pickups never use another ghost's reserved space; a ghost's own item may; a manual take may use any free space — common/src/econ/holdGhosts.test.ts
 *             mining mode collects every ore but the blacklisted; a ghost of an ore collects it whatever the blacklist and mode say — common/src/econ/holdGhosts.test.ts
 *             a ghost with a target collects up to it, then goes (the stack is real); an unlimited one always reserves GHOST_RESERVE units — common/src/econ/holdGhosts.test.ts
 * extend:     a new kind of auto pickup is one more case in autoRoom
 */

import { addTo, countOf, type Bag, type Stack } from './stacks.js';

/** A ghost in the hold: `item` is collected automatically; `n`: until the hold has this many (absent: always) */
export interface HoldGhost { item: string; n?: number }
/** A named set of ghosts kept in the profile, loaded into a ship's hold in one go */
export interface GhostTemplate { name: string; ghosts: HoldGhost[] }
/**
 * The pilot's pickup settings (profile.pickup, the pilot's own, unlike ghosts which are the hold's): `miningOff` turns
 * mining mode off (absent: on), `blacklist` the ores mining mode leaves; the ghost templates
 */
export interface PickupPrefs { miningOff?: boolean; blacklist?: string[]; templates?: GhostTemplate[] }
/** Mining mode as the rules read it: on or off, and the ores it leaves */
export interface MiningMode { on: boolean; blacklist?: readonly string[] }

/** The mining mode a pilot's settings make */
export function miningMode(p: PickupPrefs | undefined): MiningMode {
  return { on: !p?.miningOff, blacklist: p?.blacklist ?? [] };
}

/** Units of hold space an unlimited ghost keeps free for its item, so junk ore can't squeeze it out */
export const GHOST_RESERVE = 5;
export const MAX_GHOSTS = 24;
export const MAX_TEMPLATES = 12;
export const MAX_TEMPLATE_NAME = 32;
export const MAX_BLACKLIST = 64;

/** Item categories that count as ore for "Collect all ore": everything a rock gives */
export const ORE_CATEGORIES: readonly string[] = ['mineral', 'gem', 'volatile'];

/** The hold as the rules see it: its stacks, its capacity (volume units), and each item's volume and category */
export interface HoldView {
  cargo: Stack[];
  capacity: number;
  volume(id: string): number;
  category(id: string): string | undefined;
}

const used = (h: HoldView, cargo = h.cargo) => cargo.reduce((t, s) => t + s.n * h.volume(s.id), 0);

/** Space a ghost keeps for its item now: unlimited GHOST_RESERVE units, a target what's still to come */
export function ghostReserve(g: HoldGhost, held: number, volume: number): number {
  return (g.n === undefined ? GHOST_RESERVE : Math.max(0, g.n - held)) * volume;
}

/** Space the ghosts keep, all told (but `except`'s own) */
export function reservedSpace(h: HoldView, ghosts: readonly HoldGhost[], except?: string, cargo = h.cargo): number {
  let r = 0;
  for (const g of ghosts) if (g.item !== except) r += ghostReserve(g, countOf(cargo, g.item), h.volume(g.item));
  return r;
}

/** Is this an ore for mining mode (and the blacklist): everything a rock gives */
export function isOre(h: Pick<HoldView, 'category'>, item: string): boolean {
  return ORE_CATEGORIES.includes(h.category(item) ?? '');
}

/** How many of `item` a ship may pick up by itself now (0: it leaves it for the pickup panel) */
export function autoRoom(h: HoldView, ghosts: readonly HoldGhost[], mining: MiningMode, item: string, cargo = h.cargo): number {
  const vol = h.volume(item) || 1;
  const free = h.capacity - used(h, cargo);
  const g = ghosts.find((x) => x.item === item);
  if (g) {
    const want = g.n === undefined ? Infinity : Math.max(0, g.n - countOf(cargo, item));
    return Math.max(0, Math.min(want, Math.floor((free - reservedSpace(h, ghosts, item, cargo)) / vol + 1e-9)));
  }
  if (mining.on && isOre(h, item) && !mining.blacklist?.includes(item)) return Math.max(0, Math.floor((free - reservedSpace(h, ghosts, undefined, cargo)) / vol + 1e-9));
  return 0;
}

/** Of a pod's contents, what the ship would pick up by itself (as far as each fits, in turn) */
export function autoTake(h: HoldView, ghosts: readonly HoldGhost[], mining: MiningMode, bag: Bag): Bag {
  const out: Bag = {};
  const cargo = h.cargo.map((s) => ({ ...s }));
  for (const [id, n] of Object.entries(bag)) {
    const k = Math.min(n, autoRoom(h, ghosts, mining, id, cargo));
    if (k > 0) { out[id] = k; addTo(cargo, id, k); }
  }
  return out;
}

/** A manual take (the pickup panel): how many fit, and how many of those would use space a ghost of another item keeps */
export function manualRoom(h: HoldView, ghosts: readonly HoldGhost[], item: string, cargo = h.cargo): { fit: number; reserved: number } {
  const vol = h.volume(item) || 1;
  const free = h.capacity - used(h, cargo);
  const fit = Math.max(0, Math.floor(free / vol + 1e-9));
  const clean = Math.max(0, Math.floor((free - reservedSpace(h, ghosts, item, cargo)) / vol + 1e-9));
  return { fit, reserved: Math.max(0, fit - clean) };
}

/** The ghosts still wanted: one with a target the hold has reached goes (its stack is real now) */
export function settleGhosts(ghosts: readonly HoldGhost[], cargo: Stack[]): HoldGhost[] {
  return ghosts.filter((g) => g.n === undefined || countOf(cargo, g.item) < g.n);
}

/** Saved ghosts, cleaned: one per item, whole targets of 1 or more, at most MAX_GHOSTS */
export function cleanGhosts(v: unknown): HoldGhost[] {
  const out: HoldGhost[] = [];
  for (const g of Array.isArray(v) ? v : []) {
    if (!g || typeof g.item !== 'string' || out.some((x) => x.item === g.item) || out.length >= MAX_GHOSTS) continue;
    const n = typeof g.n === 'number' && Number.isFinite(g.n) && g.n >= 1 ? Math.min(1e6, Math.floor(g.n)) : undefined;
    out.push(n === undefined ? { item: g.item } : { item: g.item, n });
  }
  return out;
}

/** Saved pickup settings, cleaned (absent when there is nothing but the defaults) */
export function cleanPickup(v: unknown): PickupPrefs | undefined {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const templates: GhostTemplate[] = [];
  for (const t of Array.isArray(r.templates) ? r.templates : []) {
    if (!t || typeof t.name !== 'string' || !t.name.trim() || templates.length >= MAX_TEMPLATES) continue;
    const name = t.name.trim().slice(0, MAX_TEMPLATE_NAME);
    if (templates.some((x) => x.name === name)) continue;
    templates.push({ name, ghosts: cleanGhosts(t.ghosts) });
  }
  const blacklist = [...new Set((Array.isArray(r.blacklist) ? r.blacklist : []).filter((x): x is string => typeof x === 'string'))].slice(0, MAX_BLACKLIST);
  const out: PickupPrefs = { ...(r.miningOff === true ? { miningOff: true } : {}), ...(blacklist.length ? { blacklist } : {}), ...(templates.length ? { templates } : {}) };
  return Object.keys(out).length ? out : undefined;
}
