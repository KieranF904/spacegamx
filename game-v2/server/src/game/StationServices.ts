/**
 * Station services: the refinery and the fabricator (each with a timed queue),
 * and the market. Every request is checked here: the pilot must be at a
 * station offering the service, know the recipe, and have the goods.
 *
 * Inputs come from cargo and storage; outputs go to storage (shared between
 * stations). Refining always takes a while (recipes.json `time` per batch);
 * fabricating does for anything bigger than a small part. Jobs run one after
 * another, a queue each for the refinery and the fabricator at the station
 * they were started at, and each finished run goes straight to storage,
 * wherever the pilot is. The fabricator needs its refined materials on hand:
 * refine them first (the hangar's build orders do both for you: Hangar.ts).
 *
 * Any job can be held (the rest of its queue moves up; it keeps the progress
 * of the run it was on), resumed (back into its place), moved to the front of
 * its queue, or called off: its unfinished runs' inputs go back to storage.
 */

import {
  Economy, StationData, Bag, CraftRecipe, ServerMessage, CraftJob,
  canCraft, sellPrice, buyPrice, queueSlots, unlocks, countOf, removeFrom, isStructuralItem, cutInputs, gemItemId, type GemsFile,
  stationPerks, stationLearned, armouryRound, stationTable, type Outpost,
} from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';
import { PayoutDice, type Dice } from './payoutDice.js';
import type { Market } from './Market.js';
import { activity } from '../activity/index.js';

export interface StationHost {
  /** The station (data and display name) this pilot is at, or null */
  stationAt(conn: PilotConn): StationData | null;
  stationName(id: string): string;
  send(conn: PilotConn, msg: ServerMessage): void;
  now(): number;
  /** Parts arrived in storage (the hangar fits them) */
  delivered?(conn: PilotConn): void;
  /** A station by id */
  station?(id: string): StationData | null;
  /** Every station offering a service */
  stationsWith?(service: string): StationData[];
  /** A job was called off (the hangar holds the order it was for, so it isn't queued again) */
  cancelled?(conn: PilotConn, job: CraftJob): void;
  /** Jobs were held, resumed or reordered (the hangar's view shows them) */
  jobsChanged?(conn: PilotConn): void;
  /** Ore went through the refinery (`used`: ore id → units), for the rare traces it carried */
  refined?(conn: PilotConn, used: Bag): void;
}

/** What a hangar order's job is for */
export interface JobTag { for: string; slot: number }

/** Same station, same kind (refinery or fabricator) */
const sameQueue = (a: CraftJob, b: CraftJob) => a.station === b.station && isRefineJob(a) === isRefineJob(b);

const MAX_BATCH = 999;
/** Refinery jobs at once (they don't use fabricator slots) */
const REFINE = 'refine:';
/** Gem cutting jobs: cut:<type>:<level> */
const CUT = 'cut:';

/** Is this job the refinery's (else the fabricator's) */
export const isRefineJob = (j: { recipe: string }) => j.recipe.startsWith(REFINE);

export class StationServices {
  /** Cut gems (data/gems.json) */
  gems?: GemsFile;
  /** Whether a gem cut fails: payout dice, from the server's secret (payoutDice.ts) */
  private readonly rng: Dice;

  /** `payout`: the server's payout dice (GameServer's; none: a secret of its own) */
  constructor(private host: StationHost, private pilots: Pilots, private econ: Economy, private market?: Market, payout: PayoutDice = new PayoutDice()) {
    this.rng = payout.stream('gem cuts');
  }

  /** Cut a gem: its inputs now, the gem when the job's done (or half the inputs back, if the cut fails) */
  cutGem(conn: PilotConn, msg: { gem: string; level: number }): void {
    const st = this.at(conn, 'fabricator');
    const p = this.pilots.get(conn);
    if (!st || !p || !this.gems) return;
    const type = String(msg.gem), level = Math.floor(Number(msg.level));
    const need = cutInputs(this.gems, type, level), cut = this.gems.cuts[String(level)];
    if (!need || !cut) return;
    if (this.fabJobs(p) >= queueSlots(p)) return this.pilots.toast(conn, 'Fabricator queue is full', 'warn');
    const short = this.shortOf(conn, need);
    if (short) return this.pilots.toast(conn, `Short of ${short}`, 'warn');
    this.pilots.take(conn, need);
    this.queueJob(conn, st.id, `${CUT}${type}:${level}`, { [gemItemId(type, level)]: 1 }, cut.seconds * 1000, 1);
    this.pilots.toast(conn, `Cutting a ${this.econ.items.name(gemItemId(type, level))}: ready in ${fmtTime(cut.seconds)}${cut.fail ? ` (${Math.round(cut.fail * 100)}% of cuts fail: half the stone comes back)` : ''}`, 'info');
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  /** The station a pilot is at (docked, or in range), if any */
  stationAt(conn: PilotConn): StationData | null {
    return this.host.stationAt(conn);
  }

  /** What a pilot can make: what they've learned (an armoury's own rounds once their station's armoury presses them) */
  learned(p: { recipes: string[]; outpost?: Outpost }): string[] {
    return stationLearned(p.recipes, p.outpost);
  }

  /** The armoury tier that presses a round ("Quench line") */
  private pressLine(id: string): string {
    const tiers = stationTable()?.tracks.armoury?.tiers ?? [];
    const at = tiers.findIndex((t) => t.rounds?.includes(id));
    return at >= 0 ? `tier ${at + 1}, the ${tiers[at].name.split(':')[0]}` : 'armoury';
  }

  /** A cut job's inputs (for calling it off, or a failed cut's half) */
  private cutJobInputs(recipe: string): Bag | null {
    if (!recipe.startsWith(CUT) || !this.gems) return null;
    const [type, level] = recipe.slice(CUT.length).split(':');
    return cutInputs(this.gems, type, Number(level));
  }

  private at(conn: PilotConn, service: string): StationData | null {
    const st = this.host.stationAt(conn);
    if (!st) { this.pilots.toast(conn, 'You need to be at a station', 'warn'); return null; }
    if (!st.services.includes(service as never)) { this.pilots.toast(conn, `${st.name} has no ${service}`, 'warn'); return null; }
    return st;
  }

  /** Station screen opened: collect finished jobs here, then send the station's details */
  open(conn: PilotConn): void {
    const st = this.host.stationAt(conn);
    if (!st) return;
    this.deliver(conn);
    this.sendStation(conn, st);
  }

  sendStation(conn: PilotConn, st = this.host.stationAt(conn)): void {
    const p = this.pilots.get(conn);
    if (!st || !p) return;
    const mk = this.market?.view(st);
    this.host.send(conn, {
      type: 'station', id: st.id, name: st.name, services: st.services, note: st.market?.note,
      sells: st.market?.sells.filter((id) => this.econ.items.has(id)) ?? [], demand: mk?.demand ?? st.market?.demand ?? {},
      sat: mk?.sat, wanted: mk?.wanted, glut: mk?.glut, cycleEndsIn: mk?.cycleEndsIn,
      jobs: p.jobs.map((j) => ({ ...j, stationName: this.host.stationName(j.station) })),
      now: this.host.now(), queueSlots: queueSlots(p),
    });
  }

  // ---------------------------------------------------------------------------
  // Refinery
  // ---------------------------------------------------------------------------

  refine(conn: PilotConn, msg: { recipe: string; batches: number }): void {
    const st = this.at(conn, 'refinery');
    const p = this.pilots.get(conn);
    if (!st || !p) return;
    const r = this.econ.recipes.refining.get(String(msg.recipe));
    const batches = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(msg.batches) || 1)));
    if (!r) return;
    if (r.level && p.level < r.level) return this.pilots.toast(conn, `Refining ${this.econ.items.name(r.id)} takes pilot level ${r.level}`, 'warn');
    if (p.jobs.filter(isRefineJob).length >= unlocks(p).refinerySlots) return this.pilots.toast(conn, 'Refinery queue is full', 'warn');
    const need: Bag = {};
    for (const [id, n] of Object.entries(r.inputs)) need[id] = n * batches;
    if (!this.pilots.take(conn, need)) return this.pilots.toast(conn, 'Not enough ore for that', 'warn');
    this.queueJob(conn, st.id, `${REFINE}${r.id}`, { [r.id]: r.out }, (r.time ?? 2) * 1000, batches);
    this.pilots.toast(conn, `Refining ${r.out * batches} × ${this.econ.items.name(r.id)}: ready in ${fmtTime((r.time ?? 2) * batches)}`, 'info');
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  /**
   * Queue refining for the hangar (no need to be there): up to `n` of a
   * refined material, as far as the ore in storage goes. Returns how many
   * will come.
   */
  refineFor(conn: PilotConn, stationId: string, id: string, n: number, tag?: JobTag): number {
    const p = this.pilots.get(conn);
    const r = this.econ.recipes.refining.get(id);
    if (!p || !r || n <= 0 || (r.level && p.level < r.level)) return 0;
    let batches = Math.ceil(n / r.out);
    for (const [o, k] of Object.entries(r.inputs)) batches = Math.min(batches, Math.floor(countOf(p.storage, o) / k));
    if (batches <= 0) return 0;
    for (const [o, k] of Object.entries(r.inputs)) removeFrom(p.storage, o, k * batches);
    this.queueJob(conn, stationId, `${REFINE}${r.id}`, { [r.id]: r.out }, (r.time ?? 2) * 1000, batches, tag);
    return r.out * batches;
  }

  // ---------------------------------------------------------------------------
  // Fabricator
  // ---------------------------------------------------------------------------

  craft(conn: PilotConn, msg: { recipe: string; n: number }): void {
    const st = this.at(conn, 'fabricator');
    const p = this.pilots.get(conn);
    if (!st || !p) return;
    const r: CraftRecipe | null = this.econ.recipes.recipeFor(String(msg.recipe));
    if (!r) return;
    if (isStructuralItem(r.id)) return this.pilots.toast(conn, 'Hull, armour, conduits and holds are built from materials in the hangar', 'info');
    if (!canCraft(r, this.learned(p), p.level)) {
      const pressed = armouryRound(r.id) && canCraft(r, p.recipes, p.level);
      return this.pilots.toast(conn, pressed ? `Only your own station's armoury presses ${this.econ.items.name(r.id)}: build it up to its ${this.pressLine(r.id)}` : `You don't know how to make that yet`, 'warn');
    }
    const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(msg.n) || 1)));
    if (r.time > 0 && this.fabJobs(p) >= queueSlots(p)) return this.pilots.toast(conn, 'Fabricator queue is full', 'warn');
    const need: Bag = {};
    for (const [id, k] of Object.entries(r.inputs)) need[id] = k * n;
    const short = this.shortOf(conn, need);
    if (short) return this.pilots.toast(conn, `Short of ${short}`, 'warn');
    this.pilots.take(conn, need);
    if (r.time <= 0) {
      const out: Bag = {};
      for (const [id, k] of Object.entries(r.out)) out[id] = k * n;
      this.pilots.give(conn, out, { toStorage: true, source: 'crafted' });
      this.host.delivered?.(conn);
    } else {
      this.queue(conn, st.id, r, n);
      this.pilots.toast(conn, `Fabricating ${n > 1 ? `${n} × ` : ''}${this.econ.items.name(Object.keys(r.out)[0])}: ready in ${fmtTime(r.time * n)}`, 'info');
    }
    this.pilots.bumpStat(conn, 'crafted', n);
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  /** A timed fabricator job: `n` runs, after whatever this station's fabricator is already making */
  private queue(conn: PilotConn, stationId: string, r: CraftRecipe, n: number, tag?: JobTag): void {
    this.queueJob(conn, stationId, r.id, r.out, r.time * 1000, n, tag);
  }

  /** `n` runs of a job after whatever this station's refinery (or fabricator) is already doing */
  private queueJob(conn: PilotConn, stationId: string, recipe: string, out: Bag, unitMs: number, n: number, tag?: JobTag): void {
    const p = this.pilots.get(conn)!;
    const now = this.host.now();
    const refinery = recipe.startsWith(REFINE);
    // Your station's refinery and fabricator tracks speed the work up
    const perks = stationPerks(p.outpost);
    unitMs = Math.max(250, Math.round(unitMs * (refinery ? perks.refineTime : perks.fabTime)));
    const last = p.jobs.filter((j) => j.station === stationId && isRefineJob(j) === refinery && !j.paused).reduce((t, j) => Math.max(t, j.readyAt), now);
    p.jobs.push({
      id: p.jobs.reduce((m, j) => Math.max(m, j.id), 0) + 1, recipe, station: stationId, out: { ...out }, count: n, done: 0, unitMs, startedAt: last, readyAt: last + unitMs * n,
      ...(tag ? { for: tag.for, slot: tag.slot } : {}),
    });
    this.pilots.markDirty(conn);
  }

  // ---------------------------------------------------------------------------
  // Holding, reordering and calling off jobs
  // ---------------------------------------------------------------------------

  /** A job: hold it, resume it, move it to the front of its queue, or call it off */
  jobAction(conn: PilotConn, id: number, action: 'pause' | 'resume' | 'cancel' | 'top', quiet = false): void {
    const p = this.pilots.get(conn);
    if (!p) return;
    this.deliver(conn);
    const j = p.jobs.find((x) => x.id === id);
    if (!j) return;
    if (action === 'cancel') {
      const name = this.jobName(j);
      this.cancelJobs(conn, [j]);
      this.pilots.toast(conn, `Called off ${name}: its materials are back in storage`, 'info');
      this.host.cancelled?.(conn, j);
    } else if (action === 'pause') {
      this.hold(p, [j]);
    } else if (action === 'resume') {
      this.release(p, [j]);
    } else if (action === 'top') {
      p.jobs.splice(p.jobs.indexOf(j), 1);
      const first = p.jobs.findIndex((x) => sameQueue(x, j));
      p.jobs.splice(first < 0 ? p.jobs.length : first, 0, j);
      if (j.paused) j.paused = false;
      this.reschedule(p, j);
    }
    this.pilots.markDirty(conn);
    if (quiet) return;
    this.pilots.saveNow(conn);
    this.host.jobsChanged?.(conn);
    this.sendStation(conn);
  }

  /** Hold jobs: each keeps the progress of its current run; the rest of its queue moves up */
  hold(p: { jobs: CraftJob[] }, jobs: CraftJob[]): void {
    const now = this.host.now();
    for (const j of jobs) {
      if (j.paused) continue;
      j.heldMs = Math.max(0, Math.min(j.unitMs, now - j.startedAt - j.done * j.unitMs));
      j.paused = true;
    }
    for (const j of jobs) this.reschedule(p, j);
  }

  /** Resume held jobs, in their place in the queue */
  release(p: { jobs: CraftJob[] }, jobs: CraftJob[]): void {
    for (const j of jobs) j.paused = false;
    for (const j of jobs) this.reschedule(p, j);
  }

  /** Call jobs off: their unfinished runs' inputs go back to storage */
  cancelJobs(conn: PilotConn, jobs: CraftJob[]): void {
    const p = this.pilots.get(conn);
    if (!p || !jobs.length) return;
    const back: Bag = {};
    for (const j of jobs) {
      const inputs = isRefineJob(j) ? this.econ.recipes.refining.get(j.recipe.slice(REFINE.length))?.inputs : this.cutJobInputs(j.recipe) ?? this.econ.recipes.recipeFor(j.recipe)?.inputs;
      for (const [id, n] of Object.entries(inputs ?? {})) back[id] = (back[id] ?? 0) + n * (j.count - j.done);
    }
    const gone = new Set(jobs);
    p.jobs = p.jobs.filter((j) => !gone.has(j));
    for (const j of jobs) this.reschedule(p, j);
    if (Object.keys(back).length) this.pilots.give(conn, back, { toStorage: true, source: 'crafted', quiet: true });
    this.pilots.markDirty(conn);
  }

  /** Lay a queue out again (the one `like` is in): running jobs back to back from now, held ones aside */
  private reschedule(p: { jobs: CraftJob[] }, like: CraftJob): void {
    const now = this.host.now();
    let cursor = now;
    for (const j of p.jobs) {
      if (!sameQueue(j, like) || j.paused) continue;
      const partial = j.heldMs ?? Math.max(0, Math.min(j.unitMs, now - j.startedAt - j.done * j.unitMs));
      delete j.heldMs;
      // A run under way can't have finished already (deliver() took those)
      j.startedAt = cursor - j.done * j.unitMs - Math.min(partial, j.unitMs - 1);
      j.readyAt = j.startedAt + j.unitMs * j.count;
      cursor = j.readyAt;
    }
  }

  private jobName(j: CraftJob): string {
    const out = Object.entries(j.out)[0];
    return out ? `${out[1] * (j.count - j.done)} × ${this.econ.items.name(out[0])}` : 'the job';
  }

  /** Fabricator jobs (the refinery's don't count against its slots) */
  private fabJobs(p: { jobs: { recipe: string }[] }): number {
    return p.jobs.filter((j) => !isRefineJob(j)).length;
  }

  /** "3 × Alloy Plate" for the first thing short of `need` (cargo and storage), or null */
  private shortOf(conn: PilotConn, need: Bag): string | null {
    for (const [id, n] of Object.entries(need)) {
      const left = n - this.pilots.available(conn, id);
      if (left > 0) return `${left} × ${this.econ.items.name(id)}${this.econ.recipes.refining.has(id) ? ' (refine it first)' : ''}`;
    }
    return null;
  }

  /**
   * Fabricate for the hangar (no need to be there): up to `n` of a module, as
   * far as the materials in storage go; small ones at once, the rest queued.
   * Returns how many were made or queued.
   */
  makeFor(conn: PilotConn, stationId: string, id: string, n: number, tag?: JobTag): number {
    const p = this.pilots.get(conn);
    const r = this.econ.recipes.recipeFor(id);
    if (!p || !r || n <= 0 || !canCraft(r, this.learned(p), p.level)) return 0;
    const timed = r.time > 0;
    if (timed && this.fabJobs(p) >= queueSlots(p)) return 0;
    let k = n;
    for (const [o, m] of Object.entries(r.inputs)) k = Math.min(k, Math.floor(countOf(p.storage, o) / m));
    if (k <= 0) return 0;
    for (const [o, m] of Object.entries(r.inputs)) removeFrom(p.storage, o, m * k);
    this.pilots.bumpStat(conn, 'crafted', k);
    if (!timed) {
      const out: Bag = {};
      for (const [o, m] of Object.entries(r.out)) out[o] = m * k;
      this.pilots.give(conn, out, { toStorage: true, source: 'crafted', quiet: true });
    } else {
      this.queue(conn, stationId, r, k, tag);
    }
    return k;
  }

  /** Where the hangar's own jobs run: here if this station offers it, else home, else any station that does */
  workshop(conn: PilotConn, service: 'refinery' | 'fabricator'): string | null {
    const has = (st: StationData | null | undefined) => !!st && st.services.includes(service as never);
    const here = this.host.stationAt(conn);
    if (has(here)) return here!.id;
    const home = this.pilots.get(conn)?.home;
    const h = home ? this.host.station?.(home) : null;
    if (has(h)) return h!.id;
    return this.host.stationsWith?.(service)[0]?.id ?? null;
  }

  /** Every second or so: finished runs go to storage, wherever the pilot is */
  deliver(conn: PilotConn): boolean {
    const p = this.pilots.get(conn);
    if (!p || !p.jobs.length) return false;
    const now = this.host.now();
    const bag: Bag = {}, used: Bag = {};
    for (const j of p.jobs) {
      if (j.paused) continue;
      const ready = Math.min(j.count, Math.floor((now - j.startedAt) / j.unitMs));
      if (ready <= j.done) continue;
      const cut = this.cutJobInputs(j.recipe);
      if (cut) {
        // Each cut may fail: half the stone comes back
        const fail = Math.max(0, (this.gems?.cuts[j.recipe.split(':').pop()!]?.fail ?? 0) - stationPerks(p.outpost).cutFail);
        for (let k = j.done; k < ready; k++) {
          if (this.rng() >= fail) { for (const [id, n] of Object.entries(j.out)) bag[id] = (bag[id] ?? 0) + n; continue; }
          for (const [id, n] of Object.entries(cut)) if (Math.floor(n / 2) > 0) bag[id] = (bag[id] ?? 0) + Math.floor(n / 2);
          this.pilots.toast(conn, `The cut failed: half the stone is back in storage`, 'warn');
        }
        j.done = ready;
        continue;
      }
      for (const [id, n] of Object.entries(j.out)) bag[id] = (bag[id] ?? 0) + n * (ready - j.done);
      // Your station's refinery gets more plate out of a batch: over the job, exactly that share more
      const y = isRefineJob(j) ? stationPerks(p.outpost).refineYield : 0;
      if (y > 0) for (const [id, n] of Object.entries(j.out)) {
        const extra = Math.floor(n * ready * y) - Math.floor(n * j.done * y);
        if (extra > 0) bag[id] = (bag[id] ?? 0) + extra;
      }
      if (isRefineJob(j)) {
        for (const [id, n] of Object.entries(this.econ.recipes.refining.get(j.recipe.slice(REFINE.length))?.inputs ?? {})) used[id] = (used[id] ?? 0) + n * (ready - j.done);
      }
      j.done = ready;
    }
    if (!Object.keys(bag).length) return false;
    p.jobs = p.jobs.filter((j) => j.done < j.count);
    this.pilots.give(conn, bag, { toStorage: true, source: 'crafted', quiet: true });
    for (const [id, n] of Object.entries(bag)) if (this.econ.recipes.refining.has(id)) this.pilots.bumpStat(conn, 'refined', n);
    if (Object.keys(used).length) this.host.refined?.(conn, used);
    if (!p.jobs.length) this.pilots.toast(conn, 'Refining and fabrication done: everything is in storage', 'good');
    this.pilots.markDirty(conn);
    this.host.delivered?.(conn);
    const st = this.host.stationAt(conn);
    if (st) this.sendStation(conn, st);
    return true;
  }

  tick(conn: PilotConn): void {
    this.deliver(conn);
  }

  /** Sell every raw mineral in the hold */
  sellAll(conn: PilotConn): void {
    const st = this.at(conn, 'market');
    const p = this.pilots.get(conn);
    if (!st || !p) return;
    let total = 0, count = 0;
    for (const s of [...p.cargo]) {
      const d = this.econ.items.get(s.id);
      if (d?.category !== 'mineral') continue;
      total += this.market ? this.market.sell(st, s.id, s.n) : sellPrice(this.econ.items, s.id, st.market?.demand) * s.n;
      count += s.n;
      removeFrom(p.cargo, s.id, s.n);
    }
    if (!count) return this.pilots.toast(conn, 'No raw ore in your hold to sell', 'info');
    this.pilots.addCredits(conn, total);
    this.pilots.bumpStat(conn, 'earned', total);
    this.pilots.toast(conn, `Sold ${count} ore for ${total.toLocaleString()} cr`, 'good');
    activity.sale(conn, `${count} ore`, total, st.name);
    this.pilots.sendItems(conn);
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  // ---------------------------------------------------------------------------
  // Market
  // ---------------------------------------------------------------------------

  sell(conn: PilotConn, msg: { id: string; n: number }): void {
    const st = this.at(conn, 'market');
    const p = this.pilots.get(conn);
    if (!st || !p || typeof msg.id !== 'string') return;
    const def = this.econ.items.get(msg.id);
    if (!def) return;
    const have = countOf(p.cargo, msg.id) + countOf(p.storage, msg.id);
    const n = Math.min(have, Math.max(1, Math.floor(Number(msg.n) || 1)));
    if (n <= 0) return;
    const total = this.market ? this.market.sell(st, msg.id, n) : sellPrice(this.econ.items, msg.id, st.market?.demand) * n;
    if (total <= 0) return this.pilots.toast(conn, `Nobody here will pay for ${def.name}`, 'warn');
    // Cargo first, then storage
    const fromCargo = removeFrom(p.cargo, msg.id, n);
    removeFrom(p.storage, msg.id, n - fromCargo);
    this.pilots.addCredits(conn, total);
    this.pilots.bumpStat(conn, 'earned', total);
    this.pilots.toast(conn, `Sold ${n} × ${def.name} for ${total.toLocaleString()} cr`, 'good');
    activity.sale(conn, `${n} × ${def.name}`, total, st.name);
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  buy(conn: PilotConn, msg: { id: string; n: number }): void {
    const st = this.at(conn, 'market');
    const p = this.pilots.get(conn);
    if (!st || !p || typeof msg.id !== 'string') return;
    if (!st.market?.sells.includes(msg.id) || !this.econ.items.has(msg.id)) return this.pilots.toast(conn, `${st.name} doesn't sell that`, 'warn');
    const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(msg.n) || 1)));
    const price = buyPrice(this.econ.items, msg.id);
    if (p.credits < price * n) return this.pilots.toast(conn, 'Not enough credits', 'warn');
    this.pilots.addCredits(conn, -price * n);
    this.pilots.give(conn, { [msg.id]: n }, { toStorage: true, source: 'bought' });
    this.pilots.saveNow(conn);
  }
}

function fmtTime(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
