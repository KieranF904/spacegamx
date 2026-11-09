/**
 * People (data/people.json) and what they say. Shared so the client can show
 * a conversation exactly as the server runs it.
 *
 * Someone lives at a station (talk to them while you're docked), or at a
 * point out in space or down on a planet (fly close and press X). Talking to
 * them opens the hub: a greeting and what you can ask about: the jobs they
 * have for you, the step of a job that needs them, and their own topics.
 *
 * A topic is a list of lines run in order. Most just say something; some ask
 * you to choose (each choice has its own lines), offer a job (Accept / Not
 * now), tell you about a job somewhere else (a new lead), hand items over,
 * start a fight, or hand over a record (codex.ts). `if` lines branch on
 * what you've done. People can also call you over comms (a job finished, a
 * step done, a milestone reached): the same lines, from wherever they are.
 */

import type { Bag } from './stacks.js';
import { hashString } from '../math/rng.js';

/** Where someone can be found: docked at a station, or at a point in a system (a planet's surface is a system of its own) */
export type PersonPlace = { station: string } | { system: string; x: number; y: number; label?: string };

export interface PersonDef {
  id: string;
  name: string;
  title: string;
  /** Portrait colour */
  color?: string;
  at: PersonPlace;
  /**
   * What they're aboard out in space or on a planet (at a point): a ship from
   * the plan library, parked at their place (it can't be hurt or hurt anyone),
   * labelled `name` (default: theirs)
   */
  craft?: { ship: string; angle?: number; name?: string };
  /** Somewhere else while a condition holds (the first that matches) */
  moves?: { if: Cond; at: PersonPlace }[];
  /** First words (one at random) */
  greeting: string[];
  /** Their own things to ask about */
  topics?: Topic[];
}

export interface Topic {
  /** For `once` (remembered as person:id) */
  id?: string;
  label: string;
  if?: Cond;
  /** Offered until you've heard it once */
  once?: boolean;
  lines: Line[];
}

/** One line of a conversation (see the file comment) */
export type Line =
  | { say: string; who?: 'you' }
  | { ask?: string; choices: Choice[] }
  | { if: Cond; then: Line[]; else?: Line[] }
  /** Offer a job: Accept or Not now */
  | { offer: string }
  /** Tell you about a job (it joins your log as a lead) */
  | { reveal: string }
  | { give: Bag }
  | { flag: string }
  /** Hand over a record (data/codex.json): it joins the pilot log's Records */
  | { codex: string }
  /** The job step this conversation is about is done (talk steps: otherwise at the end) */
  | { advance: true }
  /** Start the fight this step is about (an arena boss) */
  | { fight: true }
  /** Hang up */
  | { end: true };

export interface Choice {
  text: string;
  if?: Cond;
  then?: Line[];
}

export type Cond =
  | { done: string }
  | { active: string }
  | { known: string }
  /** A quest at this step (0 first) */
  | { step: [string, number] }
  | { has: Bag }
  | { level: number }
  | { flag: string }
  /** Been to a system or docked at a station (by id) */
  | { visit: string }
  /** Mined any of this ore */
  | { mined: string }
  /** Destroyed this many hostiles (of a faction, if `of`) */
  | { kills: { n: number; of?: string } }
  /** Killed this boss */
  | { boss: string }
  /** At least this standing with a faction */
  | { rep: Record<string, number> }
  /** Took part in a world event of this kind (raid, salvage...) */
  | { event: string }
  /** A `p` chance each time the counted thing (a stat: salvaged, kills, events...) happens: the same for the same pilot, so it's a rate, not a reroll */
  | { chance: { p: number; per: string } }
  | { not: Cond }
  | { all: Cond[] }
  | { any: Cond[] };

export interface PeopleFile {
  people: PersonDef[];
}

/** Someone as the client sees them: where they are now, and whether they want you */
export interface PersonView {
  id: string;
  name: string;
  title: string;
  color: string;
  system: string;
  /** Docked at this station (by name, as the client labels stations) */
  station?: string;
  stationId?: string;
  x?: number;
  y?: number;
  /** Where, in words */
  label: string;
  /** offer: has a job for you; step: a job of yours needs them */
  mark?: 'offer' | 'step';
}

/** What a conversation shows right now */
export interface TalkView {
  /** This conversation (answers name it) */
  n: number;
  who: { name: string; title: string; color: string };
  /** A call over comms rather than face to face */
  comms?: boolean;
  /** A heading (a job's name, when it's about one) */
  title?: string;
  lines: { you?: boolean; text: string }[];
  choices: { text: string; tone?: 'quest' | 'go' | 'bye'; track?: string }[];
  /** A job on offer (Accept / Not now are the choices) */
  offer?: import('./quests.js').QuestView;
  /** What a finished job paid */
  paid?: import('./quests.js').RewardView;
}

/** Whether a condition holds for a pilot (the server's view of them) */
export interface CondContext {
  done(id: string): boolean;
  active(id: string): boolean;
  known(id: string): boolean;
  stage(id: string): number;
  has(items: Bag): boolean;
  level: number;
  flag(f: string): boolean;
  /** A tally from the pilot's stats (kills, mined:<ore>, sys:<id>, dock:<id>...) */
  stat?(key: string): number;
  rep?(faction: string): number;
  /** Who: seeds chance conditions */
  seed?: string;
}

/** A fixed roll in [0, 1) for a key */
function rollOf(key: string): number {
  let h = hashString(key);
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export function condHolds(c: Cond | undefined, x: CondContext): boolean {
  if (!c) return true;
  if ('done' in c) return x.done(c.done);
  if ('active' in c) return x.active(c.active);
  if ('known' in c) return x.known(c.known);
  if ('step' in c) return x.active(c.step[0]) && x.stage(c.step[0]) === c.step[1];
  if ('has' in c) return x.has(c.has);
  if ('level' in c) return x.level >= c.level;
  if ('flag' in c) return x.flag(c.flag);
  const stat = (k: string) => x.stat?.(k) ?? 0;
  if ('visit' in c) return stat(`sys:${c.visit}`) > 0 || stat(`dock:${c.visit}`) > 0;
  if ('mined' in c) return stat(`mined:${c.mined}`) > 0;
  if ('kills' in c) return stat(c.kills.of ? `kills:${c.kills.of}` : 'kills') >= c.kills.n;
  if ('boss' in c) return stat(`boss:${c.boss}`) > 0;
  if ('rep' in c) return Object.entries(c.rep).every(([f, n]) => (x.rep?.(f) ?? 0) >= n);
  if ('event' in c) return stat(`event:${c.event}`) > 0;
  if ('chance' in c) {
    // Did any of the times it happened come up? (each one rolled once, from who and which)
    const times = Math.min(500, stat(c.chance.per));
    for (let i = 1; i <= times; i++) if (rollOf(`${x.seed ?? ''}:${c.chance.per}:${i}`) < c.chance.p) return true;
    return false;
  }
  if ('not' in c) return !condHolds(c.not, x);
  if ('all' in c) return c.all.every((d) => condHolds(d, x));
  if ('any' in c) return c.any.some((d) => condHolds(d, x));
  return true;
}

/** Does a list of lines (or any branch of it) mark its own advance */
export function marksAdvance(lines: Line[] | undefined): boolean {
  for (const l of lines ?? []) {
    if ('advance' in l) return true;
    if ('if' in l && 'then' in l && (marksAdvance(l.then) || marksAdvance(l.else))) return true;
    if ('choices' in l && l.choices.some((c) => marksAdvance(c.then))) return true;
  }
  return false;
}
