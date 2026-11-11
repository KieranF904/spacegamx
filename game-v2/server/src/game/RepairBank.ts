/**
 * @contract server.repair-bank.sessions
 * owns:       the repair bank of connected pilots: deposits, station repairs paid from it, and the `repairBank` message
 * needs:      RepairBanks (the rules), BankHost (sessions, toast, items, save, send); npm: @space-game/common
 * invariants: a changed bank is sent at most once a second, a refilling one once a minute — server/src/game/repairBank.test.ts
 *             deposits only at a station — server/src/game/repairBank.test.ts
 *             the free part pays level 0 parts only, at BANK.repairShare of their inputs — server/src/game/repairBank.test.ts
 * extend:     a new bank action is a method here and a door in Pilots; its rules go in RepairBanks
 */
/**
 * The repair bank on the server (docs/design/death-rework-2026-11.md; the rules and numbers are
 * common/src/econ/field/bank.ts, so client and server agree). Each pilot has one, on the profile (`PlayerProfile.bank`):
 *
 *   free      refills by the wall clock to two starter ships' worth (BANK.ships) in 5 minutes; pays station repairs of
 *             level 0 parts (freePays). Never withdrawn.
 *   deposits  packs and refined materials put in at a station. Never withdrawn. They pay station repairs of any part.
 *
 * It mends a ship that survived, near a station (bridge/rebuild.ts repairStep, through payRepair / payRebuild here): its
 * damaged parts, and its destroyed ones that were built. A part never built (ShipRecord.unbuilt) or a ghost (a death
 * leaves every part of the lost ship one) needs fabricating; the bank never pays for it, and nothing at a respawn.
 * There is no bank in the field: the ship's machines work from its hold.
 *
 * RepairBanks is the rules applied to a profile (no ECS, no sockets); tests run it on bare profiles. BankSessions, below it,
 * is the bank of the pilots in play: it takes deposits and sends the `repairBank` message, through a narrow BankHost
 * that Pilots provides.
 */

import { bankCap, newBank, refillBank, freeWhole, freeSpare, spendFree, spendDeposits, depositable, depositInto, bankFullIn,
  bankPay, packDefs, bankRepairBill, freePays, countOf, removeFrom,
  type Economy, type PlayerProfile, type Bag, type Blueprint, type PlacedPart, type PackDef, type ServerRepairBankMessage } from '@space-game/common';

export class RepairBanks {
  readonly cap: Bag;
  private readonly packs: PackDef[];

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

  /** The message the client shows the bank from */
  view(p: PlayerProfile): ServerRepairBankMessage {
    const bank = p.bank ?? newBank(this.cap, 0);
    return {
      type: 'repairBank', free: freeWhole(bank), cap: { ...this.cap }, fullIn: p.bank ? bankFullIn(bank, this.cap) : 0,
      spare: freeSpare(bank, this.cap), deposits: { ...bank.deposits },
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
   * Pay a bill from the bank for the ship's repair or rebuild (all or nothing): loose deposits, then (if `useSpare`: a
   * level 0 part) the free part, then packs from the deposits (each pack that pays the most still owed; what the part
   * doesn't need is wasted)
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
    return this.payBill(p, bankRepairBill(this.econ, part, missing), freePays(part));
  }

  /** Passing a station: pay to regrow a destroyed part that was built (the caller has checked it was) */
  payRebuild(p: PlayerProfile, part: PlacedPart): boolean {
    return this.payBill(p, bankRepairBill(this.econ, part, 1), freePays(part));
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

// ---------------------------------------------------------------------------
// The bank of pilots in play: sessions and the `repairBank` message
// ---------------------------------------------------------------------------

/** The part of a pilot's session the bank reads and marks (Pilots' Session has more) */
export interface BankSession {
  conn: BankConn;
  profile: PlayerProfile;
  dirty: boolean;
  /** The last `repairBank` message sent: when (wall ms) and what (JSON) */
  bankSent?: { at: number; key: string };
  /** The bank changed since it was last sent (a station repair paid from it): sent on the next tick, at most once a second */
  bankDirty?: boolean;
  /** Their saved profile is still loading: the one in hand isn't theirs, so it's never touched */
  loading?: boolean;
}

/** What the bank needs to know about a connection (a PilotConn has it) */
export interface BankConn { playerId: number }

/** What the bank asks of Pilots and the game: a narrow door, so this file never sees the whole of either */
export interface BankHost<S extends BankSession = BankSession> {
  now(): number;
  session(conn: S['conn']): S | undefined;
  sessionOfEid(eid: number): S | undefined;
  sessions(): Iterable<S>;
  atStation(conn: S['conn']): boolean;
  toast(conn: S['conn'], text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  sendItems(conn: S['conn']): void;
  saveNow(conn: S['conn']): void;
  send(conn: S['conn'], msg: ServerRepairBankMessage): void;
  itemName(id: string): string;
}

/**
 * The repair bank of connected pilots (contract header at the top of this file).
 */
export class BankSessions<S extends BankSession = BankSession> {
  private ticks = 0;

  constructor(readonly rules: RepairBanks, private host: BankHost<S>) {}

  /** Passing a station (bridge/rebuild.ts repairStep): the bank pays to mend a damaged part. A pilotless ship is mended free */
  repair(eid: number, part: PlacedPart, missing: number): boolean {
    const s = this.host.sessionOfEid(eid);
    if (!s) return true;
    if (!this.rules.payRepair(s.profile, part, missing)) return false;
    this.changed(s);
    return true;
  }

  /** Passing a station: the bank pays to regrow a destroyed part that was built */
  rebuild(eid: number, part: PlacedPart): boolean {
    const s = this.host.sessionOfEid(eid);
    if (!s) return true;
    if (!this.rules.payRebuild(s.profile, part)) return false;
    this.changed(s);
    return true;
  }

  /** The bank changed in passing (a repair paid): saved with the profile, sent within a second */
  private changed(s: S): void {
    s.dirty = true;
    s.bankDirty = true;
  }

  /** `bankDeposit`: items from the hold or storage into the deposits, at a station, only what a bank takes */
  deposit(conn: S['conn'], items: Bag, from?: 'cargo' | 'storage'): void {
    const s = this.host.session(conn);
    if (!s || s.loading || !items || typeof items !== 'object') return;
    if (!this.host.atStation(conn)) return this.host.toast(conn, 'Put things in your repair bank at a station', 'warn');
    const asked: Bag = {};
    for (const [id, n] of Object.entries(items).slice(0, 64)) if (typeof id === 'string' && Number.isFinite(Number(n)) && Number(n) >= 1) asked[id] = Math.floor(Number(n));
    this.rules.ensure(s.profile, this.host.now());
    const moved: Bag = {}, refused = new Set<string>();
    for (const where of from ? [from] : (['cargo', 'storage'] as const)) {
      const want: Bag = {};
      for (const [id, n] of Object.entries(asked)) { const left = n - (moved[id] ?? 0); if (left > 0) want[id] = left; }
      const r = this.rules.deposit(s.profile, want, where);
      for (const [id, n] of Object.entries(r.moved)) moved[id] = (moved[id] ?? 0) + n;
      for (const id of r.refused) refused.add(id);
    }
    const total = Object.values(moved).reduce((a, n) => a + n, 0);
    if (refused.size) this.host.toast(conn, `${[...refused].map((id) => this.host.itemName(id)).join(', ')} can't go in the repair bank: it takes packs, refined materials and components`, 'warn');
    if (!total) { if (!refused.size) this.host.toast(conn, 'Nothing to put in the repair bank', 'info'); return; }
    s.dirty = true;
    this.host.toast(conn, `Put ${total} item${total > 1 ? 's' : ''} in your repair bank`, 'good');
    this.host.sendItems(conn);
    this.send(s, true);
    this.host.saveNow(conn);
  }

  /** `devBank` (net/handlers/bank.ts has checked this is a dev server): fill or empty the free part, clear or grant deposits */
  dev(conn: S['conn'], action: string, items?: Bag): boolean {
    const s = this.host.session(conn);
    if (!s || s.loading) return false;
    if (!this.rules.dev(s.profile, action, items, this.host.now())) { this.host.toast(conn, 'Nothing to do', 'info'); return false; }
    s.dirty = true;
    this.send(s, true);
    this.host.toast(conn, `Repair bank (dev): ${action}`, 'info');
    return true;
  }

  /** Once a tick: refill the free part by the clock, send changes */
  tick(now: number): void {
    const n = ++this.ticks;
    if (n % 15 !== 0) return;
    for (const s of this.host.sessions()) {
      if (s.loading) continue;
      this.rules.ensure(s.profile, now);
      this.send(s, false, now);
    }
  }

  /**
   * Tell the client its bank: at once when `force` (login, a deposit, a death), else when it changed (at most once a
   * second) or, while the free part refills, once a minute
   */
  send(s: S, force = false, now = this.host.now()): void {
    const msg = this.rules.view(s.profile);
    const key = JSON.stringify([msg.free, msg.deposits]);
    const last = s.bankSent;
    const filling = msg.fullIn > 0;
    if (!force) {
      if (!last) { /* never sent: send */ }
      else if (s.bankDirty && key !== last.key && now - last.at >= 1000) { /* changed */ }
      else if (filling && now - last.at >= 60_000) { /* refilling */ }
      else return;
    }
    s.bankDirty = false;
    s.bankSent = { at: now, key };
    this.host.send(s.conn, msg);
  }
}
