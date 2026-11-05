/**
 * What a bot measures: per trip and in total. A TRIP is one full cycle of a task that returns to its station: the wait
 * docked, the flight out, mining, collecting, the flight back and the dock (the setup before the first dock is not in
 * any trip). Times are game ticks (TICK_RATE a second); the wall clock is kept alongside for the benches.
 *
 * Ore is counted at three places so a loss shows: MINED (kept in the chunks the lasers threw), COLLECTED (picked up into
 * the hold) and DEPOSITED (left at the station). `lost` is mined less collected: chunks left drifting.
 */
import { PHASES, type Bag, type Phase } from '../core/types.js';

export interface TripStats {
  index: number;
  startTick: number;
  endTick: number;
  wallMs: number;
  /** Game ticks in each phase */
  ticks: Record<Phase, number>;
  distance: number;
  mined: Bag;
  collected: Bag;
  deposited: Bag;
  credits: number;
  valueIfSold: number;
  chunksThrown: number;
  chunksCollected: number;
  brownoutTicks: number;
  rocks: number;
}

const bag = (): Bag => ({});
const phases = (): Record<Phase, number> => Object.fromEntries(PHASES.map((p) => [p, 0])) as Record<Phase, number>;
const blank = (index: number, startTick: number): TripStats => ({
  index, startTick, endTick: startTick, wallMs: 0, ticks: phases(), distance: 0, mined: bag(), collected: bag(), deposited: bag(),
  credits: 0, valueIfSold: 0, chunksThrown: 0, chunksCollected: 0, brownoutTicks: 0, rocks: 0,
});
const addBag = (into: Bag, from: Bag): void => { for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n; };
const sum = (b: Bag): number => Object.values(b).reduce((t, n) => t + n, 0);

export interface Summary {
  trips: number;
  /** Game seconds covered by the completed trips, and all of the run (setup and a trip still going included) */
  tripSeconds: number;
  runSeconds: number;
  setupSeconds: number;
  wallSeconds: number;
  distance: number;
  mined: Bag; collected: Bag; deposited: Bag;
  oreMined: number; oreCollected: number; oreDeposited: number; oreLost: number;
  credits: number; valueIfSold: number;
  chunksThrown: number; chunksCollected: number;
  brownoutSeconds: number;
  /** Seconds in each phase, summed over completed trips, and each phase's share of the trip time */
  seconds: Record<Phase, number>;
  share: Record<Phase, number>;
  /** Per game hour of completed trips */
  orePerHour: number; valuePerHour: number; creditsPerHour: number;
  /** Mean per trip */
  tripSecondsMean: number; orePerTrip: number;
  /** Mining time over (mining + travelling), the share of a working trip spent cutting rock */
  miningShare: number; travelShare: number;
}

export class BotStats {
  readonly trips: TripStats[] = [];
  private cur: TripStats | null = null;
  private setupTicks = 0;
  /** What a trip still going has so far, and what happened outside any trip (mined before the first dock, say) */
  private startWall = 0;
  private lastPos: { x: number; y: number } | null = null;
  private firstTick = -1;
  private lastTick = 0;
  private wall0: number;

  constructor(readonly tickRate: number, private readonly wall: () => number = () => Date.now()) { this.wall0 = wall(); }

  get tripOpen(): boolean { return this.cur !== null; }
  get current(): TripStats | null { return this.cur; }

  beginTrip(tick: number): void {
    if (this.cur) this.endTrip(tick);
    this.cur = blank(this.trips.length + 1, tick);
    this.startWall = this.wall();
  }

  endTrip(tick: number): void {
    const t = this.cur;
    if (!t) return;
    t.endTick = tick;
    t.wallMs = this.wall() - this.startWall;
    this.trips.push(t);
    this.cur = null;
  }

  /** One tick spent in `phase` (and `brownout`: short of power); `pos` the ship's place, for the distance flown */
  tick(tick: number, phase: Phase, brownout: boolean, pos?: { x: number; y: number }): void {
    if (this.firstTick < 0) this.firstTick = tick;
    this.lastTick = tick;
    if (pos) {
      if (this.lastPos && phase !== 'docked') {
        const d = Math.hypot(pos.x - this.lastPos.x, pos.y - this.lastPos.y);
        // (A jump of this size is a teleport (undock or the berth), not flying)
        if (this.cur && d < 400) this.cur.distance += d;
      }
      this.lastPos = { x: pos.x, y: pos.y };
    }
    if (!this.cur) { this.setupTicks++; return; }
    this.cur.ticks[phase]++;
    if (brownout) this.cur.brownoutTicks++;
  }

  mined(b: Bag, chunks = 1): void { if (this.cur) { addBag(this.cur.mined, b); this.cur.chunksThrown += chunks; } }
  collected(b: Bag, chunks = 1): void { if (this.cur) { addBag(this.cur.collected, b); this.cur.chunksCollected += chunks; } }
  rock(): void { if (this.cur) this.cur.rocks++; }
  deposited(b: Bag, credits: number, valueIfSold: number): void {
    if (!this.cur) return;
    addBag(this.cur.deposited, b);
    this.cur.credits += credits;
    this.cur.valueIfSold += valueIfSold;
  }

  summary(): Summary {
    const done = this.trips;
    const seconds = phases(), mined = bag(), collected = bag(), deposited = bag();
    let ticks = 0, distance = 0, credits = 0, value = 0, thrown = 0, got = 0, brown = 0, wall = 0;
    for (const t of done) {
      for (const p of PHASES) seconds[p] += t.ticks[p] / this.tickRate;
      ticks += t.endTick - t.startTick;
      distance += t.distance; credits += t.credits; value += t.valueIfSold; thrown += t.chunksThrown; got += t.chunksCollected;
      brown += t.brownoutTicks; wall += t.wallMs;
      addBag(mined, t.mined); addBag(collected, t.collected); addBag(deposited, t.deposited);
    }
    const tripSeconds = ticks / this.tickRate, hours = tripSeconds / 3600 || 1;
    const share = phases();
    for (const p of PHASES) share[p] = tripSeconds ? seconds[p] / tripSeconds : 0;
    const oreMined = sum(mined), oreCollected = sum(collected), oreDeposited = sum(deposited);
    const travel = seconds.travelOut + seconds.travelBack, working = seconds.mining + seconds.collecting + travel;
    return {
      trips: done.length, tripSeconds, runSeconds: this.firstTick < 0 ? 0 : (this.lastTick - this.firstTick + 1) / this.tickRate, setupSeconds: this.setupTicks / this.tickRate,
      wallSeconds: (this.wall() - this.wall0) / 1000,
      distance, mined, collected, deposited, oreMined, oreCollected, oreDeposited, oreLost: Math.max(0, oreMined - oreCollected),
      credits, valueIfSold: value, chunksThrown: thrown, chunksCollected: got, brownoutSeconds: brown / this.tickRate,
      seconds, share,
      orePerHour: oreDeposited / hours, valuePerHour: value / hours, creditsPerHour: credits / hours,
      tripSecondsMean: done.length ? tripSeconds / done.length : 0, orePerTrip: done.length ? oreDeposited / done.length : 0,
      miningShare: working ? seconds.mining / working : 0, travelShare: working ? travel / working : 0,
    };
  }

  /** One JSON object a line: every trip, then the summary */
  jsonLines(meta: Record<string, unknown> = {}): string {
    const rows: unknown[] = this.trips.map((t) => ({ kind: 'trip', ...meta, ...t, seconds: Object.fromEntries(PHASES.map((p) => [p, +(t.ticks[p] / this.tickRate).toFixed(2)])) }));
    rows.push({ kind: 'summary', ...meta, ...this.summary() });
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  }
}

const f = (n: number, d = 0): string => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** The readable summary: a table of the totals, the rates, and the time split */
export function summaryTable(s: Summary, title: string): string {
  const L: string[] = [];
  const row = (k: string, v: string) => L.push(`  ${k.padEnd(34)}${v}`);
  L.push(`== ${title} ==`);
  row('trips completed', f(s.trips));
  row('game time (run / trips / setup)', `${f(s.runSeconds / 60, 1)} / ${f(s.tripSeconds / 60, 1)} / ${f(s.setupSeconds / 60, 1)} min`);
  row('wall time', `${f(s.wallSeconds, 1)} s`);
  row('distance flown', `${f(s.distance)} units`);
  row('ore mined (in chunks thrown)', `${f(s.oreMined)}  (${f(s.chunksThrown)} chunks)`);
  row('ore collected (into the hold)', `${f(s.oreCollected)}  (${f(s.chunksCollected)} chunks)`);
  row('ore deposited', `${f(s.oreDeposited)}`);
  row('ore lost / left drifting', f(s.oreLost));
  row('credits earned (sold)', f(s.credits));
  row('value if sold at the station', f(s.valueIfSold));
  row('brownout', `${f(s.brownoutSeconds, 1)} s`);
  L.push('  -- rates (per game hour of trips) --');
  row('ore per hour', f(s.orePerHour));
  row('value per hour (if sold)', f(s.valuePerHour));
  row('credits per hour (sold)', f(s.creditsPerHour));
  row('mean trip', `${f(s.tripSecondsMean, 1)} s, ${f(s.orePerTrip, 1)} ore`);
  row('mining / (mining + travel)', pct(s.miningShare));
  row('travel / (mining + travel)', pct(s.travelShare));
  L.push('  -- time by phase (mean per trip) --');
  for (const p of PHASES) if (p !== 'setup') row(p, `${f(s.trips ? s.seconds[p] / s.trips : 0, 1)} s  ${pct(s.share[p])}`);
  const ores = Object.entries(s.deposited).sort((a, b) => b[1] - a[1]);
  if (ores.length) { L.push('  -- ore deposited --'); for (const [k, n] of ores) row(k, f(n)); }
  return L.join('\n');
}
