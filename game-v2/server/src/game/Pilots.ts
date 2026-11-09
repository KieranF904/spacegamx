/**
 * @contract server.pilots
 * owns:       each connected pilot's session: login, events, progress (credits, XP, skills), and the public doors to pilots/*.ts
 * needs:      PilotHost, ShipBridge, ProfileStore, RepairBank (BankSessions), pilots/{cargo, death, persist}; npm: @space-game/common, bitecs
 * events:     PilotEvent (items, earned, level, refit, login, stat) for quests, ribbons and rankings
 * invariants: guests are never saved — none pinned
 *             a death costs what DeathRules says, the bank pays the rebuild — none pinned
 * extend:     a new item or death rule goes in pilots/; a new progress counter is a method here emitting a PilotEvent
 *
 * Pilots: each connected player's progress while they play.
 *
 * The profile (common/src/econ/profile.ts) is the source of truth for credits,
 * XP, cargo, storage, plans and the ship design; the ECS Player components
 * mirror it for the snapshot. This module loads profiles on login, applies
 * them to the player's entity, saves them (autosave, dock, logout, shutdown),
 * and handles every item action the client asks for:
 *   - cargo ↔ storage (only near a station), jettison, consumables
 *   - hangar refits, which may only use parts the pilot owns
 *   - the repair bank (RepairBank.ts): deposits, the free part, station repair from deposits
 *   - death: cargo dropped as a wreck, the ship back in the same design with the bank paying for it
 *
 * Guests get a fresh profile that is never saved.
 */

import type { Telemetry } from './Telemetry.js';
import { IWorld } from 'bitecs';
import { xpToReach, LEVEL_CAP, unlocks, levelUnlockNames, nextUnlockHint, giveSkillPoints, addStanding, Position, InSystem, Economy, PlayerProfile, ServerProfileMessage, diffProfile, StarterKit, Stack, Bag, ServerMessage, Blueprint, newProfile, migrateProfile, setActiveShip, SECURE_HOLD, hasAll, ShipRecord, SALVAGE, type PlacedPart, refundRetiredSkills, DOCK_FEE_LEVEL, dcos, dsin } from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import { cloneJson } from '@space-game/common';
import type { ProfileStore } from '../profile/ProfileStore.js';
import { RepairBanks, BankSessions } from './RepairBank.js';
import * as cargo from './pilots/cargo.js';
import * as death from './pilots/death.js';
import * as persist from './pilots/persist.js';

/** What Pilots needs to know about a connection */
export interface PilotConn {
  playerId: number;
  userId: number | null;
  username: string;
  docked: { station: number } | null;
}

export interface PilotHost {
  readonly world: IWorld;
  tick(): number;
  send(conn: PilotConn, msg: ServerMessage): void;
  /** Station entity within interaction range of this entity, or -1 */
  stationInRange(eid: number): number;
  /** Station entity by data id, or -1 */
  stationEntity(stationId: string): number;
  stationInfo(stationEid: number): { id: string; name: string; radius?: number } | null;
  systemId(systemNum: number): string | undefined;
  systemNum(systemId: string): number;
  /** Somewhere a pilot may safely appear (not in a black hole, star or PvP zone) */
  safeToAppear(systemNum: number, x: number, y: number): boolean;
  /** Move the player entity (to another system if needed), with no travel effects */
  place(conn: PilotConn, systemNum: number, x: number, y: number): void;
  /** A loot pod in space; returns its entity. `droppedBy` won't collect it again for a while. */
  spawnPod(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, droppedBy?: number): number;
  /** A pod only `key`'s pilot can take for `seconds` (a wreck); returns its entity */
  spawnWreck?(systemNum: number, x: number, y: number, vx: number, vy: number, items: Bag, key: string, seconds: number): number;
  /** In the system's safe space (inner Sol) */
  safeAt?(systemNum: number, x: number, y: number): boolean;
  /** The pilot's ship record changed what their hangar view shows (a part the bank built in): send the hangar again */
  hangarChanged?(conn: PilotConn): void;
}

/**
 * What dying costs (and what it doesn't):
 *   in safe space   the hold's kept; the wreck holds the machines' contents and all of the ship's minerals
 *   anywhere else   the hold's lost but for its secure stacks; the wreck holds it, the machines' contents and
 *                   SALVAGE of the ship's minerals, kept for its pilot for `wreckMinutes`
 * The ship comes back in the same design, paid for by the repair bank (RepairBank.ts); nothing goes to storage.
 */
export interface DeathRules {
  secureStacks: number;
  secureUnits: number;
  wreckMinutes: number;
}

export const DEFAULT_DEATH_RULES: DeathRules = { secureStacks: SECURE_HOLD.stacks, secureUnits: SECURE_HOLD.units, wreckMinutes: 15 };

export interface PilotsOptions {
  starter: StarterKit;
  /** Designs a guest finds in their hangar's free bays (the dev server's) */
  guestShips?: Blueprint[];
  /** Where every pilot appears, joining and respawning, whatever their profile says (the dev server's Rockery); none: where they left off, or home */
  spawn?: (eid: number) => { system: number; x: number; y: number };
  death?: Partial<DeathRules>;
  autosaveMs: number;
  /** Clock for autosave and craft jobs (wall time) */
  now?: () => number;
}

/** A station loan is repaid from this share of every credit earned until it's cleared */
export const LOAN_REPAY_SHARE = 0.25;

export interface Session {
  conn: PilotConn;
  profile: PlayerProfile;
  dirty: boolean;
  lastSave: number;
  atStation: boolean;
  /** The last `items` message sent, as JSON (an unchanged one is not sent again) */
  itemsKey?: string;
  /** The last full `profile` the client holds (what a `profileDelta` is cut from; an unchanged one is not sent again) */
  profileSent?: ServerProfileMessage;
  /** The last `repairBank` message sent: when (wall ms) and what (JSON) */
  bankSent?: { at: number; key: string };
  /** The bank changed since it was last sent (a station repair paid from it): sent on the next tick, at most once a second */
  bankDirty?: boolean;
  /** Their saved profile is still loading: the one in hand isn't theirs, so it's never saved */
  loading?: boolean;
  /** Where they last paid a docking fee, and when (a berth is paid once per visit) */
  dockPaid?: { station: string; at: number };
}

/** A docking fee covers re-berthing at the same station for this long */
const DOCK_FEE_WINDOW_MS = 30 * 60_000;

/** Things quests listen for */
export type PilotEvent =
  | { type: 'items'; items: Bag; source?: string }
  | { type: 'earned'; credits: number }
  | { type: 'level'; level: number }
  | { type: 'refit' }
  | { type: 'login' }
  /** A stat went up (ribbons and rankings watch these) */
  | { type: 'stat'; key: string; n: number };

export { xpToReach };

export class Pilots {
  /** @internal shared with pilots/*.ts */ sessions = new Map<PilotConn, Session>();
  /** @internal */ now: () => number;
  private listeners: ((conn: PilotConn, ev: PilotEvent) => void)[] = [];

  /** The ship you fly's ammunition loadout, and each gun's first crate (Ammo sets it) */
  loadout?: (p: PlayerProfile) => { load: Bag; first: Record<string, string> };

  /** The repair bank's rules on a profile (RepairBank.ts) */
  readonly bank: RepairBanks;
  /** The bank of the pilots in play: deposits, repairs paid from it, the message (RepairBank.ts) */
  private readonly banking: BankSessions<Session>;

  /** What the field machines (feature `machines`) tell the bank: wired by the game once they exist */
  fieldHooks: {
    /** A part (uid) of this pilot's ship that a machine is building, repairing or recycling */
    isClaimed?: (eid: number, uid: number) => boolean;
    /** Everything inside the ship's machines (job inputs, finished output), for the wreck */
    machineContents?: (eid: number) => Bag;
  } = {};

  constructor(readonly host: PilotHost, readonly econ: Economy, readonly ships: ShipBridge, readonly store: ProfileStore, readonly opts: PilotsOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.bank = new RepairBanks(econ, opts.starter.blueprint);
    this.banking = new BankSessions<Session>(this.bank, {
      world: host.world,
      now: () => this.now(),
      session: (conn) => this.sessions.get(conn),
      sessionOfEid: (eid) => { const c = this.connOf(eid); return c ? this.sessions.get(c) : undefined; },
      sessions: () => this.sessions.values(),
      atStation: (conn) => cargo.atStation(this, conn),
      toast: (conn, text, kind) => this.toast(conn, text, kind),
      sendItems: (conn) => this.sendItems(conn),
      saveNow: (conn) => this.saveNow(conn),
      send: (conn, msg) => host.send(conn, msg),
      hangarChanged: host.hangarChanged ? (conn) => host.hangarChanged!(conn) : undefined,
      installGhost: (eid, uid) => ships.installGhost(eid, uid),
      isClaimed: (eid, uid) => this.isClaimed(eid, uid),
      itemName: (id) => econ.items.get(id)?.name ?? id,
    });
  }

  onEvent(fn: (conn: PilotConn, ev: PilotEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Where deaths and first-hour milestones are written down (Telemetry.ts) */
  telemetry: Telemetry | null = null;

  /** The training yard (game/tutorial): where a pilot still in the tutorial appears (`resume`: where they left off in it, else a fresh spot by the station); none: not in it */
  tutorialSpawn?: (conn: PilotConn, resume: boolean) => { system: number; x: number; y: number } | null;

  /** One line of telemetry about this pilot; `once`: only the first time it happens to them */
  track(conn: PilotConn, ev: string, extra: Record<string, unknown> = {}, once = false): void {
    const s = this.sessions.get(conn);
    if (!s || s.loading || !this.telemetry?.enabled) return;
    const p = s.profile;
    if (once) {
      const flag = `tm:${ev}`;
      if (p.quests.flags.includes(flag)) return;
      p.quests.flags.push(flag);
      s.dirty = true;
    }
    this.telemetry.record({ ev, who: this.keyOf(conn) ?? '?', level: p.level, minutes: Math.round((this.now() - (Date.parse(p.createdAt) || this.now())) / 6000) / 10, ...extra });
  }

  /** The first-hour milestones, from the events quests listen for */
  private milestones(conn: PilotConn, ev: PilotEvent): void {
    if (ev.type === 'refit') this.track(conn, 'first_refit', { parts: this.sessions.get(conn)?.profile.ship.blueprint.parts.length }, true);
    else if (ev.type === 'level' && ev.level <= 10) this.track(conn, `level_${ev.level}`, {}, true);
    else if (ev.type === 'items' && ev.source === 'mined') this.track(conn, 'first_mine', {}, true);
    else if (ev.type === 'stat') {
      if (ev.key.startsWith('dock:')) this.track(conn, 'first_dock', { station: ev.key.slice(5) }, true);
      else if (ev.key === 'kills') this.track(conn, 'first_kill', {}, true);
      else if (ev.key === 'bosses') this.track(conn, 'first_boss', {}, true);
      else if (ev.key === 'jobs' || ev.key === 'quests') this.track(conn, 'first_job', {}, true);
    }
  }

  emit(conn: PilotConn, ev: PilotEvent): void {
    this.milestones(conn, ev);
    for (const fn of this.listeners) fn(conn, ev);
  }

  connections(): PilotConn[] {
    return [...this.sessions.keys()];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** A new connection plays as a guest until it logs in */
  attach(conn: PilotConn): void {
    const s: Session = { conn, profile: newProfile(this.opts.starter), dirty: false, lastSave: this.now(), atStation: false };
    for (const bp of this.opts.guestShips ?? []) {
      const slot = s.profile.hangar.indexOf(null);
      if (slot >= 0) s.profile.hangar[slot] = { blueprint: cloneJson(bp), hp: {}, ghosts: [] };
    }
    this.sessions.set(conn, s);
    this.bank.ensure(s.profile, this.now());
    persist.applyProfile(this, s, false);
    // (A guest's ship is where the world put it, beside Sol Central; in the tutorial that is the yard instead)
    const yard = this.tutorialSpawn?.(conn, false);
    if (yard) this.host.place(conn, yard.system, yard.x, yard.y);
    this.sendBank(s, true);
    this.emit(conn, { type: 'login' });
  }

  /** Logged in: load (or start) their saved profile and put them back where they were */
  async login(conn: PilotConn, userId: number): Promise<void> {
    let raw: unknown = null;
    const before = this.sessions.get(conn);
    // Until it's loaded, the profile in hand (a guest's) mustn't be saved over theirs
    if (before) before.loading = true;
    let failed = false;
    try {
      raw = await this.store.load(userId);
    } catch (e) {
      failed = true;
      console.error(`[Pilots] could not load profile ${userId}:`, e);
    } finally {
      if (before) before.loading = false;
    }
    const s = this.sessions.get(conn);
    if (!s || conn.userId !== userId) return; // left (or switched account) while loading
    // A save we couldn't read isn't an empty one: never start them afresh over it
    if (failed) { s.loading = true; this.toast(conn, 'Your save could not be loaded right now: progress this session will not be saved. Try reconnecting.', 'bad'); return; }
    // A save we can't make sense of is kept as it is (never saved over), like one we couldn't read
    let profile: PlayerProfile;
    try {
      // (A save below v5 takes the design update: its ships swapped for their remakes, by the account's name, or broken down)
      profile = raw
        ? migrateProfile(raw, this.opts.starter, this.econ.ships, { econ: this.econ, designUpdate: this.ships?.designUpdate, username: conn.username, tuning: this.ships?.tuning })
        : newProfile(this.opts.starter);
    } catch (e) {
      s.loading = true;
      console.error(`[Pilots] could not migrate profile ${userId}:`, e);
      this.toast(conn, 'Your save could not be loaded right now: progress this session will not be saved. Try reconnecting.', 'bad');
      return;
    }
    s.profile = profile;
    // (An upgraded save is written back at once: a migration never runs twice)
    s.dirty = !raw || (raw as { version?: unknown }).version !== profile.version;
    if (cargo.structureToMaterials(this, s.profile)) s.dirty = true;
    if (refundRetiredSkills(s.profile)) s.dirty = true;
    // The repair bank: made full at a first login, refilled to now; the free part pays for what a lost ship is owed
    if (!s.profile.bank) s.dirty = true;
    this.bank.ensure(s.profile, this.now());
    this.banking.payOwedFree(s);
    persist.applyProfile(this, s, true);
    this.sendBank(s, true);
    death.sendWreck(this, s);
    if (!raw) this.toast(conn, 'Welcome, pilot. Your Sparrow is fuelled and ready at Sol Central.', 'good');
    death.showNotices(this, s);
    this.emit(conn, { type: 'login' });
  }

  /** Disconnected: capture where they are and save */
  async detach(conn: PilotConn): Promise<void> {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.sessions.delete(conn);
    if (s.loading) return;
    persist.capture(this, s);
    await persist.save(this, s);
    this.devStash.delete(conn);
  }

  /**
   * A signed-in pilot came back to the ship they left in space (their old connection's session, kept while it lingered):
   * the session moves to the new connection as it is (nothing loaded, the ship untouched) and the client is told it all
   */
  adopt(from: PilotConn, to: PilotConn): boolean {
    const s = this.sessions.get(from);
    if (!s) return false;
    this.sessions.delete(from);
    this.sessions.delete(to);
    s.conn = to;
    s.loading = false;
    s.profileSent = undefined; s.itemsKey = undefined; s.bankSent = undefined;
    this.sessions.set(to, s);
    this.sendProfile(to);
    this.sendItems(to);
    this.sendBank(s, true);
    this.emit(to, { type: 'login' });
    return true;
  }

  /** Dev tool: pilots flying a library ship (devShip): the ship record (and slot) they really have, to be put back */
  devStash = new Map<PilotConn, { rec: ShipRecord; slot: number }>();

  /**
   * Dev tool: fly `blueprint` now (a copy, at full health, nothing spent), or with none the ship you really have.
   * What's saved is always the real ship: the borrowed one is never written to the profile.
   */
  devSwapShip(conn: PilotConn, blueprint: Blueprint | null): boolean {
    const s = this.sessions.get(conn);
    if (!s || s.loading) return false;
    persist.capture(this, s);
    const p = s.profile;
    if (blueprint) {
      if (!this.devStash.has(conn)) this.devStash.set(conn, { rec: p.ship, slot: p.activeSlot });
      setActiveShip(p, { blueprint: cloneJson(blueprint), hp: {}, ghosts: [] }, p.activeSlot);
    } else {
      const st = this.devStash.get(conn);
      if (!st) return false;
      this.devStash.delete(conn);
      setActiveShip(p, st.rec, st.slot);
    }
    persist.reapplyShip(this, conn);
    this.emitRefit(conn);
    return true;
  }

  /**
   * The account was deleted: its connections stop being saved (so a disconnect can't bring the profile back),
   * then the saved profile goes. Returns those connections, for the caller to disconnect.
   */
  async forgetAccount(userId: number): Promise<PilotConn[]> {
    const gone: PilotConn[] = [];
    for (const s of this.sessions.values()) {
      if (s.conn.userId !== userId) continue;
      s.loading = true;
      s.dirty = false;
      gone.push(s.conn);
    }
    await this.store.delete(userId);
    return gone;
  }

  /** Save every account (shutdown) */
  async saveAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((s) => !s.loading).map((s) => { persist.capture(this, s); return persist.save(this, s); }));
  }

  get(conn: PilotConn): PlayerProfile | undefined {
    return this.sessions.get(conn)?.profile;
  }

  connOf(eid: number): PilotConn | undefined {
    for (const s of this.sessions.values()) if (s.conn.playerId === eid) return s.conn;
    return undefined;
  }

  /** Once per tick: autosave, and refresh storage access as pilots come and go from stations */
  tick(): void {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const at = cargo.atStation(this, s.conn);
      if (at !== s.atStation) {
        s.atStation = at;
        if (at) this.setHome(s);
        this.sendItems(s.conn);
      }
      if (s.dirty && !s.loading && s.conn.userId !== null && now - s.lastSave > this.opts.autosaveMs) {
        persist.capture(this, s);
        void persist.save(this, s);
      }
    }
    this.banking.tick(now);
  }

  /** Save soon (after something important: a trade, a refit, a turn-in) */
  saveNow(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s || s.loading) return;
    persist.capture(this, s);
    void persist.save(this, s);
  }

  markDirty(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (s) s.dirty = true;
  }

  /** The ship's make-up changed: quests check refit and hangar steps */
  emitRefit(conn: PilotConn): void {
    this.emit(conn, { type: 'refit' });
  }

  /** A new entity for this connection (respawn): apply the profile to it */
  onRespawn(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    persist.mirror(this, s);
    persist.applyShip(this, s);
    const at = this.homePoint(s);
    if (at) this.host.place(conn, at.system, at.x, at.y);
    this.sendBank(s, true);
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------

  addCredits(conn: PilotConn, n: number): void {
    const s = this.sessions.get(conn);
    if (!s || n === 0) return;
    // A rebuild loan takes its share of what comes in
    const debt = s.profile.debt ?? 0;
    if (n > 0 && debt > 0) {
      const repay = Math.min(debt, Math.ceil(n * LOAN_REPAY_SHARE));
      n -= repay;
      s.profile.debt = debt - repay || undefined;
      if (!s.profile.debt) this.toast(conn, 'Rebuild loan repaid in full', 'good');
      this.sendProfile(conn);
    }
    s.profile.credits = Math.max(0, Math.round(s.profile.credits + n));
    s.dirty = true;
    persist.mirror(this, s);
    this.sendItems(conn);
  }

  /** Award XP; levels up (with a skill point each, to the cap) as thresholds pass */
  addXp(conn: PilotConn, n: number): void {
    const s = this.sessions.get(conn);
    if (!s || n <= 0) return;
    s.profile.xp += Math.round(n);
    const from = s.profile.level;
    let points = 0;
    const opened: string[] = [];
    while (s.profile.level < LEVEL_CAP && s.profile.xp >= xpToReach(s.profile.level + 1)) {
      s.profile.level++;
      points += giveSkillPoints(s.profile, 1);
      opened.push(...levelUnlockNames(this.econ.ships.functions.values(), s.profile.level));
    }
    // New hangar bays stand empty, ready
    while (s.profile.hangar.length < unlocks(s.profile).hangarSlots) s.profile.hangar.push(null);
    s.dirty = true;
    persist.mirror(this, s);
    this.sendProfile(conn);
    if (s.profile.level > from) {
      const level = s.profile.level;
      const next = nextUnlockHint(this.econ.ships.functions.values(), level);
      this.host.send(conn, { type: 'levelUp', playerId: conn.playerId, newLevel: level });
      this.toast(conn, `Level ${level}!${points ? ` +${points} skill point${points > 1 ? 's' : ''} (K to spend)` : ''}${opened.length ? ` · Unlocked: ${opened.join(', ')}` : ''}${next ? ` · Next: ${next}` : ''}`, 'good');
      this.host.send(conn, { type: 'systemMessage', text: `Level ${level}${opened.length ? `. Unlocked: ${opened.join(', ')}` : ''}.${next ? ` Next: ${next}.` : ''}`, color: '#86efac' });
      this.emit(conn, { type: 'level', level });
    }
  }

  bumpStat(conn: PilotConn, key: string, n = 1): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    s.profile.stats[key] = (s.profile.stats[key] ?? 0) + n;
    s.dirty = true;
    if (key === 'earned') this.emit(conn, { type: 'earned', credits: n });
    this.emit(conn, { type: 'stat', key, n });
  }

  /** Put an item on a quick bar slot (null clears it) */
  setQuickbar(conn: PilotConn, msg: { slot: number; id: string | null }): void {
    const s = this.sessions.get(conn);
    const slot = Math.floor(Number(msg.slot));
    if (!s || !(slot >= 0 && slot < s.profile.quickbar.length)) return;
    const id = typeof msg.id === 'string' && this.econ.items.has(msg.id) ? msg.id : null;
    // One slot per item: putting it somewhere else moves it
    if (id) s.profile.quickbar = s.profile.quickbar.map((q) => (q === id ? null : q));
    s.profile.quickbar[slot] = id;
    s.dirty = true;
    this.sendProfile(conn);
  }

  /** Quest rewards beyond items and money: plans, licences, standing, skill points */
  grant(conn: PilotConn, g: { plans?: string[]; recipes?: string[]; licences?: string[]; reputation?: Record<string, number>; skillPoints?: number }): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    const p = s.profile;
    for (const f of g.plans ?? []) if (!p.plans.includes(f)) p.plans.push(f);
    for (const r of g.recipes ?? []) if (!p.recipes.includes(r)) p.recipes.push(r);
    for (const l of g.licences ?? []) if (!p.licences.includes(l)) p.licences.push(l);
    for (const [f, n] of Object.entries(g.reputation ?? {})) p.reputation[f] = addStanding(p.reputation[f] ?? 0, n);
    if (g.skillPoints) giveSkillPoints(p, g.skillPoints);
    s.dirty = true;
    this.sendProfile(conn);
  }

  /** Skills changed: cargo space and the like follow */
  skillsChanged(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.ships.setSkills(conn.playerId, s.profile.skills);
    this.sendProfile(conn);
    this.sendItems(conn);
  }

  skills(conn: PilotConn): Record<string, number> {
    return this.sessions.get(conn)?.profile.skills ?? {};
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Ships: refits, rebuilds, death
  // ---------------------------------------------------------------------------

  /** Can this pilot use this ship plan in the hangar? */
  knowsPlan(conn: PilotConn, file: string): boolean {
    return !!this.sessions.get(conn)?.profile.plans.includes(file);
  }

  /**
   * An outer-ring station's docking fee (pilots of DOCK_FEE_LEVEL and up), once a
   * visit. Nobody is turned away: what they can't pay goes on their station loan.
   * Returns what was charged (0: free) and how much of it was lent.
   */
  payDockFee(conn: PilotConn, station: string, fee: number): { fee: number; lent: number } {
    const s = this.sessions.get(conn);
    if (!s || !(fee > 0) || s.profile.level < DOCK_FEE_LEVEL) return { fee: 0, lent: 0 };
    const now = this.now();
    if (s.dockPaid?.station === station && now - s.dockPaid.at < DOCK_FEE_WINDOW_MS) return { fee: 0, lent: 0 };
    s.dockPaid = { station, at: now };
    fee = Math.round(fee);
    const paid = Math.min(fee, Math.max(0, s.profile.credits));
    const lent = fee - paid;
    s.profile.credits -= paid;
    if (lent > 0) s.profile.debt = (s.profile.debt ?? 0) + lent;
    s.dirty = true;
    persist.mirror(this, s);
    this.sendItems(conn);
    if (lent > 0) this.sendProfile(conn);
    this.toast(conn, lent > 0
      ? `Docking fee ${fee} cr: you're short, so ${lent} cr goes on your station loan (you owe ${s.profile.debt} cr, repaid from ${LOAN_REPAY_SHARE * 100}% of what you earn)`
      : `Docking fee: ${fee} cr`, lent > 0 ? 'warn' : 'info');
    return { fee, lent };
  }

  // ---------------------------------------------------------------------------
  // The repair bank (RepairBank.ts holds the rules; this is the sessions, the live ship and the messages)
  // ---------------------------------------------------------------------------

  /** A machine of the pilot's ship is working on this part (uid): the bank leaves it alone */
  isClaimed(eid: number, uid: number): boolean {
    return this.fieldHooks.isClaimed?.(eid, uid) ?? false;
  }

  /** The free part's spare (the top of it), what a field machine may use for repairs of the ship's own design */
  bankSpare(eid: number): Bag { return this.banking.spare(eid); }

  /** Take a bill from the spare (all or nothing) */
  spendBankSpare(eid: number, bill: Bag): boolean { return this.banking.spendSpare(eid, bill); }

  /** Passing a station (bridge/rebuild.ts repairStep): the deposits pay to mend a damaged part. A pilotless ship is mended free */
  bankRepair(eid: number, part: PlacedPart, missing: number): boolean { return this.banking.repair(eid, part, missing); }

  /** Passing a station: the deposits pay to regrow a missing part */
  bankRebuild(eid: number, part: PlacedPart): boolean { return this.banking.rebuild(eid, part); }

  /** `bankDeposit`: items from the hold or storage into the deposits, at a station, only what a bank takes */
  bankDeposit(conn: PilotConn, items: Bag, from?: 'cargo' | 'storage'): void { this.banking.deposit(conn, items, from); }

  /** `devBank` (net/handlers/bank.ts has checked this is a dev server) */
  devBank(conn: PilotConn, action: string, items?: Bag): boolean { return this.banking.dev(conn, action, items); }

  /** Tell the client its bank (RepairBank.ts BankSessions.send) */
  sendBank(s: Session, force = false, now = this.now()): void { this.banking.send(s, force, now); }

  get death(): DeathRules {
    return { ...DEFAULT_DEATH_RULES, ...(this.opts.death ?? {}) };
  }

  /** Who a pilot is for things kept for them (wrecks): their account, or their name as a guest */
  keyOf(conn: PilotConn): string | undefined {
    if (conn.userId !== null && conn.userId !== undefined) return `u:${conn.userId}`;
    return conn.username ? `g:${conn.username}` : undefined;
  }

  private setHome(s: Session): void {
    const st = this.host.stationInRange(s.conn.playerId);
    const info = st >= 0 ? this.host.stationInfo(st) : null;
    if (info && info.id !== s.profile.home) {
      s.profile.home = info.id;
      s.dirty = true;
      this.sendProfile(s.conn);
    }
  }

  /** Where this pilot respawns: beside their home station */
  homePoint(s: Session | PilotConn): { system: number; x: number; y: number } | null {
    const sess = 'profile' in s ? s : this.sessions.get(s);
    if (!sess) return null;
    if (this.opts.spawn) return this.opts.spawn(sess.conn.playerId);
    const yard = this.tutorialSpawn?.(sess.conn, false);
    if (yard) return yard;
    const st = this.host.stationEntity(sess.profile.home) >= 0 ? this.host.stationEntity(sess.profile.home) : this.host.stationEntity(this.opts.starter.home);
    if (st < 0) {
      const p = this.opts.starter.position;
      return { system: this.host.systemNum(p.system), x: p.x, y: p.y };
    }
    const a = (sess.conn.playerId * 2.399) % (Math.PI * 2);
    // Just inside its docking ring, clear of the station itself (Sol Central's a big one)
    const r = Math.max(650, (this.host.stationInfo(st)?.radius ?? 0) * 0.85);
    return { system: InSystem.systemId[st], x: Position.x[st] + dcos(a) * r, y: Position.y[st] + dsin(a) * r };
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  sendProfile(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    const p = s.profile;
    const homeEid = this.host.stationEntity(p.home);
    const lo = this.loadout?.(p);
    const msg = {
      type: 'profile' as const, guest: conn.userId === null, credits: p.credits, xp: p.xp, level: p.level,
      xpLevel: xpToReach(p.level), xpNext: xpToReach(p.level + 1), skillPoints: p.skillPoints, skills: p.skills,
      plans: p.plans, recipes: p.recipes, licences: p.licences, home: p.home, quickbar: p.quickbar, debt: p.debt ?? 0, ammo: p.ammo?.open ?? {}, ammoPrefer: lo?.first ?? p.ammo?.prefer ?? {}, loadout: lo?.load ?? {}, outpost: p.outpost ?? null, now: this.now(), homeName: (homeEid >= 0 ? this.host.stationInfo(homeEid)?.name : undefined) ?? p.home,
    };
    // (A full state, and its clock only seeds the client's skew: a copy of what they hold is not sent again; mining and
    // ammo used to resend it every second or so)
    // The first goes whole; after that only the fields that changed (XP and credits are most of them)
    const prev = s.profileSent;
    const sent = cloneJson(msg) as ServerProfileMessage;
    s.profileSent = sent;
    if (!prev) { this.host.send(conn, msg); return; }
    const delta = diffProfile(prev, sent);
    if (delta) this.host.send(conn, delta);
  }

  sendItems(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    const msg = {
      type: 'items' as const, cargo: s.profile.cargo, storage: s.profile.storage, cargoCapacity: cargo.cargoCapacity(this, conn),
      credits: s.profile.credits, atStation: cargo.atStation(this, conn),
    };
    // (A full state: a copy of what they already hold changes nothing for them)
    const key = JSON.stringify(msg);
    if (s.itemsKey === key) return;
    s.itemsKey = key;
    this.host.send(conn, msg);
  }

  toast(conn: PilotConn, text: string, kind: 'info' | 'good' | 'warn' | 'bad' = 'info'): void {
    this.host.send(conn, { type: 'toast', text, kind });
  }

  // ---------------------------------------------------------------------------
  // The rules live in pilots/{cargo,death,persist}.ts; these are the public doors
  // ---------------------------------------------------------------------------

  cargoCapacity(conn: PilotConn): number { return cargo.cargoCapacity(this, conn); }
  cargoUsed(profile: PlayerProfile): number { return cargo.cargoUsed(this, profile); }
  cargoMass(eid: number): number { return cargo.cargoMass(this, eid); }
  cargoFree(conn: PilotConn): number { return cargo.cargoFree(this, conn); }
  atStation(conn: PilotConn): boolean { return cargo.atStation(this, conn); }
  give(conn: PilotConn, items: Bag, opts: { toStorage?: boolean; source?: string; at?: { x: number; y: number }; quiet?: boolean } = {}): Bag { return cargo.give(this, conn, items, opts); }
  take(conn: PilotConn, need: Bag, from: 'cargo' | 'storage' | 'any' = 'any'): boolean { return cargo.take(this, conn, need, from); }
  removeEverywhere(conn: PilotConn, id: string): number { return cargo.removeEverywhere(this, conn, id); }
  available(conn: PilotConn, id: string): number { return cargo.available(this, conn, id); }
  handleMove(conn: PilotConn, msg: { id: string; n: number; to: 'cargo' | 'storage' }): void { return cargo.handleMove(this, conn, msg); }
  handleStore(conn: PilotConn, what: unknown): void { return cargo.handleStore(this, conn, what); }
  handleJettison(conn: PilotConn, msg: { id: string; n: number }): void { return cargo.handleJettison(this, conn, msg); }
  handleUse(conn: PilotConn, msg: { id: string }): void { return cargo.handleUse(this, conn, msg); }
  scrapItem(conn: PilotConn, id: string, n: number): void { return cargo.scrapItem(this, conn, id, n); }
  onDestroyed(conn: PilotConn, systemNum: number, x: number, y: number, vx: number, vy: number, cause: Record<string, unknown> = {}): void { return death.onDestroyed(this, conn, systemNum, x, y, vx, vy, cause); }
  wreckRecovered(key: string): void { return death.wreckRecovered(this, key); }
  reapplyShip(conn: PilotConn): void { return persist.reapplyShip(this, conn); }
  captureNow(conn: PilotConn): void { return persist.captureNow(this, conn); }
  /** What would be written to disk for this pilot (pilots/persist.ts) */
  persistable(conn: PilotConn, p: PlayerProfile): PlayerProfile { return persist.persistable(this, conn, p); }
}

export type { Stack };
export { hasAll };
