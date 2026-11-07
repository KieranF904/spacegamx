/**
 * What a ship keeps of its field work between sessions (ShipRecord.field; docs/design/field-fabrication.md, "State").
 * The plan itself is the record's blueprint (standing parts + planned parts, the planned ones in `ghosts`); this holds
 * the rest: the machines' switches, the recycling queue, planned parts that can't join the blueprint yet, and what sits
 * inside the machines. Jobs are not kept: a job under way when the pilot leaves is called off (its inputs go back to
 * the hold, or into `held` if the hold is full).
 */

import type { PlacedPart } from '../../ships/types.js';
import type { Bag } from '../stacks.js';
import { PACK_MODES, type PackMode } from './packs.js';

/** No bay holds more (minebay.ts mineBayOf caps a model's magazine here too) */
const MAX_MAGAZINE = 64;

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
  /**
   * Planned parts that can't be in the blueprint yet: their cells are still taken by a part being recycled, or nothing
   * standing or planned joins them yet. The blueprint must always pass validateBlueprint; these join it when they can
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
  const rc = Array.isArray(r.recycle) ? [...new Set(r.recycle.filter((u): u is number => Number.isInteger(u)))] : [];
  if (rc.length) out.recycle = rc;
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
