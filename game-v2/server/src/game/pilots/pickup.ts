/**
 * @contract server.pilots.pickup
 * owns:       what a pilot's ship picks up by itself (ore in mining mode but the blacklisted, the hold's ghosts), the ghost and template requests, mining mode and the ore blacklist
 * needs:      Pilots (sessions, econ, toast, sendItems, sendProfile), pilots/cargo (capacity); npm: @space-game/common (econ/holdGhosts.ts, the rules)
 * invariants: a pod's non-ore loot is not picked up without a ghost of it; a ghost's item is, ore never into another ghost's reserved space — server/src/game/pickup.test.ts
 *             ghosts are the flown ship's: another ship has its own, a death clears them, a template loads them in one go — server/src/game/pickup.test.ts
 *             mining mode and the blacklist are the pilot's; "Blacklist & jettison" lists the ore and throws out what the hold has of it — server/src/game/pickup.test.ts
 * extend:     a new pickup setting is a field on PickupPrefs (common) and a branch in handlePrefs
 */

import { autoTake as autoTakeRule, cleanGhosts, countOf, isOre, miningMode, settleGhosts, MAX_BLACKLIST, MAX_GHOSTS, MAX_TEMPLATES, MAX_TEMPLATE_NAME, type Bag, type GhostTemplate, type HoldGhost, type HoldView, type PlayerProfile } from '@space-game/common';
import type { Pilots, PilotConn } from '../Pilots.js';
import { cargoCapacity, handleJettison } from './cargo.js';

/** The ghosts in the hold of the ship flown */
export function ghostsOf(p: PlayerProfile): HoldGhost[] {
  return p.ship.wants ?? [];
}

/** The hold as the rules (common econ/holdGhosts.ts) read it */
export function holdView(self: Pilots, conn: PilotConn, p: PlayerProfile): HoldView {
  return { cargo: p.cargo, capacity: cargoCapacity(self, conn), volume: (id) => self.econ.items.volume(id), category: (id) => self.econ.items.get(id)?.category };
}

/** Of a pod's contents, what this pilot's ship picks up by itself now (nothing in the gun range: nothing is given there) */
export function autoTake(self: Pilots, conn: PilotConn, items: Bag): Bag {
  const s = self.sessions.get(conn);
  if (!s || self.frozen.has(conn)) return {};
  return autoTakeRule(holdView(self, conn, s.profile), ghostsOf(s.profile), miningMode(s.profile.pickup), items);
}

/** The hold changed: a ghost whose target it has reached goes (that stack is real now). True if any went */
export function settle(p: PlayerProfile): boolean {
  const g = p.ship.wants;
  if (!g?.length) return false;
  const kept = settleGhosts(g, p.cargo);
  if (kept.length === g.length) return false;
  if (kept.length) p.ship.wants = kept; else delete p.ship.wants;
  return true;
}

const setGhosts = (p: PlayerProfile, g: HoldGhost[]) => { if (g.length) p.ship.wants = g; else delete p.ship.wants; };

/** `ghost { item, n?, remove? }`: set a ghost in the flown ship's hold (an unlimited one without `n`), or drop it */
export function handleGhost(self: Pilots, conn: PilotConn, msg: { item?: unknown; n?: unknown; remove?: unknown }): void {
  const s = self.sessions.get(conn);
  if (!s || self.frozen.has(conn) || typeof msg.item !== 'string') return;
  const p = s.profile;
  const list = ghostsOf(p).filter((g) => g.item !== msg.item);
  if (!msg.remove) {
    if (!self.econ.items.has(msg.item)) return;
    if (list.length >= MAX_GHOSTS) return self.toast(conn, `A hold keeps at most ${MAX_GHOSTS} ghosts`, 'warn');
    const n = typeof msg.n === 'number' && Number.isFinite(msg.n) && msg.n >= 1 ? Math.min(1e6, Math.floor(msg.n)) : undefined;
    // (A target already met is no ghost: the stack is real)
    list.push(n === undefined ? { item: msg.item } : { item: msg.item, n });
  }
  setGhosts(p, list);
  settle(p);
  s.dirty = true;
  self.sendItems(conn);
}

/** `ghostTemplate`: save the hold's ghosts under a name, load one (replacing them), or delete one */
export function handleTemplate(self: Pilots, conn: PilotConn, msg: { save?: unknown; load?: unknown; remove?: unknown }): void {
  const s = self.sessions.get(conn);
  if (!s || self.frozen.has(conn)) return;
  const p = s.profile;
  const templates = [...(p.pickup?.templates ?? [])];
  const name = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, MAX_TEMPLATE_NAME) : '');
  if (name(msg.save)) {
    const id = name(msg.save);
    const ghosts = cleanGhosts(ghostsOf(p));
    if (!ghosts.length) return self.toast(conn, 'No ghosts in the hold to save', 'info');
    const i = templates.findIndex((t) => t.name === id);
    if (i < 0 && templates.length >= MAX_TEMPLATES) return self.toast(conn, `At most ${MAX_TEMPLATES} templates: delete one first`, 'warn');
    if (i >= 0) templates[i] = { name: id, ghosts }; else templates.push({ name: id, ghosts });
    self.toast(conn, `Saved the template "${id}"`, 'good');
  } else if (name(msg.load)) {
    const t = templates.find((x) => x.name === name(msg.load));
    if (!t) return;
    setGhosts(p, cleanGhosts(t.ghosts.filter((g) => self.econ.items.has(g.item))));
    settle(p);
    self.sendItems(conn);
  } else if (name(msg.remove)) {
    const i = templates.findIndex((t) => t.name === name(msg.remove));
    if (i < 0) return;
    templates.splice(i, 1);
  } else return;
  p.pickup = { ...p.pickup, templates };
  if (!templates.length) delete p.pickup.templates;
  if (!Object.keys(p.pickup).length) delete p.pickup;
  s.dirty = true;
  self.sendProfile(conn);
}

/** `pickupPrefs { mining }`: mining mode on or off */
export function handlePrefs(self: Pilots, conn: PilotConn, msg: { mining?: unknown }): void {
  const s = self.sessions.get(conn);
  if (!s || self.frozen.has(conn) || typeof msg.mining !== 'boolean') return;
  const p = s.profile;
  p.pickup = { ...p.pickup };
  if (msg.mining) delete p.pickup.miningOff; else p.pickup.miningOff = true;
  if (!Object.keys(p.pickup).length) delete p.pickup;
  s.dirty = true;
  self.sendProfile(conn);
}

/** `oreBlacklist { item, on, jettison? }`: an ore mining mode leaves (or no longer); `jettison`: and out with what the hold has of it */
export function handleBlacklist(self: Pilots, conn: PilotConn, msg: { item?: unknown; on?: unknown; jettison?: unknown }): void {
  const s = self.sessions.get(conn);
  if (!s || self.frozen.has(conn) || typeof msg.item !== 'string' || typeof msg.on !== 'boolean') return;
  const p = s.profile;
  const item = msg.item;
  if (!self.econ.items.has(item) || !isOre(holdView(self, conn, p), item)) return;
  const list = (p.pickup?.blacklist ?? []).filter((x) => x !== item);
  if (msg.on) {
    if (list.length >= MAX_BLACKLIST) return self.toast(conn, `The blacklist holds at most ${MAX_BLACKLIST} ores`, 'warn');
    list.push(item);
  }
  p.pickup = { ...p.pickup, blacklist: list };
  if (!list.length) delete p.pickup.blacklist;
  if (!Object.keys(p.pickup).length) delete p.pickup;
  s.dirty = true;
  self.sendProfile(conn);
  const held = countOf(p.cargo, item);
  if (msg.on && msg.jettison === true && held > 0) handleJettison(self, conn, { id: item, n: held });
}

/** The profile message's pickup field */
export function pickupView(p: PlayerProfile): { mining: boolean; blacklist: string[]; templates: GhostTemplate[] } {
  return { mining: !p.pickup?.miningOff, blacklist: p.pickup?.blacklist ?? [], templates: p.pickup?.templates ?? [] };
}
