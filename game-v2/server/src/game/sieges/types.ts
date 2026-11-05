/**
 * What a siege reaches into (SiegeHost: GameServer builds it), and the state
 * of one party's siege (Run), shared by the files in this folder.
 */

import type { ServerMessage, StarSystemData } from '@space-game/common';
import type { PilotConn } from '../Pilots.js';
import type { Texts } from '../../data/rules.js';
import type { SiegeProfile, SiegeRules, SiegeSpawn, SIEGE_STRINGS } from './rules.js';

export interface SiegeHost {
  tick(): number;
  instances(id: string): number[];
  /** The party (0: none) and everyone in it */
  partyId(conn: PilotConn): number;
  name(conn: PilotConn): string;
  pilots(num: number): PilotAt[];
  toOrbit(conn: PilotConn, surface: StarSystemData, angle: number): void;
  toast(conn: PilotConn, text: string, kind?: 'info' | 'good' | 'warn' | 'bad'): void;
  send(conn: PilotConn, msg: ServerMessage): void;
  /** A structure players defend, built in `grade`; returns its entity (-1: couldn't) */
  spawnStructure(design: string, num: number, x: number, y: number, name: string, grade?: number): number;
  removeStructure(eid: number): void;
  shipAt(eid: number): { x: number; y: number; hull: number } | null;
  healStructure(eid: number, fraction: number): void;
  /** Mend a pilot's own ship */
  refit(eid: number): void;
  /**
   * A turret: aims at (leading by `shot`, its shells' speed; 0: no lead) and fires on hostiles within range, its damage
   * × `damage`; `pick` chooses what it fires on first (an entity in range; -1: none), else the nearest hostile in range
   */
  arm(eid: number, opts: { range: number; shot: number; damage: number; pick?: () => number }): void;
  /**
   * Hostiles (built in `grade`) at a point, sent at another: each its hull × `hp`, its reach and aggro if given (factions
   * found from the designs unless given). Their entities in the order of `ships` (-1: one that couldn't be made); ships
   * of different roles fly in different packs
   */
  spawnHostiles(num: number, ships: SiegeSpawn[], x: number, y: number, at: { x: number; y: number }, grade: number): number[];
  /** Orders for hostiles: their pack sent at `at`; each going for `prey` first (-1: none), and only it if `only` */
  order(eids: number[], o: { at?: { x: number; y: number }; prey?: number; only?: boolean }): void;
  /** A design's name (a boss's, for the banner) */
  shipName(design: string): string;
  /** Hold a ship where it is (a nest) */
  pin(eid: number): void;
  /** Something's about to arrive here (`warning`), or just has (`warpIn`) */
  effect?(num: number, x: number, y: number, kind: 'warning' | 'warpIn' | 'launch'): void;
  /** The rating of these ships together, built in `grade` (ships/rating.ts) */
  rateShips(ships: string[], grade: number): number;
  /** What killing (or holding against) a grade pays, against Mk I */
  gradeReward(grade: number): number;
  hostileAlive(eid: number): boolean;
  removeHostile(eid: number): void;
  reward(conn: PilotConn, xp: number, credits: number, label: string): void;
}

/** A pilot down on the moon */
export interface PilotAt { conn: PilotConn; eid: number; x: number; y: number }

export interface Turret {
  eid: number;
  kind: string;
  /** 0, 1, 2: marks I, II, III */
  mark: number;
  /** Supplies put into it, for scrapping */
  spent: number;
  /** What it fires on first (turrets.ts TURRET_ORDERS) */
  orders: string;
}

/** One of tonight's hostiles: what it is, what it cost, its role, what that has it on */
export interface RaiderInfo {
  ship: string;
  cost: number;
  role?: string;
  boss?: boolean;
  /** Which front it came in with (-1: the stream, an objective's) */
  front: number;
  /** A sapper's turret, an escort's lead */
  prey?: number;
  lead?: number;
  /** When its role may next re-send it */
  nextOrder?: number;
}

/** Tonight so far */
export interface Tally {
  kills: number;
  byPilot: Map<PilotConn, number>;
  /** Kills by pad (its turret) */
  byPad: Map<number, number>;
  /** Kills' budget cost, for the score */
  value: number;
  objectives: number;
  /** The bastion's hull at nightfall */
  hullStart: number;
  turretsLost: number;
  /** Pads whose turret was shot down tonight */
  padsLost: number[];
}

/** Dawn's look back at the night (what each pilot shot down: `byPilot`) */
export interface NightSummary {
  night: number; kills: number; turretKills: number; mvp?: { label: string; kills: number }; hullLost: number; turretsLost: number;
  objectives: number; supplies: number; streakBonus: number; perfect: boolean; streak: number; score: number; best: boolean;
  byPilot: Map<PilotConn, number>;
}

/** An objective out on the moon (its kind: objectives/index.ts) */
export interface SiegeObjective { kind: string; x: number; y: number; until: number; held: number; eid: number; release: number }

export interface Run {
  key: number;
  num: number;
  /** The siege's own generator (seeded by its key and instance: a server decision, math/rng.ts) */
  rng: () => number;
  sys: StarSystemData;
  name: string;
  /** Mk I-V: what the nights, the bastion and the turrets are built of */
  grade: number;
  /** Roster nights skipped (night 1 here is the roster's night offset + 1) */
  offset: number;
  phase: 'day' | 'dusk' | 'night' | 'lost';
  wave: number;
  supplies: number;
  ready: Set<PilotConn>;
  bastion: number;
  turrets: (Turret | null)[];
  /** Each pilot's haul, paid when they leave */
  haul: Map<PilotConn, { xp: number; credits: number; nights: number }>;
  raiders: number[];
  /** Its siege */
  profile: SiegeProfile;
  /** Tonight's fronts still to come (when, and what), and the ships still to stream in */
  fronts: { at: number; ships: SiegeSpawn[]; pos: { x: number; y: number }; warned?: boolean }[];
  stream: SiegeSpawn[];
  nextStream: number;
  /** Tonight's side (arc), or the pincer's first */
  side: number;
  frontNo: number;
  /** Tonight's boss (its name), if any */
  boss: string;
  /** Ships an objective sent (they don't hold back the dawn: they go with it) */
  extras: number[];
  objective: SiegeObjective | null;
  nextObjective: number;
  next: number;
  lastPilots: number;
  shown: Map<PilotConn, string>;
  banner: string;
  /** Tonight's hostiles (objectives' too) */
  info: Map<number, RaiderInfo>;
  tally: Tally;
  /** Perfect nights in a row, the best night's score */
  streak: number;
  best: number;
  /** Dawn's summary, shown by day */
  summary: NightSummary | null;
  /** What tonight brings (planned at dusk) */
  tonight: { night: number; boss?: string; newKinds: string[]; roles: { name: string; ship: string; note: string }[] } | null;
  /** Focus fire: on what, until when; when the party can use it again */
  focus: { target: number; until: number; readyAt: number };
  /** Mending under way: ticks held, by pad (-1: the bastion) */
  mend: Map<number, number>;
  /** The last stand (the bastion under rules.breach.below): its first mend tonight is still free */
  breach: boolean;
  freeMend: boolean;
}

export type SiegeText = keyof typeof SIEGE_STRINGS;

/** What the siege's parts (shop, objectives) work with: the host, the rules, the text, and a few shared moves */
export interface SiegeCtx {
  readonly host: SiegeHost;
  readonly rules: SiegeRules;
  readonly t: Texts<SiegeText>;
  /** Fortifications are built a grade better than what comes at them */
  fortGrade(grade: number): number;
  turretName(label: string, mark: number): string;
  /** Tell everyone on the moon who did what */
  announce(run: Run, conn: PilotConn, what: string): void;
  sendState(run: Run, force: boolean): void;
}
