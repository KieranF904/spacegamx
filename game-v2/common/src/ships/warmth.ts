/**
 * Warmth: in a cold place (a system's cryo rating: hazards.ts hazardsAt) cold builds up on a ship and its warmth runs
 * down; near heat (a star, a station, a ship on fire, a lava world) it comes back. Insulating materials slow the build-up
 * (materials.json `insulation`, by share of the hull: rebuild.ts makeup) but never stop it. Frost hits (gemmed guns, the
 * Brood Mother's cold) take warmth off the same meter.
 *
 * Running low costs a ship in stages (WARMTH_STAGES): its guns recycle slower, then its drive goes numb, and frozen
 * through it seizes up (an EMP) and shakes a little warmth back (THAW). The server keeps the meter
 * (server/src/game/Warmth.ts, ShipBridge.warm); its pilot gets it as a whole percent (snapshot data[13]), and both
 * sides work the stage out from that percent, so prediction flies and fires the same. Others' replicas see a numb
 * drive by its control bit (replica.ts CTL.numb).
 *
 * How fast and where are data (hazards.json `warmth`); what the stages cost is here, beside EMP_CONTROL.
 */

import type { HazardFlight } from './hazards.js';

/** data/hazards.json `warmth` */
export interface WarmthRules {
  /** Warmth (0..1) lost a second per point of cryo rating, before insulation */
  coldPerPoint: number;
  /** Regained a second anywhere that isn't cold */
  ambient: number;
  /** How long being frozen through seizes a ship up */
  seizeTicks: number;
  /** Heat: warmth regained a second near each (the best one counts; near enough, it beats any cold there is) */
  sources: {
    /** Within `margin` of a star's surface: full `rate` over the inner half, fading out to nothing at the edge */
    star?: { margin: number; rate: number };
    /** Within `margin` of a station's hull; berthed, `docked` */
    station?: { margin: number; rate: number; docked: number };
    /** Within `radius` of a ship on fire (your own counts) */
    burning?: { radius: number; rate: number };
    /** Within `margin` of the surface of a planet of one of these kinds */
    planet?: { kinds: string[]; margin: number; rate: number };
  };
}

export type WarmthStageName = 'warm' | 'chilled' | 'numb' | 'frozen';

export interface WarmthStage {
  name: WarmthStageName;
  /** Below this percent */
  below: number;
  /** Gun intervals × this */
  guns: number;
  /** Thrust and steering × this */
  control: number;
}

/** What running low on warmth costs, coldest last (percent: what the pilot is told, so both sides agree) */
export const WARMTH_STAGES: readonly WarmthStage[] = [
  { name: 'warm', below: 101, guns: 1, control: 1 },
  { name: 'chilled', below: 50, guns: 1.15, control: 1 },
  { name: 'numb', below: 25, guns: 1.3, control: 0.8 },
  { name: 'frozen', below: 1, guns: 1.3, control: 0.8 },
];

/** Frozen through, a ship seizes up and comes out of it with this much warmth */
export const THAW = 0.15;

/** Warmth (0..1) as its pilot is told it: a whole percent */
export const warmthPercent = (w: number): number => Math.round(Math.max(0, Math.min(1, w)) * 100);

/** The stage a percent of warmth is in */
export function warmthStage(pct: number): WarmthStage {
  let s = WARMTH_STAGES[0];
  for (const x of WARMTH_STAGES) if (pct < x.below) s = x;
  return s;
}

/** A numb drive (the server, its pilot's prediction and replicas all fly it with this) */
export function withNumb(h: HazardFlight | undefined, stage: WarmthStage): HazardFlight | undefined {
  if (stage.control >= 1) return h;
  return { control: (h?.control ?? 1) * stage.control, driftAccel: h?.driftAccel ?? 0, jump: h?.jump ?? 1, cap: h?.cap ?? 1 };
}

/** The share of cold a hull keeps out (0..1): its materials' insulation by share of its cells */
export function insulationOf(d: { makeup: { insulation?: number } }): number {
  return Math.max(0, Math.min(0.9, d.makeup.insulation ?? 0));
}

/** Warmth lost a second to a cryo rating, through a hull's insulation */
export function coldRate(rules: WarmthRules, cryo: number, insulation: number): number {
  return Math.max(0, cryo) * rules.coldPerPoint * (1 - insulation);
}

/** Seconds from full warmth to frozen through at a cryo rating (Infinity: never) */
export function secondsToFreeze(rules: WarmthRules, cryo: number, insulation: number): number {
  const r = coldRate(rules, cryo, insulation);
  return r > 0 ? 1 / r : Infinity;
}

/** A star's heat at `d` from its centre (radius `r`) */
export function starHeat(rules: WarmthRules, d: number, r: number): number {
  const s = rules.sources.star;
  if (!s || r <= 0) return 0;
  const out = d - r;
  if (out >= s.margin) return 0;
  return out <= s.margin / 2 ? s.rate : s.rate * (1 - (out - s.margin / 2) / (s.margin / 2));
}

/**
 * One step of the meter: `w` (0..1) after `dt` seconds with `heat` coming in and a cryo rating of `cryo`. In the cold
 * it runs down unless heat beats it; anywhere else it comes back (at least at the ambient rate).
 */
export function stepWarmth(rules: WarmthRules, w: number, dt: number, cryo: number, insulation: number, heat: number): number {
  const rate = cryo > 0 ? heat - coldRate(rules, cryo, insulation) : Math.max(heat, rules.ambient);
  return Math.max(0, Math.min(1, w + rate * dt));
}
