/**
 * @contract server.repair-bank.sessions
 * owns:       the repair bank of connected pilots: deposits, station repairs paid from it, rebuilding owed parts on the live
 *             ship, and the `repairBank` message
 * needs:      RepairBanks (the rules), BankHost (sessions, toast, items, save, send, installGhost, isClaimed); npm: bitecs
 * events:     hangarChanged when a part is built in
 * invariants: a changed bank is sent at most once a second, a refilling one once a minute — server/src/game/repairBank.test.ts
 *             deposits only at a station — server/src/game/repairBank.test.ts
 * extend:     a new bank action is a method here and a door in Pilots; its rules go in RepairBanks
 */
/**
 * The repair bank on the server (docs/design/field-fabrication.md, sections 2.4 and 6; the rules and numbers are
 * common/src/econ/field/bank.ts, so client and server agree). Each pilot has one, on the profile (`PlayerProfile.bank`):
 *
 *   free      refills by the wall clock to two starter ships' worth (BANK.ships) in 5 minutes; pays for the ship at once on a respawn (core outward),
 *             and its top half ("spare") may also pay repairs. Never withdrawn.
 *   deposits  packs and refined materials put in at a station. Never withdrawn. They mend the ship near any station
 *             (bridge/rebuild.ts repairStep, through payRepair / payRebuild here) and, after a respawn, rebuild what the
 *             free part didn't cover, anywhere, at BANK.respawnSpeed (stepDeposits): never instantly.
 *   No guaranteed ship: a pilot who dies until the free part is empty respawns as a bare core, and is rebuilt as it refills.
 *
 * A death makes every part of the design (but the core and the hangar's placeholders) a ghost and records it as owed
 * (`ShipRecord.owed`): standing or missing alike, since a part the build view planned is a missing part of the design.
 * Hangar placeholders are not owed, so the free part and the deposits only ever rebuild the ship's own design.
 *
 * RepairBanks is the rules applied to a profile (no ECS, no sockets); tests run it on bare profiles. BankSessions, below it,
 * is the bank of the pilots in play: it installs the parts that come back on the live ship and sends the `repairBank`
 * message, through a narrow BankHost that Pilots provides.
 */

import { entityExists, hasComponent, type IWorld } from 'bitecs';
import { Player, Dead, bankCap, newBank, refillBank, freeWhole, freeSpare, spendFree, spendDeposits, depositable, depositInto, bankFullIn,
  bankPay, packDefs, payCoreOutward, joinDepths, adjacency, jobTicks, fabWork, attachWork, repairBill, BANK,
  computeJoins, blueprintGeometry, countOf, removeFrom,
  type Economy, type PlayerProfile, type ShipRecord, type Bag, type Blueprint, type PlacedPart, type PackDef, type ServerRepairBankMessage, coreIndex, coreOf } from '@space-game/common';

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
    const core = coreOf(rec.blueprint.parts);
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
    const root = coreIndex(parts);
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
    const root = coreIndex(parts);
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

// ---------------------------------------------------------------------------
// The bank of pilots in play: sessions, the live ship and the `repairBank` message
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
  readonly world: IWorld;
  now(): number;
  session(conn: S['conn']): S | undefined;
  sessionOfEid(eid: number): S | undefined;
  sessions(): Iterable<S>;
  atStation(conn: S['conn']): boolean;
  toast(conn: S['conn'], text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  sendItems(conn: S['conn']): void;
  saveNow(conn: S['conn']): void;
  send(conn: S['conn'], msg: ServerRepairBankMessage): void;
  /** The pilot's ship record changed what their hangar view shows (a part the bank built in) */
  hangarChanged?(conn: S['conn']): void;
  /** Bring a part the bank just built onto the live ship, at full HP */
  installGhost(eid: number, uid: number): void;
  /** A machine of the pilot's ship is working on this part */
  isClaimed(eid: number, uid: number): boolean;
  itemName(id: string): string;
}

/**
 * The repair bank of connected pilots (contract header at the top of this file).
 */
export class BankSessions<S extends BankSession = BankSession> {
  private ticks = 0;

  constructor(readonly rules: RepairBanks, private host: BankHost<S>) {}

  /** The free part's spare (the top of it), what a field machine may use for repairs of the ship's own design */
  spare(eid: number): Bag {
    const s = this.host.sessionOfEid(eid);
    return s ? this.rules.spare(s.profile) : {};
  }

  /** Take a bill from the spare (all or nothing) */
  spendSpare(eid: number, bill: Bag): boolean {
    const s = this.host.sessionOfEid(eid);
    if (!s || !this.rules.spendSpare(s.profile, bill)) return false;
    this.changed(s);
    return true;
  }

  /** Passing a station (bridge/rebuild.ts repairStep): the deposits pay to mend a damaged part. A pilotless ship is mended free */
  repair(eid: number, part: PlacedPart, missing: number): boolean {
    const s = this.host.sessionOfEid(eid);
    if (!s) return true;
    if (!this.rules.payRepair(s.profile, part, missing)) return false;
    this.changed(s);
    return true;
  }

  /** Passing a station: the deposits pay to regrow a missing part */
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
    this.payOwedFree(s);
    this.send(s, true);
    this.host.saveNow(conn);
  }

  /** `devBank` (net/handlers/bank.ts has checked this is a dev server): fill or empty the free part, clear or grant deposits */
  dev(conn: S['conn'], action: string, items?: Bag): boolean {
    const s = this.host.session(conn);
    if (!s || s.loading) return false;
    if (!this.rules.dev(s.profile, action, items, this.host.now())) { this.host.toast(conn, 'Nothing to do', 'info'); return false; }
    s.dirty = true;
    this.payOwedFree(s);
    this.send(s, true);
    this.host.toast(conn, `Repair bank (dev): ${action}`, 'info');
    return true;
  }

  /** The free part pays the owed parts of the ship it can, core outward, building them on the live ship */
  payOwedFree(s: S): void {
    const eid = s.conn.playerId;
    const rec = s.profile.ship;
    if (!rec.owed?.length) return;
    const uids = this.rules.payFree(s.profile, rec, (uid) => this.host.isClaimed(eid, uid));
    this.install(s, uids);
  }

  /** Parts the bank has just built are installed on the live ship (if it is flying), at full HP */
  private install(s: S, uids: number[]): void {
    if (!uids.length) return;
    const eid = s.conn.playerId;
    if (this.flying(eid)) {
      for (const uid of uids) this.host.installGhost(eid, uid);
    }
    s.dirty = true;
    // (The hangar and station windows read the record, not the ship: the parts built in must leave their missing list)
    this.host.hangarChanged?.(s.conn);
    if (!s.profile.ship.owed?.length) this.host.toast(s.conn, 'Your repair bank has rebuilt your ship', 'good');
  }

  private flying(eid: number): boolean {
    return entityExists(this.host.world, eid) && hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid);
  }

  /** Once a tick: refill the free part by the clock, rebuild what is owed (free part as it refills, deposits at a fabricator's pace), send changes */
  tick(now: number): void {
    const n = ++this.ticks;
    if (n % 15 !== 0) return;
    for (const s of this.host.sessions()) {
      if (s.loading) continue;
      const p = s.profile;
      this.rules.ensure(p, now);
      const eid = s.conn.playerId;
      if (this.flying(eid) && p.ship.owed?.length) {
        this.payOwedFree(s);
        const uid = this.rules.stepDeposits(p, p.ship, 15, (u) => this.host.isClaimed(eid, u));
        if (uid !== null) { this.install(s, [uid]); s.bankDirty = true; }
      }
      this.send(s, false, now);
    }
  }

  /**
   * Tell the client its bank: at once when `force` (login, a deposit, a death), else when it changed (at most once a
   * second) or, while the free part refills, once a minute
   */
  send(s: S, force = false, now = this.host.now()): void {
    const owed = this.rules.owedUids(s.profile.ship).length;
    const msg = this.rules.view(s.profile, owed);
    const key = JSON.stringify([msg.free, msg.deposits, msg.rebuilding ?? 0]);
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
