/**
 * @contract server.pilots.persist
 * owns:       moving a profile between the store, the session and the live ship entity
 * needs:      Pilots (sessions, store, host, ships), ProfileStore; npm: @space-game/common, bitecs
 * invariants: a guest profile is never saved with the accounts (one with a key is kept by it: pilots/guests.ts) — server/src/game/pilots/guests.test.ts
 *             a saved ship that fails the rules is kept as saved; a loaner flies meanwhile and is never written — server/src/game/pilots/loaner.test.ts
 *             a save the lease refuses tells the pilot, retries with backoff and never kicks — server/src/game/pilots/lease.test.ts
 * extend:     a new profile field that mirrors onto the ship goes in applyProfile/capture
 */

import { hasComponent, entityExists } from 'bitecs';
import { Player, Position, InSystem, Dead, PlayerProfile, type ShipRecord, coreOf, addTo } from '@space-game/common';
import { cloneJson } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';
import * as lease from './lease.js';
import { isLeaseRefused } from '../../profile/lease.js';

/** Does this profile hold a gun range cheat ship anywhere (never to be saved: Blueprint.range) */
export function holdsRangeShip(p: PlayerProfile): boolean {
  return !!p.ship?.blueprint?.range || p.hangar.some((r) => !!r?.blueprint?.range);
}

export async function save(self: Pilots, s: Session): Promise<void> {
  s.lastSave = self.now();
  if (s.conn.userId === null) {
    // (A guest: never with the accounts. One with a key is kept a while under it, pilots/guests.ts; a profile still
    // loading isn't theirs)
    if (s.conn.guestId && !s.loading) {
      s.dirty = false;
      self.guests.put(s.conn.guestId, s.conn.username, persistable(self, s.conn, s.profile), s.conn.address);
    }
    return;
  }
  s.dirty = false;
  s.profile.updatedAt = new Date(self.now()).toISOString();
  try {
    // (Fenced by the lease: a server that lost the account can't write over the one that took it)
    await self.store.save(s.conn.userId, persistable(self, s.conn, s.profile), lease.serverId(self));
    s.leaseRefused = undefined;
  } catch (e) {
    s.dirty = true;
    if (isLeaseRefused(e)) { leaseRefused(self, s); return; }
    console.error(`[Pilots] save failed for ${s.conn.userId}:`, e);
  }
}

/** Longest wait between tries while another session holds the account */
const LEASE_RETRY_MAX_MS = 60_000;
/** The pilot hears of it again no sooner than this */
const LEASE_TOAST_MS = 30_000;

/**
 * A save the lease refused (another server or session holds the account): never a kick. The pilot is told, once and
 * then again now and then, and the save is retried with a growing wait (the profile stays dirty, so autosave takes it up)
 */
function leaseRefused(self: Pilots, s: Session): void {
  const now = self.now();
  const count = (s.leaseRefused?.count ?? 0) + 1;
  const wait = Math.min(LEASE_RETRY_MAX_MS, Math.max(1000, self.opts.autosaveMs) * (1 << Math.min(count - 1, 10)));
  const told = s.leaseRefused?.toldAt ?? -Infinity;
  const tell = now - told >= LEASE_TOAST_MS;
  s.leaseRefused = { count, retryAt: now + wait, toldAt: tell ? now : told };
  console.error(`[Pilots] save refused for ${s.conn.userId}: the account's lease is held elsewhere (try ${count}, next in ${Math.round(wait / 1000)}s)`);
  if (tell) self.toast(s.conn, LEASE_REFUSED_TEXT, 'bad');
}
export const LEASE_REFUSED_TEXT = "Your progress couldn't be saved: your account is active in another session. Retrying…";

/** Copy live state (ship HP, position) into the profile */
export function capture(self: Pilots, s: Session): void {
  const eid = s.conn.playerId;
  if (!entityExists(self.host.world, eid) || !hasComponent(self.host.world, Player, eid) || hasComponent(self.host.world, Dead, eid)) return;
  const ship = self.ships.get(eid);
  // (A gun range cheat ship is never written into any profile, whatever the profile in hand: types.ts Blueprint.range)
  if (ship && ship.kind === 'ship' && ship.derived.root >= 0 && !ship.blueprint.range) {
    const hp: Record<number, number> = {};
    ship.blueprint.parts.forEach((p, i) => {
      if (self.ships.isGhost(eid, i)) return; // not built yet: the record's ghost list says so
      const f = ship.detached[i] ? 0 : ship.hp[i] / ship.maxHp[i];
      if (f < 0.999) hp[p.uid] = Math.max(0, Math.round(f * 1000) / 1000);
    });
    // Same record object as the hangar slot: update it in place
    s.profile.ship.blueprint = ship.blueprint;
    s.profile.ship.hp = hp;
    // The ghosts as the live ship has them (a part built or planned since, by a machine or the bank), the record's order kept
    const live = new Set<number>();
    ship.blueprint.parts.forEach((p, i) => { if (self.ships.isGhost(eid, i)) live.add(p.uid); });
    const rec = s.profile.ship;
    const known = (rec.ghosts ?? []).filter((u) => live.has(u));
    const seen = new Set(known);
    rec.ghosts = [...known, ...ship.blueprint.parts.filter((p) => live.has(p.uid) && !seen.has(p.uid)).map((p) => p.uid)];
    if (rec.owed) { rec.owed = rec.owed.filter((u) => live.has(u)); if (!rec.owed.length) delete rec.owed; }
  }
  const system = self.host.systemId(InSystem.systemId[eid]);
  // (Nor is a place no pilot is ever saved in: the gun range. The profile keeps where it was)
  if (system && !self.host.transient?.(InSystem.systemId[eid])) s.profile.position ={ system, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]) };
}

/** Put the profile into the world: stats, ship, position */
export function applyProfile(self: Pilots, s: Session, placeShip: boolean): void {
  const { conn, profile } = s;
  const eid = conn.playerId;
  mirror(self, s);
  self.ships.setSkills(eid, profile.skills);
  if (placeShip && hasComponent(self.host.world, Player, eid) && !hasComponent(self.host.world, Dead, eid)) {
    applyShip(self, s);
    const sys = self.host.systemNum(profile.position.system);
    const yard = self.tutorialSpawn?.(conn, true);
    if (yard) {
      self.host.place(conn, yard.system, yard.x, yard.y);
    } else if (!self.opts.spawn && sys >= 0 && self.host.safeToAppear(sys, profile.position.x, profile.position.y)) {
      self.host.place(conn, sys, profile.position.x, profile.position.y);
    } else {
      const at = self.homePoint(s);
      if (at) self.host.place(conn, at.system, at.x, at.y);
    }
  }
  self.sendProfile(conn);
  self.sendItems(conn);
}

/** The profile's ship onto the entity (design, then saved HP, then parts not built yet) */
export function applyShip(self: Pilots, s: Session): void {
  const eid = s.conn.playerId;
  const bp = s.profile.ship.blueprint;
  // (a borrowed dev ship flies as it is: an enemy's design needn't pass a pilot's rules. A saved ship needn't keep
  // weapons' mounting rules made since it was fitted: it flies, its hangar flagging what to fix)
  if (!self.devStash.has(s.conn) && !self.frozen.has(s.conn) && !self.loaners.has(s.profile.ship)) {
    const check = self.ships.validate(bp, { mounting: false, devParts: true });
    if (!check.ok) flyLoaner(self, s, check.errors.map((e) => e.message));
  }
  const rec = s.profile.ship;
  // (The core always comes back, free)
  const core = coreOf(rec.blueprint.parts);
  if (core && rec.ghosts?.includes(core.uid)) rec.ghosts = rec.ghosts.filter((u) => u !== core.uid);
  const ghosts = new Set(rec.ghosts ?? []);
  self.ships.respawnInPlace(eid, rec.blueprint);
  self.ships.setPartHp(eid, (uid) => (ghosts.has(uid) ? 0 : rec.hp[uid] ?? 1));
  if (ghosts.size) self.ships.setGhosts(eid, [...ghosts]);
}

/**
 * The saved ship fails the ship rules (a data edit since it was built): it stays in its hangar slot exactly as saved, and
 * a loaner (the starter) flies in its place. The loaner is the profile's ship only in memory: persistable writes the saved
 * record back, so nothing of the pilot's is replaced, and a later fix to the data gives them their ship back as it was.
 * A refit of that slot or flying another ship ends the loan (Hangar.ts); losing the loaner costs only the pilot's cargo, as in any death (death.ts).
 */
function flyLoaner(self: Pilots, s: Session, errors: string[]): void {
  const p = s.profile, saved = p.ship;
  const loaner: ShipRecord = { blueprint: cloneJson(self.opts.starter.blueprint), hp: {}, ghosts: [], plan: self.opts.starter.planFile };
  self.loaners.add(loaner);
  p.hangar[p.activeSlot] = saved; // (already: the hangar slot is the ship's record)
  p.ship = loaner;
  console.warn(`[Pilots] the saved ${saved.blueprint.name} of ${s.conn.username} (slot ${p.activeSlot}) fails the ship rules, kept as saved; flying a loaner: ${errors.slice(0, 3).join('; ')}`);
  self.toast(s.conn, `Your ${saved.blueprint.name} no longer passes the ship rules (${errors[0] ?? 'unknown error'}). It is kept in your hangar exactly as it was; you are flying a loaner ${loaner.blueprint.name} meanwhile`, 'warn');
}

/** The ship record changed (hangar): put it on the entity again */
export function reapplyShip(self: Pilots, conn: PilotConn): void {
  const s = self.sessions.get(conn);
  if (!s) return;
  applyShip(self, s);
  mirror(self, s);
  // Its guns may take other crates now
  self.sendProfile(conn);
}

/** Copy the live ship into its record now (before swapping ships) */
export function captureNow(self: Pilots, conn: PilotConn): void {
  const s = self.sessions.get(conn);
  if (s) capture(self, s);
}

/** ECS mirrors of the profile (the snapshot and HUD read these) */
export function mirror(self: Pilots, s: Session): void {
  const eid = s.conn.playerId;
  if (!hasComponent(self.host.world, Player, eid)) return;
  Player.credits[eid] = s.profile.credits;
  Player.xp[eid] = s.profile.xp;
  Player.level[eid] = s.profile.level;
}

/**
 * What's written to disk: their profile, with the real ship back if a library ship's borrowed (devSwapShip); in the gun
 * range, the real profile frozen as it was when they went in (pilots/freeze.ts), never the copy in play
 */
export function persistable(self: Pilots, conn: PilotConn, p: PlayerProfile): PlayerProfile {
  return keepSavedShip(self, chosen(self, conn, p));
}

function chosen(self: Pilots, conn: PilotConn, p: PlayerProfile): PlayerProfile {
  const real = self.frozen.get(conn);
  if (real) return real;
  // (A cheat ship never goes to disk, however it got here: the starter in its place)
  if (holdsRangeShip(p)) {
    console.error(`[Pilots] a gun range ship was about to be saved for ${conn.username}: not saved`);
    const swap = (r: ShipRecord | null) => (r?.blueprint.range ? { blueprint: cloneJson(self.opts.starter.blueprint), hp: {}, ghosts: [] } : r);
    return { ...p, ship: swap(p.ship)!, hangar: p.hangar.map(swap) };
  }
  const st = self.devStash.get(conn);
  if (!st) return p;
  const hangar = p.hangar.map((r, i) => (i === st.slot ? st.rec : r));
  return { ...p, ship: st.rec, hangar, activeSlot: st.slot };
}

/** A loaner is never saved: the ship saved is the record it stands in for (flyLoaner), and what its machines held goes to storage */
function keepSavedShip(self: Pilots, p: PlayerProfile): PlayerProfile {
  const loaner = p.ship;
  const saved = p.hangar[p.activeSlot];
  if (!self.loaners.has(loaner) || !saved) return p;
  const held = Object.entries(loaner.field?.held ?? {}).filter(([, n]) => n > 0);
  if (!held.length) return { ...p, ship: saved };
  const storage = p.storage.map((st) => ({ ...st }));
  for (const [id, n] of held) addTo(storage, id, n);
  return { ...p, ship: saved, storage };
}
