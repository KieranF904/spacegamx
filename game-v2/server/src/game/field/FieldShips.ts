/**
 * Field machines at work on pilots' ships (docs/design/field-fabrication.md sections 4.2, 5 and 5.1): the server half
 * of the `machines` part feature (ships/features/machines). One FieldShip a pilot's ship, holding its two machines:
 * the fabricator (builds, repairs, attaches and recycles parts) and the refiner (refines the hold's ore). A ship with
 * no working fabricator (refiner) part has the core's own in its place: tier 0, slow, starter grade, no power.
 *
 * Every rule is common's (econ/field): which part is next (nextFieldTarget), what a job costs and takes (fieldPay,
 * repairBill, jobEu, jobTicks), how it steps (stepJob), where a finished part goes (placeFinished). This file only
 * runs them on the live ship and keeps the pilot's record (blueprint, ghosts, field) in step.
 *
 * Netcode: a powered machine's job progresses by the energy its part took this tick (PortsState.machEu, the ports
 * core's counter, which the pilot's own prediction steps too); the core's by the tick. Progress is never sent: only
 * decisions (a machine switched, a plan saved, a recycle queued) and rare events (a job started, finished or called
 * off, a stall, a part placed), as `fieldState` and `fieldDone`. A tick where nothing of that happens sends nothing.
 *
 * Jobs are not saved. What sits inside the machines (a job's inputs, output waiting for hold room) is mirrored into
 * the record's `field.held` whenever it changes, so a pilot who leaves mid-job finds those items in the machine (and
 * then the hold) next time: the job is called off by leaving.
 */

import { defineQuery, hasComponent } from 'bitecs';
import {
  Player, Dead, InSystem, MACHINE_FAB, MACHINE_REF, PACK_MODES, attachWork, buildPoints, canFabricate, canRefine, fabWork,
  fieldBuildInputs, fieldPay, fixModelMaterials, healPart, isStructural, jobEu, jobTicks, nextFieldTarget, packDefs, packShare,
  parseBlueprint, partItemId, partLicensed, placeFinished, portsMachineEu, recycleCandidates, recycleReturn, recycleWork,
  REARM, nextRearm, rearmBill, rearmWork,
  refineWork, repairBill, repairWork, restorePart, setPortsMachine, specOf, stepJob, tierRule, unlocks, joinDepths, adjacency,
  type Bag, type Blueprint, type FieldJob, type FieldJobKind, type FieldPartView, type FieldRecord, type MachineBlock,
  type MachineKind, type MachineView, type PackDef, type PackMode, type PlacedPart, type ServerFieldStateMessage,
  type ShipRecord, type ShipState, type ValidationResult, type PlanSpot,
} from '@space-game/common';
import type { BankCap, FeatureInstance, FeatureMessageHandler, HoldCap, ShipsOf, TellCap, WorldCap } from '../../ships/features/types.js';

/** What field machines ask of the game: the ships' records, stores and refits, the hold, profile and bank, telling pilots */
export type FieldHost = WorldCap & ShipsOf<'catalog' | 'chargeOf' | 'get' | 'installGhost' | 'refitInFlight' | 'validate'>
  & Pick<TellCap, 'tell' | 'send'> & HoldCap & BankCap;
import { SimPass } from '../../sim/SystemClocks.js';
import { joinsOf, planDiff, promoteWaiting, removeParts, type Validate } from './plan.js';
import { pickRefine } from './refine.js';

const playerQuery = defineQuery([Player]);
/** An idle machine looks for work this often (the hold may have changed), besides whenever something happens */
const POLL_TICKS = 30;

interface JobMeta {
  /** Work seconds of its phases (to re-cost it if another machine takes it over) */
  make: number;
  attach: number;
  /** Paid from the repair bank (never given back: the bank can't be withdrawn from) */
  bank: Bag;
  /** A refine's output */
  out?: Bag;
}

interface Machine {
  kind: MachineKind;
  /** Ports kind (MACHINE_FAB, MACHINE_REF) */
  pk: number;
  tier: number;
  /** Its part's uid and index (-1: the core's own) */
  uid: number;
  part: number;
  /** A part on the ports core (draws power: progresses by machEu); else the core's own (by the tick) */
  powered: boolean;
  /** Its part's draw a tick (PortsLayout.rate) */
  rate: number;
  on: boolean;
  drawing: boolean;
  job?: FieldJob;
  meta?: JobMeta;
  holding: Bag;
  blocked?: MachineBlock;
}

interface FieldShip {
  eid: number;
  rec: ShipRecord;
  ship: ShipState;
  rebuilds: number;
  fab: Machine;
  ref: Machine;
  /** machEu read last tick, by ports kind */
  eu: number[];
  nextJob: number;
  /** Something the pilot should be told happened: send fieldState at the end of the tick */
  changed: boolean;
  /** Look for work this tick */
  wake: boolean;
  /** What the fabricator's jobs were short of when it last looked (the HUD's list; the refiner's auto choice) */
  short: Bag;
}

const isEmpty = (b: Bag | undefined) => !b || !Object.keys(b).some((k) => b[k] > 0);
const addBag = (to: Bag, from: Bag, k = 1) => { for (const [id, n] of Object.entries(from)) if (n > 0) to[id] = (to[id] ?? 0) + n * k; return to; };
const minus = (a: Bag, b: Bag): Bag => { const out: Bag = {}; for (const [id, n] of Object.entries(a)) { const k = n - (b[id] ?? 0); if (k > 0) out[id] = k; } return out; };
const sameBag = (a: Bag, b: Bag) => { const ka = Object.keys(a).filter((k) => a[k] > 0), kb = Object.keys(b).filter((k) => b[k] > 0); return ka.length === kb.length && ka.every((k) => a[k] === b[k]); };
const covers = (have: Bag, need: Bag) => Object.entries(need).every(([id, n]) => (have[id] ?? 0) >= n);

export class FieldShips implements FeatureInstance {
  private readonly byEid = new Map<number, FieldShip>();
  private readonly packs: PackDef[];
  private readonly validateLoose: Validate;

  constructor(private readonly host: FieldHost) {
    this.packs = packDefs(host.econ.items);
    this.validateLoose = (bp) => host.ships.validate(bp, { mounting: false });
  }

  // ===================================================================== for package B and the integrator

  /** A part (uid) on this pilot's ship that a machine is building, repairing or recycling now (one builder a part; a rearm fills a bay's magazine, not the part) */
  isClaimed(eid: number, uid: number): boolean {
    const j = this.byEid.get(eid)?.fab.job;
    return !!j && j.uid === uid && j.kind !== 'refine' && j.kind !== 'rearm';
  }

  /**
   * Everything inside the pilot's machines: their jobs' inputs and the output waiting for hold room (what a death puts
   * in the wreck). `take`: they are emptied (the death's): the jobs are called off with nothing given back
   */
  machineContents(eid: number, take = false): Bag {
    const fs = this.byEid.get(eid);
    const rec = fs?.rec ?? this.host.profile(eid)?.ship;
    const out: Bag = fs ? this.contents(fs) : { ...(rec?.field?.held ?? {}) };
    if (take) {
      if (fs) for (const m of [fs.fab, fs.ref]) { m.job = undefined; m.meta = undefined; m.holding = {}; this.setDrawing(fs, m, false); fs.changed = true; }
      if (rec?.field) delete rec.field.held;
      if (fs) this.flush(fs);
    }
    return out;
  }

  // ===================================================================== feature hooks

  readonly messages: Readonly<Record<string, FeatureMessageHandler>> = {
    fieldPlan: (eid, msg) => this.onPlan(eid, msg?.blueprint),
    fieldPlanClear: (eid) => this.onPlanClear(eid),
    machine: (eid, msg) => this.onMachine(eid, msg),
    fieldCancel: (eid, msg) => this.onCancel(eid, msg),
    fieldRecycle: (eid, msg) => this.onRecycle(eid, msg),
  };

  onShipRebuilt(eid: number): void {
    const fs = this.byEid.get(eid);
    if (fs) fs.wake = true;
  }

  onLeave(eid: number): void {
    // (What the machines hold is in the record already: flush keeps field.held in step)
    this.byEid.delete(eid);
  }

  tick(): void {
    const w = this.host.world, tick = this.host.getTick();
    for (const eid of playerQuery(w)) {
      if (hasComponent(w, Dead, eid) || !SimPass.on(InSystem.systemId[eid])) continue;
      const fs = this.track(eid);
      if (!fs) continue;
      this.step(fs, tick);
      if (fs.wake || (tick + eid) % POLL_TICKS === 0) { fs.wake = false; this.decide(fs, tick); }
      this.applyBits(fs);
      if (fs.changed) this.flush(fs);
    }
  }

  // ===================================================================== the ship and its record

  /** The pilot's FieldShip, made or brought up to date when its body or record changed */
  private track(eid: number): FieldShip | undefined {
    const ship = this.host.ships.get(eid);
    if (!ship || ship.kind !== 'ship' || ship.derived.root < 0) return undefined;
    let fs = this.byEid.get(eid);
    if (fs && fs.ship === ship) {
      if (fs.rebuilds !== ship.rebuilds) { fs.rebuilds = ship.rebuilds; this.syncMachines(fs); fs.wake = true; }
      return fs;
    }
    const rec = this.host.profile(eid)?.ship;
    if (!rec) return undefined;
    if (!fs || fs.rec !== rec) {
      fs = this.create(eid, rec, ship);
      this.byEid.set(eid, fs);
      return fs;
    }
    // A new body for the same record (a refit elsewhere, a respawn): its parts may have moved
    fs.ship = ship;
    fs.rebuilds = ship.rebuilds;
    this.syncMachines(fs);
    for (const m of [fs.fab, fs.ref]) {
      const j = m.job;
      if (j && j.uid !== undefined && j.kind !== 'build' && this.indexOf(fs, j.uid) < 0) this.callOff(fs, m);
    }
    fs.wake = true;
    return fs;
  }

  private create(eid: number, rec: ShipRecord, ship: ShipState): FieldShip {
    const f = rec.field ?? {};
    const mk = (kind: MachineKind, pk: number, on: boolean): Machine => ({ kind, pk, tier: 0, uid: -1, part: -1, powered: false, rate: 0, on, drawing: false, holding: {} });
    const fs: FieldShip = {
      eid, rec, ship, rebuilds: ship.rebuilds,
      fab: mk('fabricator', MACHINE_FAB, !!f.fabOn), ref: mk('refiner', MACHINE_REF, !!f.refOn),
      eu: [0, 0, 0], nextJob: 0, changed: false, wake: true, short: {},
    };
    // (What a past session left inside the machines waits for hold room)
    if (!isEmpty(f.held)) fs.fab.holding = { ...f.held! };
    this.syncMachines(fs);
    // (A ship with field work saved is told it at once; one with none hears nothing until something happens: its
    // client takes both machines as off, the ship's own parts as which they are)
    fs.changed = !!rec.field && Object.keys(rec.field).length > 0;
    const e = this.host.ships.chargeOf(eid).e;
    if (e) { fs.eu[MACHINE_FAB] = portsMachineEu(e, MACHINE_FAB); fs.eu[MACHINE_REF] = portsMachineEu(e, MACHINE_REF); }
    return fs;
  }

  private field(fs: FieldShip): FieldRecord {
    return (fs.rec.field ??= {});
  }

  private indexOf(fs: FieldShip, uid: number): number {
    return fs.ship.blueprint.parts.findIndex((p) => p.uid === uid);
  }

  /** Which part is each machine now (fx.machines: a working one), its tier and its draw; a job it can't do is called off */
  private syncMachines(fs: FieldShip): void {
    const d = fs.ship.derived, fx = d.fx?.machines, L = d.ports;
    for (const m of [fs.fab, fs.ref]) {
      const idx = fx ? (m.kind === 'fabricator' ? fx.fab : fx.ref) : -1;
      const powered = idx >= 0 && !!L && d.alive[idx];
      const tier = powered ? (m.kind === 'fabricator' ? fx!.fabTier : fx!.refTier) : 0;
      const uid = powered ? fs.ship.blueprint.parts[idx].uid : -1;
      const rate = powered ? L!.rate[idx] : 0;
      m.part = powered ? idx : -1;
      if (m.uid === uid && m.tier === tier && m.powered === powered && m.rate === rate) continue;
      const before = { tier: m.tier, powered: m.powered, rate: m.rate };
      m.uid = uid; m.tier = tier; m.powered = powered; m.rate = rate;
      fs.changed = true;
      if (m.job) this.retarget(fs, m, before);
    }
  }

  /** Another machine took a job over (its part lost or built): the same share done, in the new machine's units */
  private retarget(fs: FieldShip, m: Machine, before: { tier: number; powered: boolean; rate: number }): void {
    const j = m.job!, meta = m.meta!;
    if (!this.canDo(fs, m, j)) { this.callOff(fs, m); return; }
    const was: Machine = { ...m, ...before };
    const re = (work: number, done: number) => {
      const old = this.units(was, work, j.packShare), now = this.units(m, work, j.packShare);
      return { need: now, done: old > 0 ? Math.min(now, Math.round((done / old) * now)) : 0 };
    };
    // (A part taken from the hold has no MAKE: it stays at none)
    const a = j.need > 0 ? re(meta.make, j.done) : { need: 0, done: 0 }, b = re(meta.attach, j.attachDone);
    j.need = a.need; j.done = a.done; j.attachNeed = b.need; j.attachDone = b.done;
    fs.changed = true;
  }

  private canDo(fs: FieldShip, m: Machine, j: FieldJob): boolean {
    if (j.kind === 'refine') return canRefine(this.host.econ, m.tier, j.recipe ?? '');
    if (j.kind === 'recycle' || j.kind === 'rearm') return true;
    const i = j.uid !== undefined ? this.indexOf(fs, j.uid) : -1;
    const spec = i >= 0 ? fs.ship.blueprint.parts[i] : j.item ? this.specOfItem(j.item) : null;
    return !!spec && canFabricate(this.host.ships.catalog, m.tier, spec);
  }

  private specOfItem(item: string): { fn: string; material: string; piece: string } | null {
    const m = /^part:([^:]+):([^:]+):([^:]+)$/.exec(item);
    return m ? { material: m[1], fn: m[2], piece: m[3] } : null;
  }

  /** Units a job of `work` seconds takes on this machine: eu (powered: jobEu) or ticks (the core's: jobTicks) */
  private units(m: Pick<Machine, 'kind' | 'tier' | 'powered' | 'rate'>, work: number, share: number): number {
    if (!(work > 0)) return 0;
    const speed = tierRule(m.kind, m.tier).speed;
    return m.powered ? jobEu(work, speed, m.rate, share) : jobTicks(work, speed, share);
  }

  // ===================================================================== each tick: progress

  private step(fs: FieldShip, tick: number): void {
    const e = this.host.ships.chargeOf(fs.eid).e;
    for (const m of [fs.fab, fs.ref]) {
      let units = 0;
      if (e) {
        const cur = portsMachineEu(e, m.pk), was = fs.eu[m.pk];
        fs.eu[m.pk] = cur;
        if (m.powered && cur > was) units = cur - was;
      }
      if (!m.powered && m.drawing) units = 1;
      if (!m.job || !m.drawing || units <= 0) continue;
      const j = m.job, phase = j.phase;
      stepJob(j, units);
      if (j.kind === 'build' && phase === 'make' && j.phase !== 'make') this.made(fs, m);
      if (m.job && m.job.phase === 'done') this.finish(fs, m, tick);
    }
  }

  /** The bits the ports core reads: a powered machine draws only while it's drawing */
  private applyBits(fs: FieldShip): void {
    const e = this.host.ships.chargeOf(fs.eid).e;
    if (!e) return;
    for (const m of [fs.fab, fs.ref]) {
      const want = m.powered && m.drawing, bit = 1 << (m.pk - 1);
      if (((e.mach & bit) !== 0) !== want) setPortsMachine(e, m.pk, want);
    }
  }

  private setDrawing(fs: FieldShip, m: Machine, on: boolean): void {
    if (m.drawing === on) return;
    m.drawing = on;
    fs.changed = true;
  }

  // ===================================================================== the next job

  private decide(fs: FieldShip, tick: number): void {
    this.tidy(fs);
    for (const m of [fs.fab, fs.ref]) {
      // (Once the fabricator has its job: what the parts still wanted need, the HUD's list and what the refiner on
      // auto works towards)
      if (m === fs.ref) this.noteShort(fs, fs.fab.on ? this.wantShort(fs, fs.fab) : {});
      if (!isEmpty(m.holding)) this.unload(fs, m);
      if (m.job) { this.setDrawing(fs, m, m.on); continue; }
      if (!isEmpty(m.holding)) { this.setBlocked(fs, m, 'cargo'); this.setDrawing(fs, m, false); continue; }
      if (!m.on) { this.setBlocked(fs, m, undefined); this.setDrawing(fs, m, false); continue; }
      if (m.kind === 'fabricator') this.pickFab(fs, m, tick); else this.pickRef(fs, m, tick);
      this.setDrawing(fs, m, !!m.job);
    }
  }

  private setBlocked(fs: FieldShip, m: Machine, b: MachineBlock | undefined): void {
    if (m.blocked === b) return;
    m.blocked = b;
    fs.changed = true;
  }

  /** What the part-pick sees of each part (order.ts FieldPartView) */
  private views(fs: FieldShip, tier: number): FieldPartView[] {
    const ship = fs.ship, cat = this.host.ships.catalog;
    const rc = new Set(fs.rec.field?.recycle ?? []);
    return ship.blueprint.parts.map((p, i) => {
      const alive = !!ship.derived.alive[i];
      const core = p.fn === 'core';
      return {
        alive,
        missing: alive && !core && ship.maxHp[i] > 0 ? Math.max(0, 1 - ship.hp[i] / ship.maxHp[i]) : 0,
        wanted: !alive && !core && !rc.has(p.uid),
        recycle: alive && rc.has(p.uid),
        blocked: false,
        makeable: canFabricate(cat, tier, p),
      };
    });
  }

  private pickFab(fs: FieldShip, m: Machine, tick: number): void {
    const bp = fs.ship.blueprint, n = bp.parts.length, root = fs.ship.derived.root, joins = joinsOf(this.host.ships.catalog, bp);
    const view = this.views(fs, m.tier);
    const skip = new Set<number>();
    const short: Bag = {};
    for (let guard = 0; guard <= n; guard++) {
      const t = nextFieldTarget(n, root, joins, view, (i) => skip.has(i));
      if (!t) break;
      if (this.startFab(fs, m, t.kind, t.part, view[t.part].missing, short, tick)) { this.setBlocked(fs, m, undefined); return; }
      skip.add(t.part);
    }
    // (Then the Mine Bays' magazines, once nothing above could start)
    const rearm = this.startRearm(fs, m, short, tick);
    if (rearm === 'started') { this.setBlocked(fs, m, undefined); return; }
    if (skip.size || rearm === 'short') { this.setBlocked(fs, m, 'materials'); return; }
    // (Nothing it can make: would a better machine find work?)
    const better = nextFieldTarget(n, root, joins, view.map((v) => ({ ...v, makeable: true })));
    this.setBlocked(fs, m, better ? 'grade' : 'idle');
  }

  /**
   * What the parts this machine could work on still need from the hold, all told: the damaged ones' repair bills and
   * the wanted ones' inputs (a part whose item is in the hold needs nothing), less what the hold pays (packs as the
   * pack mode allows). The job under way is paid already
   */
  private wantShort(fs: FieldShip, m: Machine): Bag {
    const econ = this.host.econ, bp = fs.ship.blueprint, view = this.views(fs, m.tier);
    const busy = m.job?.uid, need: Bag = {};
    const items: Bag = {};
    bp.parts.forEach((p, i) => {
      const v = view[i];
      if (!v.makeable || p.uid === busy) return;
      if (v.alive && !v.recycle && v.missing > 1e-6) addBag(need, repairBill(econ, p, v.missing));
      else if (v.wanted) {
        const item = partItemId(p);
        if (!isStructural(p.fn) && this.host.holdCount(fs.eid, item) > (items[item] ?? 0)) { items[item] = (items[item] ?? 0) + 1; return; }
        addBag(need, fieldBuildInputs(econ, p));
      }
    });
    const rearm = m.job?.kind === 'rearm' ? null : this.rearmWanted(fs);
    if (rearm) addBag(need, rearmBill(rearm.count));
    if (isEmpty(need)) return {};
    const mode: PackMode = fs.rec.field?.packs ?? 'off';
    return fieldPay(need, (id) => this.host.holdCount(fs.eid, id), this.packs, mode).short;
  }

  private noteShort(fs: FieldShip, short: Bag): void {
    if (sameBag(fs.short, short)) return;
    fs.short = short;
    fs.changed = true;
  }

  /** Start a fabricator job on part `i`, paying for it all or nothing; false (what it was short of added to `short`) if it can't */
  private startFab(fs: FieldShip, m: Machine, kind: 'repair' | 'build' | 'recycle', i: number, missing: number, short: Bag, tick: number): boolean {
    const p = fs.ship.blueprint.parts[i], spec = specOf(p), econ = this.host.econ, cat = this.host.ships.catalog;
    const item = partItemId(spec);
    if (kind === 'recycle') return this.begin(fs, m, 'recycle', { uid: p.uid, item, held: {}, make: recycleWork(econ, spec), attach: 0, share: 0, bank: {} }, tick);
    if (kind === 'repair') {
      const pay = this.pay(fs, m, repairBill(econ, spec, missing), true, short);
      return !!pay && this.begin(fs, m, 'repair', { uid: p.uid, item, held: pay.held, make: repairWork(econ, spec, missing), attach: 0, share: pay.share, bank: pay.bank }, tick);
    }
    // A build: a finished part of this kind in the hold is fitted (attach only); else it's made from its inputs
    if (!isStructural(p.fn) && this.host.holdCount(fs.eid, item) >= 1 && this.host.holdTake(fs.eid, { [item]: 1 })) {
      return this.begin(fs, m, 'build', { uid: p.uid, item, held: { [item]: 1 }, make: 0, attach: attachWork(cat, spec), share: 0, bank: {} }, tick);
    }
    const own = !fs.ship.ghost[i];
    const pay = this.pay(fs, m, fieldBuildInputs(econ, spec), own, short);
    return !!pay && this.begin(fs, m, 'build', { uid: p.uid, item, held: pay.held, make: fabWork(econ, spec), attach: attachWork(cat, spec), share: pay.share, bank: pay.bank }, tick);
  }

  /**
   * Pay a bill from the hold (loose materials, and packs as the pack mode allows: fieldPay), all or nothing; a repair or
   * a rebuild of the ship's own design may make up the rest from the bank's free spare. Null (nothing taken) if it can't
   */
  private pay(fs: FieldShip, m: Machine, bill: Bag, own: boolean, short: Bag): { held: Bag; share: number; bank: Bag } | null {
    const mode: PackMode = m.kind === 'fabricator' ? fs.rec.field?.packs ?? 'off' : 'off';
    const r = fieldPay(bill, (id) => this.host.holdCount(fs.eid, id), this.packs, mode);
    const fromHold = addBag(addBag({}, r.take), r.packs);
    let bank: Bag = {};
    if (!isEmpty(r.short)) {
      const spare = own ? this.host.bankSpare?.(fs.eid) : undefined;
      if (!spare || !covers(spare, r.short)) { addBag(short, r.short); return null; }
      bank = { ...r.short };
    }
    if (!isEmpty(fromHold) && !this.host.holdTake(fs.eid, fromHold)) { addBag(short, bill); return null; }
    if (!isEmpty(bank) && !this.host.spendBankSpare?.(fs.eid, bank)) {
      if (!isEmpty(fromHold)) this.host.holdGive(fs.eid, fromHold);
      addBag(short, bank);
      return null;
    }
    return { held: addBag({ ...fromHold }, bank), share: packShare(r), bank };
  }

  /** The Mine Bay rearm the fabricator would take next (order.ts nextRearm), or null: every magazine is full */
  private rearmWanted(fs: FieldShip): { uid: number; count: number } | null {
    const bays = fs.ship.derived.fx?.minebay?.bays;
    return bays?.length ? nextRearm(bays, fs.rec.field?.mines, REARM.perJob) : null;
  }

  /** Start a rearm job (rules.ts REARM: placeholder cost), paid from the hold all or nothing (never the bank: it pays parts) */
  private startRearm(fs: FieldShip, m: Machine, short: Bag, tick: number): 'started' | 'short' | 'none' {
    const r = this.rearmWanted(fs);
    if (!r) return 'none';
    const pay = this.pay(fs, m, rearmBill(r.count), false, short);
    if (!pay) return 'short';
    this.begin(fs, m, 'rearm', { uid: r.uid, held: pay.held, make: rearmWork(r.count), attach: 0, share: pay.share, bank: pay.bank }, tick);
    m.job!.count = r.count;
    return 'started';
  }

  /** A rearm done: its mines into the bay's magazine (the record's: the mine bay feature reads it), up to its capacity; a bay lost meanwhile gets its inputs back */
  private rearmed(fs: FieldShip, m: Machine, j: FieldJob, meta: JobMeta): void {
    const bay = fs.ship.derived.fx?.minebay?.bays.find((b) => b.uid === j.uid);
    if (!bay) { this.giveBack(fs, m, minus(j.held, meta.bank)); return; }
    const mines = (this.field(fs).mines ??= {});
    mines[bay.uid] = Math.min(bay.capacity, Math.max(0, Math.floor(mines[bay.uid] ?? 0)) + Math.max(0, Math.floor(j.count ?? 0)));
    this.host.markDirty(fs.eid);
  }

  private begin(fs: FieldShip, m: Machine, kind: FieldJobKind, o: { uid?: number; item?: string; recipe?: string; held: Bag; make: number; attach: number; share: number; bank: Bag; out?: Bag }, _tick: number): boolean {
    const need = this.units(m, o.make, o.share), attachNeed = this.units(m, o.attach, o.share);
    m.job = {
      id: ++fs.nextJob, kind, uid: o.uid, item: o.item, recipe: o.recipe, held: o.held,
      need, done: 0, attachNeed, attachDone: 0, phase: need > 0 ? 'make' : attachNeed > 0 ? 'attach' : 'done', packShare: o.share,
    };
    m.meta = { make: o.make, attach: o.attach, bank: o.bank, out: o.out };
    fs.changed = true;
    return true;
  }

  private pickRef(fs: FieldShip, m: Machine, tick: number): void {
    const econ = this.host.econ;
    const r = pickRefine(econ, m.tier, fs.rec.field?.recipe, fs.short, (id) => this.host.holdCount(fs.eid, id));
    if ('blocked' in r) { this.setBlocked(fs, m, r.blocked); return; }
    if (!this.host.holdTake(fs.eid, r.inputs)) { this.setBlocked(fs, m, 'materials'); return; }
    this.setBlocked(fs, m, undefined);
    this.begin(fs, m, 'refine', { item: r.recipe, recipe: r.recipe, held: r.inputs, make: refineWork(econ, r.recipe), attach: 0, share: 0, bank: {}, out: r.out }, tick);
  }

  // ===================================================================== finishing

  /** Open planned spots a finished part could go to, nearest the core first (order.ts placeFinished) */
  private spots(fs: FieldShip): PlanSpot[] {
    const ship = fs.ship, bp = ship.blueprint, n = bp.parts.length, joins = joinsOf(this.host.ships.catalog, bp);
    const alive = ship.derived.alive, adj = adjacency(n, joins), depth = joinDepths(n, ship.derived.root, joins);
    const rc = new Set(fs.rec.field?.recycle ?? []);
    const out: PlanSpot[] = [];
    for (let i = 0; i < n; i++) {
      const p = bp.parts[i];
      if (alive[i] || p.fn === 'core' || rc.has(p.uid) || depth[i] < 0) continue;
      out.push({ part: i, item: partItemId(p), open: true, joined: adj[i].some((j) => alive[j]) });
    }
    return out.sort((a, b) => depth[a.part] - depth[b.part] || a.part - b.part);
  }

  /** A build's MAKE is done: it attaches where it can go now (its own spot, else another wanting the same), else the hold */
  private made(fs: FieldShip, m: Machine): void {
    const j = m.job!;
    const own = j.uid !== undefined ? this.indexOf(fs, j.uid) : -1;
    const at = placeFinished(j.item!, own, this.spots(fs));
    if (at.to === 'cargo') { j.phase = 'done'; return; }
    const uid = fs.ship.blueprint.parts[at.part].uid;
    if (uid !== j.uid) { j.uid = uid; fs.changed = true; }
  }

  private finish(fs: FieldShip, m: Machine, _tick: number): void {
    const j = m.job!, meta = m.meta!;
    m.job = undefined; m.meta = undefined;
    fs.changed = true; fs.wake = true;
    this.setDrawing(fs, m, false);
    const done = (item: string, to: 'ship' | 'cargo' | 'machine', uid?: number) =>
      this.host.send(fs.eid, { type: 'fieldDone', kind: m.kind, job: j.id, item, to, uid });
    if (j.kind === 'refine') { done(j.item!, this.toHold(fs, m, meta.out ?? {})); return; }
    if (j.kind === 'rearm') { this.rearmed(fs, m, j, meta); return; }
    if (j.kind === 'build') {
      const own = j.uid !== undefined ? this.indexOf(fs, j.uid) : -1;
      const at = placeFinished(j.item!, own, this.spots(fs));
      if (at.to === 'spot') { const uid = this.install(fs, at.part); done(j.item!, 'ship', uid); return; }
      done(j.item!, this.toHold(fs, m, { [j.item!]: 1 }));
      return;
    }
    const i = j.uid !== undefined ? this.indexOf(fs, j.uid) : -1;
    const alive = i >= 0 && !!fs.ship.derived.alive[i];
    if (j.kind === 'repair') {
      // (The part was lost meanwhile: its inputs come back)
      if (!alive) { this.giveBack(fs, m, minus(j.held, meta.bank)); return; }
      healPart(fs.ship, i, fs.ship.maxHp[i], this.host.tuning);
      done(j.item!, 'ship', j.uid);
      return;
    }
    // A recycle: the part comes off (if that strands nothing now) and half its materials go to the hold
    const rc = new Set(fs.rec.field?.recycle ?? []);
    if (alive && !this.removable(fs, i)) return; // (it waits: picked again once it can go)
    if (!this.takeOff(fs, new Set([j.uid!]))) return;
    rc.delete(j.uid!);
    this.setRecycle(fs, [...rc]);
    if (alive) done(j.item!, this.toHold(fs, m, recycleReturn(this.host.econ, this.specOfItem(j.item!)!)));
    this.promote(fs);
  }

  /** Can this standing part (index) come off without stranding anything (order.ts recycleCandidates) */
  private removable(fs: FieldShip, i: number): boolean {
    const ship = fs.ship, n = ship.blueprint.parts.length, joins = joinsOf(this.host.ships.catalog, ship.blueprint);
    const alive = ship.blueprint.parts.map((_, k) => !!ship.derived.alive[k]);
    const queued = alive.map((_, k) => k === i);
    return recycleCandidates(n, ship.derived.root, joins, alive, queued).includes(i);
  }

  /** A finished part onto its spot (a ghost built in, a lost part back): returns its uid */
  private install(fs: FieldShip, i: number): number {
    const ship = fs.ship, uid = ship.blueprint.parts[i].uid;
    if (ship.ghost[i]) {
      this.host.ships.installGhost(fs.eid, uid);
      if (fs.rec.ghosts) fs.rec.ghosts = fs.rec.ghosts.filter((u) => u !== uid);
      // (A part the bank owed since a death, built by the machine instead: the bank owes it no longer)
      if (fs.rec.owed) { fs.rec.owed = fs.rec.owed.filter((u) => u !== uid); if (!fs.rec.owed.length) delete fs.rec.owed; }
    } else {
      restorePart(ship, i, 1);
      // (Not "freshly destroyed" if lost again before the rebuild point)
      ship.rebuildHp[i] = 0;
    }
    if (fs.rec.hp) delete fs.rec.hp[uid];
    this.host.markDirty(fs.eid);
    return uid;
  }

  /** Output into the hold as far as it fits (structure as what it's made of); the rest waits in the machine */
  private toHold(fs: FieldShip, m: Machine, items: Bag): 'cargo' | 'machine' {
    const flat = this.flatten(items);
    const left = this.host.holdGive(fs.eid, flat);
    if (isEmpty(left)) return 'cargo';
    addBag(m.holding, left);
    this.setBlocked(fs, m, 'cargo');
    return 'machine';
  }

  private flatten(items: Bag): Bag {
    const out: Bag = {};
    for (const [id, n] of Object.entries(items)) {
      const spec = this.specOfItem(id);
      if (spec && isStructural(spec.fn)) addBag(out, this.host.econ.recipes.partInputs(spec), n);
      else out[id] = (out[id] ?? 0) + n;
    }
    return out;
  }

  /** A machine's held output into the hold as room allows */
  private unload(fs: FieldShip, m: Machine): void {
    if (this.host.holdRoom(fs.eid) <= 0) return;
    const left = this.host.holdGive(fs.eid, m.holding);
    if (sameBag(left, m.holding)) return;
    m.holding = left;
    fs.changed = true;
    if (isEmpty(left)) this.setBlocked(fs, m, undefined);
  }

  private giveBack(fs: FieldShip, m: Machine, items: Bag): void {
    if (isEmpty(items)) return;
    const left = this.host.holdGive(fs.eid, items);
    if (!isEmpty(left)) addBag(m.holding, left);
    fs.changed = true;
  }

  /** Call a job off: its inputs back to the hold (what's paid from the bank is spent), or into the machine while it's full */
  private callOff(fs: FieldShip, m: Machine): void {
    const j = m.job;
    if (!j) return;
    const bank = m.meta?.bank ?? {};
    m.job = undefined; m.meta = undefined;
    this.setDrawing(fs, m, false);
    this.giveBack(fs, m, minus(j.held, bank));
    fs.changed = true; fs.wake = true;
  }

  // ===================================================================== the blueprint (live ship and record together)

  /** Put a new design on the live ship and its record together (ghosts: planned parts in it), keeping every part's state */
  private refit(fs: FieldShip, bp: Blueprint, ghosts: number[]): boolean {
    if (!this.validateLoose(bp).ok) return false;
    if (!this.host.ships.refitInFlight(fs.eid, bp, ghosts)) return false;
    const ship = this.host.ships.get(fs.eid)!;
    fs.ship = ship;
    fs.rebuilds = ship.rebuilds;
    fs.rec.blueprint = bp;
    const g = new Set(ghosts);
    fs.rec.ghosts = bp.parts.filter((p) => g.has(p.uid)).map((p) => p.uid);
    if (fs.rec.hp) for (const k of Object.keys(fs.rec.hp)) if (!bp.parts.some((p) => p.uid === Number(k))) delete fs.rec.hp[Number(k)];
    this.syncMachines(fs);
    this.host.markDirty(fs.eid);
    fs.changed = true; fs.wake = true;
    return true;
  }

  private ghostUids(fs: FieldShip): number[] {
    return fs.ship.blueprint.parts.filter((_, i) => fs.ship.ghost[i]).map((p) => p.uid);
  }

  /** Take parts out of the design (a recycle done, a queued part lost); parts cut off by it wait. False: it can't be done now */
  private takeOff(fs: FieldShip, uids: Set<number>): boolean {
    const alive = (uid: number) => { const i = this.indexOf(fs, uid); return i >= 0 && !!fs.ship.derived.alive[i]; };
    const r = removeParts(this.validateLoose, fs.ship.blueprint, uids, (u) => !uids.has(u) && alive(u));
    if (!r) return false;
    const ghosts = this.ghostUids(fs).filter((u) => !uids.has(u) && r.blueprint.parts.some((p) => p.uid === u));
    if (!this.refit(fs, r.blueprint, ghosts)) return false;
    if (r.waiting.length) this.setWaiting(fs, [...(fs.rec.field?.waiting ?? []), ...r.waiting]);
    return true;
  }

  /** Waiting planned parts into the design as far as they can go now */
  private promote(fs: FieldShip): void {
    const w = fs.rec.field?.waiting;
    if (!w?.length) return;
    const r = promoteWaiting(this.validateLoose, fs.ship.blueprint, w);
    if (!r.added.length) return;
    if (this.refit(fs, r.blueprint, [...this.ghostUids(fs), ...r.added])) this.setWaiting(fs, r.left);
  }

  private setWaiting(fs: FieldShip, w: PlacedPart[]): void {
    if (!w.length && !fs.rec.field?.waiting) return;
    const f = this.field(fs);
    if (w.length) f.waiting = w; else delete f.waiting;
    this.host.markDirty(fs.eid);
  }

  private setRecycle(fs: FieldShip, uids: number[]): void {
    if (!uids.length && !fs.rec.field?.recycle) return;
    const f = this.field(fs);
    if (uids.length) f.recycle = uids; else delete f.recycle;
    this.host.markDirty(fs.eid);
    fs.changed = true;
  }

  /** A part queued for recycling that was lost meanwhile simply goes (nothing left to break down) */
  private tidy(fs: FieldShip): void {
    const rc = fs.rec.field?.recycle;
    if (!rc?.length) return;
    const lost = rc.filter((u) => { const i = this.indexOf(fs, u); return i < 0 || !fs.ship.derived.alive[i]; });
    if (!lost.length) return;
    const busy = fs.fab.job?.kind === 'recycle' ? fs.fab.job.uid : undefined;
    const gone = new Set(lost.filter((u) => u !== busy && this.indexOf(fs, u) >= 0));
    if (gone.size && !this.takeOff(fs, gone)) return;
    this.setRecycle(fs, rc.filter((u) => !lost.includes(u) || u === busy));
    this.promote(fs);
  }

  // ===================================================================== messages

  private ensure(eid: number): FieldShip | undefined {
    if (!hasComponent(this.host.world, Player, eid) || hasComponent(this.host.world, Dead, eid)) return undefined;
    return this.track(eid);
  }

  private onPlan(eid: number, raw: unknown): void {
    const fs = this.ensure(eid);
    if (!fs) return;
    let target: Blueprint;
    try {
      const r = raw as { parts?: unknown } | null;
      if (!r || typeof r !== 'object' || !Array.isArray(r.parts) || r.parts.length > 256) throw new Error('not a blueprint');
      target = fixModelMaterials(this.host.ships.catalog, parseBlueprint(JSON.stringify(raw)));
      target.name = (target.name || fs.ship.blueprint.name).slice(0, 64);
      target.power = 'ports';
      for (const p of target.parts) if (p.facing !== undefined && (typeof p.facing !== 'string' || p.facing.length > 16)) delete p.facing;
    } catch {
      this.host.tell(eid, "That plan isn't a ship design", 'warn');
      return;
    }
    const err = this.planProblem(fs, target);
    if (err) { this.host.tell(eid, err, 'warn'); return; }
    this.applyPlan(fs, target);
  }

  private onPlanClear(eid: number): void {
    const fs = this.ensure(eid);
    if (!fs) return;
    const bp = fs.ship.blueprint;
    this.applyPlan(fs, { ...bp, parts: bp.parts.filter((_, i) => !fs.ship.ghost[i]) }, true);
  }

  /** What's wrong with a plan as a design for this pilot (null: nothing) */
  private planProblem(fs: FieldShip, target: Blueprint): string | null {
    const live = new Map(fs.ship.blueprint.parts.map((p, i) => [p.uid, { p, ghost: fs.ship.ghost[i] }]));
    const standing = (u: number) => { const l = live.get(u); return !!l && !l.ghost; };
    const v: ValidationResult = this.host.ships.validate(target);
    // (A part fitted before a weapon's mounting rules changed may stay as it is, as a saved ship does)
    const errors = v.errors.filter((e) => !(e.code === 'badMounting' && e.uids.every(standing)));
    if (errors.length) return `That plan has problems: ${errors[0].message}`;
    if (this.host.freeBuild?.(fs.eid)) return null;
    const prof = this.host.profile(fs.eid);
    if (!prof) return 'No pilot';
    const fresh = target.parts.filter((p) => !standing(p.uid) || partItemId(live.get(p.uid)!.p) !== partItemId(p));
    const unlicensed = fresh.filter((p) => !partLicensed(p, prof.recipes, prof.level));
    if (unlicensed.length) return `You aren't licensed to fit ${this.host.econ.items.name(partItemId(unlicensed[0]))} yet: it opens at its level`;
    const cap = unlocks(prof).complexity, cost = buildPoints(this.host.ships.catalog, target);
    if (cost > cap && cost > buildPoints(this.host.ships.catalog, fs.ship.blueprint)) return `At level ${prof.level} your ships can cost up to ${cap} build points (this plan costs ${cost})`;
    return null;
  }

  private applyPlan(fs: FieldShip, target: Blueprint, clear = false): void {
    const ship = fs.ship;
    const ghosts = new Set(this.ghostUids(fs));
    const r = planDiff(this.validateLoose, this.host.ships.catalog, {
      blueprint: ship.blueprint, ghosts,
      alive: (u) => { const i = this.indexOf(fs, u); return i >= 0 && !!ship.derived.alive[i]; },
    }, target);
    if ('error' in r) { this.host.tell(fs.eid, r.error, 'warn'); return; }
    if (!this.refit(fs, r.blueprint, r.ghosts)) { this.host.tell(fs.eid, "That plan can't be saved", 'warn'); return; }
    this.setRecycle(fs, clear ? [] : r.recycle);
    this.setWaiting(fs, clear ? [] : r.waiting);
    // Jobs on parts no longer in it, or no longer to recycle, are called off (a build carries on: its part goes where it can)
    const rc = new Set(fs.rec.field?.recycle ?? []);
    const j = fs.fab.job;
    if (j && j.kind !== 'build' && (j.uid === undefined || this.indexOf(fs, j.uid) < 0 || (j.kind === 'recycle' && !rc.has(j.uid)))) this.callOff(fs, fs.fab);
    fs.changed = true; fs.wake = true;
  }

  private machineOf(fs: FieldShip, kind: unknown): Machine | undefined {
    return kind === 'fabricator' ? fs.fab : kind === 'refiner' ? fs.ref : undefined;
  }

  private onMachine(eid: number, msg: { kind?: unknown; on?: unknown; packs?: unknown; recipe?: unknown }): void {
    const fs = this.ensure(eid);
    const m = fs && this.machineOf(fs, msg?.kind);
    if (!fs || !m) return;
    const f = this.field(fs);
    if (typeof msg.on === 'boolean') {
      m.on = msg.on;
      if (m.kind === 'fabricator') { if (m.on) f.fabOn = true; else delete f.fabOn; } else if (m.on) f.refOn = true; else delete f.refOn;
      // (Takes effect this tick: off pauses the job, keeping its progress and inputs)
      if (!m.on) { this.setDrawing(fs, m, false); this.applyBits(fs); }
    }
    if (m.kind === 'fabricator' && typeof msg.packs === 'string' && (PACK_MODES as readonly string[]).includes(msg.packs)) {
      if (msg.packs === 'off') delete f.packs; else f.packs = msg.packs as PackMode;
    }
    if (m.kind === 'refiner' && msg.recipe !== undefined) {
      if (msg.recipe === null) delete f.recipe;
      else if (typeof msg.recipe === 'string' && this.host.econ.recipes.refining.has(msg.recipe)) f.recipe = msg.recipe;
    }
    this.host.markDirty(eid);
    fs.changed = true; fs.wake = true;
  }

  private onCancel(eid: number, msg: { kind?: unknown; job?: unknown }): void {
    const fs = this.ensure(eid);
    const m = fs && this.machineOf(fs, msg?.kind);
    if (!fs || !m || !m.job || m.job.id !== msg.job) return;
    this.callOff(fs, m);
  }

  private onRecycle(eid: number, msg: { uids?: unknown; cancel?: unknown }): void {
    const fs = this.ensure(eid);
    if (!fs || !Array.isArray(msg?.uids) || msg.uids.length > 256) return;
    const rc = new Set(fs.rec.field?.recycle ?? []);
    for (const u of msg.uids) {
      if (!Number.isInteger(u)) continue;
      const i = this.indexOf(fs, u);
      if (msg.cancel === true) { rc.delete(u); continue; }
      if (i < 0 || fs.ship.ghost[i] || !fs.ship.derived.alive[i] || fs.ship.blueprint.parts[i].fn === 'core') continue;
      rc.add(u);
    }
    this.setRecycle(fs, [...rc]);
    const j = fs.fab.job;
    if (j?.kind === 'recycle' && j.uid !== undefined && !rc.has(j.uid)) this.callOff(fs, fs.fab);
    fs.wake = true;
  }

  // ===================================================================== telling the pilot

  /** Everything inside the machines (not what the bank paid: that is spent) */
  private contents(fs: FieldShip): Bag {
    const out: Bag = {};
    for (const m of [fs.fab, fs.ref]) {
      addBag(out, m.holding);
      if (m.job) addBag(out, minus(m.job.held, m.meta?.bank ?? {}));
    }
    return out;
  }

  /** Something changed: the record's `held` follows the machines, and the pilot is sent the field state */
  private flush(fs: FieldShip): void {
    fs.changed = false;
    const held = this.contents(fs);
    // (A record that never had field work keeps no field entry)
    if (!sameBag(held, fs.rec.field?.held ?? {})) {
      const f = this.field(fs);
      if (isEmpty(held)) delete f.held; else f.held = held;
      this.host.markDirty(fs.eid);
    }
    const f: FieldRecord = fs.rec.field ?? {};
    const msg: ServerFieldStateMessage = {
      type: 'fieldState', tick: this.host.getTick(),
      machines: [this.view(fs, fs.fab), this.view(fs, fs.ref)],
      recycle: [...(f.recycle ?? [])],
      short: isEmpty(fs.short) ? undefined : { ...fs.short },
    };
    this.host.send(fs.eid, msg);
  }

  private view(fs: FieldShip, m: Machine): MachineView {
    const f = fs.rec.field ?? {};
    const v: MachineView = { kind: m.kind, tier: m.tier, uid: m.uid, on: m.on, drawing: m.drawing };
    if (m.kind === 'fabricator') v.packs = f.packs ?? 'off';
    if (m.kind === 'refiner' && f.recipe) v.recipe = f.recipe;
    if (m.job) { v.job = { ...m.job, held: { ...m.job.held } }; v.at = m.powered ? fs.eu[m.pk] : this.host.getTick(); }
    if (!isEmpty(m.holding)) v.holding = { ...m.holding };
    if (m.blocked) v.blocked = m.blocked;
    return v;
  }
}
