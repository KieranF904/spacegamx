/**
 * The repair bank on the server (docs/design/field-fabrication.md, sections 2.4 and 6; the rules and numbers are
 * common/src/econ/field/bank.ts, so client and server agree). Each pilot has one, on the profile (`PlayerProfile.bank`):
 *
 *   free      refills by the wall clock to a starter ship's worth; pays for the ship at once on a respawn (core outward),
 *             and its top quarter ("spare") may also pay repairs. Never withdrawn.
 *   deposits  packs and refined materials put in at a station. Never withdrawn. They mend the ship near any station
 *             (bridge/rebuild.ts repairStep, through payRepair / payRebuild here) and, after a respawn, rebuild what the
 *             free part didn't cover, anywhere, at BANK.respawnSpeed (stepDeposits): never instantly.
 *   No guaranteed ship: a pilot who dies until the free part is empty respawns as a bare core, and is rebuilt as it refills.
 *
 * A death makes every standing part (but the core) a ghost and records it as owed (`ShipRecord.owed`): ghosts of a field
 * plan are not owed, so the free part and the deposits only ever rebuild the ship's own design.
 *
 * This file is the rules applied to a profile (no ECS, no sockets): Pilots owns the sessions, installs the parts that
 * come back on the live ship and sends the `repairBank` message. Tests run it on bare profiles.
 */

import {
  bankCap, newBank, refillBank, freeWhole, freeSpare, spendFree, spendDeposits, depositable, depositInto, bankFullIn,
  bankPay, packDefs, payCoreOutward, joinDepths, adjacency, jobTicks, fabWork, attachWork, repairBill, BANK,
  computeJoins, blueprintGeometry, countOf, removeFrom,
  type Economy, type PlayerProfile, type ShipRecord, type Bag, type Blueprint, type PlacedPart, type PackDef, type ServerRepairBankMessage,
} from '@space-game/common';

/** Is a part (uid) being built, repaired or recycled by a field machine (feature `machines`)? */
export type ClaimCheck = (uid: number) => boolean;

export class RepairBanks {
  readonly cap: Bag;
  private readonly packs: PackDef[];
  private readonly joinCache = new WeakMap<Blueprint, [number, number][]>();
  /** Ticks counted toward the deposit rebuild's current part, and which part it is */
  private readonly progress = new WeakMap<ShipRecord, { uid: number; ticks: number }>();

  constructor(readonly econ: Economy, starter: Blueprint) {
    this.cap = bankCap(econ, starter);
    this.packs = packDefs(econ.items);
  }

  // ---------------------------------------------------------------------------
  // The free part
  // ---------------------------------------------------------------------------

  /** The pilot's bank, made full if they have none (first login), refilled to `now`; true if anything changed */
  ensure(p: PlayerProfile, now: number): boolean {
    if (!p.bank) { p.bank = newBank(this.cap, now); return true; }
    return refillBank(p.bank, this.cap, now);
  }

  /** What the free part may give repairs now (whole units above its top quarter's floor) */
  spare(p: PlayerProfile): Bag {
    return p.bank ? freeSpare(p.bank, this.cap) : {};
  }

  /** Take a bill from the spare (all or nothing; never more than the spare) */
  spendSpare(p: PlayerProfile, bill: Bag): boolean {
    if (!p.bank) return false;
    const spare = freeSpare(p.bank, this.cap);
    for (const [id, n] of Object.entries(bill)) if ((spare[id] ?? 0) < n) return false;
    return spendFree(p.bank, bill);
  }

  /** The message the client shows the bank from (`rebuilding`: parts the deposits are still to rebuild) */
  view(p: PlayerProfile, rebuilding = 0): ServerRepairBankMessage {
    const bank = p.bank ?? newBank(this.cap, 0);
    return {
      type: 'repairBank', free: freeWhole(bank), cap: { ...this.cap }, fullIn: p.bank ? bankFullIn(bank, this.cap) : 0,
      spare: freeSpare(bank, this.cap), deposits: { ...bank.deposits }, ...(rebuilding > 0 ? { rebuilding } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Deposits
  // ---------------------------------------------------------------------------

  /** Put `items` from the hold or storage into the deposits: only depositable ones, only what they have. Returns what went in and what was refused */
  deposit(p: PlayerProfile, items: Bag, from: 'cargo' | 'storage'): { moved: Bag; refused: string[] } {
    const moved: Bag = {}, refused: string[] = [];
    if (!p.bank) return { moved, refused: Object.keys(items) };
    const list = from === 'storage' ? p.storage : p.cargo;
    for (const [id, want] of Object.entries(items)) {
      const n = Math.floor(Number(want));
      if (!(n >= 1)) continue;
      if (!depositable(this.econ, id)) { refused.push(id); continue; }
      const k = Math.min(n, countOf(list, id));
      if (k <= 0) continue;
      removeFrom(list, id, k);
      moved[id] = k;
    }
    depositInto(p.bank, moved);
    return { moved, refused };
  }

  /**
   * Pay a bill from the bank for the ship's repair or rebuild (all or nothing): loose deposits, then (if `useSpare`) the
   * free part's spare, then packs from the deposits (each pack that pays the most still owed; what the part doesn't need is wasted)
   */
  payBill(p: PlayerProfile, need: Bag, useSpare: boolean): boolean {
    const bank = p.bank;
    if (!bank) return false;
    const owe: Bag = {}, loose: Bag = {}, fromSpare: Bag = {};
    for (const [id, n] of Object.entries(need)) if (n > 0) owe[id] = Math.ceil(n);
    for (const id of Object.keys(owe)) {
      const k = Math.min(owe[id], bank.deposits[id] ?? 0);
      if (k > 0) { loose[id] = k; owe[id] -= k; }
    }
    if (useSpare) {
      const spare = freeSpare(bank, this.cap);
      for (const id of Object.keys(owe)) {
        const k = Math.min(owe[id], spare[id] ?? 0);
        if (k > 0) { fromSpare[id] = k; owe[id] -= k; }
      }
    }
    const rest: Bag = { ...bank.deposits };
    for (const [id, k] of Object.entries(loose)) rest[id] -= k;
    const packed = bankPay(owe, rest, this.packs);
    if (Object.keys(packed.short).length) return false;
    const used: Bag = { ...loose };
    for (const [id, k] of Object.entries(packed.used)) used[id] = (used[id] ?? 0) + k;
    if (!spendDeposits(bank, used)) return false;
    spendFree(bank, fromSpare);
    return true;
  }

  /** Passing a station: pay to mend a damaged part (`missing`: the share of its HP gone) */
  payRepair(p: PlayerProfile, part: PlacedPart, missing: number): boolean {
    return this.payBill(p, repairBill(this.econ, part, missing), true);
  }

  /** Passing a station: pay to regrow a missing part */
  payRebuild(p: PlayerProfile, part: PlacedPart): boolean {
    return this.payBill(p, this.econ.recipes.partInputs(part), true);
  }

  // ---------------------------------------------------------------------------
  // A death, and the parts the bank owes after it
  // ---------------------------------------------------------------------------

  private joinsOf(bp: Blueprint): [number, number][] {
    let j = this.joinCache.get(bp);
    if (!j) { j = computeJoins(blueprintGeometry(this.econ.ships, bp)); this.joinCache.set(bp, j); }
    return j;
  }

  /** Parts of this record still owed (ghosts that were destroyed with the ship), uids */
  owedUids(rec: ShipRecord): number[] {
    const ghosts = new Set(rec.ghosts ?? []);
    return (rec.owed ?? []).filter((u) => ghosts.has(u));
  }

  /**
   * The ship was destroyed: it comes back in the same design with the core free, and every other standing part a ghost
   * owed to the bank. The free part pays at once, core outward (what it can); the rest wait for the deposits (stepDeposits),
   * the free part as it refills (payFree), or a fabricator. Parts that were planned ghosts stay planned, not owed.
   * Returns how many parts the free part paid and how many are still owed
   */
  respawn(p: PlayerProfile, rec: ShipRecord, claimed?: ClaimCheck): { paid: number; owed: number } {
    const core = rec.blueprint.parts.find((q) => q.fn === 'core');
    const ghosts = new Set(rec.ghosts ?? []);
    const owed = new Set(this.owedUids(rec));
    for (const q of rec.blueprint.parts) {
      if (q === core || ghosts.has(q.uid)) continue;
      ghosts.add(q.uid);
      owed.add(q.uid);
    }
    if (core) ghosts.delete(core.uid);
    rec.ghosts = rec.blueprint.parts.filter((q) => ghosts.has(q.uid)).map((q) => q.uid);
    rec.owed = rec.blueprint.parts.filter((q) => owed.has(q.uid)).map((q) => q.uid);
    rec.hp = {};
    const paid = this.payFree(p, rec, claimed).length;
    return { paid, owed: this.owedUids(rec).length };
  }

  /**
   * The free part pays the owed ghosts it can, core outward (a part it can't pay is passed over; one beyond it may still
   * be reached). The record loses them as ghosts. Returns the uids paid, in order (the caller builds them on a live ship)
   */
  payFree(p: PlayerProfile, rec: ShipRecord, claimed?: ClaimCheck): number[] {
    const bank = p.bank;
    if (!bank) return [];
    const owed = new Set(this.owedUids(rec));
    if (!owed.size) return [];
    const parts = rec.blueprint.parts;
    const ghosts = new Set(rec.ghosts ?? []);
    const root = parts.findIndex((q) => q.fn === 'core');
    const built = parts.map((q) => !ghosts.has(q.uid));
    const { paid, spent } = payCoreOutward(
      parts.length, root, this.joinsOf(rec.blueprint), built,
      (i) => owed.has(parts[i].uid) && !claimed?.(parts[i].uid),
      (i) => this.econ.recipes.partInputs(parts[i]), freeWhole(bank),
    );
    if (!paid.length) return [];
    spendFree(bank, spent);
    const uids = paid.map((i) => parts[i].uid);
    this.built(rec, uids);
    return uids;
  }

  /** These ghosts are built now: off the record's ghost and owed lists */
  built(rec: ShipRecord, uids: number[]): void {
    const done = new Set(uids);
    rec.ghosts = (rec.ghosts ?? []).filter((u) => !done.has(u));
    rec.owed = (rec.owed ?? []).filter((u) => !done.has(u));
    for (const u of done) delete rec.hp[u];
    if (!rec.owed.length) delete rec.owed;
    this.progress.delete(rec);
  }

  /**
   * After a respawn the deposits rebuild what the free part didn't, anywhere, a part at a time at BANK.respawnSpeed (a
   * Field Fabricator's: fabricate plus attach). Called with the ticks since the last call; returns the uid that is
   * finished (paid from the deposits, off the record's lists: the caller builds it on the live ship), or null. Nothing
   * is paid while a part is under way, so a pilot who loses the deposits' cover just stops
   */
  stepDeposits(p: PlayerProfile, rec: ShipRecord, ticks: number, claimed?: ClaimCheck): number | null {
    const bank = p.bank;
    if (!bank || !Object.keys(bank.deposits).length) { this.progress.delete(rec); return null; }
    const owed = new Set(this.owedUids(rec));
    if (!owed.size) { this.progress.delete(rec); return null; }
    const parts = rec.blueprint.parts;
    const ghosts = new Set(rec.ghosts ?? []);
    const root = parts.findIndex((q) => q.fn === 'core');
    if (root < 0) return null;
    const joins = this.joinsOf(rec.blueprint);
    const depth = joinDepths(parts.length, root, joins), adj = adjacency(parts.length, joins);
    let pick = -1;
    for (let i = 0; i < parts.length; i++) {
      const q = parts[i];
      if (!owed.has(q.uid) || depth[i] < 0 || claimed?.(q.uid)) continue;
      if (!adj[i].some((j) => !ghosts.has(parts[j].uid))) continue;
      if (pick >= 0 && !(depth[i] < depth[pick])) continue;
      if (Object.keys(bankPay(this.econ.recipes.partInputs(q), bank.deposits, this.packs).short).length) continue;
      pick = i;
    }
    if (pick < 0) { this.progress.delete(rec); return null; }
    const part = parts[pick];
    let g = this.progress.get(rec);
    if (!g || g.uid !== part.uid) this.progress.set(rec, (g = { uid: part.uid, ticks: 0 }));
    g.ticks += ticks;
    if (g.ticks < jobTicks(fabWork(this.econ, part) + attachWork(this.econ.ships, part), BANK.respawnSpeed)) return null;
    if (!this.payBill(p, this.econ.recipes.partInputs(part), false)) { this.progress.delete(rec); return null; }
    this.built(rec, [part.uid]);
    return part.uid;
  }

  // ---------------------------------------------------------------------------
  // Dev tools (net/handlers/bank.ts, dev server only)
  // ---------------------------------------------------------------------------

  /** `fill` the free part, `empty` it, `clearDeposits`, or `grant` items (depositable ones) into the deposits */
  dev(p: PlayerProfile, action: string, items: Bag | undefined, now: number): boolean {
    p.bank ??= newBank(this.cap, now);
    const bank = p.bank;
    switch (action) {
      case 'fill': bank.free = { ...this.cap }; bank.at = now; return true;
      case 'empty': bank.free = {}; bank.at = now; return true;
      case 'clearDeposits': bank.deposits = {}; return true;
      case 'grant': {
        // (No items: a kit of every pack, 10 each)
        const asked = items && Object.keys(items).length ? items : Object.fromEntries(this.packs.map((k) => [k.id, 10]));
        const give: Bag = {};
        for (const [id, n] of Object.entries(asked)) {
          const k = Math.min(9999, Math.floor(Number(n)));
          if (k >= 1 && depositable(this.econ, id)) give[id] = k;
        }
        if (!Object.keys(give).length) return false;
        depositInto(bank, give);
        return true;
      }
      default: return false;
    }
  }
}
