/**
 * @contract server.enemies.memory
 * owns:       what a system's hostiles remember when it is put away, and the spawner clocks
 * needs:      Enemies (packs, enemies, ships, host, data), ./populations, SystemMemory; npm: @space-game/common
 * invariants: a restored pack is the pack that was captured — server/src/game/systemMemory.test.ts
 * extend:     a new remembered field is added to PackMemory/EnemyMemory (model.ts) and to capture/restore here
 */

import { Velocity } from '@space-game/common';
import type { FarPose } from '../../ships/SimLod.js';
import { shipMemory, restoreHp } from '../SystemMemory.js';
import type { Enemies } from '../Enemies.js';
import type { PackOrigin, EnemyMemory, EnemyAi, PackMemory, Pack } from './model.js';
import * as populations from './populations.js';

/**
 * A system's packs as they are: the ones its own spawners sent (PackOrigin),
 * each ship where it is (`where`: a distant one's route worked out) and every
 * part's HP; times as world ticks (`offset` on). `evict`: and every pack
 * there is taken out of the world (the rest, an event's or a job's, go as
 * they always did when a system emptied), never counted as wiped out (no
 * nest starts rebuilding). A boss's own pack is Bosses' to remember.
 */
export function capture(self: Enemies, num: number, where: (eid: number) => FarPose, offset: number, evict: boolean): PackMemory[] {
  const out: PackMemory[] = [];
  const w = (t?: number) => (t === undefined ? undefined : t + offset);
  for (const [id, p] of self.packs) {
    if (p.systemNum !== num || p.boss) continue;
    // (A population's pack is its population's: put away, it's a ghost again)
    if (p.pop) { if (evict) populations.unloadSlot(self, p.pop.p, p.pop.slot, self.host.tick()); continue; }
    const members: EnemyMemory[] = [];
    for (const m of p.origin ? p.members : []) {
      const e = self.enemies.get(m), ship = self.ships.get(m);
      if (!e || !ship) continue;
      members.push({
        ...shipMemory(ship, where(m)), type: e.type, faction: e.faction, elite: e.elite, grade: e.grade, plating: e.plating,
        state: e.state === 'patrol' ? 'patrol' : 'return', waypoint: { ...e.waypoint }, strafe: e.strafe, flank: e.flank, ...(e.behaviour ? { behaviour: { ...e.behaviour } } : {}),
      });
    }
    if (members.length) {
      out.push({
        origin: p.origin!, home: { ...p.home }, members, passive: p.passive, angryUntil: w(p.angryUntil), zone: p.zone, size0: p.size0,
        nest: p.nest?.slice(p.nest.indexOf(':') + 1), group: p.group, roam: p.roam, style: p.style, wp: p.wp, wpUntil: w(p.wpUntil),
        pauseUntil: w(p.pauseUntil), pace: p.pace, dest: p.dest, settleUntil: w(p.settleUntil),
      });
    }
    if (!evict) continue;
    for (const m of p.members) { self.enemies.delete(m); if (self.ships.has(m)) self.ships.removeShip(m); }
    self.packs.delete(id);
  }
  if (evict) self.arrivals = self.arrivals.filter((a) => a.num !== num);
  return out;
}

/**
 * A remembered system's packs back: each ship where it was, as hurt as it
 * was less `heal` (a share of each part's max: time away mends), handed to
 * `adopt` (put to sleep and flown on from then: SimLod.adopt)
 */
export function restore(self: Enemies, num: number, packs: PackMemory[], offset: number, heal: number, adopt: (eid: number, pose: FarPose) => void): void {
  const l = (t?: number) => (t === undefined ? undefined : t - offset);
  for (const m of packs) {
    // (Nests' and zones' packs are their populations' now: a file from before them has them as ships, left out)
    if (m.nest !== undefined || m.origin === 'zone') continue;
    const pack: Pack = {
      id: self.nextPack++, systemNum: num, home: { ...m.home }, members: new Set(), lastSeen: self.host.tick(), origin: m.origin, passive: m.passive,
      angryUntil: l(m.angryUntil), zone: m.zone, size0: m.size0, wp: m.wp, wpUntil: l(m.wpUntil), pauseUntil: l(m.pauseUntil), pace: m.pace, dest: m.dest, settleUntil: l(m.settleUntil),
    };
    self.packs.set(pack.id, pack);
    for (const s of m.members) {
      if (!self.data.factions[s.faction]) continue;
      const eid = self.spawnShip(pack, s.type, s.faction, s.grade, s.plating ?? 0, s.elite, s.x, s.y, s.a, s.flank);
      if (eid < 0) continue;
      const e = self.enemies.get(eid)!;
      e.state = s.state; e.waypoint = { ...s.waypoint }; e.strafe = s.strafe;
      if (s.behaviour) e.behaviour = { ...s.behaviour };
      Velocity.x[eid] = s.vx; Velocity.y[eid] = s.vy;
      restoreHp(self.ships, eid, s.hp, heal);
      adopt(eid, { x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.a, angVel: 0 });
    }
    if (!pack.members.size) self.packs.delete(pack.id);
    else pack.size0 ??= pack.members.size;
  }
}

/** What a hostile is doing, to remember it by (a fight's forgotten: it's on its way home) */
export function aiOf(self: Enemies, eid: number): EnemyAi | undefined {
  const e = self.enemies.get(eid), pack = e && self.packs.get(e.pack);
  if (!e || !pack) return undefined;
  return { state: e.state === 'patrol' ? 'patrol' : 'return', waypoint: { ...e.waypoint }, home: { ...pack.home }, ...(e.behaviour ? { behaviour: { ...e.behaviour } } : {}) };
}

export function setAi(self: Enemies, eid: number, ai: EnemyAi): void {
  const e = self.enemies.get(eid), pack = e && self.packs.get(e.pack);
  if (!e || !pack) return;
  e.state = ai.state; e.waypoint = { ...ai.waypoint }; pack.home = { ...ai.home };
  if (ai.behaviour) e.behaviour = { ...ai.behaviour };
}

/** Every spawner's clock still to run (when each may next send, launch, rebuild), keyed by system id, as world ticks */
export function timers(self: Enemies, offset: number): Record<string, Record<string, number>> {
  const now = self.host.tick();
  const out: Record<string, Record<string, number>> = {};
  for (const [name, map] of clocks(self)) {
    const o: Record<string, number> = (out[name] = {});
    for (const [k, t] of map) {
      const s = String(k), i = s.indexOf(':'), id = self.host.systemId(Number(i < 0 ? s : s.slice(0, i)));
      if (id !== undefined && t > now) o[i < 0 ? id : id + s.slice(i)] = t + offset;
    }
  }
  return out;
}

export function setTimers(self: Enemies, t: Record<string, Record<string, number>>, offset: number): void {
  for (const [name, map] of clocks(self)) {
    for (const [k, at] of Object.entries(t[name] ?? {})) {
      const i = k.indexOf(':'), num = self.host.systemNum(i < 0 ? k : k.slice(0, i));
      if (num < 0 || typeof at !== 'number') continue;
      (map as Map<string | number, number>).set(i < 0 ? num : `${num}${k.slice(i)}`, at - offset);
    }
  }
}

/** The spawners' clocks, by name (keys: a system's number, or `${number}:...`) */
export function clocks(self: Enemies): [string, Map<string, number> | Map<number, number>][] {
  return [['spawn', self.nextSpawn], ['nestLock', self.nestLock]];
}
