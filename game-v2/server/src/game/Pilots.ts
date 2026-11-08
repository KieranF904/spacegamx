/**
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
import { hasComponent, entityExists, IWorld } from 'bitecs';
import {
  xpToReach, LEVEL_CAP, FULL_CHARGE, unlocks, levelUnlockNames, nextUnlockHint, giveSkillPoints, addStanding,
  Player, Position, Velocity, Rotation, Health, InSystem, Dead, Boost,
  Economy, PlayerProfile, ServerProfileMessage, diffProfile, StarterKit, Stack, Bag, ServerMessage, Blueprint,
  newProfile, migrateProfile, setActiveShip, holdClass, sweeps, STORE_SWEEPS, type StoreSweep, secureHold, SECURE_HOLD, countOf, addTo, removeFrom, hasAll, removeAll, partItemId, buyPrice,
  BOOST_FUEL_DEFAULT, ShipRecord, SALVAGE, skillValue, type PlacedPart, refundRetiredSkills, salvageOf, salvageParts, isStructuralItem, parsePartItemId, licenceName, DOCK_FEE_LEVEL, dcos, dsin,
} from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { ProfileStore } from '../profile/ProfileStore.js';
import { RepairBanks } from './RepairBank.js';

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

interface Session {
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
  private sessions = new Map<PilotConn, Session>();
  private now: () => number;
  private listeners: ((conn: PilotConn, ev: PilotEvent) => void)[] = [];

  /** The ship you fly's ammunition loadout, and each gun's first crate (Ammo sets it) */
  loadout?: (p: PlayerProfile) => { load: Bag; first: Record<string, string> };

  /** The repair bank's rules on a profile (RepairBank.ts) */
  readonly bank: RepairBanks;

  /** What the field machines (feature `machines`) tell the bank: wired by the game once they exist */
  fieldHooks: {
    /** A part (uid) of this pilot's ship that a machine is building, repairing or recycling */
    isClaimed?: (eid: number, uid: number) => boolean;
    /** Everything inside the ship's machines (job inputs, finished output), for the wreck */
    machineContents?: (eid: number) => Bag;
  } = {};

  constructor(private host: PilotHost, readonly econ: Economy, private ships: ShipBridge, private store: ProfileStore, private opts: PilotsOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.bank = new RepairBanks(econ, opts.starter.blueprint);
  }

  onEvent(fn: (conn: PilotConn, ev: PilotEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Where deaths and first-hour milestones are written down (Telemetry.ts) */
  telemetry: Telemetry | null = null;

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

  private emit(conn: PilotConn, ev: PilotEvent): void {
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
      if (slot >= 0) s.profile.hangar[slot] = { blueprint: JSON.parse(JSON.stringify(bp)), hp: {}, ghosts: [] };
    }
    this.sessions.set(conn, s);
    this.bank.ensure(s.profile, this.now());
    this.applyProfile(s, false);
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
    if (this.structureToMaterials(s.profile)) s.dirty = true;
    if (refundRetiredSkills(s.profile)) s.dirty = true;
    // The repair bank: made full at a first login, refilled to now; the free part pays for what a lost ship is owed
    if (!s.profile.bank) s.dirty = true;
    this.bank.ensure(s.profile, this.now());
    this.payOwedFree(s);
    this.applyProfile(s, true);
    this.sendBank(s, true);
    this.sendWreck(s);
    if (!raw) this.toast(conn, 'Welcome, pilot. Your Sparrow is fuelled and ready at Sol Central.', 'good');
    this.showNotices(s);
    this.emit(conn, { type: 'login' });
  }

  /** Disconnected: capture where they are and save */
  async detach(conn: PilotConn): Promise<void> {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.sessions.delete(conn);
    if (s.loading) return;
    this.capture(s);
    await this.save(s);
    this.devStash.delete(conn);
  }

  /** Dev tool: pilots flying a library ship (devShip): the ship record (and slot) they really have, to be put back */
  private devStash = new Map<PilotConn, { rec: ShipRecord; slot: number }>();

  /**
   * Dev tool: fly `blueprint` now (a copy, at full health, nothing spent), or with none the ship you really have.
   * What's saved is always the real ship: the borrowed one is never written to the profile.
   */
  devSwapShip(conn: PilotConn, blueprint: Blueprint | null): boolean {
    const s = this.sessions.get(conn);
    if (!s || s.loading) return false;
    this.capture(s);
    const p = s.profile;
    if (blueprint) {
      if (!this.devStash.has(conn)) this.devStash.set(conn, { rec: p.ship, slot: p.activeSlot });
      setActiveShip(p, { blueprint: JSON.parse(JSON.stringify(blueprint)), hp: {}, ghosts: [] }, p.activeSlot);
    } else {
      const st = this.devStash.get(conn);
      if (!st) return false;
      this.devStash.delete(conn);
      setActiveShip(p, st.rec, st.slot);
    }
    this.reapplyShip(conn);
    this.emitRefit(conn);
    return true;
  }

  /** What's written to disk: their profile, with the real ship back if a library ship's borrowed (devSwapShip) */
  private persistable(conn: PilotConn, p: PlayerProfile): PlayerProfile {
    const st = this.devStash.get(conn);
    if (!st) return p;
    const hangar = p.hangar.map((r, i) => (i === st.slot ? st.rec : r));
    return { ...p, ship: st.rec, hangar, activeSlot: st.slot };
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
    await Promise.all([...this.sessions.values()].filter((s) => !s.loading).map((s) => { this.capture(s); return this.save(s); }));
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
      const at = this.atStation(s.conn);
      if (at !== s.atStation) {
        s.atStation = at;
        if (at) this.setHome(s);
        this.sendItems(s.conn);
      }
      if (s.dirty && !s.loading && s.conn.userId !== null && now - s.lastSave > this.opts.autosaveMs) {
        this.capture(s);
        void this.save(s);
      }
    }
    this.bankTick(now);
  }

  private async save(s: Session): Promise<void> {
    s.lastSave = this.now();
    if (s.conn.userId === null) return;
    s.dirty = false;
    s.profile.updatedAt = new Date(this.now()).toISOString();
    try {
      await this.store.save(s.conn.userId, this.persistable(s.conn, s.profile));
    } catch (e) {
      s.dirty = true;
      console.error(`[Pilots] save failed for ${s.conn.userId}:`, e);
    }
  }

  /** Save soon (after something important: a trade, a refit, a turn-in) */
  saveNow(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s || s.loading) return;
    this.capture(s);
    void this.save(s);
  }

  markDirty(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (s) s.dirty = true;
  }

  /** Copy live state (ship HP, position) into the profile */
  private capture(s: Session): void {
    const eid = s.conn.playerId;
    if (!entityExists(this.host.world, eid) || !hasComponent(this.host.world, Player, eid) || hasComponent(this.host.world, Dead, eid)) return;
    const ship = this.ships.get(eid);
    if (ship && ship.kind === 'ship' && ship.derived.root >= 0) {
      const hp: Record<number, number> = {};
      ship.blueprint.parts.forEach((p, i) => {
        if (this.ships.isGhost(eid, i)) return; // not built yet: the record's ghost list says so
        const f = ship.detached[i] ? 0 : ship.hp[i] / ship.maxHp[i];
        if (f < 0.999) hp[p.uid] = Math.max(0, Math.round(f * 1000) / 1000);
      });
      // Same record object as the hangar slot: update it in place
      s.profile.ship.blueprint = ship.blueprint;
      s.profile.ship.hp = hp;
      // The ghosts as the live ship has them (a part built or planned since, by a machine or the bank), the record's order kept
      const live = new Set<number>();
      ship.blueprint.parts.forEach((p, i) => { if (this.ships.isGhost(eid, i)) live.add(p.uid); });
      const rec = s.profile.ship;
      const known = (rec.ghosts ?? []).filter((u) => live.has(u));
      const seen = new Set(known);
      rec.ghosts = [...known, ...ship.blueprint.parts.filter((p) => live.has(p.uid) && !seen.has(p.uid)).map((p) => p.uid)];
      if (rec.owed) { rec.owed = rec.owed.filter((u) => live.has(u)); if (!rec.owed.length) delete rec.owed; }
    }
    const system = this.host.systemId(InSystem.systemId[eid]);
    if (system) s.profile.position = { system, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]) };
  }

  /** Put the profile into the world: stats, ship, position */
  private applyProfile(s: Session, placeShip: boolean): void {
    const { conn, profile } = s;
    const eid = conn.playerId;
    this.mirror(s);
    this.ships.setSkills(eid, profile.skills);
    if (placeShip && hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid)) {
      this.applyShip(s);
      const sys = this.host.systemNum(profile.position.system);
      if (!this.opts.spawn && sys >= 0 && this.host.safeToAppear(sys, profile.position.x, profile.position.y)) {
        this.host.place(conn, sys, profile.position.x, profile.position.y);
      } else {
        const at = this.homePoint(s);
        if (at) this.host.place(conn, at.system, at.x, at.y);
      }
    }
    this.sendProfile(conn);
    this.sendItems(conn);
  }

  /** The profile's ship onto the entity (design, then saved HP, then parts not built yet) */
  private applyShip(s: Session): void {
    const eid = s.conn.playerId;
    const bp = s.profile.ship.blueprint;
    // (a borrowed dev ship flies as it is: an enemy's design needn't pass a pilot's rules. A saved ship needn't keep
    // weapons' mounting rules made since it was fitted: it flies, its hangar flagging what to fix)
    if (!this.devStash.has(s.conn) && !this.ships.validate(bp, { mounting: false }).ok) {
      setActiveShip(s.profile, { blueprint: JSON.parse(JSON.stringify(this.opts.starter.blueprint)), hp: {}, ghosts: [], plan: this.opts.starter.planFile });
    }
    const rec = s.profile.ship;
    // (The core always comes back, free)
    const core = rec.blueprint.parts.find((q) => q.fn === 'core');
    if (core && rec.ghosts?.includes(core.uid)) rec.ghosts = rec.ghosts.filter((u) => u !== core.uid);
    const ghosts = new Set(rec.ghosts ?? []);
    this.ships.respawnInPlace(eid, rec.blueprint);
    this.ships.setPartHp(eid, (uid) => (ghosts.has(uid) ? 0 : rec.hp[uid] ?? 1));
    if (ghosts.size) this.ships.setGhosts(eid, [...ghosts]);
  }

  /** The ship record changed (hangar): put it on the entity again */
  reapplyShip(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.applyShip(s);
    this.mirror(s);
    // Its guns may take other crates now
    this.sendProfile(conn);
  }

  /** Copy the live ship into its record now (before swapping ships) */
  captureNow(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (s) this.capture(s);
  }

  /** The ship's make-up changed: quests check refit and hangar steps */
  emitRefit(conn: PilotConn): void {
    this.emit(conn, { type: 'refit' });
  }

  /** ECS mirrors of the profile (the snapshot and HUD read these) */
  private mirror(s: Session): void {
    const eid = s.conn.playerId;
    if (!hasComponent(this.host.world, Player, eid)) return;
    Player.credits[eid] = s.profile.credits;
    Player.xp[eid] = s.profile.xp;
    Player.level[eid] = s.profile.level;
  }

  /** A new entity for this connection (respawn): apply the profile to it */
  onRespawn(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.mirror(s);
    this.applyShip(s);
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
    this.mirror(s);
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
    this.mirror(s);
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

  cargoCapacity(conn: PilotConn): number {
    const nav = this.sessions.get(conn)?.profile.skills.navigation ?? 0;
    return Math.floor((this.ships.get(conn.playerId)?.derived.cargoCapacity ?? 0) * (1 + skillValue('navigation', nav)));
  }

  cargoUsed(profile: PlayerProfile): number {
    return profile.cargo.reduce((t, s) => t + s.n * this.econ.items.volume(s.id), 0);
  }

  /** Mass of what's in a pilot's hold (common/src/ships/load.ts: a full hold flies heavy); storage weighs nothing */
  cargoMass(eid: number): number {
    const conn = this.connOf(eid);
    const s = conn && this.sessions.get(conn);
    return s ? this.econ.items.massOf(s.profile.cargo) : 0;
  }

  /** Room left in cargo, in volume units */
  cargoFree(conn: PilotConn): number {
    const s = this.sessions.get(conn);
    return s ? Math.max(0, this.cargoCapacity(conn) - this.cargoUsed(s.profile)) : 0;
  }

  /** Near enough a station to reach storage */
  atStation(conn: PilotConn): boolean {
    const eid = conn.playerId;
    if (!hasComponent(this.host.world, Player, eid) || hasComponent(this.host.world, Dead, eid)) return false;
    return conn.docked !== null || this.host.stationInRange(eid) >= 0;
  }

  /**
   * Put items in cargo as far as there's room. Returns what didn't fit.
   * `toStorage` sends them straight to storage instead (quest rewards, crafting).
   */
  give(conn: PilotConn, items: Bag, opts: { toStorage?: boolean; source?: string; at?: { x: number; y: number }; quiet?: boolean } = {}): Bag {
    const s = this.sessions.get(conn);
    if (!s) return items;
    // Structure is never kept as items: it arrives as what it's made of
    if (Object.keys(items).some(isStructuralItem)) {
      const flat: Bag = {};
      for (const [id, n] of Object.entries(items)) {
        const part = isStructuralItem(id) ? parsePartItemId(id) : null;
        if (part) for (const [m, k] of Object.entries(this.econ.recipes.partInputs(part))) flat[m] = (flat[m] ?? 0) + k * n;
        else flat[id] = (flat[id] ?? 0) + n;
      }
      items = flat;
    }
    const left: Bag = {};
    const got: Bag = {};
    let free = opts.toStorage ? Infinity : this.cargoFree(conn);
    for (const [id, n] of Object.entries(items)) {
      if (!this.econ.items.has(id) || n <= 0) continue;
      const vol = this.econ.items.volume(id);
      const fit = opts.toStorage ? n : Math.min(n, Math.floor(free / vol + 1e-9));
      if (fit > 0) {
        addTo(opts.toStorage ? s.profile.storage : s.profile.cargo, id, fit);
        got[id] = fit;
        free -= fit * vol;
      }
      if (fit < n) left[id] = n - fit;
    }
    if (Object.keys(got).length) {
      s.dirty = true;
      this.sendItems(conn);
      if (!opts.quiet) this.host.send(conn, { type: 'gained', items: got, source: opts.source, x: opts.at?.x, y: opts.at?.y });
      this.emit(conn, { type: 'items', items: got, source: opts.source });
      if (opts.source === 'mined') {
        this.bumpStat(conn, 'mined', Object.values(got).reduce((t, k) => t + k, 0));
        for (const [id, k] of Object.entries(got)) this.bumpStat(conn, `mined:${id}`, k);
      }
    }
    return left;
  }

  /** Take items from cargo then storage (storage only at a station); false (taking nothing) if short */
  take(conn: PilotConn, need: Bag, from: 'cargo' | 'storage' | 'any' = 'any'): boolean {
    const s = this.sessions.get(conn);
    if (!s) return false;
    const useStorage = from === 'storage' || (from === 'any' && this.atStation(conn));
    const useCargo = from !== 'storage';
    const have = (id: string) => (useCargo ? countOf(s.profile.cargo, id) : 0) + (useStorage ? countOf(s.profile.storage, id) : 0);
    if (!Object.entries(need).every(([id, n]) => have(id) >= n)) return false;
    for (const [id, n] of Object.entries(need)) {
      const fromStore = useStorage ? removeFrom(s.profile.storage, id, n) : 0;
      if (fromStore < n && useCargo) removeFrom(s.profile.cargo, id, n - fromStore);
    }
    s.dirty = true;
    this.sendItems(conn);
    return true;
  }

  /** Take every one of an item, wherever it is (a job's own items, when it's abandoned) */
  removeEverywhere(conn: PilotConn, id: string): number {
    const s = this.sessions.get(conn);
    if (!s) return 0;
    const n = removeFrom(s.profile.cargo, id, countOf(s.profile.cargo, id)) + removeFrom(s.profile.storage, id, countOf(s.profile.storage, id));
    if (n > 0) { s.dirty = true; this.sendItems(conn); }
    return n;
  }

  /** How many of an item the pilot can use right now (cargo, plus storage at a station) */
  available(conn: PilotConn, id: string): number {
    const s = this.sessions.get(conn);
    if (!s) return 0;
    return countOf(s.profile.cargo, id) + (this.atStation(conn) ? countOf(s.profile.storage, id) : 0);
  }

  handleMove(conn: PilotConn, msg: { id: string; n: number; to: 'cargo' | 'storage' }): void {
    const s = this.sessions.get(conn);
    if (!s || typeof msg.id !== 'string' || !Number.isFinite(msg.n)) return;
    if (!this.atStation(conn)) return this.toast(conn, 'Storage is only reachable at a station', 'warn');
    const from = msg.to === 'cargo' ? s.profile.storage : s.profile.cargo;
    const to = msg.to === 'cargo' ? s.profile.cargo : s.profile.storage;
    let n = Math.min(Math.max(1, Math.floor(msg.n)), countOf(from, msg.id));
    if (msg.to === 'cargo') n = Math.min(n, Math.floor(this.cargoFree(conn) / this.econ.items.volume(msg.id) + 1e-9));
    if (n <= 0) return this.toast(conn, msg.to === 'cargo' ? 'Cargo hold is full' : 'Nothing to move', 'warn');
    removeFrom(from, msg.id, n);
    addTo(to, msg.id, n);
    s.dirty = true;
    this.sendItems(conn);
  }

  /**
   * A quick storage control (at a station): every stack in the hold of the
   * kinds it sweeps (common econ/loadout.ts). Only 'all' takes ammunition,
   * the loadout's crates, utility (consumables, the quick bar) and job items.
   */
  handleStore(conn: PilotConn, what: unknown): void {
    const s = this.sessions.get(conn);
    if (!s || !STORE_SWEEPS.includes(what as StoreSweep)) return;
    if (!this.atStation(conn)) return this.toast(conn, 'Storage is only reachable at a station', 'warn');
    const p = s.profile;
    const ctx = { loadout: this.loadout?.(p).load, quickbar: p.quickbar };
    let n = 0;
    for (const st of [...p.cargo]) {
      if (!sweeps(what as StoreSweep, holdClass(st.id, this.econ.items.get(st.id), ctx))) continue;
      const k = removeFrom(p.cargo, st.id, st.n);
      addTo(p.storage, st.id, k);
      n += k;
    }
    if (!n) return this.toast(conn, 'Nothing in the hold of that kind', 'info');
    s.dirty = true;
    this.sendItems(conn);
  }

  handleJettison(conn: PilotConn, msg: { id: string; n: number }): void {
    const s = this.sessions.get(conn);
    const eid = conn.playerId;
    if (!s || typeof msg.id !== 'string' || !hasComponent(this.host.world, Player, eid) || hasComponent(this.host.world, Dead, eid)) return;
    const want = Math.floor(Number(msg.n));
    const n = removeFrom(s.profile.cargo, msg.id, Number.isFinite(want) && want >= 1 ? want : 1);
    if (n <= 0) return;
    const a = Rotation.angle[eid] + Math.PI;
    const r = (this.ships.get(eid)?.derived.radius ?? 40) + 40;
    this.host.spawnPod(InSystem.systemId[eid], Position.x[eid] + dcos(a) * r, Position.y[eid] + dsin(a) * r,
      Velocity.x[eid] + dcos(a) * 1.5, Velocity.y[eid] + dsin(a) * 1.5, { [msg.id]: n }, eid);
    s.dirty = true;
    this.sendItems(conn);
  }

  /** Consumables */
  handleUse(conn: PilotConn, msg: { id: string }): void {
    const s = this.sessions.get(conn);
    const eid = conn.playerId;
    if (!s || typeof msg.id !== 'string') return;
    const def = this.econ.items.get(msg.id);
    if (!def || this.available(conn, msg.id) <= 0) return;
    const alive = hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid);
    if (!alive) return;
    switch (msg.id) {
      case 'scanner_charge':
        this.take(conn, { scanner_charge: 1 });
        this.host.send(conn, { type: 'scanPulse', seconds: 30 });
        return;
      case 'boost_cell':
        // Tops up every battery (energy.ts)
        if (Boost.fuel[eid] >= 99.5) return this.toast(conn, 'Your batteries are full', 'info');
        this.take(conn, { boost_cell: 1 });
        this.ships.setCharge(eid, FULL_CHARGE);
        return;
      default:
        this.toast(conn, `${def.name} can't be used like that`, 'info');
    }
  }

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
    this.mirror(s);
    this.sendItems(conn);
    if (lent > 0) this.sendProfile(conn);
    this.toast(conn, lent > 0
      ? `Docking fee ${fee} cr: you're short, so ${lent} cr goes on your station loan (you owe ${s.profile.debt} cr, repaid from ${LOAN_REPAY_SHARE * 100}% of what you earn)`
      : `Docking fee: ${fee} cr`, lent > 0 ? 'warn' : 'info');
    return { fee, lent };
  }

  /**
   * The pilot's ship was destroyed. Their cargo drops where they died, in a wreck kept for them, with what was inside the
   * ship's machines and SALVAGE of its minerals (all of them in safe space); nothing goes to storage. There is no loaner
   * and no insurance: they respawn at home in the same design, the core free, and the repair bank pays for the rest
   * (RepairBank.ts respawn): the free part at once, core outward, then the deposits over time. An empty bank means a bare core.
   */
  onDestroyed(conn: PilotConn, systemNum: number, x: number, y: number, vx: number, vy: number, cause: Record<string, unknown> = {}): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    const p = s.profile;
    // A borrowed library ship (dev: devSwapShip) lost: nothing salvaged, no wreck, your own ship back as it was
    const borrowed = this.devStash.get(conn);
    if (borrowed) {
      this.devStash.delete(conn);
      setActiveShip(p, borrowed.rec, borrowed.slot);
      this.toast(conn, 'The borrowed ship was destroyed (dev): you respawn in your own', 'info');
      s.dirty = true;
      return;
    }
    const D = this.death;
    const safe = !!this.host.safeAt?.(systemNum, x, y);
    this.track(conn, 'death', { system: this.host.systemId(systemNum), x: Math.round(x), y: Math.round(y), safe, ship: p.ship.blueprint.name, parts: p.ship.blueprint.parts.length, cargo: p.cargo.reduce((n, st) => n + st.n, 0), deaths: (p.stats.deaths ?? 0) + 1, ...cause });
    // The hold: kept whole in safe space; elsewhere its secure stacks stay (its most valuable few), the rest goes with the wreck
    const cargo: Bag = {};
    if (!safe) {
      const secure = secureHold(p.cargo, (id) => this.econ.items.get(id)?.value ?? 0, D.secureStacks, D.secureUnits);
      const kept: typeof p.cargo = [];
      for (const st of p.cargo) {
        const k = secure.get(st) ?? 0;
        if (k > 0) kept.push({ ...st, n: k });
        if (st.n - k > 0) cargo[st.id] = (cargo[st.id] ?? 0) + st.n - k;
      }
      p.cargo = kept;
    }
    const rec = p.ship;
    const standing = new Set(rec.ghosts ?? []);
    const built = rec.blueprint.parts.filter((q) => !standing.has(q.uid));
    // The wreck also holds the machines' contents (or what was saved of them) and the built parts' minerals
    const inMachines = this.fieldHooks.machineContents?.(conn.playerId) ?? rec.field?.held ?? {};
    for (const [id, n] of Object.entries(inMachines)) if (n > 0) cargo[id] = (cargo[id] ?? 0) + n;
    for (const [id, n] of Object.entries(salvageParts(this.econ, built, safe ? 1 : SALVAGE))) cargo[id] = (cargo[id] ?? 0) + n;
    // (Nothing is inside the machines now, and a recycling queue means nothing on a ship that is all ghosts)
    if (rec.field) { delete rec.field.held; delete rec.field.recycle; if (!Object.keys(rec.field).length) delete rec.field; }
    // Back in the same design: the core free, the free part pays core outward, the rest is owed
    this.bank.ensure(p, this.now());
    const back = this.bank.respawn(p, rec, (uid) => this.isClaimed(conn.playerId, uid));
    const deposits = Object.keys(p.bank?.deposits ?? {}).length > 0;
    let note = `Your ${rec.blueprint.name} was destroyed. ` + (back.owed <= 0
      ? 'Your repair bank rebuilt all of it'
      : back.paid > 0
        ? `Your repair bank rebuilt ${back.paid} part${back.paid > 1 ? 's' : ''}; ${back.owed} more come back ${deposits ? 'from your deposits and ' : ''}as the bank refills`
        : `You are back as a bare core: ${back.owed} part${back.owed > 1 ? 's' : ''} come back ${deposits ? 'from your deposits and ' : ''}as your repair bank refills`);
    // The wreck: kept for its pilot a while, marked on their map
    const sysId = this.host.systemId(systemNum);
    const key = this.keyOf(conn);
    if (Object.keys(cargo).length) {
      const kept = !!(this.host.spawnWreck && key && sysId);
      const eid = kept ? this.host.spawnWreck!(systemNum, x, y, vx * 0.3, vy * 0.3, cargo, key!, D.wreckMinutes * 60) : this.host.spawnPod(systemNum, x, y, vx * 0.5, vy * 0.5, cargo);
      if (kept && eid >= 0) {
        p.wreck = { system: sysId!, x: Math.round(x), y: Math.round(y), until: this.now() + D.wreckMinutes * 60_000 };
        note += `. Your wreck holds your cargo and the rest of its materials: it's marked on your map and kept for you for ${D.wreckMinutes} minutes`;
      }
    }
    if (!safe && p.cargo.length) note += `. Your secure hold kept ${p.cargo.length} stack${p.cargo.length > 1 ? 's' : ''}`;
    this.toast(conn, note, 'warn');
    p.stats.deaths = (p.stats.deaths ?? 0) + 1;
    s.dirty = true;
    this.sendItems(conn);
    this.sendWreck(s);
    this.sendBank(s, true);
    void this.save(s);
  }

  // ---------------------------------------------------------------------------
  // The repair bank (RepairBank.ts holds the rules; this is the sessions, the live ship and the messages)
  // ---------------------------------------------------------------------------

  /** A machine of the pilot's ship is working on this part (uid): the bank leaves it alone */
  isClaimed(eid: number, uid: number): boolean {
    return this.fieldHooks.isClaimed?.(eid, uid) ?? false;
  }

  /** The free part's spare (the top of it), what a field machine may use for repairs of the ship's own design */
  bankSpare(eid: number): Bag {
    const conn = this.connOf(eid);
    const s = conn && this.sessions.get(conn);
    return s ? this.bank.spare(s.profile) : {};
  }

  /** Take a bill from the spare (all or nothing) */
  spendBankSpare(eid: number, bill: Bag): boolean {
    const conn = this.connOf(eid);
    const s = conn && this.sessions.get(conn);
    if (!s || !this.bank.spendSpare(s.profile, bill)) return false;
    this.bankChanged(s);
    return true;
  }

  /** Passing a station (bridge/rebuild.ts repairStep): the deposits pay to mend a damaged part. A pilotless ship is mended free */
  bankRepair(eid: number, part: PlacedPart, missing: number): boolean {
    const conn = this.connOf(eid);
    const s = conn && this.sessions.get(conn);
    if (!s) return true;
    if (!this.bank.payRepair(s.profile, part, missing)) return false;
    this.bankChanged(s);
    return true;
  }

  /** Passing a station: the deposits pay to regrow a missing part */
  bankRebuild(eid: number, part: PlacedPart): boolean {
    const conn = this.connOf(eid);
    const s = conn && this.sessions.get(conn);
    if (!s) return true;
    if (!this.bank.payRebuild(s.profile, part)) return false;
    this.bankChanged(s);
    return true;
  }

  /** The bank changed in passing (a repair paid): saved with the profile, sent within a second */
  private bankChanged(s: Session): void {
    s.dirty = true;
    s.bankDirty = true;
  }

  /** `bankDeposit`: items from the hold or storage into the deposits, at a station, only what a bank takes */
  bankDeposit(conn: PilotConn, items: Bag, from?: 'cargo' | 'storage'): void {
    const s = this.sessions.get(conn);
    if (!s || s.loading || !items || typeof items !== 'object') return;
    if (!this.atStation(conn)) return this.toast(conn, 'Put things in your repair bank at a station', 'warn');
    const asked: Bag = {};
    for (const [id, n] of Object.entries(items).slice(0, 64)) if (typeof id === 'string' && Number.isFinite(Number(n)) && Number(n) >= 1) asked[id] = Math.floor(Number(n));
    this.bank.ensure(s.profile, this.now());
    const moved: Bag = {}, refused = new Set<string>();
    for (const where of from ? [from] : (['cargo', 'storage'] as const)) {
      const want: Bag = {};
      for (const [id, n] of Object.entries(asked)) { const left = n - (moved[id] ?? 0); if (left > 0) want[id] = left; }
      const r = this.bank.deposit(s.profile, want, where);
      for (const [id, n] of Object.entries(r.moved)) moved[id] = (moved[id] ?? 0) + n;
      for (const id of r.refused) refused.add(id);
    }
    const total = Object.values(moved).reduce((a, n) => a + n, 0);
    if (refused.size) this.toast(conn, `${[...refused].map((id) => this.econ.items.get(id)?.name ?? id).join(', ')} can't go in the repair bank: it takes packs, refined materials and components`, 'warn');
    if (!total) { if (!refused.size) this.toast(conn, 'Nothing to put in the repair bank', 'info'); return; }
    s.dirty = true;
    this.toast(conn, `Put ${total} item${total > 1 ? 's' : ''} in your repair bank`, 'good');
    this.sendItems(conn);
    this.payOwedFree(s);
    this.sendBank(s, true);
    this.saveNow(conn);
  }

  /** `devBank` (net/handlers/bank.ts has checked this is a dev server): fill or empty the free part, clear or grant deposits */
  devBank(conn: PilotConn, action: string, items?: Bag): boolean {
    const s = this.sessions.get(conn);
    if (!s || s.loading) return false;
    if (!this.bank.dev(s.profile, action, items, this.now())) { this.toast(conn, 'Nothing to do', 'info'); return false; }
    s.dirty = true;
    this.payOwedFree(s);
    this.sendBank(s, true);
    this.toast(conn, `Repair bank (dev): ${action}`, 'info');
    return true;
  }

  /** The free part pays the owed parts of the ship it can, core outward, building them on the live ship */
  private payOwedFree(s: Session): void {
    const eid = s.conn.playerId;
    const rec = s.profile.ship;
    if (!rec.owed?.length) return;
    const uids = this.bank.payFree(s.profile, rec, (uid) => this.isClaimed(eid, uid));
    this.installOwed(s, uids);
  }

  /** Parts the bank has just built are installed on the live ship (if it is flying), at full HP */
  private installOwed(s: Session, uids: number[]): void {
    if (!uids.length) return;
    const eid = s.conn.playerId;
    if (entityExists(this.host.world, eid) && hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid)) {
      for (const uid of uids) this.ships.installGhost(eid, uid);
    }
    s.dirty = true;
    // (The hangar and station windows read the record, not the ship: the parts built in must leave their missing list)
    this.host.hangarChanged?.(s.conn);
    if (!s.profile.ship.owed?.length) this.toast(s.conn, 'Your repair bank has rebuilt your ship', 'good');
  }

  /** Once a tick: refill the free part by the clock, rebuild what is owed (free part as it refills, deposits at a fabricator's pace), send changes */
  private bankTick(now: number): void {
    const n = ++this.bankTicks;
    if (n % 15 !== 0) return;
    for (const s of this.sessions.values()) {
      if (s.loading) continue;
      const p = s.profile;
      this.bank.ensure(p, now);
      const eid = s.conn.playerId;
      const alive = entityExists(this.host.world, eid) && hasComponent(this.host.world, Player, eid) && !hasComponent(this.host.world, Dead, eid);
      if (alive && p.ship.owed?.length) {
        this.payOwedFree(s);
        const uid = this.bank.stepDeposits(p, p.ship, 15, (u) => this.isClaimed(eid, u));
        if (uid !== null) { this.installOwed(s, [uid]); s.bankDirty = true; }
      }
      this.sendBank(s, false, now);
    }
  }

  private bankTicks = 0;

  /**
   * Tell the client its bank: at once when `force` (login, a deposit, a death), else when it changed (at most once a
   * second) or, while the free part refills, once a minute
   */
  sendBank(s: Session, force = false, now = this.now()): void {
    const owed = this.bank.owedUids(s.profile.ship).length;
    const msg = this.bank.view(s.profile, owed);
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

  private get death(): DeathRules {
    return { ...DEFAULT_DEATH_RULES, ...(this.opts.death ?? {}) };
  }

  /** Who a pilot is for things kept for them (wrecks): their account, or their name as a guest */
  keyOf(conn: PilotConn): string | undefined {
    if (conn.userId !== null && conn.userId !== undefined) return `u:${conn.userId}`;
    return conn.username ? `g:${conn.username}` : undefined;
  }

  /** A pilot recovered their wreck (its pod was emptied) */
  wreckRecovered(key: string): void {
    for (const s of this.sessions.values()) {
      if (this.keyOf(s.conn) !== key || !s.profile.wreck) continue;
      s.profile.wreck = undefined;
      s.dirty = true;
      this.toast(s.conn, 'Wreck recovered: everything in it is in your hold', 'good');
      this.sendWreck(s);
    }
  }

  /** Tell them where their wreck is (or that it's gone) */
  private sendWreck(s: Session): void {
    const w = s.profile.wreck;
    if (!w || w.until <= this.now()) {
      if (w) { s.profile.wreck = undefined; s.dirty = true; }
      this.host.send(s.conn, { type: 'wreck', gone: true });
      return;
    }
    this.host.send(s.conn, { type: 'wreck', system: w.system, x: w.x, y: w.y, seconds: Math.round((w.until - this.now()) / 1000) });
  }

  /** One-time messages left on the profile (a migration's: the v5 ship wipe's refund), shown once and cleared */
  private showNotices(s: Session): void {
    const list = s.profile.notices;
    if (!list?.length) return;
    for (const n of list) {
      const items = Object.entries(n.items ?? {}).sort((a, b) => b[1] - a[1]);
      const shown = items.slice(0, 12).map(([id, k]) => `${k} ${this.econ.items.get(id)?.name ?? id}`);
      if (items.length > shown.length) shown.push(`and ${items.length - shown.length} more`);
      this.toast(s.conn, shown.length ? `${n.text}: ${shown.join(', ')}` : n.text, 'info');
    }
    delete s.profile.notices;
    s.dirty = true;
  }

  /** Scrap modules from storage (or the hold) at a station: SALVAGE of their minerals as ore, their components in full */
  scrapItem(conn: PilotConn, id: string, n: number): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    if (!s.atStation) return this.toast(conn, 'Scrap parts at a station', 'warn');
    if (!parsePartItemId(id)) return this.toast(conn, 'Only ship parts can be scrapped', 'info');
    const k = Math.min(this.available(conn, id), Math.max(1, n || 1));
    if (k <= 0) return;
    this.take(conn, { [id]: k });
    const salvage = salvageOf(this.econ, { [id]: k });
    this.give(conn, salvage, { toStorage: true, source: 'salvaged' });
    this.toast(conn, `Scrapped ${k} × ${this.econ.items.name(id)}`, 'info');
    this.saveNow(conn);
  }

  /**
   * Structure isn't kept as items any more (it's paid in materials when it's
   * placed): turn any in storage or the hold back into what it's made of.
   * True if anything changed.
   */
  private structureToMaterials(p: PlayerProfile): boolean {
    let changed = false;
    for (const list of [p.storage, p.cargo]) {
      for (const st of [...list]) {
        if (!isStructuralItem(st.id)) continue;
        const part = parsePartItemId(st.id)!;
        removeFrom(list, st.id, st.n);
        for (const [id, k] of Object.entries(this.econ.recipes.partInputs(part))) addTo(p.storage, id, k * st.n);
        changed = true;
      }
    }
    return changed;
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
    const sent = JSON.parse(JSON.stringify(msg)) as ServerProfileMessage;
    s.profileSent = sent;
    if (!prev) { this.host.send(conn, msg); return; }
    const delta = diffProfile(prev, sent);
    if (delta) this.host.send(conn, delta);
  }

  sendItems(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    const msg = {
      type: 'items' as const, cargo: s.profile.cargo, storage: s.profile.storage, cargoCapacity: this.cargoCapacity(conn),
      credits: s.profile.credits, atStation: this.atStation(conn),
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
}

export type { Stack };
export { hasAll };
