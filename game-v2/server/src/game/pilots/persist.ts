/**
 * @contract server.pilots.persist
 * owns:       moving a profile between the store, the session and the live ship entity
 * needs:      Pilots (sessions, store, host, ships), ProfileStore
 * invariants: a guest profile is never saved — none pinned
 * extend:     a new profile field that mirrors onto the ship goes in applyProfile/capture
 */

import { hasComponent, entityExists } from 'bitecs';
import { Player, Position, InSystem, Dead, PlayerProfile, setActiveShip } from '@space-game/common';
import { cloneJson } from '@space-game/common';
import type { Pilots, PilotConn, Session } from '../Pilots.js';

export async function save(self: Pilots, s: Session): Promise<void> {
  s.lastSave = self.now();
  if (s.conn.userId === null) return;
  s.dirty = false;
  s.profile.updatedAt = new Date(self.now()).toISOString();
  try {
    await self.store.save(s.conn.userId, persistable(self, s.conn, s.profile));
  } catch (e) {
    s.dirty = true;
    console.error(`[Pilots] save failed for ${s.conn.userId}:`, e);
  }
}

/** Copy live state (ship HP, position) into the profile */
export function capture(self: Pilots, s: Session): void {
  const eid = s.conn.playerId;
  if (!entityExists(self.host.world, eid) || !hasComponent(self.host.world, Player, eid) || hasComponent(self.host.world, Dead, eid)) return;
  const ship = self.ships.get(eid);
  if (ship && ship.kind === 'ship' && ship.derived.root >= 0) {
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
  if (system) s.profile.position = { system, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]) };
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
    if (!self.opts.spawn && sys >= 0 && self.host.safeToAppear(sys, profile.position.x, profile.position.y)) {
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
  if (!self.devStash.has(s.conn) && !self.ships.validate(bp, { mounting: false }).ok) {
    setActiveShip(s.profile, { blueprint: cloneJson(self.opts.starter.blueprint), hp: {}, ghosts: [], plan: self.opts.starter.planFile });
  }
  const rec = s.profile.ship;
  // (The core always comes back, free)
  const core = rec.blueprint.parts.find((q) => q.fn === 'core');
  if (core && rec.ghosts?.includes(core.uid)) rec.ghosts = rec.ghosts.filter((u) => u !== core.uid);
  const ghosts = new Set(rec.ghosts ?? []);
  self.ships.respawnInPlace(eid, rec.blueprint);
  self.ships.setPartHp(eid, (uid) => (ghosts.has(uid) ? 0 : rec.hp[uid] ?? 1));
  if (ghosts.size) self.ships.setGhosts(eid, [...ghosts]);
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

/** What's written to disk: their profile, with the real ship back if a library ship's borrowed (devSwapShip) */
export function persistable(self: Pilots, conn: PilotConn, p: PlayerProfile): PlayerProfile {
  const st = self.devStash.get(conn);
  if (!st) return p;
  const hangar = p.hangar.map((r, i) => (i === st.slot ? st.rec : r));
  return { ...p, ship: st.rec, hangar, activeSlot: st.slot };
}
