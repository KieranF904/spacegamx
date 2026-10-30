/**
 * System memory: a system nobody's in isn't simulated at all.
 *
 * Once the last pilot has been gone from a system a little while (rules.json
 * memory.evictAfterSeconds: a death, a quick hop through a gate and back),
 * what its own spawners put there is written down and taken out of the
 * world: its packs (each ship where it is, how it's moving, what it was doing,
 * its pack, nest or zone, every part's HP), its bosses (and how far into their
 * phases), its freighters and derelicts, and when each one destroyed is due
 * back. Its other hostiles (an event's, a job's) go, as they always did when
 * a system emptied. Nothing of it costs a tick.
 *
 * As a pilot comes (at a gate's mouth, or however they arrive), it's all put
 * back before they're there: each ship where its route would have taken it in
 * the time since (ships/SimLod.ts flies it on from where it was, for at most
 * memory.fastForwardMinutes of it: a patrol after an hour looks like one
 * after a couple of minutes), mended by memory.healPerMinute of each part's max
 * HP for every minute away (bosses memory.bossHealPerMinute), a boss's phases
 * as its hull now is. Only what's due back by now comes back: each spawner
 * keeps its own clock (a boss's respawnSeconds, a nest rebuilding, a zone's,
 * a freighter's, a derelict's), so a boss killed stays dead until it's due,
 * however often you come and go.
 *
 * It's kept on disk (data/world/memory.json: never in git, never overwritten
 * by a deploy), written whole every memory.saveSeconds and at shutdown, with
 * every spawner's clock: a restart picks the world up where it was. Times are
 * kept as world ticks, the server's tick plus `offset`; the world's clock runs
 * on through downtime (a boss due in ten minutes when the server went down
 * for five is due five minutes after it's back). No file, or one that can't
 * be read, is a fresh world (an unreadable one is kept aside as `.bad-<time>`).
 */

import { readFileSync, renameSync } from 'fs';
import { mkdir, writeFile, rename } from 'fs/promises';
import { dirname } from 'path';
import type { ShipState } from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { FarPose } from '../ships/SimLod.js';
import type { PackMemory } from './Enemies.js';
import type { BossMemory } from './Bosses.js';
import { mergeRules } from '../data/rules.js';

export interface MemoryRules {
  /** A system's put away once nobody's been in it this long */
  evictAfterSeconds: number;
  /** Time away mends: this share of each part's max HP a minute (a wreck to whole in 1 / this minutes), bosses more slowly */
  healPerMinute: number;
  bossHealPerMinute: number;
  /**
   * Ships are flown on from where they were left for at most this much of the
   * time away (the last of it): a patrol's anywhere round its home after a few
   * legs, and catching up costs a tick the more of it there is
   */
  fastForwardMinutes: number;
  /** Written to disk this often */
  saveSeconds: number;
}

/** rules.json `memory` patches these */
export const MEMORY_RULES: MemoryRules = { evictAfterSeconds: 20, healPerMinute: 0.04, bossHealPerMinute: 0.02, fastForwardMinutes: 2, saveSeconds: 60 };

/** The file's format (a file of another is set aside and the world starts fresh) */
export const MEMORY_VERSION = 1;
/** Ships brought back a tick while a pilot's only at a gate's mouth (the rest at once if they come through first) */
export const MEMORY_BATCH = 40;

/** A ship as remembered: where it was, how it was moving and turning, each part's HP (a share of its max, by part index) */
export interface ShipMemory { x: number; y: number; vx: number; vy: number; a: number; av?: number; hp: number[] }

/** A freighter's slot, a derelict's: its ship if it was there, else when it's due back (world tick) */
export interface TrafficMemory { id: string; leg: number; dwell: number; respawnAt?: number; ship?: ShipMemory }
export interface DerelictMemory { id: string; spawns: number; respawnAt?: number; ship?: ShipMemory }

/** A system as it was put away (times as world ticks) */
export interface SystemSnapshot {
  at: number;
  packs: PackMemory[];
  bosses: BossMemory[];
  traffic: TrafficMemory[];
  derelicts: DerelictMemory[];
}

/** Every spawner's clock (when each may send, launch, rebuild next), by system or boss id: world ticks */
export interface MemoryTimers { enemies: Record<string, Record<string, number>>; bosses: Record<string, number> }

/** data/world/memory.json */
export interface MemoryFile {
  version: number;
  /** Wall clock (ms) and world tick when it was written */
  savedAt: number;
  worldTick: number;
  timers: MemoryTimers;
  /** Every remembered system, by id: put away, or as it was when written */
  systems: Record<string, SystemSnapshot>;
}

export interface WorldStore {
  /** What was written last (null: nothing, or nothing readable) */
  load(): unknown;
  save(data: MemoryFile): Promise<void>;
}

export interface MemoryHost {
  tick(): number;
  /** Wall clock, ms */
  now(): number;
  /** The systems remembered (the world's own: not an arena's copies, surfaces or pilots' stations) */
  systems(): { num: number; id: string }[];
  /** Systems pilots are in now; ones they're about to be in (at a gate's or rift's mouth) */
  occupied(): Set<number>;
  approaching(): Set<number>;
  /** A system as it is now (`evict`: and taken out of the world) */
  capture(num: number, offset: number, evict: boolean): Omit<SystemSnapshot, 'at'>;
  /** Put back as remembered: mended by these shares of max HP, its ships flown on from local tick `from` */
  restore(num: number, snap: SystemSnapshot, offset: number, mend: { ships: number; bosses: number }, from: number): void;
  timers(offset: number): MemoryTimers;
  setTimers(t: MemoryTimers, offset: number): void;
}

const round = (v: number, k: number) => Math.round(v * k) / k;

/** A ship as it is, at `at` (a distant one's route worked out: SimLod.where) */
export function shipMemory(ship: ShipState, at: FarPose): ShipMemory {
  return {
    x: round(at.x, 10), y: round(at.y, 10), vx: round(at.vx, 1000), vy: round(at.vy, 1000), a: round(at.angle, 1000),
    ...(at.angVel ? { av: round(at.angVel, 1e6) } : {}),
    hp: ship.hp.map((h, i) => (ship.detached[i] || !(ship.maxHp[i] > 0) ? 0 : round(Math.min(1, h / ship.maxHp[i]), 1000))),
  };
}

/** Each part's HP back as remembered, mended by `heal` (a share of its max); a design that's changed since comes back whole */
export function restoreHp(ships: ShipBridge, eid: number, hp: number[], heal: number): void {
  const ship = ships.get(eid);
  if (!ship || hp.length !== ship.blueprint.parts.length) return;
  const by = new Map(ship.blueprint.parts.map((p, i) => [p.uid, Math.min(1, (hp[i] ?? 1) + heal)]));
  if ([...by.values()].every((f) => f >= 1)) return;
  ships.setPartHp(eid, (uid) => by.get(uid) ?? 1);
}

export class SystemMemory {
  /** World tick = server tick + this */
  offset = 0;
  readonly rules: MemoryRules;
  /** The remembered systems by number, and which are in the world now (the rest are put away) */
  private ids = new Map<number, string>();
  private resident = new Set<number>();
  private kept = new Map<string, SystemSnapshot>();
  /** When each resident system was last seen empty (put away after evictAfterSeconds) */
  private emptySince = new Map<number, number>();
  private near = new Set<number>();
  /** Systems being brought back a batch a tick (a pilot's at a gate's mouth): what's still to come, and how */
  private coming = new Map<number, { parts: SystemSnapshot[]; mend: { ships: number; bosses: number }; from: number }>();
  private lastSave: number;
  private saving: Promise<void> = Promise.resolve();

  constructor(private host: MemoryHost, rules: unknown, private store?: WorldStore, private log: (msg: string) => void = (m) => console.log(`[Memory] ${m}`)) {
    this.rules = mergeRules(MEMORY_RULES, rules);
    for (const s of host.systems()) this.ids.set(s.num, s.id);
    this.lastSave = host.tick();
  }

  /** Read what was kept (once, before the world's built): systems remembered there are put away, not built fresh */
  load(): void {
    const raw = this.store?.load() as Partial<MemoryFile> | null | undefined;
    const ok = !!raw && raw.version === MEMORY_VERSION && typeof raw.worldTick === 'number' && typeof raw.savedAt === 'number' && typeof raw.systems === 'object' && !!raw.systems;
    if (raw && !ok) this.log(`the kept world is in another format (version ${String((raw as { version?: unknown }).version)}): starting fresh`);
    if (ok) {
      const file = raw as MemoryFile;
      const down = Math.max(0, this.host.now() - file.savedAt);
      this.offset = file.worldTick + Math.round((down * 60) / 1000) - this.host.tick();
      const known = new Set(this.ids.values());
      for (const [id, snap] of Object.entries(file.systems)) if (known.has(id) && snap && typeof snap.at === 'number') this.kept.set(id, snap);
      if (file.timers) this.host.setTimers(file.timers, this.offset);
      this.log(`${this.kept.size} systems remembered, written ${Math.round(down / 60000)} min ago`);
    }
    for (const [num, id] of this.ids) if (!this.kept.has(id)) this.resident.add(num);
  }

  /** Is this system put away (built from memory when a pilot comes, not fresh) */
  remembers(id: string): boolean {
    return this.kept.has(id);
  }

  worldTick(): number {
    return this.host.tick() + this.offset;
  }

  /** Once a tick, before anything's spawned: bring back what pilots are in or coming to, put away what's been left */
  tick(): void {
    const now = this.host.tick();
    const here = this.host.occupied();
    // (Gate and rift mouths: a few times a second is plenty, they're seconds from going through)
    if (now % 15 === 0) this.near = this.host.approaching();
    for (const num of here) this.enter(num);
    for (const [num, c] of this.coming) {
      this.host.restore(num, c.parts.shift()!, this.offset, c.mend, c.from);
      if (!c.parts.length) this.coming.delete(num);
    }
    for (const num of this.near) { if (!here.has(num)) this.prefetch(num); here.add(num); }
    if (now % 30 === 0) {
      for (const num of this.resident) {
        if (here.has(num)) continue;
        const since = this.emptySince.get(num) ?? now;
        this.emptySince.set(num, since);
        if (now - since >= this.rules.evictAfterSeconds * 60) this.putAway(num);
      }
    }
    if (this.store && now - this.lastSave >= this.rules.saveSeconds * 60) { this.lastSave = now; void this.save(); }
  }

  /** A pilot is in, or arriving in, this system: it's in the world (all of it back now, if it was put away) */
  enter(num: number): void {
    this.emptySince.delete(num);
    this.prefetch(num);
    const c = this.coming.get(num);
    if (!c) return;
    this.coming.delete(num);
    for (const part of c.parts) this.host.restore(num, part, this.offset, c.mend, c.from);
  }

  /**
   * A pilot's coming (at a gate's mouth): it's in the world from now, its
   * ships brought back MEMORY_BATCH a tick from here on (the first now), so
   * a big system costs no one tick much. Each is flown on from the same
   * moment, mended as much: it's as if they'd all come back at once.
   */
  private prefetch(num: number): void {
    this.emptySince.delete(num);
    if (!this.ids.has(num) || this.resident.has(num)) return;
    this.resident.add(num);
    const id = this.ids.get(num)!, snap = this.kept.get(id);
    this.kept.delete(id);
    if (!snap) return;
    const away = Math.max(0, this.worldTick() - snap.at), minutes = away / 3600;
    const mend = { ships: Math.min(1, minutes * this.rules.healPerMinute), bosses: Math.min(1, minutes * this.rules.bossHealPerMinute) };
    const from = this.host.tick() - Math.min(away, this.rules.fastForwardMinutes * 3600);
    const [first, ...parts] = batches(snap, MEMORY_BATCH);
    this.host.restore(num, first, this.offset, mend, from);
    if (parts.length) this.coming.set(num, { parts, mend, from });
  }

  /** (tests, tools) put a system away now */
  putAway(num: number): void {
    const id = this.ids.get(num);
    if (!id || !this.resident.has(num)) return;
    // (Still coming back: all of it first, so nothing's lost)
    this.enter(num);
    this.kept.set(id, { at: this.worldTick(), ...this.host.capture(num, this.offset, true) });
    this.resident.delete(num);
    this.emptySince.delete(num);
  }

  /** Is this system in the world now (not put away) */
  isResident(num: number): boolean {
    return !this.ids.has(num) || this.resident.has(num);
  }

  /** Everything as it is, for the store: what's put away, and what's in the world as it is now */
  snapshot(): MemoryFile {
    // (Anything still coming back is all brought back first: nothing's written half there)
    for (const num of [...this.coming.keys()]) this.enter(num);
    const systems: Record<string, SystemSnapshot> = Object.fromEntries(this.kept);
    for (const num of this.resident) systems[this.ids.get(num)!] = { at: this.worldTick(), ...this.host.capture(num, this.offset, false) };
    return { version: MEMORY_VERSION, savedAt: this.host.now(), worldTick: this.worldTick(), timers: this.host.timers(this.offset), systems };
  }

  /** Write it all to the store (one write at a time; the last asked for is the one that lands) */
  save(): Promise<void> {
    if (!this.store) return Promise.resolve();
    const data = this.snapshot();
    this.saving = this.saving.then(() => this.store!.save(data)).catch((e) => this.log(`couldn't write the world: ${(e as Error).message}`));
    return this.saving;
  }
}

/** A snapshot cut into pieces of about `n` ships each (whole packs; the first holds everything else that isn't a ship, if any) */
function batches(snap: SystemSnapshot, n: number): SystemSnapshot[] {
  const out: SystemSnapshot[] = [];
  let cur: SystemSnapshot | null = null, size = 0;
  const piece = () => { if (!cur || size >= n) { cur = { at: snap.at, packs: [], bosses: [], traffic: [], derelicts: [] }; out.push(cur); size = 0; } return cur; };
  for (const p of snap.packs ?? []) { piece().packs.push(p); size += p.members.length; }
  for (const b of snap.bosses ?? []) { piece().bosses.push(b); size++; }
  for (const t of snap.traffic ?? []) { piece().traffic.push(t); size += t.ship ? 1 : 0; }
  for (const d of snap.derelicts ?? []) { piece().derelicts.push(d); size += d.ship ? 1 : 0; }
  return out.length ? out : [{ at: snap.at, packs: [], bosses: [], traffic: [], derelicts: [] }];
}

/** The memory as a JSON file, written whole and swapped in (never half written) */
export function worldFileStore(file: string): WorldStore {
  return {
    load: () => {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[Memory] couldn't read ${file}: ${(e as Error).message}: starting a fresh world`);
        return null;
      }
      try { return JSON.parse(text); } catch {
        const bad = `${file}.bad-${Date.now()}`;
        try { renameSync(file, bad); } catch { /* (it's overwritten at the next save) */ }
        console.warn(`[Memory] ${file} can't be read (kept as ${bad}): starting a fresh world`);
        return null;
      }
    },
    save: async (data) => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    },
  };
}
