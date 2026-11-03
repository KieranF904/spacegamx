/**
 * Planning a night: its budget spent on the profile's roster, its boss, the
 * split into fronts and a stream, and where each lot comes in from.
 */

import { DEFAULT_SIEGE_RULES, DEG, FRONT_WARN, SECOND, type SiegeProfile, type SiegeRules, type SiegeSpawn, type SiegeUnit } from './rules.js';
import { ROLES } from './roles/index.js';
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

/** A unit's role tonight (from its `roleFrom` night), if it has one that exists */
export function unitRole(u: SiegeUnit, night: number): string | undefined {
  return u.role && ROLES[u.role] && night >= (u.roleFrom ?? u.from) ? u.role : undefined;
}

/** A unit as the ships it sends tonight, tuned (its hull grows by the night; its role's tuning over its own) */
export function unitSpawns(u: SiegeUnit, profile: SiegeProfile, night: number): SiegeSpawn[] {
  const tough = 1 + profile.hpPerNight * (night - 1);
  const role = unitRole(u, night);
  const tune = (role && ROLES[role].tune) || ((s: SiegeSpawn) => s);
  return Array.from({ length: u.group ?? 1 }, () => tune({ ship: u.ship, faction: u.faction, hp: (u.hp ?? 1) * tough, damage: u.damage, range: u.range, aggro: u.aggro, role, cost: u.cost / (u.group ?? 1) }));
}

/** How many fronts a night comes in: one more every few nights, and one more for every few pilots past the first */
export function frontCount(rules: SiegeRules, profile: SiegeProfile, wave: number, pilots: number): number {
  const F = profile.fronts, extra = Math.floor(Math.max(0, pilots - 1) / Math.max(1, rules.party.frontPer));
  return Math.max(1, Math.min(F.max, 1 + Math.floor((wave - 1) / F.every)) + Math.min(2, extra));
}

/**
 * Tonight, planned at dusk (`start`: the tick night falls): the plan (and its
 * boss) split into fronts, a front more every few nights (and for bigger
 * parties), each mixing the night's kinds, and a share held back to stream
 * in. Where each front comes in is picked now, so it can be shown coming.
 */
export function planNight(rules: SiegeRules, run: Run, pilots: number, start: number): void {
  const P = run.profile, night = run.wave + run.offset;
  const plan = wavePlan(night, pilots, Math.random, rules, P);
  // The stream: a share of the night, one at a time (from its night; a bigger party's is bigger)
  const share = P.stream.share + rules.party.streamPerPilot * Math.max(0, pilots - 1);
  const stream: SiegeSpawn[] = [], main: SiegeSpawn[][] = [];
  for (const u of plan) {
    const ships = unitSpawns(u, P, night);
    if (night >= P.stream.from && Math.random() < share) stream.push(...ships);
    else main.push(ships);
  }
  const n = frontCount(rules, P, run.wave, pilots);
  const fronts: SiegeSpawn[][] = Array.from({ length: n }, () => []);
  main.forEach((g, i) => fronts[i % n].push(...g));
  const boss = siegeBoss(P, night);
  if (boss) fronts[0].unshift(...unitSpawns(boss, P, night).map((s) => ({ ...s, plating: 1, boss: true })));
  run.frontNo = 0;
  // An arc's side: its set one, or a new one each night
  run.side = (P.approach.angles?.length && P.approach.kind === 'arc' ? P.approach.angles[0] * DEG : Math.random() * Math.PI * 2);
  run.fronts = fronts.filter((f) => f.length).map((ships, i) => ({ at: start + FRONT_WARN + i * P.fronts.gapSeconds * SECOND, ships, pos: frontPoint(run) }));
  run.stream = stream;
  run.nextStream = start + 5 * SECOND;
  run.nextObjective = start + P.objectives.everySeconds * SECOND * (0.3 + Math.random() * 0.4);
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
