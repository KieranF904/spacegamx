/**
 * @contract server.enemies.populations
 * owns:       nest and zone populations: their ships slot by slot, ghosts loaded and put back, respawn, the wire rows
 * needs:      Enemies (rng, packs, enemies, host, ships, data), common/world/populations, ./placement
 * invariants: a ghost's place is the same on server and clients — server/src/game/enemies.test.ts
 *             ships come back one at a time per spawner — server/src/game/enemies.test.ts
 * extend:     a new population rule is a function here, called from Enemies.tick
 */

import { Position, Velocity, nestPosition, nestPost, NEST_RADIUS, datan2, dcos, dhypot, dsin, spawnersOf, seedGroups, pickGroup, ghostCentre, ghostShip, slotStyle, packPopSlot, lureSector, packLure, LIFE_ASLEEP_RESET, FOCUS_RANGE, GHOST_STEP, type Lure } from '@space-game/common';
import { clampBand, anchoredWaypoint, LOOSE_REACH, type XY } from '../Roaming.js';
import { restoreHp } from '../SystemMemory.js';
import type { ShipState } from '@space-game/common';
import type { Enemies } from '../Enemies.js';
import type { SpawnGroup, SpawnNest, Enemy, PopSlot, Population, PopRows, PopulationMemory, Pack } from './model.js';
import * as placement from './placement.js';

/** How fast a nest's ships come out of it (units a tick) */
const LAUNCH_SPEED = 5;

/**
 * Between one ship coming back and the next (ticks): its spawner's respawnSeconds shared out over the ships of the
 * pack the next one goes to (a pack refills in about respawnSeconds, as one pack a respawnSeconds always did, but a
 * ship at a time)
 */
export function interval(self: Enemies, pop: Population): number {
  const every = ((pop.nest?.respawnSeconds ?? pop.zone?.respawnSeconds) ?? self.data.rules.respawnSeconds) * 60;
  const i = nextSlot(self, pop), g = i >= 0 ? pop.sp.def.groups[pop.slots[i].group] : undefined;
  const size = g?.ships.length ?? Math.max(1, Math.round(pop.sp.def.groups.reduce((n, q) => n + q.ships.length, 0) / Math.max(1, pop.sp.def.groups.length)));
  return Math.max(60, Math.round(every / Math.max(1, size)));
}

/** The slot the next ship back goes to: a hurt pack's first, then a wiped-out one (-1: it's full) */
export function nextSlot(self: Enemies, pop: Population): number {
  const i = pop.slots.findIndex((s) => s.group >= 0 && s.alive && s.alive !== full(self, pop, s));
  return i >= 0 ? i : pop.slots.findIndex((s) => !s.alive);
}

export function full(self: Enemies, pop: Population, s: PopSlot): number {
  const n = s.group >= 0 ? pop.sp.def.groups[s.group]?.ships.length ?? 0 : 0;
  return n ? (1 << n) - 1 : 0;
}

export function short(self: Enemies, pop: Population): boolean {
  return pop.slots.some((s) => s.group < 0 || s.alive !== full(self, pop, s));
}

/**
 * A population short of ships gets one back every interval (`next`), the first an interval after it was first
 * short: a hurt pack's missing ships first, then a wiped-out one, as a group by weight (its heavies not until
 * they're rebuilt, `nestLock`). However long it's been (a system nobody's in, a restart), it's caught up on here.
 */
export function regrow(self: Enemies, pop: Population, now: number): void {
  if (!short(self, pop)) { pop.next = 0; return; }
  if (!pop.next) pop.next = now + interval(self, pop);
  for (let guard = 0; pop.next <= now && guard < 1000 && short(self, pop); guard++) {
    regrowOne(self, pop, pop.next, now);
    pop.next += interval(self, pop);
  }
  if (!short(self, pop)) pop.next = 0;
}

export function regrowOne(self: Enemies, pop: Population, at: number, now: number): void {
  const i = nextSlot(self, pop);
  if (i < 0) return;
  const slot = pop.slots[i], empty = !slot.alive;
  if (empty) {
    const taken = pop.slots.filter((s, j) => j !== i && s.alive).map((s) => s.group);
    const g = pickGroup(pop.sp.def.groups, taken, self.rng, (q) => at >= (self.nestLock.get(`${pop.key}:${q}`) ?? -Infinity));
    if (g < 0) return;
    slot.group = g; slot.elite = 0; slot.hp = [];
  }
  const n = pop.sp.def.groups[slot.group].ships.length;
  let k = 0;
  while (k < n && slot.alive & (1 << k)) k++;
  if (k >= n) return;
  slot.alive |= 1 << k;
  slot.elite = k === 0 && self.rng() < self.data.rules.eliteChance ? slot.elite | 1 : slot.elite & ~(1 << k);
  slot.hp[k] = undefined;
  pop.changed = true;
  // Loaded: it comes out of the nest and joins its pack; a wiped-out pack's first ship with a pilot near the nest is
  // seen launching; otherwise its ghost is a ship stronger (loaded where it is once a pilot's near)
  const pack = slot.pack !== undefined ? self.packs.get(slot.pack) : undefined;
  if (pack) launchInto(self, pop, i, pack, k, now);
  else if (empty && now - at < 60 && pop.nest?.place && self.host.players(pop.num).some((p) => {
    const c = nestPosition(pop.nest!.place!, pop.nest!.planets, now);
    return dhypot(Position.x[p] - c.x, Position.y[p] - c.y) < placement.loadRange(self);
  })) loadSlot(self, pop, i, now, true);
}

/** One of a population's ships made real in this pack: its type, faction, grade, elite, its nest's leash and keenness */
export function spawnPopShip(self: Enemies, pop: Population, i: number, pack: Pack, k: number, x: number, y: number, angle: number): number {
  const slot = pop.slots[i], g = pop.sp.def.groups[slot.group] as SpawnGroup;
  const flank = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.min(1.6, 0.55 * Math.ceil(k / 2));
  const eid = self.spawnShip(pack, g.ships[k], g.faction, self.gradeOf(pop.num), g.plating ?? 0, !!(slot.elite & (1 << k)), x, y, angle, flank);
  if (eid < 0) return -1;
  const e = self.enemies.get(eid)!;
  e.pop = { p: pop, slot: i, k };
  const n = pop.nest, f = self.data.factions[g.faction];
  if (n && f) {
    // A loose pack's leash reaches past where it strays; a nomad's is round wherever it's got to
    const roam = n.roam ?? 2400, leash = pack.style === 'loose' ? Math.max(n.leash ?? f.behaviour.leash ?? 0, roam * LOOSE_REACH + 2500) : n.leash;
    if (leash || n.aggro) e.behaviour = { ...f.behaviour, ...(leash ? { leash } : {}), ...(n.aggro ? { aggro: n.aggro } : {}) };
  }
  return eid;
}

/** A ship back while its pack's loaded: out of the nest's hull, seen launching (a zone's: where its pack's ghost would be) */
export function launchInto(self: Enemies, pop: Population, i: number, pack: Pack, k: number, now: number): void {
  const n = pop.nest;
  const at = n?.place ? nestPosition(n.place, n.planets, now) : ghostCentre(pop.sys, pop.sysId, pop.sp, i, slotStyle(pop.sp, pop.slots[i].group), now, pop.lure);
  const a = launchAngle(self, n, at), c = dcos(a), s = dsin(a);
  const from = n?.place ? NEST_RADIUS : 0, x = at.x + c * from, y = at.y + s * from;
  if (n?.place && !n.place.hidden) self.host.effect?.(pop.num, x, y, 'launch');
  const eid = spawnPopShip(self, pop, i, pack, k, x, y, a);
  if (eid < 0) { pop.slots[i].alive &= ~(1 << k); return; }
  Velocity.x[eid] = c * LAUNCH_SPEED; Velocity.y[eid] = s * LAUNCH_SPEED;
  const roam = pack.roam ?? 2400;
  // (A posted nest's ships go out to patrol round its post, by a way clear of rock)
  self.enemies.get(eid)!.waypoint = n?.post ? anchoredWaypoint({ x, y }, placement.homeAt(self, pack, now), roam, self.rng, placement.clearRun(self, eid)) : { x: at.x + c * roam * 0.6, y: at.y + s * roam * 0.6 };
  pack.size0 = Math.max(pack.size0 ?? 0, pack.members.size);
}

/**
 * A ghost pack made real: each of its live ships exactly where its ghost is (common ghostShip), hurt as it was
 * (mended for the time since it was put back), on patrol; `launch`: a wiped-out pack's first ship back, seen
 * coming out of the nest's hull instead
 */
export function loadSlot(self: Enemies, pop: Population, i: number, now: number, launch = false, seen = false): void {
  const slot = pop.slots[i], g = pop.sp.def.groups[slot.group] as SpawnGroup | undefined;
  if (!g || !slot.alive) return;
  const style = slotStyle(pop.sp, slot.group), n = pop.nest, roam = pop.sp.def.roam ?? 2400;
  const nestAt = n?.place ? nestPosition(n.place, n.planets, now) : undefined;
  const c = ghostCentre(pop.sys, pop.sysId, pop.sp, i, style, now, pop.lure);
  const pack: Pack = {
    id: self.nextPack++, systemNum: pop.num, home: n?.place && style !== 'nomad' ? nestPost(n, n.place, n.planets, now) : { ...c }, members: new Set(), lastSeen: now,
    passive: g.passive, origin: n ? 'nest' : 'zone', pop: { p: pop, slot: i }, roam, pace: 0.4 + self.rng() * 0.45,
    ...(pop.zone ? { zone: pop.zone.id } : {}),
    ...(n ? { nest: pop.key, nestDef: n, group: slot.group, style } : {}),
  };
  self.packs.set(pack.id, pack);
  const away = now - (slot.leftAt ?? now);
  const heal = away >= LIFE_ASLEEP_RESET ? 1 : (away / 3600) * self.mendPerMinute;
  const a0 = launchAngle(self, n, nestAt);
  for (let k = 0; k < g.ships.length; k++) {
    if (!(slot.alive & (1 << k))) continue;
    const out = launch && nestAt;
    const at = out ? { x: nestAt.x + dcos(a0) * (NEST_RADIUS + k * 170), y: nestAt.y + dsin(a0) * (NEST_RADIUS + k * 170) } : ghostShip(c, k);
    const h = out ? a0 : self.rng() * Math.PI * 2;
    const eid = spawnPopShip(self, pop, i, pack, k, at.x, at.y, h);
    if (eid < 0) { slot.alive &= ~(1 << k); continue; }
    const v = out ? LAUNCH_SPEED : 0;
    Velocity.x[eid] = dcos(h) * v; Velocity.y[eid] = dsin(h) * v;
    const hp = slot.hp[k];
    if (hp) restoreHp(self.ships, eid, hp, heal);
    // (Loaded within a pilot's sight, an arrival as anyone's: it comes in as a warp-in looks)
    if (seen && !out) self.host.effect?.(pop.num, at.x, at.y, 'warpIn');
    self.enemies.get(eid)!.waypoint = { ...c };
  }
  slot.hp = []; slot.leftAt = undefined;
  pop.changed = true;
  if (!pack.members.size) { self.packs.delete(pack.id); return; }
  pack.size0 = pack.members.size;
  slot.pack = pack.id;
  if (launch && nestAt && n?.place && !n.place.hidden) self.host.effect?.(pop.num, nestAt!.x + dcos(a0) * NEST_RADIUS, nestAt!.y + dsin(a0) * NEST_RADIUS, 'launch');
  if (n) {
    pack.wp = clampBand(launch && nestAt ? { x: nestAt.x + dcos(a0) * roam, y: nestAt.y + dsin(a0) * roam } : c, n.band ?? { min: 0, max: 1e9 });
    pack.wpUntil = now + 60 * 20;
    if (style === 'nomad') pack.settleUntil = now + 60 * 15;
  }
}

/** A loaded pack nobody's near any more, all asleep and none fighting, back to a ghost (each ship's hurt kept) */
export function unloadSlot(self: Enemies, pop: Population, i: number, now: number): void {
  const slot = pop.slots[i], pack = slot.pack !== undefined ? self.packs.get(slot.pack) : undefined;
  slot.pack = undefined;
  pop.changed = true;
  if (!pack) return;
  for (const m of pack.members) {
    const e = self.enemies.get(m), ship = self.ships.get(m);
    if (e?.pop && ship) slot.hp[e.pop.k] = hpShares(ship);
    // (Out of the books first: put away, not lost)
    self.enemies.delete(m); self.pilots.forget(m); self.custom.forget(m);
    if (self.ships.has(m)) self.ships.removeShip(m);
  }
  self.packs.delete(pack.id);
  slot.leftAt = now;
}

/** A system's ghosts a pilot's near are loaded; loaded packs nobody's near, all asleep and calm, go back to ghosts */
export function tendPops(self: Enemies, num: number, players: number[], now: number): void {
  const list = populations(self).get(num);
  if (!list) return;
  const R = placement.loadRange(self), far = R * 1.25;
  const near = (x: number, y: number, r: number) => players.some((p) => dhypot(Position.x[p] - x, Position.y[p] - y) < r);
  for (const pop of list) {
    pop.slots.forEach((slot, i) => {
      if (slot.pack !== undefined) {
        const pack = self.packs.get(slot.pack);
        if (!pack) { slot.pack = undefined; pop.changed = true; return; }
        // (Kept while anyone's within 1.25 times the load range of any of its ships, or any of them is fighting)
        for (const m of pack.members) {
          const e = self.enemies.get(m), at = self.host.where?.(m) ?? { x: Position.x[m], y: Position.y[m] };
          if (near(at.x, at.y, far) || (e && (e.state === 'engage' || e.state === 'flee' || e.target >= 0))) return;
        }
        unloadSlot(self, pop, i, now);
        return;
      }
      if (!slot.alive || !players.length) return;
      const c = ghostCentre(pop.sys, pop.sysId, pop.sp, i, slotStyle(pop.sp, slot.group), now, pop.lure);
      if (near(c.x, c.y, R)) loadSlot(self, pop, i, now, false, near(c.x, c.y, FOCUS_RANGE));
    });
    tendLure(self, pop, players, now);
  }
}

/**
 * A spawner with nomads: its lure follows its band's pilots, by sector (common Lure): the sector of the pilot in its
 * band nearest its first nomad's ghost. A new sector starts a new lure from now (the clients are told: pops `n`);
 * nobody in the band leaves it as it is. Pilots' places aren't the clients' to know past their view: a sector a
 * sixteenth of the way round changes seldom, and is all they're told.
 */
export function tendLure(self: Enemies, pop: Population, players: number[], now: number): void {
  const band = pop.sp.band;
  const slot = pop.slots.findIndex((s) => s.group >= 0 && slotStyle(pop.sp, s.group) === 'nomad');
  if (!band || slot < 0) return;
  const inBand = players.filter((p) => { const r = dhypot(Position.x[p], Position.y[p]); return r > band.min - 4000 && r < band.max + 4000; });
  if (!inBand.length) return;
  const c = ghostCentre(pop.sys, pop.sysId, pop.sp, slot, 'nomad', now, pop.lure);
  let best = inBand[0], bd = Infinity;
  for (const p of inBand) { const d = dhypot(Position.x[p] - c.x, Position.y[p] - c.y); if (d < bd) { bd = d; best = p; } }
  const sector = lureSector(Position.x[best], Position.y[best]);
  const l = pop.lure ?? { l1: -1, s1: 0, l2: -1, s2: 0 };
  if (sector === l.l2) return;
  pop.lure = { l1: l.l2, s1: l.s2, l2: sector, s2: Math.floor(now / GHOST_STEP) };
  pop.changed = true;
}

/** A population's ship is gone (shot down, or gone some other way): its slot remembers, and the spawner starts on its replacement */
export function popLost(self: Enemies, e: Enemy, now: number): void {
  const at = e.pop;
  if (!at) return;
  e.pop = undefined;
  const pop = at.p, slot = pop.slots[at.slot];
  slot.alive &= ~(1 << at.k);
  slot.elite &= ~(1 << at.k);
  slot.hp[at.k] = undefined;
  pop.changed = true;
  if (!pop.next) pop.next = now + interval(self, pop);
  // (A wiped-out heavy pack's group isn't sent again until it's rebuilt)
  const g = pop.sp.def.groups[slot.group] as SpawnGroup | undefined;
  if (!slot.alive && g?.respawnSeconds) self.nestLock.set(`${pop.key}:${slot.group}`, now + g.respawnSeconds * 60);
}

/**
 * A system's populations as the wire has them: `p` [spawner index, slots, ...a code a slot] for each (common
 * packPopSlot), `n` its nomads' lures (common packLure)
 */
export function popRows(self: Enemies, num: number): PopRows {
  const out: PopRows = { p: [], n: [] };
  for (const pop of populations(self).get(num) ?? []) popRow(self, pop, out);
  return out;
}

export function popRow(self: Enemies, pop: Population, out: PopRows): void {
  out.p.push(pop.sp.index, pop.slots.length, ...pop.slots.map((s) => packPopSlot(s.group, s.pack !== undefined, s.alive)));
  if (pop.lure) packLure(out.n, pop.sp.index, pop.lure);
}

/** What's changed in each system's populations since last asked (a death, a ship back, a pack loaded or put back, a lure moved): its rows */
export function popChanges(self: Enemies): Map<number, PopRows> {
  const out = new Map<number, PopRows>();
  for (const [num, list] of populations(self)) {
    for (const pop of list) {
      if (!pop.changed) continue;
      pop.changed = false;
      let rows = out.get(num);
      if (!rows) out.set(num, (rows = { p: [], n: [] }));
      popRow(self, pop, rows);
    }
  }
  return out;
}

/** A population's slots now (tests, tools): each one's group, ships alive (bit k), and whether it's loaded */
export function population(self: Enemies, systemNum: number, id: string): { next: number; slots: { group: number; alive: number; loaded: boolean; ships: number[] }[] } | null {
  const pop = populations(self).get(systemNum)?.find((p) => p.sp.def.id === id);
  if (!pop) return null;
  return { next: pop.next, slots: pop.slots.map((s) => ({ group: s.group, alive: s.alive, loaded: s.pack !== undefined, ships: s.pack !== undefined ? [...(self.packs.get(s.pack)?.members ?? [])] : [] })) };
}

/** Where a population's slot's pack is while it's a ghost, at `tick` (tests, tools: the clients work out the same) */
export function ghostAt(self: Enemies, systemNum: number, id: string, slot: number, tick = self.host.tick()): XY | null {
  const pop = populations(self).get(systemNum)?.find((p) => p.sp.def.id === id), s = pop?.slots[slot];
  if (!pop || !s || s.group < 0) return null;
  return ghostCentre(pop.sys, pop.sysId, pop.sp, slot, slotStyle(pop.sp, s.group), tick, pop.lure);
}

/** Every population as remembered (the memory file): times as world ticks; a loaded pack's ships as hurt as they are now */
export function popMemory(self: Enemies, offset: number): Record<string, Record<string, PopulationMemory>> {
  const out: Record<string, Record<string, PopulationMemory>> = {};
  for (const list of populations(self).values()) {
    for (const pop of list) {
      const pack = (s: PopSlot) => (s.pack !== undefined ? self.packs.get(s.pack) : undefined);
      (out[pop.sysId] ??= {})[pop.sp.def.id] = {
        ...(pop.next ? { next: pop.next + offset } : {}),
        ...(pop.lure ? { lure: { ...pop.lure, s1: pop.lure.s1 * GHOST_STEP + offset, s2: pop.lure.s2 * GHOST_STEP + offset } } : {}),
        slots: pop.slots.map((s) => {
          const hp = [...s.hp];
          for (const m of pack(s)?.members ?? []) { const e = self.enemies.get(m), ship = self.ships.get(m); if (e?.pop && ship) hp[e.pop.k] = hpShares(ship); }
          const kept = hp.some((h) => h) ? { hp: hp.map((h) => h ?? null) } : {};
          return { group: s.group, alive: s.alive, ...(s.elite ? { elite: s.elite } : {}), ...kept, ...(s.leftAt !== undefined ? { leftAt: s.leftAt + offset } : {}) };
        }),
      };
    }
  }
  return out;
}

/** Populations back as remembered (a spawner's data changed since: what still fits; a new one's full) */
export function setPopMemory(self: Enemies, data: Record<string, Record<string, PopulationMemory>> | undefined, offset: number): void {
  for (const list of populations(self).values()) {
    for (const pop of list) {
      const m = data?.[pop.sysId]?.[pop.sp.def.id];
      if (!m || !Array.isArray(m.slots)) continue;
      pop.slots.forEach((slot, i) => {
        const r = m.slots[i];
        if (!r || typeof r.group !== 'number' || r.group >= pop.sp.def.groups.length) return;
        slot.group = r.group;
        const n = r.group >= 0 ? pop.sp.def.groups[r.group].ships.length : 0;
        slot.alive = (r.alive | 0) & (n ? (1 << n) - 1 : 0);
        slot.elite = (r.elite ?? 0) & slot.alive;
        slot.hp = (r.hp ?? []).map((h) => (Array.isArray(h) ? h : undefined));
        slot.leftAt = typeof r.leftAt === 'number' ? r.leftAt - offset : undefined;
        slot.pack = undefined;
      });
      pop.next = typeof m.next === 'number' ? m.next - offset : 0;
      const l = m.lure;
      if (l && [l.l1, l.s1, l.l2, l.s2].every((v) => typeof v === 'number')) pop.lure = { l1: l.l1, s1: Math.floor((l.s1 - offset) / GHOST_STEP), l2: l.l2, s2: Math.floor((l.s2 - offset) / GHOST_STEP) };
      pop.changed = true;
    }
  }
}

/** Which way a nest's ships come out of it: anywhere, or (one with a post, a heap against a den's wall) out towards its post */
export function launchAngle(self: Enemies, n: SpawnNest | undefined, at: XY | undefined): number {
  const roll = self.rng();
  if (!n?.post || !at) return roll * Math.PI * 2;
  return datan2(n.post.y - at.y, n.post.x - at.x) + (roll - 0.5) * 1.2;
}

/** Every system's populations, built the first time they're wanted: a fresh world's are full, their groups from the seed */
export function populations(self: Enemies): Map<number, Population[]> {
  if (self.pops) return self.pops;
  const out = new Map<number, Population[]>();
  for (const [sysId, spawns] of Object.entries(self.data.spawns)) {
    const num = self.host.systemNum(sysId);
    if (num < 0) continue;
    const sys = spawns.nests?.find((n) => n.sys)?.sys;
    const list: Population[] = [];
    for (const sp of spawnersOf(spawns, sys)) {
      const groups = seedGroups(sysId, sp);
      const slots = groups.map((g): PopSlot => {
        const n = g >= 0 ? sp.def.groups[g].ships.length : 0;
        return { group: g, alive: n ? (1 << n) - 1 : 0, elite: n && self.rng() < self.data.rules.eliteChance ? 1 : 0, hp: [] };
      });
      list.push({
        num, sysId, sp, sys, key: `${num}:${sp.def.id}`, slots, next: 0, changed: true,
        ...(sp.kind === 'nest' ? { nest: spawns.nests!.find((q) => q.id === sp.def.id) } : { zone: spawns.zones!.find((q) => q.id === sp.def.id) }),
      });
    }
    if (list.length) out.set(num, list);
  }
  self.pops = out;
  return out;
}

/** A ship's parts' HP as shares of their max (undefined: it's whole) */
function hpShares(ship: ShipState): number[] | undefined {
  const hp = ship.hp.map((h, i) => (ship.detached[i] || !(ship.maxHp[i] > 0) ? 0 : Math.round(Math.min(1, h / ship.maxHp[i]) * 1000) / 1000));
  return hp.every((h) => h >= 1) ? undefined : hp;
}
