/**
 * Hangar slots: the ship you fly plus designs you're building (profile.hangar).
 *
 * Saving a design to a slot builds in what you have (parts already on that
 * ship, then storage, then modules in your hold) from the core outwards; the
 * rest are ghosts, which you can design with as long as you know how to make
 * them (an admin's free build on a dev server takes nothing and needs no licence). Structure (hull,
 * armour, holds) is paid for in refined materials as it goes in, and its
 * wires in wire spools (one lays four segments) as the design is saved;
 * modules (weapons, generators, thrusters...) take their fabricated item
 * (econ/salvage.ts). Ghosts fill in by themselves as what they take reaches
 * storage, always from the core outwards so nothing ever hangs loose. The
 * ship you fly fills only while you're at a station; the others sit in the
 * hangar and fill whenever the materials arrive. Taking parts out of a design
 * loses nothing: modules go back to storage, structure back to materials.
 *
 * "Build" puts a slot on order: the hangar refines ore, fabricates modules
 * and fits them, a step at a time as materials allow, until it's whole (tick).
 * A ship lost in battle comes back to its slot as ghosts on order, with its
 * salvage in storage (Pilots.onDestroyed), and can't be flown until it's
 * whole; you're lent a starter ship meanwhile. Scrapping a slot breaks its
 * built parts down to salvage. Fly any slot whose core is built.
 *
 * Orders are worked in priority order (econ/orders.ts: the first takes what
 * it needs first). One can be held (it starts nothing new, and its jobs
 * wait), resumed, moved to the front, or called off (its jobs refunded).
 */

import {
  Blueprint, Bag, Economy, ShipRecord, PlayerProfile, Catalog, ServerMessage, unlocks,
  partItemId, canCraft, countOf, addTo, removeFrom, installableGhosts, setActiveShip, placeGeometry, computeJoins,
  placeCost, ghostBill, salvageParts, orderRanking, CraftJob, partLicensed, wireSpools, WIRE_ITEM,
  socketsFor, setPartGems, parseGemItemId, type GemsFile, buildPoints, shipLoadout } from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';
import type { StationServices, JobTag } from './StationServices.js';
import type { ShipBridge } from '../ships/ShipBridge.js';

export interface HangarHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  now(): number;
  /** Free build is on for them (a dev server's admin): their hangar shows it */
  freeBuild?(conn: PilotConn): boolean;
}

type PartState = 'intact' | 'wrecked' | 'ghost';

export class Hangar {
  /** Cut gems and sockets (data/gems.json) */
  gems?: GemsFile;

  constructor(
    private host: HangarHost, private pilots: Pilots, private ships: ShipBridge,
    private econ: Economy, private catalog: Catalog, private services: StationServices,
  ) {}

  // ---------------------------------------------------------------------------
  // Licences
  // ---------------------------------------------------------------------------

  /**
   * Which new parts a pilot may put on a ship: their material and function are
   * licensed (econ/market.ts partLicensed: models and materials by level), or a plan they know calls for that
   * many of them (a plan is a reward: its design is buildable as given)
   */
  private licensedFor(p: PlayerProfile, plan?: string, design?: string): (q: { material: string; fn: string; piece: string }) => boolean {
    const learned = p.recipes;
    const budget = new Map<string, number>();
    // No plan named: a known plan of the same design counts (refitting in the editor)
    const known = plan && p.plans.includes(plan) ? plan : design ? p.plans.find((k) => this.ships.library.get(k)?.name === design) : undefined;
    const planBp = known ? this.ships.library.get(known) : undefined;
    for (const q of planBp?.parts ?? []) budget.set(partItemId(q), (budget.get(partItemId(q)) ?? 0) + 1);
    return (q) => {
      if (partLicensed(q, learned, p.level)) return true;
      const id = partItemId(q), left = budget.get(id) ?? 0;
      if (left <= 0) return false;
      budget.set(id, left - 1);
      return true;
    };
  }

  // ---------------------------------------------------------------------------
  // State of a slot's parts
  // ---------------------------------------------------------------------------

  /** Each part's state in a slot (the active slot reads the live ship) */
  private states(conn: PilotConn, p: PlayerProfile, slot: number): Map<number, PartState> {
    const out = new Map<number, PartState>();
    const rec = p.hangar[slot];
    if (!rec) return out;
    const ghosts = new Set(rec.ghosts ?? []);
    const live = slot === p.activeSlot ? this.ships.get(conn.playerId) : undefined;
    rec.blueprint.parts.forEach((part, i) => {
      if (ghosts.has(part.uid)) out.set(part.uid, 'ghost');
      else if (live) out.set(part.uid, live.derived.alive[i] ? 'intact' : 'wrecked');
      else out.set(part.uid, (rec.hp[part.uid] ?? 1) > 0 ? 'intact' : 'wrecked');
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  /**
   * Save a design to a slot. Returns errors (empty = saved). Unchanged parts
   * keep their state; new ones are built from what you have where they join
   * the built structure, and are ghosts otherwise.
   */
  save(conn: PilotConn, slot: number, bp: Blueprint, opts: { plan?: string; grantAll?: boolean } = {}): string[] {
    const p = this.pilots.get(conn);
    if (!p) return ['no pilot'];
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.hangar.length) return ['no such hangar slot'];
    if (!bp.parts.some((q) => q.fn === 'core')) return ['a ship needs a core'];
    if (p.hangar[slot]?.loaner && !opts.grantAll) return ['this is a loaner: refit a ship of your own (or design one in an empty slot)'];
    // Everything you can't build from what you have must be something you can make
    const old = p.hangar[slot];
    const prior = this.states(conn, p, slot);
    const oldPart = new Map((old?.blueprint.parts ?? []).map((q) => [q.uid, q]));
    // A gun's gems (and the mods they make) are the server's to give: a design only keeps those its unchanged guns already carry
    for (const q of bp.parts) {
      const o = oldPart.get(q.uid);
      const keepGems = o?.gems?.length && o.fn === q.fn && o.material === q.material && o.piece === q.piece ? o.gems : [];
      if (this.gems) setPartGems(this.gems, q, keepGems);
      else { delete q.mods; delete q.gems; }
    }
    const keep =(uid: number, id: string): PartState | null => {
      const q = oldPart.get(uid);
      return q && partItemId(q) === id ? prior.get(uid) ?? null : null;
    };
    // The pool: storage and the modules in your hold, plus what intact parts the new design drops come back as
    const pool: Bag = {};
    for (const s of p.storage) pool[s.id] = s.n;
    for (const s of p.cargo) if (this.econ.items.get(s.id)?.category === 'part') pool[s.id] = (pool[s.id] ?? 0) + s.n;
    const newUids = new Set(bp.parts.map((q) => q.uid));
    const freed: Bag = {};
    const free = (q: { material: string; fn: string; piece: string }) => {
      for (const [id, n] of Object.entries(placeCost(this.econ, q))) { pool[id] = (pool[id] ?? 0) + n; freed[id] = (freed[id] ?? 0) + n; }
    };
    for (const q of old?.blueprint.parts ?? []) {
      const id = partItemId(q);
      const st = prior.get(q.uid);
      if (st === 'intact' && (!newUids.has(q.uid) || partItemId(bp.parts.find((x) => x.uid === q.uid)!) !== id)) free(q);
    }
    const affordable = (q: { material: string; fn: string; piece: string }) => Object.entries(placeCost(this.econ, q)).every(([id, n]) => (pool[id] ?? 0) >= n);
    const learned = p.recipes;
    const missing: string[] = [];
    const unlicensed: string[] = [];
    const allowed = this.licensedFor(p, opts.plan ?? (old && old.blueprint.name === bp.name ? old.plan : undefined), bp.name);
    for (const q of bp.parts) {
      const id = partItemId(q);
      if (opts.grantAll || keep(q.uid, id) !== null) continue;
      // Plates in storage or a salvaged module don't teach you to fit it
      if (!allowed(q)) { unlicensed.push(this.econ.items.name(id)); continue; }
      const r = this.econ.recipes.recipeFor(id);
      if (!affordable(q) && !(r && canCraft(r, learned, p.level))) missing.push(this.econ.items.name(id));
    }
    // Build points: how big (and how good) a ship of yours may be (more as you level). A plan builds as designed; a ship already past it may stay so, not grow
    const cap = unlocks(p).complexity, cost = buildPoints(this.catalog, bp);
    if (cost > cap && !opts.grantAll && !(opts.plan ?? old?.plan) && cost > (old ? buildPoints(this.catalog, old.blueprint) : 0)) {
      return [`at level ${p.level} your ships can cost up to ${cap} build points (this one costs ${cost}: every cell counts, better grades more): more as you level`];
    }
    if (unlicensed.length) return [`you aren't licensed to fit ${[...new Set(unlicensed)].slice(0, 3).join(', ')}: each opens at its level`];
    if (missing.length) return [`you can't make ${[...new Set(missing)].slice(0, 3).join(', ')} yet: it opens at its level`];
    // Wires: a spool lays four segments, paid as the design is saved (taken out, they come back; an unwired design is auto-wired, free)
    const spools = opts.grantAll ? 0 : wireSpools(bp.wires?.length ?? 0) - wireSpools(old?.blueprint.wires?.length ?? 0);
    if (spools > 0 && (pool[WIRE_ITEM] ?? 0) < spools) return [`you need ${spools} wire spool${spools > 1 ? 's' : ''} to lay those wires (you have ${pool[WIRE_ITEM] ?? 0}): the fabricator makes them`];

    // Build from the core outwards through intact parts
    const geoms = bp.parts.map((q) => placeGeometry(this.catalog, q));
    const adj: number[][] = bp.parts.map(() => []);
    for (const [a, b] of computeJoins(geoms)) { adj[a].push(b); adj[b].push(a); }
    const core = bp.parts.findIndex((q) => q.fn === 'core');
    const state = new Map<number, PartState>();
    const used: Bag = {};
    const take = (q: { material: string; fn: string; piece: string }): boolean => {
      if (opts.grantAll) return true;
      if (!affordable(q)) return false;
      for (const [id, n] of Object.entries(placeCost(this.econ, q))) { pool[id] -= n; used[id] = (used[id] ?? 0) + n; }
      return true;
    };
    if (spools > 0) { pool[WIRE_ITEM] -= spools; used[WIRE_ITEM] = spools; }
    else if (spools < 0) freed[WIRE_ITEM] = (freed[WIRE_ITEM] ?? 0) - spools;
    const queue: number[] = [];
    const seen = new Set<number>();
    const visit = (i: number) => {
      const q = bp.parts[i];
      const id = partItemId(q);
      const k = keep(q.uid, id);
      let st: PartState;
      if (k === 'intact') st = 'intact';
      else if (k === 'wrecked') st = 'wrecked';
      else st = take(q) ? 'intact' : 'ghost';
      state.set(q.uid, st);
      if (st === 'intact') for (const j of adj[i]) if (!seen.has(j)) { seen.add(j); queue.push(j); }
    };
    seen.add(core);
    visit(core);
    if (state.get(bp.parts[core].uid) === 'ghost' && slot === p.activeSlot) return ['you need a core for the ship you fly'];
    while (queue.length) visit(queue.shift()!);
    // Unreached: ghosts (an intact part that's now cut off goes back to storage)
    for (const q of bp.parts) {
      if (state.has(q.uid)) continue;
      if (keep(q.uid, partItemId(q)) === 'intact') free(q);
      state.set(q.uid, 'ghost');
    }

    // Storage: give back freed parts, take used ones (pool already netted them)
    if (!opts.grantAll) {
      for (const [id, n] of Object.entries(freed)) addTo(p.storage, id, n);
      // (from storage first, then the hold)
      for (const [id, n] of Object.entries(used)) { const left = n - removeFrom(p.storage, id, n); if (left > 0) removeFrom(p.cargo, id, left); }
    }
    const hp: Record<number, number> = {};
    const ghosts: number[] = [];
    for (const q of bp.parts) {
      const st = state.get(q.uid)!;
      if (st === 'ghost') ghosts.push(q.uid);
      else if (st === 'wrecked') hp[q.uid] = 0;
      else if (keep(q.uid, partItemId(q)) === 'intact' && old) {
        const f = slot === p.activeSlot ? this.liveHp(conn, q.uid) : old.hp[q.uid];
        if (f !== undefined && f < 0.999) hp[q.uid] = f;
      }
    }
    const rec: ShipRecord = {
      blueprint: bp, hp, ghosts: this.coreOutwards(bp, ghosts, adj, core), plan: opts.plan ?? (old && old.blueprint.name === bp.name ? old.plan : undefined),
      // A lost ship stays lost (and on order) until it's whole
      ...(old?.lost && ghosts.length ? { lost: true, auto: true } : old?.auto && ghosts.length ? { auto: true } : {}),
      // Its ammunition loadout stays with it (crates for guns it no longer has are simply not carried)
      ...(old?.ammo ? { ammo: old.ammo } : {}),
    };
    if (slot === p.activeSlot) {
      setActiveShip(p, rec, slot);
      this.pilots.reapplyShip(conn);
      this.pilots.emitRefit(conn);
    } else {
      p.hangar[slot] = rec;
    }
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.fill(conn);
    this.pilots.saveNow(conn);
    this.send(conn);
    return [];
  }

  /** Fly the ship in another slot (at a station; its core must be built) */
  fly(conn: PilotConn, slot: number): void {
    const p = this.pilots.get(conn);
    const rec = p?.hangar[slot];
    if (!p || !rec || slot === p.activeSlot) return;
    if (!this.pilots.atStation(conn)) return this.pilots.toast(conn, 'Swap ships at a station', 'warn');
    const core = rec.blueprint.parts.find((q) => q.fn === 'core');
    if (rec.lost) {
      const total = rec.blueprint.parts.length, built = total - (rec.ghosts ?? []).length;
      return this.pilots.toast(conn, `The ${rec.blueprint.name} is still being rebuilt (${built}/${total} parts): you can fly it once it's whole`, 'warn');
    }
    if (!core || (rec.ghosts ?? []).includes(core.uid)) return this.pilots.toast(conn, `The ${rec.blueprint.name} needs its core built first`, 'warn');
    this.pilots.captureNow(conn);
    const was = p.activeSlot;
    setActiveShip(p, rec, slot);
    // The loaner goes back
    if (p.hangar[was]?.loaner) this.dropSlot(p, was);
    this.pilots.reapplyShip(conn);
    this.pilots.emitRefit(conn);
    this.pilots.toast(conn, `Now flying the ${rec.blueprint.name}`, 'good');
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.pilots.saveNow(conn);
    this.send(conn);
  }

  /**
   * Scrap a slot you're not flying: its built parts break down to salvage
   * (ore and components: econ/salvage.ts). A loaner just goes back.
   */
  scrap(conn: PilotConn, slot: number): void {
    const p = this.pilots.get(conn);
    const rec = p?.hangar[slot];
    if (!p || !rec || slot === p.activeSlot) return;
    if (!rec.loaner) {
      const ghosts = new Set(rec.ghosts ?? []);
      const salvage = salvageParts(this.econ, rec.blueprint.parts.filter((q) => !ghosts.has(q.uid) && (rec.hp[q.uid] ?? 1) > 0));
      for (const [id, n] of Object.entries(salvage)) addTo(p.storage, id, n);
      const n = Object.values(salvage).reduce((t, k) => t + k, 0);
      this.pilots.toast(conn, `Scrapped the ${rec.blueprint.name}: ${n} items of salvage in storage`, 'info');
    }
    this.dropSlot(p, slot);
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.pilots.saveNow(conn);
    this.send(conn);
  }

  // ---------------------------------------------------------------------------
  // Gems
  // ---------------------------------------------------------------------------

  /** A part on a slot's ship, at a station, for socket work: the record and part, or why not */
  private socketPart(conn: PilotConn, slot: number, uid: number): { p: PlayerProfile; rec: ShipRecord; part: Blueprint['parts'][number] } | string {
    const p = this.pilots.get(conn);
    if (!p || !this.gems) return 'no pilot';
    if (!this.pilots.atStation(conn)) return 'Socket gems at a station';
    const rec = p.hangar[slot];
    const part = rec?.blueprint.parts.find((q) => q.uid === uid);
    if (!rec || !part) return 'No such part';
    return { p, rec, part };
  }

  /** The record's design with one part's gems changed (a copy, so the ship flying keeps its own until it's put on again) */
  private regem(conn: PilotConn, p: PlayerProfile, slot: number, rec: ShipRecord, uid: number, gems: string[]): void {
    const bp: Blueprint = JSON.parse(JSON.stringify(rec.blueprint));
    const part = bp.parts.find((q) => q.uid === uid)!;
    setPartGems(this.gems!, part, gems);
    const next = { ...rec, blueprint: bp };
    if (slot === p.activeSlot) {
      this.pilots.captureNow(conn);
      setActiveShip(p, { ...p.ship, blueprint: bp }, slot);
      this.pilots.reapplyShip(conn);
    } else p.hangar[slot] = next;
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.pilots.saveNow(conn);
    this.send(conn);
  }

  /** Put a gem from storage (or the hold) into a free socket */
  socketGem(conn: PilotConn, slot: number, uid: number, gem: string): void {
    const at = this.socketPart(conn, slot, uid);
    if (typeof at === 'string') return this.pilots.toast(conn, at, 'warn');
    const { p, rec, part } = at;
    if (!parseGemItemId(gem) || !this.econ.items.get(gem)?.socket) return;
    const free = socketsFor(this.gems!, this.catalog, part, p.level) - (part.gems?.length ?? 0);
    if (free <= 0) {
      const any = socketsFor(this.gems!, this.catalog, part, 100);
      return this.pilots.toast(conn, any ? (part.gems?.length ? 'Its sockets are full' : 'No socket on it at your level yet') : 'That part has no sockets: steel and better weapons do', 'warn');
    }
    if (!this.pilots.take(conn, { [gem]: 1 })) return this.pilots.toast(conn, `You have no ${this.econ.items.name(gem)}`, 'warn');
    this.regem(conn, p, slot, rec, uid, [...(part.gems ?? []), gem]);
    this.pilots.toast(conn, `${this.econ.items.name(gem)} set into the ${this.econ.items.name(partItemId(part))}`, 'good');
  }

  /** Take a gem out: it doesn't survive it */
  unsocketGem(conn: PilotConn, slot: number, uid: number, index: number): void {
    const at = this.socketPart(conn, slot, uid);
    if (typeof at === 'string') return this.pilots.toast(conn, at, 'warn');
    const { p, rec, part } = at;
    const gems = [...(part.gems ?? [])];
    if (!(index >= 0 && index < gems.length)) return;
    const [gone] = gems.splice(index, 1);
    this.regem(conn, p, slot, rec, uid, gems);
    this.pilots.toast(conn, `The ${this.econ.items.name(gone)} cracked coming out`, 'info');
  }

  /** A gemmed part of the ship you fly was destroyed: its gems are gone (the flying ship keeps its design until it's put on again) */
  gemsLost(conn: PilotConn, uid: number): void {
    const p = this.pilots.get(conn);
    const part = p?.ship.blueprint.parts.find((q) => q.uid === uid);
    if (!p || !part?.gems?.length || !this.gems) return;
    const names = part.gems.map((g) => this.econ.items.name(g));
    const bp: Blueprint = JSON.parse(JSON.stringify(p.ship.blueprint));
    setPartGems(this.gems, bp.parts.find((q) => q.uid === uid)!, []);
    // The record only: the live ship's part is gone anyway, and changes when it's next put on
    p.ship.blueprint = bp;
    p.hangar[p.activeSlot] = p.ship;
    this.pilots.markDirty(conn);
    this.pilots.toast(conn, `Lost with the part: ${names.join(', ')}`, 'bad');
  }

  /** Empty a slot (a loaner's slot past the pilot's bays goes altogether) */
  private dropSlot(p: PlayerProfile, slot: number): void {
    const bays = unlocks(p).hangarSlots;
    if (slot >= bays && p.hangar.length > bays) {
      p.hangar.splice(slot, 1);
      if (p.activeSlot > slot) p.activeSlot--;
    } else {
      p.hangar[slot] = null;
    }
  }

  /** Put a slot on order: the hangar refines, fabricates and fits what it needs from here on, as materials allow */
  build(conn: PilotConn, slot: number): void {
    const p = this.pilots.get(conn);
    const rec = p?.hangar[slot];
    if (!p || !rec) return;
    if (!(rec.ghosts ?? []).length) return this.pilots.toast(conn, `The ${rec.blueprint.name} is already built`, 'info');
    rec.auto = true;
    rec.paused = false;
    // New orders go after the ones already running
    rec.rank = p.hangar.reduce((m, r, i) => (r?.auto && i !== slot ? Math.max(m, r.rank ?? 0) : m), 0) + 1;
    const r = this.work(conn, slot);
    const doing: string[] = [];
    if (r.refining) doing.push(`refining ${r.refining}`);
    if (r.fabricating) doing.push(`fabricating ${r.fabricating}`);
    const short = r.short.length ? `. Still short of ${r.short.slice(0, 3).join(', ')}` : '';
    this.pilots.toast(conn, `${rec.blueprint.name} on order${doing.length ? `: ${doing.join(', ')}` : ''}. Parts go in as they're ready${short}`, r.short.length && !doing.length ? 'warn' : 'good');
    this.pilots.sendItems(conn);
    this.fill(conn);
    this.pilots.markDirty(conn);
    this.pilots.saveNow(conn);
    this.send(conn);
  }

  /** A slot's order: hold it, carry on, call it off, or work it first */
  order(conn: PilotConn, slot: number, action: 'pause' | 'resume' | 'cancel' | 'top'): void {
    const p = this.pilots.get(conn);
    const rec = p?.hangar[slot];
    if (!p || !rec || !rec.auto) return;
    this.services.deliver(conn);
    const name = rec.blueprint.name;
    const jobs = p.jobs.filter((j) => j.slot === slot && j.for === name);
    if (action === 'pause') {
      rec.paused = true;
      this.services.hold(p, jobs);
      this.pilots.toast(conn, `${name}: order on hold`, 'info');
    } else if (action === 'resume') {
      rec.paused = false;
      this.services.release(p, jobs);
      this.work(conn, slot);
      this.pilots.toast(conn, `${name}: order resumed`, 'good');
    } else if (action === 'cancel') {
      if (rec.lost) return this.pilots.toast(conn, `The ${name} was lost: it stays on order until it's rebuilt (hold it, or scrap it)`, 'warn');
      rec.auto = false;
      rec.paused = false;
      delete rec.rank;
      this.services.cancelJobs(conn, jobs);
      this.pilots.toast(conn, `${name}: order called off${jobs.length ? ', its materials are back in storage' : ''}`, 'info');
    } else if (action === 'top') {
      rec.rank = p.hangar.reduce((m, r) => (r?.auto ? Math.min(m, r.rank ?? 0) : m), 0) - 1;
      // Its jobs go to the front of their queues (in their order)
      for (const j of [...jobs].reverse()) this.services.jobAction(conn, j.id, 'top', true);
      this.pilots.toast(conn, `${name} goes first`, 'good');
    }
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.fill(conn);
    this.pilots.saveNow(conn);
    this.send(conn);
    this.services.sendStation(conn);
  }

  /** A job called off at the refinery or fabricator: hold its order, or it would just queue it again */
  jobCancelled(conn: PilotConn, job: CraftJob): void {
    const p = this.pilots.get(conn);
    const rec = job.slot !== undefined ? p?.hangar[job.slot] : null;
    if (!p || !rec?.auto || rec.paused || rec.blueprint.name !== job.for) return;
    rec.paused = true;
    this.services.hold(p, p.jobs.filter((j) => j.slot === job.slot && j.for === job.for));
    this.pilots.toast(conn, `The ${rec.blueprint.name}'s order is on hold so it isn't queued again: resume it from Ships`, 'info');
    this.send(conn);
  }

  /** What's on its way to storage (unfinished jobs' output) */
  private coming(p: PlayerProfile): Bag {
    const out: Bag = {};
    for (const j of p.jobs) for (const [id, n] of Object.entries(j.out)) out[id] = (out[id] ?? 0) + n * (j.count - j.done);
    return out;
  }

  /** What a slot's ghosts still need beyond storage and what's being made (modules as items, structure as materials) */
  stillNeeded(p: PlayerProfile, slot: number): Bag {
    const rec = p.hangar[slot];
    if (!rec) return {};
    const need = ghostBill(this.econ, rec.blueprint, rec.ghosts ?? []);
    const coming = this.coming(p);
    for (const id of Object.keys(need)) need[id] = Math.max(0, need[id] - countOf(p.storage, id) - (coming[id] ?? 0));
    return need;
  }

  /**
   * One step of a slot's order: fabricate the modules it's short of (from the
   * materials in storage), then supply whatever materials are still short
   * (structure's, and the modules'): refined from ore, or fabricated if
   * they're components (a power coupling, from wire and electronics). What
   * can't be made from what you have is reported short.
   */
  private work(conn: PilotConn, slot: number): { refining: number; fabricating: number; short: string[] } {
    const p = this.pilots.get(conn)!;
    const rec = p.hangar[slot]!;
    const out = { refining: 0, fabricating: 0, short: [] as string[] };
    if (rec.paused) return out;
    const tag = { for: rec.blueprint.name, slot };
    const need = ghostBill(this.econ, rec.blueprint, rec.ghosts ?? []);
    const avail = (id: string) => countOf(p.storage, id) + (this.coming(p)[id] ?? 0);
    // Materials wanted in all: structure's own, plus the inputs of modules still to fabricate
    const materials: Bag = {};
    for (const [id, n] of Object.entries(need)) {
      if (this.econ.recipes.refining.has(id)) { materials[id] = (materials[id] ?? 0) + n; continue; }
      const left = n - avail(id);
      if (left <= 0) continue;
      const r = this.econ.recipes.recipeFor(id);
      if (!r || !canCraft(r, this.services.learned(p), p.level)) { out.short.push(this.econ.items.name(id)); continue; }
      const fab = this.services.workshop(conn, 'fabricator');
      const k = fab ? this.services.makeFor(conn, fab, id, left, tag) : 0;
      out.fabricating += k;
      if (k < left) for (const [m, q] of Object.entries(r.inputs)) materials[m] = (materials[m] ?? 0) + q * (left - k);
    }
    const got = this.supply(conn, materials, tag);
    out.refining += got.refining;
    out.fabricating += got.fabricating;
    out.short.push(...got.short);
    return out;
  }

  /**
   * Make what's short of these materials: refined from ore if they're
   * refined, fabricated if they're components with a recipe you know (and
   * those components' own inputs in turn, a few levels down). What's in
   * storage or already being made counts.
   */
  private supply(conn: PilotConn, materials: Bag, tag: JobTag): { refining: number; fabricating: number; short: string[] } {
    const p = this.pilots.get(conn)!;
    const out = { refining: 0, fabricating: 0, short: [] as string[] };
    const coming = this.coming(p);
    const avail = (id: string) => countOf(p.storage, id) + (coming[id] ?? 0);
    let wanted = materials;
    for (let depth = 0; depth < 3 && Object.keys(wanted).length; depth++) {
      const next: Bag = {};
      for (const [id, n] of Object.entries(wanted)) {
        const left = n - avail(id);
        if (left <= 0) continue;
        if (this.econ.recipes.refining.has(id)) {
          const ref = this.services.workshop(conn, 'refinery');
          const k = ref ? this.services.refineFor(conn, ref, id, left, tag) : 0;
          out.refining += k;
          if (k < left) out.short.push(`ore for ${this.econ.items.name(id)}`);
          continue;
        }
        const r = this.econ.recipes.recipeFor(id);
        if (!r || !canCraft(r, this.services.learned(p), p.level)) { out.short.push(this.econ.items.name(id)); continue; }
        const per = r.out[id] ?? 1;
        const runs = Math.ceil(left / per);
        const fab = this.services.workshop(conn, 'fabricator');
        const k = fab ? this.services.makeFor(conn, fab, id, runs, tag) : 0;
        out.fabricating += k;
        if (k < runs) for (const [m, q] of Object.entries(r.inputs)) next[m] = (next[m] ?? 0) + q * (runs - k);
      }
      wanted = next;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Fabrication orders
  // ---------------------------------------------------------------------------

  /** What each order last waited on (shown with it) */
  private orderWaits = new Map<string, string>();

  /** Order `n` of an item: it's made as its materials come in */
  orderItem(conn: PilotConn, item: string, n: number): void {
    const p = this.pilots.get(conn);
    const r = this.econ.recipes.recipeFor(item);
    if (!p || !r || !Number.isFinite(n) || n < 1) return;
    if (!canCraft(r, this.services.learned(p), p.level)) return this.pilots.toast(conn, "You don't know how to make that yet", 'warn');
    const orders = (p.fabOrders ??= []);
    if (orders.length >= 20) return this.pilots.toast(conn, 'Twenty orders at once is the most: let some finish', 'warn');
    const id = orders.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    orders.push({ id, item, n: Math.min(999, Math.floor(n)), made: 0 });
    this.pilots.markDirty(conn);
    this.pilots.toast(conn, `Ordered ${Math.floor(n)} × ${this.econ.items.name(item)}: what's short is refined as ore comes in, then it's made`, 'info');
    this.workOrders(conn);
    this.send(conn);
  }

  /** Call an order off: its refining jobs stop and give their ore back; what it made stays made */
  cancelOrder(conn: PilotConn, id: number): void {
    const p = this.pilots.get(conn);
    const o = p?.fabOrders?.find((x) => x.id === id);
    if (!p || !o) return;
    const tag = `order:${o.id}`;
    this.services.cancelJobs(conn, p.jobs.filter((j) => j.for === tag && j.done < j.count && j.recipe.startsWith('refine:')));
    p.fabOrders = p.fabOrders!.filter((x) => x !== o);
    if (!p.fabOrders.length) delete p.fabOrders;
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.send(conn);
  }

  /**
   * One step of each order, first come first: fabricate as many as storage
   * allows now; for the rest, refine the materials it's short of from the ore
   * in storage (what's already being refined counts). What it can't make yet
   * from anything it has, it waits for.
   */
  private workOrders(conn: PilotConn): boolean {
    const p = this.pilots.get(conn);
    if (!p?.fabOrders?.length) return false;
    let changed = false;
    for (const o of [...p.fabOrders]) {
      const r = this.econ.recipes.recipeFor(o.item);
      if (!r) continue;
      const tag = { for: `order:${o.id}`, slot: -1 };
      const per = r.out[o.item] ?? 1;
      let left = Math.ceil((o.n - o.made) / per);
      const fab = this.services.workshop(conn, 'fabricator');
      const k = fab && left > 0 ? this.services.makeFor(conn, fab, o.item, left, tag) : 0;
      if (k > 0) { o.made += k * per; left -= k; changed = true; }
      const waits: string[] = [];
      let refining = false;
      if (left > 0) {
        const coming = this.coming(p);
        for (const id of Object.keys(r.inputs)) if ((coming[id] ?? 0) > 0) refining = true;
        // Its inputs: refined from ore, or fabricated if they're components
        const want: Bag = {};
        for (const [id, q] of Object.entries(r.inputs)) want[id] = q * left;
        const got = this.supply(conn, want, tag);
        if (got.refining || got.fabricating) { changed = true; refining = true; }
        waits.push(...got.short);
        if (!waits.length && k === 0 && !refining) waits.push(fab ? 'a free fabricator slot' : 'a fabricator');
      }
      const key = `${conn.playerId}:${o.id}`;
      if (o.made >= o.n) {
        p.fabOrders = p.fabOrders!.filter((x) => x !== o);
        this.orderWaits.delete(key);
        this.pilots.toast(conn, `Order done: ${o.n} × ${this.econ.items.name(o.item)} (into storage as each finishes)`, 'good');
        changed = true;
        continue;
      }
      const w = waits.length ? `waiting for ${waits.join(', ')}` : refining ? 'refining its materials' : 'fabricating';
      if (this.orderWaits.get(key) !== w) { this.orderWaits.set(key, w); changed = true; }
    }
    if (!p.fabOrders?.length) delete p.fabOrders;
    if (changed) this.pilots.markDirty(conn);
    return changed;
  }

  /** Every second or so: slots on order take their next step (first in line first), and finished ones say so */
  tick(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    let changed = this.workOrders(conn);
    for (const slot of orderRanking(p.hangar)) {
      const rec = p.hangar[slot];
      if (!rec?.auto) continue;
      const r = this.work(conn, slot);
      if (r.refining || r.fabricating) changed = true;
    }
    p.hangar.forEach((rec) => {
      if (!rec?.auto || (rec.ghosts ?? []).length) return;
      rec.auto = false;
      rec.paused = false;
      delete rec.rank;
      changed = true;
      if (rec.lost) {
        rec.lost = false;
        this.pilots.toast(conn, `The ${rec.blueprint.name} is rebuilt: fly it from the hangar at a station`, 'good');
      } else {
        this.pilots.toast(conn, `The ${rec.blueprint.name} is built`, 'good');
      }
    });
    if (!changed) return;
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.fill(conn);
    this.send(conn);
  }

  /**
   * Fit parts from storage into ghosts, core outwards: every slot you're not
   * flying, and the one you fly while you're at a station.
   */
  fill(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    let fitted = 0;
    const atStation = this.pilots.atStation(conn);
    p.hangar.forEach((rec, slot) => {
      if (!rec || !(rec.ghosts ?? []).length) return;
      // Cheap check first: anything in storage this slot wants at all?
      if (!Object.keys(ghostBill(this.econ, rec.blueprint, rec.ghosts ?? [])).some((id) => countOf(p.storage, id) > 0)) return;
      const active = slot === p.activeSlot;
      if (active && !atStation) return;
      const live = active ? this.ships.get(conn.playerId) : undefined;
      // (Ghosts saved before a licence was checked still need one, or a plan that calls for them)
      const planned = new Set((rec.plan && p.plans.includes(rec.plan) ? this.ships.library.get(rec.plan)?.parts ?? [] : []).map(partItemId));
      const licensed = this.licensedFor(p);
      for (let guard = 0; guard < rec.blueprint.parts.length; guard++) {
        const ghosts = rec.ghosts ?? [];
        const ghostSet = new Set(ghosts);
        const structural = (i: number) => {
          const q = rec.blueprint.parts[i];
          if (ghostSet.has(q.uid)) return false;
          return live ? live.derived.alive[i] : (rec.hp[q.uid] ?? 1) > 0;
        };
        const affordable = (uid: number) => {
          const q = rec.blueprint.parts.find((x) => x.uid === uid)!;
          if (!licensed(q) && !planned.has(partItemId(q))) return false;
          return Object.entries(placeCost(this.econ, q)).every(([id, n]) => countOf(p.storage, id) >= n);
        };
        const next = installableGhosts(this.catalog, rec.blueprint, ghosts, structural).find(affordable);
        if (next === undefined) break;
        const part = rec.blueprint.parts.find((q) => q.uid === next)!;
        for (const [id, n] of Object.entries(placeCost(this.econ, part))) removeFrom(p.storage, id, n);
        rec.ghosts = ghosts.filter((u) => u !== next);
        delete rec.hp[next];
        if (live) {
          this.ships.installGhost(conn.playerId, next);
        }
        fitted++;
      }
    });
    if (!fitted) return;
    this.pilots.markDirty(conn);
    this.pilots.sendItems(conn);
    this.pilots.emitRefit(conn);
    this.send(conn);
  }

  send(conn: PilotConn): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    const now = this.host.now();
    this.host.send(conn, {
      type: 'hangar', active: p.activeSlot, now,
      jobs: p.jobs.map((j) => ({ ...j })),
      slots: p.hangar.map((rec, slot) => {
        if (!rec) return null;
        const states = this.states(conn, p, slot);
        return {
          blueprint: rec.blueprint, plan: rec.plan, ghosts: rec.ghosts ?? [],
          wrecked: [...states].filter(([, s]) => s === 'wrecked').map(([u]) => u),
          lost: rec.lost, auto: rec.auto, loaner: rec.loaner, paused: rec.paused, rank: rec.rank,
          loadout: shipLoadout(this.catalog, this.ships.tuning, rec.blueprint, rec.ammo),
          first: slot === p.activeSlot ? { ...p.ammo?.prefer, ...rec.ammo?.first } : rec.ammo?.first,
        };
      }),
      designs: Array.from({ length: unlocks(p).blueprintSlots }, (_, i) => p.designs?.[i] ?? null),
      budget: unlocks(p).complexity,
      orders: (p.fabOrders ?? []).map((o) => ({ ...o, waiting: this.orderWaits.get(`${conn.playerId}:${o.id}`) ?? '' })),
      ...(this.host.freeBuild?.(conn) ? { freeBuild: true } : {}),
    });
  }

  /** Save a design for later (a blueprint only: it builds nothing). Its gems stay with the ship it came from */
  saveDesign(conn: PilotConn, slot: number, bp: Blueprint): void {
    const p = this.pilots.get(conn);
    if (!p || !Number.isInteger(slot) || slot < 0 || slot >= unlocks(p).blueprintSlots) return;
    const clean: Blueprint = JSON.parse(JSON.stringify(bp));
    for (const q of clean.parts) { delete q.mods; delete q.gems; }
    const designs = p.designs ?? [];
    while (designs.length <= slot) designs.push(null);
    designs[slot] = clean;
    p.designs = designs;
    this.pilots.markDirty(conn);
    this.pilots.toast(conn, `Design saved: ${clean.name} (slot ${slot + 1})`, 'good');
    this.send(conn);
  }

  deleteDesign(conn: PilotConn, slot: number): void {
    const p = this.pilots.get(conn);
    if (!p?.designs?.[slot]) return;
    p.designs[slot] = null;
    this.pilots.markDirty(conn);
    this.send(conn);
  }

  // ---------------------------------------------------------------------------

  private liveHp(conn: PilotConn, uid: number): number | undefined {
    const ship = this.ships.get(conn.playerId);
    if (!ship) return undefined;
    const i = ship.blueprint.parts.findIndex((q) => q.uid === uid);
    return i < 0 ? undefined : ship.hp[i] / ship.maxHp[i];
  }

  /** Ghost uids ordered by join distance from the core */
  private coreOutwards(bp: Blueprint, ghosts: number[], adj: number[][], core: number): number[] {
    const dist = new Map<number, number>([[core, 0]]);
    const queue = [core];
    while (queue.length) {
      const i = queue.shift()!;
      for (const j of adj[i]) if (!dist.has(j)) { dist.set(j, dist.get(i)! + 1); queue.push(j); }
    }
    const idx = new Map(bp.parts.map((q, i) => [q.uid, i]));
    return [...ghosts].sort((a, b) => (dist.get(idx.get(a)!) ?? 999) - (dist.get(idx.get(b)!) ?? 999));
  }
}
