/**
 * What a ship keeps of its field work between sessions (ShipRecord.field; docs/design/field-fabrication.md, "State").
 * The plan itself is the record's blueprint: the parts standing, and the missing ones (planned or lost alike: hp 0 in the
 * record) the fabricator builds. This holds the rest: the machines' switches, the recycling queue, and what sits inside
 * the machines. Jobs are not kept: a job under way when the pilot leaves is called off (its inputs go back to
 * the hold, or into `held` if the hold is full).
 */

import type { PlacedPart } from '../../ships/types.js';
import type { Bag } from '../stacks.js';
import { PACK_MODES, type PackMode } from './packs.js';

/** No bay holds more (minebay.ts mineBayOf caps a model's magazine here too) */
const MAX_MAGAZINE = 64;
/** The most parts the fabricator's priority or hold lists keep, and recipes the refiner's auto list */
export const MAX_ORDER = 64;
export const MAX_REFINE = 16;

export interface FieldRecord {
  /** Switches (absent: off) */
  fabOn?: boolean;
  refOn?: boolean;
  /** How the fabricator may use packs (absent: 'off') */
  packs?: PackMode;
  /** The refiner's chosen recipe (absent: auto, what the plan is short of) */
  recipe?: string;
  /** Standing parts queued for recycling (uids) */
  recycle?: number[];
  /** The fabricator's priority (the Ship window's Fabricator tab): these parts (uids) are worked first, in this order, whenever it can */
  first?: number[];
  /** Parts (uids) the fabricator leaves alone until the pilot lets it go on (held from the Fabricator tab) */
  paused?: number[];
  /** The refiner's auto list: on auto, once the plan needs nothing it can make, it refines these (recipe ids), first first */
  refine?: string[];
  /**
   * (Old saves only, read once) planned parts an earlier field plan kept outside the blueprint. Nothing writes it now:
   * the server moves them into the blueprint as missing parts when the ship is next flown (FieldShips.migrate)
   */
  waiting?: PlacedPart[];
  /** Items inside the machines: inputs of a job called off and finished output, waiting for room in the hold */
  held?: Bag;
  /** Each Mine Bay's loaded mines, by the bay's uid (docs/design/groups-mines-docking.md; absent or no entry: empty) */
  mines?: Record<number, number>;
}

const isPart = (p: unknown): p is PlacedPart => {
  const q = p as PlacedPart;
  return !!q && typeof q === 'object' && Number.isInteger(q.uid) && typeof q.fn === 'string' && typeof q.piece === 'string'
    && typeof q.material === 'string' && Number.isInteger(q.x) && Number.isInteger(q.y) && [0, 1, 2, 3].includes(q.rot);
};

/** A field record as saved, tolerant of junk (profile.ts cleanRecord); nothing worth keeping: absent */
export function cleanFieldRecord(v: unknown): { field?: FieldRecord } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  const out: FieldRecord = {};
  if (r.fabOn === true) out.fabOn = true;
  if (r.refOn === true) out.refOn = true;
  if (typeof r.packs === 'string' && (PACK_MODES as readonly string[]).includes(r.packs) && r.packs !== 'off') out.packs = r.packs as PackMode;
  if (typeof r.recipe === 'string') out.recipe = r.recipe;
  const uids = (v: unknown, max: number): number[] => (Array.isArray(v) ? [...new Set(v.filter((u): u is number => Number.isInteger(u)))].slice(0, max) : []);
  const rc = uids(r.recycle, 1024);
  if (rc.length) out.recycle = rc;
  const first = uids(r.first, MAX_ORDER);
  if (first.length) out.first = first;
  const paused = uids(r.paused, MAX_ORDER);
  if (paused.length) out.paused = paused;
  const refine = Array.isArray(r.refine) ? [...new Set(r.refine.filter((x): x is string => typeof x === 'string' && x.length <= 64))].slice(0, MAX_REFINE) : [];
  if (refine.length) out.refine = refine;
  const w = Array.isArray(r.waiting) ? r.waiting.filter(isPart) : [];
  if (w.length) out.waiting = w;
  const held: Bag = {};
  if (r.held && typeof r.held === 'object' && !Array.isArray(r.held)) {
    for (const [id, n] of Object.entries(r.held as Record<string, unknown>)) if (typeof n === 'number' && Number.isFinite(n) && n >= 1) held[id] = Math.floor(n);
  }
  if (Object.keys(held).length) out.held = held;
  const mines: Record<number, number> = {};
  if (r.mines && typeof r.mines === 'object' && !Array.isArray(r.mines)) {
    for (const [k, n] of Object.entries(r.mines as Record<string, unknown>)) {
      const uid = Number(k);
      if (Number.isInteger(uid) && typeof n === 'number' && Number.isFinite(n) && n >= 1) mines[uid] = Math.min(MAX_MAGAZINE, Math.floor(n));
    }
  }
  if (Object.keys(mines).length) out.mines = mines;
  return Object.keys(out).length ? { field: out } : {};
}
