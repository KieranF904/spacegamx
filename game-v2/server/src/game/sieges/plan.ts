/**
 * Planning a night: its budget spent on the profile's roster, its boss, the
 * split into fronts and a stream, and where each lot comes in from.
 */

import { DEFAULT_SIEGE_RULES, DEG, FRONT_WARN, SECOND, type SiegeProfile, type SiegeRules, type SiegeSpawn, type SiegeUnit } from './rules.js';
import type { Run } from './types.js';

/** What claiming your haul by day multiplies it by: +25% for every five nights you held */
export function haulBonus(nights: number, rules: SiegeRules = DEFAULT_SIEGE_RULES): number {
  return 1 + rules.haulBonus.per * Math.floor(nights / rules.haulBonus.every);
}

/** A moon's siege profile (its bastion's, or the default), as merged from the rules */
export function siegeProfile(rules: SiegeRules, id?: string): SiegeProfile {
  return rules.profiles[id ?? ''] ?? rules.profiles[rules.defaultProfile] ?? Object.values(rules.profiles)[0];
}

/** The night's ships: its budget (growing faster as the nights go on) spent on the toughest things it can afford, most of the time */
export function wavePlan(wave: number, pilots: number, rnd: () => number = Math.random, rules: SiegeRules = DEFAULT_SIEGE_RULES, profile: SiegeProfile = siegeProfile(rules)): SiegeUnit[] {
  const w = rules.wave;
  let budget = (w.base + wave * w.perWave + wave * wave * w.perWave2) * profile.difficulty * (w.solo + w.perPilot * Math.max(1, pilots));
  const open = profile.roster.filter((r) => r.from <= wave && (r.until === undefined || wave <= r.until));
  const out: SiegeUnit[] = [];
  for (let guard = 0; budget >= 1 && guard < w.maxPicks; guard++) {
    const can = open.filter((r) => r.cost <= budget);
    if (!can.length) break;
    // Lean towards what came in most recently, so each night feels like a step up
    const pick = rnd() < w.leanChance ? can[can.length - 1 - Math.floor(rnd() * Math.min(w.leanSpread, can.length))] : can[Math.floor(rnd() * can.length)];
    out.push(pick);
    budget -= pick.cost;
  }
  return out.length ? out : open.slice(0, 1);
}

/** The night's ships by design (a group counts each of its ships) */
export function waveRoster(wave: number, pilots: number, rnd: () => number = Math.random, rules: SiegeRules = DEFAULT_SIEGE_RULES, profile?: SiegeProfile): string[] {
  return wavePlan(wave, pilots, rnd, rules, profile).flatMap((u) => Array.from({ length: u.group ?? 1 }, () => u.ship));
}

/** The boss a profile sends on a night (roster night), if it's a boss night */
export function siegeBoss(profile: SiegeProfile, night: number): SiegeUnit | null {
  const b = profile.bosses;
  if (!b.ships.length || night < b.from || night % b.every !== 0) return null;
  const open = b.ships.filter((s) => s.from <= night);
  return open.length ? open[(Math.floor(night / b.every) - 1) % open.length] : null;
}

/** A unit as the ships it sends tonight, tuned (its hull grows by the night) */
export function unitSpawns(u: SiegeUnit, profile: SiegeProfile, night: number): SiegeSpawn[] {
  const tough = 1 + profile.hpPerNight * (night - 1);
  return Array.from({ length: u.group ?? 1 }, () => ({ ship: u.ship, faction: u.faction, hp: (u.hp ?? 1) * tough, damage: u.damage, range: u.range, aggro: u.aggro }));
}

/**
 * Tonight: the plan (and its boss) split into fronts, a front more every few
 * nights, each mixing the night's kinds, and a share held back to stream in.
 */
export function planNight(rules: SiegeRules, run: Run, pilots: number, now: number): void {
  const P = run.profile, night = run.wave + run.offset;
  const plan = wavePlan(night, pilots, Math.random, rules, P);
  // The stream: a share of the night, one at a time (from its night)
  const stream: SiegeSpawn[] = [], main: SiegeSpawn[][] = [];
  for (const u of plan) {
    const ships = unitSpawns(u, P, night);
    if (night >= P.stream.from && Math.random() < P.stream.share) stream.push(...ships);
    else main.push(ships);
  }
  const n = Math.max(1, Math.min(P.fronts.max, 1 + Math.floor((run.wave - 1) / P.fronts.every)));
  const fronts: SiegeSpawn[][] = Array.from({ length: n }, () => []);
  main.forEach((g, i) => fronts[i % n].push(...g));
  const boss = siegeBoss(P, night);
  if (boss) fronts[0].unshift(...unitSpawns(boss, P, night).map((s) => ({ ...s, plating: 1 })));
  run.fronts = fronts.filter((f) => f.length).map((ships, i) => ({ at: now + FRONT_WARN + i * P.fronts.gapSeconds * SECOND, ships }));
  run.stream = stream;
  run.nextStream = now + 5 * SECOND;
  run.frontNo = 0;
  // An arc's side: its set one, or a new one each night
  run.side = (P.approach.angles?.length && P.approach.kind === 'arc' ? P.approach.angles[0] * DEG : Math.random() * Math.PI * 2);
  run.nextObjective = now + P.objectives.everySeconds * SECOND * (0.3 + Math.random() * 0.4);
}

/** Where the next lot comes from, by the moon's approach */
function approachAngle(run: Run): number {
  const a = run.profile.approach, k = run.frontNo++;
  const jitter = (deg: number) => (Math.random() - 0.5) * 2 * deg * DEG;
  switch (a.kind) {
    case 'lanes': { const L = a.angles?.length ? a.angles : [0]; return L[Math.floor(Math.random() * L.length)] * DEG + jitter(a.spread ?? 10); }
    case 'arc': return run.side + jitter(a.spread ?? 40);
    case 'pincer': return run.side + (k % 2 ? Math.PI : 0) + jitter(a.spread ?? 15);
    default: return Math.random() * Math.PI * 2;
  }
}

/** Where the next lot comes in: out in the dark, where the moon's approach says */
export function frontPoint(run: Run): { x: number; y: number } {
  const R = run.sys.surface!.radius, b = run.sys.surface!.bastion!;
  const a = approachAngle(run);
  // Out of the dark, but not so far that slow drones take all night to arrive
  const k = run.profile.approach.radius;
  return { x: b.x + Math.cos(a) * R * k, y: b.y + Math.sin(a) * R * k };
}
