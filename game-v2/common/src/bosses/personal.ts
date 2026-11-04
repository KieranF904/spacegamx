/**
 * Personal attacks (docs/bosses/rework-2026-11.md 2.2): every pilot present (inside the barrier; dummy pilots too) rolls
 * each beat for an attack of their own. Pure luck: no fair rotation, no streak protection. A loose cap holds how many run
 * at once (only big groups meet it); a roll that wins while it's full is dropped, not queued. None starts during a
 * signature move or a window's rest beat: ones already running finish.
 *
 * The roll is the server's decision (it alone knows who is present in what order), drawn from a hash of the boss's seed,
 * the beat's tick and the pilot's slot, so it is the same on every run (tests, the dev tools' replays) and the decision
 * sent is {slot, attack, seed}. Pure: integer hashing only.
 */

import { hashInts, hashUnit } from '../math/rng.js';

export interface PersonalRules {
  /** Ticks between rolls */
  beat: number;
  /** Each present pilot's chance a beat */
  chance: number;
  /** The attacks it can draw (by name), by stage (index 0 its first) */
  pool: readonly (readonly string[])[];
  /** How long one runs (ticks) */
  ticks: number;
}

export const PERSONAL = {
  beat: 120,
  /** The loose cap: max(capMin, ceil(pilots / 2)), never more than capMax */
  capMin: 2,
  capMax: 6,
} as const;

/** One drawn: who (their slot in the boss's pilot list), which attack, its own seed, and when it started and ends */
export interface PersonalDraw { slot: number; attack: number; seed: number; at: number; until: number }

/** How many personal attacks may run at once with this many pilots present */
export function personalCap(pilots: number): number {
  if (pilots <= 0) return 0;
  return Math.min(PERSONAL.capMax, Math.max(PERSONAL.capMin, Math.ceil(pilots / 2)));
}

/** Is this tick a roll (a beat) */
export const personalBeat = (rules: PersonalRules, tick: number) => tick % Math.max(1, rules.beat) === 0;

/**
 * A beat's rolls: `present` pilots (slots 0..present-1), `running` the attacks still running. Returns the new draws,
 * in slot order (the cap fills lowest slot first: which slot is lowest is the server's list order, itself luck of
 * arrival). `held`: a signature move or a rest beat: nothing starts
 */
export function rollPersonal(rules: PersonalRules, stage: number, seed: number, tick: number, present: number, running: number, held: boolean): PersonalDraw[] {
  const out: PersonalDraw[] = [];
  const pool = rules.pool[Math.max(0, Math.min(rules.pool.length - 1, stage - 1))] ?? [];
  if (held || !pool.length || !personalBeat(rules, tick)) return out;
  let room = personalCap(present) - running;
  for (let slot = 0; slot < present && room > 0; slot++) {
    if (hashUnit(seed, tick, slot, 0x9e15) >= rules.chance) continue;
    const s = hashInts(seed, tick, slot, 0x5eed);
    out.push({ slot, attack: s % pool.length, seed: (s >>> 8) & 0xffff, at: tick, until: tick + rules.ticks });
    room--;
  }
  return out;
}

/** Drop the draws that have run their time; returns how many still run */
export function pruneDraws(draws: PersonalDraw[], tick: number): number {
  for (let i = draws.length - 1; i >= 0; i--) if (tick >= draws[i].until) draws.splice(i, 1);
  return draws.length;
}
