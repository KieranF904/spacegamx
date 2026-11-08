/**
 * The repair bank (docs/design/field-fabrication.md, "The repair bank"): one per pilot, the same at every station. It
 * replaces insurance and loaners.
 *
 *   free      basic materials that refill by themselves up to BANK.ships starter ships' worth (bankCap), never withdrawn. On a
 *             respawn they pay for the ship at once, core outward (order.ts payCoreOutward). While nearly full the top
 *             BANK.spareShare of it may also pay repairs (freeSpare).
 *   deposits  packs and refined materials the pilot put in; never withdrawn, counted apart. They don't pay at a respawn;
 *             they repair the ship near any station (fast), and after a respawn rebuild what the free part didn't cover
 *             (at the normal rate, anywhere). A pack spent here gives a part all of its constituents it needs
 *             (packs.ts bankPay).
 *   No guaranteed ship: an empty free part means a bare core, rebuilt as it refills.
 *
 * Pure; wall-clock times are passed in (the server's clock), so it runs the same in tests.
 */

import type { Blueprint } from '../../ships/types.js';
import type { Economy } from '../economy.js';
import type { Bag } from '../stacks.js';

export interface RepairBank {
  /** The free part, by item: fractional while refilling (whole units are spent: freeWhole) */
  free: Bag;
  /** Deposits, by item (packs and refined materials) */
  deposits: Bag;
  /** Wall ms the free part was last refilled to */
  at: number;
}

export const BANK = Object.freeze({
  /** The free part holds this many starter ships' worth */
  ships: 2,
  /** The free part refills from empty to full in this many seconds (each item at its own cap's pace) */
  refillSeconds: 300,
  /** While the free part holds more than (1 - spareShare) of its cap, what is above that may pay repairs (a half: one
   *  starter ship's worth is always kept for a respawn, the other may mend) */
  spareShare: 0.5,
  /** Deposits repair a ship within this distance of any station (world units) */
  stationRange: 1500,
  /** Near a station: a missing part rebuilt from deposits every this many seconds, nearest the core first */
  stationPartSeconds: 2,
  /** Near a station: damaged parts healed this share of their HP a second, paid from deposits */
  stationHealPerSecond: 0.1,
  /** After a respawn: deposits rebuild the parts the free part didn't, anywhere, at this fabricator speed (a Field Fabricator's) */
  respawnSpeed: 1,
});

/** BANK.ships starter ships' worth: every part's recipe inputs but the core's (the core always comes back, free) */
export function bankCap(econ: Economy, starter: Blueprint): Bag {
  const out: Bag = {};
  for (const p of starter.parts) {
    if (p.fn === 'core') continue;
    for (const [id, n] of Object.entries(econ.recipes.partInputs(p))) out[id] = (out[id] ?? 0) + n * BANK.ships;
  }
  return out;
}

export function newBank(cap: Bag, now: number): RepairBank {
  return { free: { ...cap }, deposits: {}, at: now };
}

/** Refill the free part to `now` (each item up to its cap); true if anything changed */
export function refillBank(bank: RepairBank, cap: Bag, now: number): boolean {
  const dt = (now - bank.at) / 1000;
  bank.at = now;
  if (!(dt > 0)) return false;
  let changed = false;
  for (const [id, c] of Object.entries(cap)) {
    const have = bank.free[id] ?? 0;
    if (have >= c) continue;
    const next = Math.min(c, have + (c * dt) / BANK.refillSeconds);
    if (next !== have) { bank.free[id] = next; changed = true; }
  }
  // (An item no longer in the cap, after a starter change: let it be spent but not refilled)
  return changed;
}

/** The free part in whole units */
export function freeWhole(bank: RepairBank): Bag {
  const out: Bag = {};
  for (const [id, n] of Object.entries(bank.free)) { const k = Math.floor(n + 1e-9); if (k > 0) out[id] = k; }
  return out;
}

/** How full the free part is, all told (0..1) */
export function bankFill(bank: RepairBank, cap: Bag): number {
  let have = 0, want = 0;
  for (const [id, c] of Object.entries(cap)) { want += c; have += Math.min(c, bank.free[id] ?? 0); }
  return want > 0 ? have / want : 1;
}

/** Seconds until the free part is full (0: full) */
export function bankFullIn(bank: RepairBank, cap: Bag): number {
  let worst = 0;
  for (const [id, c] of Object.entries(cap)) if (c > 0) worst = Math.max(worst, (1 - Math.min(c, bank.free[id] ?? 0) / c) * BANK.refillSeconds);
  return Math.max(0, Math.ceil(worst - 1e-9));
}

/** What of the free part may pay repairs now: whole units above (1 - spareShare) of its cap */
export function freeSpare(bank: RepairBank, cap: Bag): Bag {
  const out: Bag = {};
  for (const [id, c] of Object.entries(cap)) {
    const k = Math.floor((bank.free[id] ?? 0) - (1 - BANK.spareShare) * c + 1e-9);
    if (k > 0) out[id] = k;
  }
  return out;
}

/** Take a bill from the free part (whole units), all or nothing */
export function spendFree(bank: RepairBank, bill: Bag): boolean {
  for (const [id, n] of Object.entries(bill)) if ((bank.free[id] ?? 0) + 1e-9 < n) return false;
  for (const [id, n] of Object.entries(bill)) bank.free[id] = Math.max(0, (bank.free[id] ?? 0) - n);
  return true;
}

/** Take used deposits (packs.ts bankPay's `used`), all or nothing */
export function spendDeposits(bank: RepairBank, used: Bag): boolean {
  for (const [id, n] of Object.entries(used)) if ((bank.deposits[id] ?? 0) < n) return false;
  for (const [id, n] of Object.entries(used)) {
    const k = (bank.deposits[id] ?? 0) - n;
    if (k > 0) bank.deposits[id] = k; else delete bank.deposits[id];
  }
  return true;
}

/** Can this item be deposited? Packs, refined materials and components (never ore, parts, ammunition or the rest) */
export function depositable(econ: Economy, id: string): boolean {
  const d = econ.items.get(id);
  if (!d) return false;
  return !!d.pack || d.category === 'refined' || d.category === 'component';
}

/** Put items in the deposits (the caller has taken them from the pilot) */
export function depositInto(bank: RepairBank, items: Bag): void {
  for (const [id, n] of Object.entries(items)) if (n > 0) bank.deposits[id] = (bank.deposits[id] ?? 0) + Math.floor(n);
}

/** A bank as saved, tolerant of junk (profile.ts migrateProfile); absent or broken: none (the server makes a full one) */
export function cleanBank(v: unknown): RepairBank | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const bag = (x: unknown, whole: boolean): Bag => {
    const out: Bag = {};
    if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
    for (const [id, n] of Object.entries(x as Record<string, unknown>)) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
      out[id] = whole ? Math.floor(n) : n;
      if (out[id] <= 0) delete out[id];
    }
    return out;
  };
  return { free: bag(r.free, false), deposits: bag(r.deposits, true), at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 };
}
