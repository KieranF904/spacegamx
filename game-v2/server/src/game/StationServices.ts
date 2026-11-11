/**
 * Station services: the refinery and the fabricator (each with a timed queue),
 * and the market. Every request is checked here: the pilot must be at a
 * station offering the service, know the recipe, and have the goods.
 *
 * Inputs come from cargo and storage; outputs go to storage (shared between
 * stations). Refining always takes a while (recipes.json `time` per batch);
 * fabricating does for anything bigger than a small part. Jobs run in
 * parallel lanes, a queue each for the refinery and the fabricator at the station
 * they were started at, and each finished run goes straight to storage,
 * wherever the pilot is. The fabricator needs its refined materials on hand:
 * refine them first (the hangar's build orders do both for you: Hangar.ts).
 *
 * Each queue runs as many jobs side by side as the pilot has lanes (one, plus
 * one per engineering milestone: jobLanes, 4 at most). The queue itself has no
 * length limit, and an order needs no materials in hand: a job takes its
 * inputs when a lane starts its runs (as many runs as the materials in storage
 * allow, topped up as more arrive), not when it is queued. A job whose next
 * run lacks materials waits and doesn't block: the next one in line that can
 * start does, first come first served. Finished runs land in storage, so a
 * refine feeds the fabrication queued behind it (deliver() starts whatever
 * can start, every second or so and at login).
 *
 * Any job can be held (the rest of its queue moves up; it keeps the progress
 * of the run it was on), resumed (back into its place), moved to the front of
 * its queue, or called off: the inputs of runs it had taken but not finished
 * go back to storage (runs it never started cost nothing).
 */

import {
  Economy, StationData, Bag, CraftRecipe, ServerMessage, CraftJob,
  canCraft, sellPrice, buyPrice, jobLanes, countOf, removeFrom, isStructuralItem, cutInputs, gemItemId, type GemsFile,
  stationPerks, stationLearned, type PlayerProfile, armouryRound, stationTable, type Outpost,
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
/** Runs whose inputs are taken (jobs saved before lazy starts paid for every run when queued) */
const takenOf = (j: CraftJob) => j.taken ?? j.count;
/** Runs still to pay for: they start, and take their inputs, when a lane has them and the materials are in storage */
const untaken = (j: CraftJob) => j.count - takenOf(j);
/** Paid-for runs still to finish: it holds a lane (or is scheduled behind one, if it was held and resumed with the lanes full) */
const running = (j: CraftJob) => takenOf(j) > j.done;

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
    const short = this.shortOf(conn, need);
    if (short) return this.pilots.toast(conn, `Short of ${short}`, 'warn');
    this.pilots.take(conn, need);
    this.queueJob(conn, st.id, `${CUT}${type}:${level}`, { [gemItemId(type, level)]: 1 }, cut.seconds * 1000, 1, undefined, true);
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
      jobs: p.jobs.map((j) => ({ ...j, stationName: this.host.stationName(j.station), ...this.jobState(p, j) })),
      now: this.host.now(), lanes: jobLanes(p),
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
    // Queued whatever ore is in hand; the batches take it when a lane starts them
    const j = this.queueJob(conn, st.id, `${REFINE}${r.id}`, { [r.id]: r.out }, (r.time ?? 2) * 1000, batches);
    this.startNow(conn);
    const name = `${r.out * batches} × ${this.econ.items.name(r.id)}`;
    this.pilots.toast(conn, this.began(p, j) ? `Refining ${name}: ready in ${fmtTime((r.time ?? 2) * batches)}` : `Queued ${name}: ${this.waitText(p, j)}`, 'info');
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  /**
   * Queue refining for the hangar (no need to be there): `n` of a refined
   * material, ore in hand or not; the batches start as the ore reaches
   * storage. Returns how many will come.
   */
  refineFor(conn: PilotConn, stationId: string, id: string, n: number, tag?: JobTag): number {
    const p = this.pilots.get(conn);
    const r = this.econ.recipes.refining.get(id);
    if (!p || !r || n <= 0 || (r.level && p.level < r.level)) return 0;
    const batches = Math.ceil(n / r.out);
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
    if (isStructuralItem(r.id)) return this.pilots.toast(conn, 'Hull, armour, conduits and cargo holds are built in the hangar from plate.', 'info');
    if (!canCraft(r, this.learned(p), p.level)) {
      const pressed = armouryRound(r.id) && canCraft(r, p.recipes, p.level);
      return this.pilots.toast(conn, pressed ? `${this.econ.items.name(r.id)} is made only at your own station's armoury. Upgrade it to ${this.pressLine(r.id)}.` : `You don't know how to make that yet`, 'warn');
    }
    const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(msg.n) || 1)));
    const name = `${n > 1 ? `${n} × ` : ''}${this.econ.items.name(Object.keys(r.out)[0])}`;
    if (r.time > 0) {
      // Queued whatever is in hand; its inputs are taken when a lane starts it
      const j = this.queue(conn, st.id, r, n);
      this.startNow(conn);
      this.pilots.toast(conn, this.began(p, j) ? `Fabricating ${name}: ready in ${fmtTime(r.time * n)}` : `Queued ${name}: ${this.waitText(p, j)}`, 'info');
    } else {
      // Instant: it needs its inputs now
      const need: Bag = {};
      for (const [id, k] of Object.entries(r.inputs)) need[id] = k * n;
      const short = this.shortOf(conn, need);
      if (short) return this.pilots.toast(conn, `Short of ${short}`, 'warn');
      this.pilots.take(conn, need);
      const out: Bag = {};
      for (const [id, k] of Object.entries(r.out)) out[id] = k * n;
      this.pilots.give(conn, out, { toStorage: true, source: 'crafted' });
      this.host.delivered?.(conn);
    }
    this.pilots.bumpStat(conn, 'crafted', n);
    this.pilots.saveNow(conn);
    this.sendStation(conn, st);
  }

  /** A timed fabricator job: `n` runs, after whatever this station's fabricator is already making */
  private queue(conn: PilotConn, stationId: string, r: CraftRecipe, n: number, tag?: JobTag): CraftJob {
    return this.queueJob(conn, stationId, r.id, r.out, r.time * 1000, n, tag);
  }

  /**
   * `n` runs of a job at the back of this station's refinery (or fabricator)
   * queue. Nothing is taken yet: deliver() starts its runs when a lane and the
   * materials are there. `prepaid` jobs (gem cuts) have paid already: they
   * take the first lane to come free, as jobs always used to.
   */
  private queueJob(conn: PilotConn, stationId: string, recipe: string, out: Bag, unitMs: number, n: number, tag?: JobTag, prepaid = false): CraftJob {
    const p = this.pilots.get(conn)!;
    const now = this.host.now();
    const refinery = recipe.startsWith(REFINE);
    // Your station's refinery and fabricator tracks speed the work up
    const perks = stationPerks(p.outpost);
    unitMs = Math.max(250, Math.round(unitMs * (refinery ? perks.refineTime : perks.fabTime)));
    const last = prepaid ? Math.min(...this.lanes(p, stationId, refinery, now)) : now;
    const job: CraftJob = {
      id: p.jobs.reduce((m, j) => Math.max(m, j.id), 0) + 1, recipe, station: stationId, out: { ...out }, count: n, done: 0, unitMs, startedAt: last, readyAt: prepaid ? last + unitMs * n : last,
      taken: prepaid ? n : 0,
      ...(tag ? { for: tag.for, slot: tag.slot } : {}),
    };
    p.jobs.push(job);
    this.pilots.markDirty(conn);
    return job;
  }

  /** Start what can start now, taking from cargo too (the pilot is at the station and just placed an order) */
  private startNow(conn: PilotConn): void {
    this.deliver(conn, 'any');
  }

  /** Has a lane started some of this job's runs (or has it finished: it's gone from the list) */
  private began(p: PlayerProfile, j: CraftJob): boolean {
    return !p.jobs.includes(j) || takenOf(j) > 0;
  }

  /** What one run of a job takes */
  private jobInputs(j: CraftJob): Bag {
    return (isRefineJob(j) ? this.econ.recipes.refining.get(j.recipe.slice(REFINE.length))?.inputs : this.cutJobInputs(j.recipe) ?? this.econ.recipes.recipeFor(j.recipe)?.inputs) ?? {};
  }

  /** What the runs of a pilot's jobs not yet started will take (`tag`: only the jobs of that order) */
  pendingInputs(p: PlayerProfile, tag?: JobTag): Bag {
    const out: Bag = {};
    for (const j of p.jobs) {
      if (untaken(j) <= 0 || (tag && (j.for !== tag.for || j.slot !== tag.slot))) continue;
      for (const [id, n] of Object.entries(this.jobInputs(j))) out[id] = (out[id] ?? 0) + n * untaken(j);
    }
    return out;
  }

  /** "2 × Alloy Plate, 5 × Iron Ore" for what one run of the job is short of in storage (empty: nothing) */
  private shortText(p: PlayerProfile, j: CraftJob): string {
    const bits: string[] = [];
    for (const [id, n] of Object.entries(this.jobInputs(j))) {
      const left = n - countOf(p.storage, id);
      if (left > 0) bits.push(`${left} × ${this.econ.items.name(id)}`);
    }
    return bits.join(', ');
  }

  /** Why a job that hasn't started waits: its materials, or a lane */
  private waitText(p: PlayerProfile, j: CraftJob): string {
    const short = this.shortText(p, j);
    return short ? `waiting for materials: ${short}` : 'waiting for a lane';
  }

  /** A job's state for the station screen: held, running, or waiting (for a lane, or for materials: what's short) */
  private jobState(p: PlayerProfile, j: CraftJob): { wait?: 'lane' | 'materials'; short?: string } {
    if (j.paused) return {};
    if (running(j)) return j.startedAt > this.host.now() ? { wait: 'lane' } : {};
    if (untaken(j) <= 0) return {};
    const short = this.shortText(p, j);
    return short ? { wait: 'materials', short } : { wait: 'lane' };
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
      const paid = running(j);
      this.cancelJobs(conn, [j]);
      this.pilots.toast(conn, `Called off ${name}${paid ? ': its materials are back in storage' : ''}`, 'info');
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
    // A freed lane (a held or called-off job) goes to the next job that can start
    this.deliver(conn);
    this.pilots.saveNow(conn);
    this.host.jobsChanged?.(conn);
    this.sendStation(conn);
  }

  /** Hold jobs: each keeps the progress of its current run; the rest of its queue moves up */
  hold(p: PlayerProfile, jobs: CraftJob[]): void {
    const now = this.host.now();
    for (const j of jobs) {
      if (j.paused) continue;
      if (running(j)) j.heldMs = Math.max(0, Math.min(j.unitMs, now - j.startedAt - j.done * j.unitMs));
      j.paused = true;
    }
    for (const j of jobs) this.reschedule(p, j);
  }

  /** Resume held jobs, in their place in the queue */
  release(p: PlayerProfile, jobs: CraftJob[]): void {
    for (const j of jobs) j.paused = false;
    for (const j of jobs) this.reschedule(p, j);
  }

  /** Call jobs off: the inputs of the runs they took and hadn't finished go back to storage (runs not started took nothing) */
  cancelJobs(conn: PilotConn, jobs: CraftJob[]): void {
    const p = this.pilots.get(conn);
    if (!p || !jobs.length) return;
    const back: Bag = {};
    for (const j of jobs) {
      for (const [id, n] of Object.entries(this.jobInputs(j))) back[id] = (back[id] ?? 0) + n * (takenOf(j) - j.done);
    }
    for (const id of Object.keys(back)) if (back[id] <= 0) delete back[id];
    const gone = new Set(jobs);
    p.jobs = p.jobs.filter((j) => !gone.has(j));
    for (const j of jobs) this.reschedule(p, j);
    if (Object.keys(back).length) this.pilots.give(conn, back, { toStorage: true, source: 'crafted', quiet: true });
    this.pilots.markDirty(conn);
  }

  /** How many jobs a queue runs at once (the same for the refinery and the fabricator: engineering's lanes, not the queue's slots) */
  private slots(p: PlayerProfile, _refinery: boolean): number {
    return jobLanes(p);
  }

  /** When each lane of a queue comes free, jobs given the first free lane in their order (held ones aside) */
  private lanes(p: PlayerProfile, stationId: string, refinery: boolean, now: number): number[] {
    const free = new Array<number>(this.slots(p, refinery)).fill(now);
    for (const j of p.jobs) {
      if (j.station !== stationId || isRefineJob(j) !== refinery || j.paused || !running(j)) continue;
      free[free.indexOf(Math.min(...free))] = Math.max(now, j.readyAt);
    }
    return free;
  }

  /** Lay a queue out again (the one `like` is in): jobs with paid-for runs side by side from now, one to a lane, held ones (and ones waiting to start) aside */
  private reschedule(p: PlayerProfile, like: CraftJob): void {
    const now = this.host.now();
    const free = new Array<number>(this.slots(p, isRefineJob(like))).fill(now);
    for (const j of p.jobs) {
      if (!sameQueue(j, like) || j.paused || !running(j)) continue;
      const lane = free.indexOf(Math.min(...free)), cursor = free[lane];
      const partial = j.heldMs ?? Math.max(0, Math.min(j.unitMs, now - j.startedAt - j.done * j.unitMs));
      delete j.heldMs;
      // A run under way can't have finished already (deliver() took those)
      j.startedAt = cursor - j.done * j.unitMs - Math.min(partial, j.unitMs - 1);
      j.readyAt = j.startedAt + j.unitMs * takenOf(j);
      free[lane] = j.readyAt;
    }
  }

  private jobName(j: CraftJob): string {
    const out = Object.entries(j.out)[0];
    return out ? `${out[1] * (j.count - j.done)} × ${this.econ.items.name(out[0])}` : 'the job';
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
   * Fabricate for the hangar (no need to be there): `n` of a module. Timed
   * ones are all queued, materials in hand or not (they start as the
   * materials reach storage); small ones are made at once, as far as the
   * materials in storage go. Returns how many were made or queued.
   */
  makeFor(conn: PilotConn, stationId: string, id: string, n: number, tag?: JobTag): number {
    const p = this.pilots.get(conn);
    const r = this.econ.recipes.recipeFor(id);
    if (!p || !r || n <= 0 || !canCraft(r, this.learned(p), p.level)) return 0;
    if (r.time > 0) {
      const runs = Math.floor(n);
      if (runs <= 0) return 0;
      this.queue(conn, stationId, r, runs, tag);
      this.pilots.bumpStat(conn, 'crafted', runs);
      return runs;
    }
    let k = n;
    for (const [o, m] of Object.entries(r.inputs)) k = Math.min(k, Math.floor(countOf(p.storage, o) / m));
    if (k <= 0) return 0;
    for (const [o, m] of Object.entries(r.inputs)) removeFrom(p.storage, o, m * k);
    this.pilots.bumpStat(conn, 'crafted', k);
    const out: Bag = {};
    for (const [o, m] of Object.entries(r.out)) out[o] = m * k;
    this.pilots.give(conn, out, { toStorage: true, source: 'crafted', quiet: true });
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

  /**
   * Every second or so (and when the station screen opens, and at login):
   * finished runs go to storage, wherever the pilot is, and whatever can start
   * now does, in queue order (a job with materials behind one without goes
   * first). Starting takes inputs from storage (`from`: any also takes cargo,
   * for an order just placed at the station). A start is dated when its lane
   * came free, or when the latest of its inputs arrived from a job finishing
   * (a refine that finished while offline feeds the fabrication behind it from
   * then on), never retroactively for materials that weren't there.
   */
  deliver(conn: PilotConn, from: 'storage' | 'any' = 'storage'): boolean {
    const p = this.pilots.get(conn);
    if (!p || !p.jobs.length) return false;
    const now = this.host.now();
    const arrived: Bag = {};
    let changed = false, delivered = false;
    // Each pass finishes what's done, then starts what it freed room (and materials) for; a run started in the past may already be done
    for (let pass = 0; pass < 24; pass++) {
      const lanes = this.laneTimes(p, now);
      const fin = this.finish(conn, p, now, arrived);
      const began = this.startRuns(conn, p, now, lanes, arrived, from);
      delivered ||= fin;
      changed ||= fin || began;
      if (!began) break;
    }
    if (!changed) return false;
    this.pilots.markDirty(conn);
    if (delivered) this.host.delivered?.(conn);
    const st = this.host.stationAt(conn);
    if (st) this.sendStation(conn, st);
    return true;
  }

  /** Finished runs into storage (`arrived`: when each item last came in, ms); true if any went */
  private finish(conn: PilotConn, p: PlayerProfile, now: number, arrived: Bag): boolean {
    const bag: Bag = {}, used: Bag = {};
    for (const j of p.jobs) {
      if (j.paused) continue;
      const ready = Math.min(takenOf(j), Math.floor((now - j.startedAt) / j.unitMs));
      if (ready <= j.done) continue;
      const at = j.startedAt + ready * j.unitMs;
      for (const id of Object.keys(j.out)) arrived[id] = Math.max(arrived[id] ?? 0, at);
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
    return true;
  }

  /** When each lane of each queue comes free, as it stands (a lane whose job is done keeps that job's end time: what a start behind it is dated from; a lane no job has is free from always) */
  private laneTimes(p: PlayerProfile, now: number): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const j of p.jobs) {
      if (j.paused || !running(j)) continue;
      const key = `${j.station}|${isRefineJob(j)}`;
      let free = out.get(key);
      if (!free) out.set(key, free = new Array<number>(this.slots(p, isRefineJob(j))).fill(-Infinity));
      free[free.indexOf(Math.min(...free))] = j.readyAt;
    }
    return out;
  }

  /**
   * Start the runs that can: each job in queue order, if it has a lane (or
   * already holds one) and its inputs are in storage, takes them for as many
   * runs as they cover. A job short of materials is passed over; the next one
   * goes ahead of it.
   */
  private startRuns(conn: PilotConn, p: PlayerProfile, now: number, lanes: Map<string, number[]>, arrived: Bag, from: 'storage' | 'any'): boolean {
    let any = false;
    for (const j of p.jobs) {
      if (j.paused || untaken(j) <= 0) continue;
      const each = this.jobInputs(j);
      const key = `${j.station}|${isRefineJob(j)}`;
      let free = lanes.get(key);
      if (!free) lanes.set(key, free = new Array<number>(this.slots(p, isRefineJob(j))).fill(-Infinity));
      const holds = running(j);
      const lane = free.indexOf(Math.min(...free));
      // Not running: it needs a free lane first
      if (!holds && free[lane] > now) continue;
      let k = untaken(j);
      for (const [id, n] of Object.entries(each)) k = Math.min(k, Math.floor((from === 'any' ? this.pilots.available(conn, id) : countOf(p.storage, id)) / n));
      if (k <= 0) continue;
      const need: Bag = {};
      for (const [id, n] of Object.entries(each)) need[id] = n * k;
      if (!this.pilots.take(conn, need, from)) continue;
      if (holds) {
        // Under way: more runs on the end of it
        j.taken = takenOf(j) + k;
        j.readyAt = j.startedAt + j.unitMs * j.taken;
      } else {
        // From when the lane was free and the last of its inputs came in from a job finishing (an idle lane, inputs from storage: now)
        let at = free[lane];
        for (const id of Object.keys(each)) at = Math.max(at, arrived[id] ?? -Infinity);
        if (at === -Infinity) at = now;
        j.startedAt = at - j.done * j.unitMs;
        j.taken = j.done + k;
        j.readyAt = at + j.unitMs * k;
        free[lane] = j.readyAt;
      }
      any = true;
    }
    return any;
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
