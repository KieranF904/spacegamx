/**
 * Quests (data/quests.json) and bounties. Shared so the client can describe
 * steps and rewards exactly as the server tracks them.
 *
 * A quest is a list of steps done in order. Most steps count events (mine 20
 * ore, destroy 3 pirates); travel and dock steps complete on arrival; refit
 * steps check the ship you're flying; deliver steps are checked (and the
 * goods taken) when you turn the quest in at its station.
 *
 * Bounties are generated: each station posts a few, chosen deterministically
 * from the station and the current time window, so everyone sees the same
 * board and a bounty's id is enough to rebuild it. Fleet operations are the
 * same, for parties: jobs that need two or more pilots working together.
 *
 * Operation steps (courier, scan, escort, defend, uplink) happen out in space;
 * the server's Operations module runs them and can fail them (the freighter
 * was destroyed, the clock ran out).
 */

import type { Bag } from './stacks.js';
import type { Cond, Line } from './dialogue.js';
import { dpow } from '../math/detTrig.js';
import { hashString, mulberry32 } from '../math/rng.js';

/**
 * Every step can end with a word from the quest's person (their `say` lines,
 * shown as a toast the moment it's done).
 */
export type QuestStep = QuestStepKind & { after?: Line[] };

export type QuestStepKind =
  | { type: 'travel'; system: string; text?: string }
  | { type: 'dock'; station: string; text?: string }
  | { type: 'mine'; item?: string; count: number; text?: string }
  | { type: 'loot'; item?: string; count: number; text?: string }
  | { type: 'refine'; item?: string; count: number; text?: string }
  /** `teach`: a recipe learned when the step starts (a job's own kit) */
  | { type: 'craft'; item?: string; category?: string; count: number; teach?: string; text?: string }
  /** `material`: the parts counted must be of it (with `fn`, parts of that function made of it) */
  | { type: 'refit'; fn?: string; material?: string; count?: number; minParts?: number; text?: string }
  | { type: 'kill'; faction?: string; enemy?: string; system?: string; count: number; text?: string }
  | { type: 'deliver'; items: Bag; text?: string }
  | { type: 'sell'; credits: number; text?: string }
  | { type: 'level'; level: number; text?: string }
  /**
   * Defeat a boss. With an `arena` (an instanced surface), it isn't out in the
   * world: you talk to `person` (their `lines`, then "ready?") and you, and
   * your party, fight it in your own copy of the arena.
   */
  | { type: 'boss'; boss: string; arena?: string; person?: string; lines?: Line[]; text?: string }
  /**
   * Talk to someone (dialogue.ts): their `lines` (the topic is named after the
   * job), then `take` is handed over (missing it, they tell you and the step
   * waits) and `give` handed to you. Lines with { advance } decide for
   * themselves when the step is done; otherwise it's done at the end.
   */
  | { type: 'talk'; person: string; lines?: Line[]; take?: Bag; give?: Bag; text?: string }
  /** Fly to a point (an explored site): `give` is found there */
  | { type: 'visit'; system: string; x: number; y: number; radius?: number; label: string; give?: Bag; text?: string }
  /** Start building a ship plan in a hangar slot */
  | { type: 'slot'; plan: string; text?: string }
  /** Finish building it (no ghost parts left) */
  | { type: 'build'; plan: string; text?: string }
  /** Fly it */
  | { type: 'fly'; plan: string; text?: string }
  /** Carry a sealed dispatch to a station before the clock runs out */
  | { type: 'courier'; station: string; seconds: number; text?: string }
  /** Scan derelict wrecks: fly close and hold steady a few seconds each */
  | { type: 'scan'; count: number; system: string; text?: string }
  /** Meet a freighter at one station and see it safely to another */
  | { type: 'escort'; from: string; to: string; ambushes: number; ward?: string; text?: string }
  /** Defend an outpost near a station against waves of raiders */
  | { type: 'defend'; near: string; waves: number; text?: string }
  /** Hold every relay beacon at once until the uplink is through (a party job) */
  | { type: 'uplink'; near: string; beacons: number; seconds: number; text?: string }
  /**
   * Hold steady inside a spot while something works (a fix, a survey, a
   * repair): leave and the progress drains. `raid`: that many raiders are
   * sent to break it up once you start.
   */
  | { type: 'hold'; system: string; x: number; y: number; radius?: number; seconds: number; label: string; raid?: number; text?: string }
  /**
   * A run through `rings` rings in order against the clock, starting at a
   * spot (a calibration run, a race through the debris). Out of time: back to
   * the start to try again.
   */
  | { type: 'course'; system: string; x: number; y: number; rings: number; seconds: number; label: string; spacing?: number; text?: string }
  /**
   * Find a container at a spot and pull it aboard: it's there when you come
   * near (only you can take it), `guard` raiders with it. The item stays in
   * your hold for whatever comes next (a deliver step).
   */
  | { type: 'recover'; system: string; x: number; y: number; item: string; label: string; guard?: number; text?: string }
  /**
   * Build a structure at a site with a Constructor fitted, piece by piece
   * from parts in your hold (each piece takes `seconds`). The pieces built
   * are kept, so you can come back with the rest. Only pilots who've built
   * some of it see it (BuildView); it's scenery, nothing collides with it.
   */
  | { type: 'construct'; system: string; x: number; y: number; label: string; structure: string; pieces: { id: string; item: string; name: string }[]; seconds?: number; text?: string };

/** A structure a pilot is building or has built (their own, drawn only for them) */
export interface BuildView {
  id: string;
  system: string;
  x: number;
  y: number;
  label: string;
  /** Which kind (the client knows how to draw it), and its pieces: built or still to come */
  structure: string;
  pieces: { id: string; built: boolean }[];
}

/** Steps that happen out in space (Operations runs them) */
export const OP_STEPS = ['courier', 'scan', 'escort', 'defend', 'uplink', 'hold', 'course', 'recover', 'construct'];

/** Where in the UI a step happens (the client points at it) */
export type StepHint = 'refinery' | 'fabricator' | 'market' | 'ships' | 'hangar' | 'contracts';

export function stepHint(s: QuestStep): StepHint | undefined {
  switch (s.type) {
    case 'refine': return 'refinery';
    case 'craft': return 'fabricator';
    case 'sell': return 'market';
    case 'slot': case 'build': case 'fly': return 'ships';
    case 'refit': return 'hangar';
    default: return undefined;
  }
}

export interface QuestRewards {
  xp?: number;
  credits?: number;
  /** Items into storage */
  items?: Bag;
  /** Ship plans learned (blueprint file names) */
  plans?: string[];
  /** Fabrication licences learned (material:steel, fn:railgun) */
  recipes?: string[];
  /** Sector access (system ids) */
  licences?: string[];
  reputation?: Record<string, number>;
  skillPoints?: number;
  /** Records found (data/codex.json ids): not shown with the reward, they turn up as found */
  codex?: string[];
}

export interface QuestDef {
  id: string;
  name: string;
  /** main (story), guild, shipwright, traders, bounty, fleet (party operations) */
  chain: string;
  /** Needs a party of at least this many pilots (fleet operations) */
  party?: number;
  /** The station whose board posts it, and where deliver steps are handed in */
  giver?: string;
  /** Who gives it (people.json): you're offered it by talking to them, never on a board */
  person?: string;
  /** Known from the start (a beginner's job); others you hear about */
  starter?: boolean;
  /** What they say before offering it (default: the intro) */
  offer?: Line[];
  /** Who's talking (jobs with no person) */
  npc?: string;
  level: number;
  requires?: string[];
  /** Minimum reputation to be offered it */
  minRep?: Record<string, number>;
  /**
   * When it shows itself: a condition (dialogue's: done, known, has, level,
   * flag, all/any/not) that, once it holds, puts the job in the log as a new
   * lead. Until then nobody mentions it (prerequisites still apply).
   */
  reveal?: Cond;
  /** Hidden jobs: the hint a rumour gives before it's found ("Someone at the depot wants a pilot who can mine") */
  rumour?: string;
  repeatable?: boolean;
  /** Bumped when the job's steps are rewritten: anyone part-way through starts it again */
  rev?: number;
  /** Given when the job is taken (its kit's recipes, the licence it hands you) */
  onStart?: { recipes?: string[]; items?: Bag };
  intro: string;
  outro: string;
  steps: QuestStep[];
  rewards: QuestRewards;
}

export interface QuestsFile {
  quests: QuestDef[];
  /** Friendly factions you build standing with (and their quartermasters) */
  reputations: Record<string, { name: string; description: string; vendor?: import('./market.js').VendorDef }>;
  /** Systems you need a licence to enter (the licence id: `licence`, or the system's own id) */
  restricted: Record<string, { name: string; hint: string; licence?: string }>;
}

/** The licence a restricted system needs */
export function sectorLicence(file: Pick<QuestsFile, 'restricted'>, systemId: string): string | null {
  const r = file.restricted[systemId];
  return r ? r.licence ?? systemId : null;
}

/** A quest as the client sees it (step text rendered by the server) */
export interface QuestView {
  id: string;
  name: string;
  chain: string;
  npc?: string;
  giver?: string;
  giverName: string;
  /** Who gave it (a person's name) and where they are */
  person?: string;
  where?: string;
  level: number;
  intro: string;
  steps: { text: string; need: number; hint?: StepHint }[];
  stage: number;
  progress: number;
  rewards: RewardView;
  /** Where the current step happens, for the objective marker */
  target?: QuestTarget;
}

export interface QuestTarget {
  system: string;
  /** A station (by name, as the client labels it) */
  station?: string;
  /** A point (a boss's lair) */
  x?: number;
  y?: number;
  label: string;
}

/** A job you've heard about but haven't taken: who has it, where, and what stands in the way */
export interface QuestLead {
  id: string;
  name: string;
  chain: string;
  level: number;
  who: string;
  where: string;
  /** available: go and ask; locked: not yet (needs); rumour: only a hint, so far */
  state: 'available' | 'locked' | 'rumour';
  needs: string[];
  intro: string;
  rewards: RewardView;
  target?: QuestTarget;
  /** Joined the log since it was last looked at */
  fresh?: boolean;
}

/** Rewards with names resolved */
export interface RewardView {
  xp: number;
  credits: number;
  items: Bag;
  plans: string[];
  recipes: string[];
  licences: string[];
  /** Standing gained, by faction name */
  reputation: Record<string, number>;
  skillPoints: number;
}

/** How a step reads in the tracker */
export function stepText(s: QuestStep, names: { item(id: string): string; station(id: string): string; system(id: string): string; faction(id: string): string; enemy(id: string): string; plan?(file: string): string; person?(id: string): string }): string {
  if (s.text) return s.text;
  switch (s.type) {
    case 'travel': return `Travel to ${names.system(s.system)}`;
    case 'dock': return `Dock at ${names.station(s.station)}`;
    case 'mine': return `Mine ${s.count} ${s.item ? names.item(s.item) : 'ore'}`;
    case 'loot': return `Recover ${s.count} ${s.item ? names.item(s.item) : 'items'}`;
    case 'refine': return `Refine ${s.count} ${s.item ? names.item(s.item) : 'materials'}`;
    case 'craft': return `Fabricate ${s.count} ${s.item ? names.item(s.item) : s.category === 'part' ? 'ship parts' : 'items'}`;
    case 'refit': return s.fn || s.material ? `Fit ${s.count ?? 1} ${[s.material, s.fn].filter(Boolean).join(' ')} part${(s.count ?? 1) > 1 ? 's' : ''} to your ship` : `Fly a ship of at least ${s.minParts} parts`;
    case 'kill': return `Destroy ${s.count} ${s.enemy ? names.enemy(s.enemy) : s.faction ? names.faction(s.faction) : 'hostiles'}${s.system ? ` in ${names.system(s.system)}` : ''}`;
    case 'deliver': return `Deliver ${Object.entries(s.items).map(([id, n]) => `${n} ${names.item(id)}`).join(', ')}`;
    case 'sell': return `Earn ${s.credits.toLocaleString()} credits trading`;
    case 'level': return `Reach pilot level ${s.level}`;
    case 'boss': return s.arena && s.person ? `Defeat ${names.enemy(s.boss)} (talk to ${names.person?.(s.person) ?? s.person} when you're ready)` : `Defeat ${names.enemy(s.boss)}`;
    case 'talk': return `Talk to ${names.person?.(s.person) ?? s.person}`;
    case 'visit': return `Fly to ${s.label}${s.system ? ` (${names.system(s.system)})` : ''}`;
    case 'slot': return `Start building the ${names.plan?.(s.plan) ?? s.plan} in a hangar slot`;
    case 'build': return `Finish building the ${names.plan?.(s.plan) ?? s.plan}`;
    case 'fly': return `Fly the ${names.plan?.(s.plan) ?? s.plan}`;
    case 'courier': return `Deliver the sealed dispatch to ${names.station(s.station)} within ${fmtSecs(s.seconds)}`;
    case 'scan': return `Scan ${s.count} derelict wreck${s.count > 1 ? 's' : ''} in ${names.system(s.system)} (fly close, stay still)`;
    case 'escort': return `Escort ${s.ward ?? 'the freighter'} from ${names.station(s.from)} to ${names.station(s.to)}`;
    case 'defend': return `Defend the outpost near ${names.station(s.near)}: ${s.waves} waves`;
    case 'uplink': return `Hold all ${s.beacons} relay beacons near ${names.station(s.near)} at once (${fmtSecs(s.seconds)})`;
    case 'hold': return `Stay still at ${s.label} for ${fmtSecs(s.seconds)}${s.system ? ` (${names.system(s.system)})` : ''}`;
    case 'course': return `Fly the ${s.rings}-ring run from ${s.label} within ${fmtSecs(s.seconds)}`;
    case 'recover': return `Recover the ${names.item(s.item)} from ${s.label}`;
    case 'construct': return `Construct ${s.label} (${s.pieces.length} parts, a Constructor fitted)`;
  }
}

function fmtSecs(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
}

/** How many events a step needs (1 for arrival and check steps) */
export function stepCount(s: QuestStep): number {
  switch (s.type) {
    case 'mine': case 'loot': case 'refine': case 'craft': case 'kill': case 'scan': return s.count;
    case 'sell': return s.credits;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// Bounties
// ---------------------------------------------------------------------------

/** Bounty boards change every this many ms */
export const BOUNTY_WINDOW_MS = 30 * 60 * 1000;

export interface BountyContext {
  station: { id: string; name: string; system: string };
  danger: number;
  /** Factions that spawn in this system */
  factions: string[];
  /** Ores worth asking for at this danger */
  ores: string[];
  /** Other stations in this system (escorts) */
  peers?: string[];
  /** Stations a courier could be sent to (this system and the next), with how many gates away */
  destinations?: { id: string; hops: number }[];
  /** Derelict wrecks in this system (scans) */
  derelicts?: number;
}

/** The bounties a station posts in a time window */
/** Bounties and fleet work pay modestly: credits are for what you can't make yourself */
const CREDIT_SCALE = 0.15;
const payOut = (n: number) => Math.max(5, Math.round((n * CREDIT_SCALE) / 5) * 5);

export function bountyIds(stationId: string, nowMs: number, count = 4): string[] {
  const w = Math.floor(nowMs / BOUNTY_WINDOW_MS);
  return Array.from({ length: count }, (_, i) => `bounty:${stationId}:${w}:${i}`);
}

/** Rebuild a bounty from its id. A station's bounties in one window are all different kinds. */
export function bountyDef(id: string, ctx: BountyContext): QuestDef | null {
  const m = /^bounty:([^:]+):(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  const slot = Number(m[3]);
  const r = mulberry32(hashString(id));
  const d = Math.max(1, ctx.danger);
  const fighting = ctx.factions.length > 0;
  const kinds = fighting ? ['kill', 'mine', 'salvage', 'deliver', 'parts'] : ['mine', 'deliver', 'parts'];
  if (ctx.destinations?.length) kinds.push('courier');
  if ((ctx.derelicts ?? 0) >= 2) kinds.push('scan');
  if (ctx.peers?.length) kinds.push('escort');
  kinds.push('defend');
  // Same offset for every slot in the window, so the slots never repeat a kind
  const offset = Math.floor(mulberry32(hashString(`bounty:${m[1]}:${m[2]}`))() * kinds.length);
  const kind = kinds[(offset + slot) % kinds.length];
  const base = { id, chain: 'bounty', giver: ctx.station.id, npc: `${ctx.station.name} contracts`, level: 1, repeatable: true };
  if (kind === 'courier') {
    const dest = ctx.destinations![Math.floor(r() * ctx.destinations!.length)];
    const seconds = 150 + dest.hops * 150 + Math.floor(r() * 4) * 15;
    const pay = 160 + dest.hops * 220;
    return {
      ...base, name: 'Courier: sealed dispatch',
      intro: `A sealed dispatch has to reach the station manager there, and fast. The clock starts when you take it. Our autopilot (G) knows the way.`,
      outro: 'Signed for, seal unbroken, with time to spare. Nicely flown.',
      steps: [{ type: 'courier', station: dest.id, seconds }],
      rewards: { xp: Math.round(pay * 0.8 * d), credits: payOut(pay * d), reputation: { traders: 3 } },
    };
  }
  if (kind === 'scan') {
    const count = Math.min(ctx.derelicts!, 2 + Math.floor(r() * 3));
    return {
      ...base, name: 'Survey: derelict scans',
      intro: `The salvage office wants fresh scans of the wrecks in this system before the claims open. Fly close to each one and hold steady while your sensors work.`,
      outro: 'Clean readings, every one. The claims office thanks you.',
      steps: [{ type: 'scan', count, system: ctx.station.system }],
      rewards: { xp: 70 * count * d, credits: payOut(85 * count * d), reputation: { shipwrights: 2 } },
    };
  }
  if (kind === 'escort') {
    const to = ctx.peers![Math.floor(r() * ctx.peers!.length)];
    const ambushes = 1 + Math.floor(d / 3) + Math.floor(r() * 2);
    return {
      ...base, name: 'Escort: freighter run',
      intro: `A freighter is ready to leave and raiders have been watching the lane. Meet her outside the station and keep her in one piece until she docks.`,
      outro: 'She docked without a scratch. The captain is buying.',
      steps: [{ type: 'escort', from: ctx.station.id, to, ambushes }],
      rewards: { xp: 160 * ambushes * d, credits: payOut(190 * ambushes * d), reputation: { traders: 3, sol_patrol: 1 } },
    };
  }
  if (kind === 'defend') {
    const waves = 2 + Math.floor(r() * 2) + (d >= 4 ? 1 : 0);
    return {
      ...base, name: 'Defence: hold the outpost',
      intro: `A mining outpost near here keeps getting hit. Our scouts say another raid is coming. Get out there and hold it until they give up.`,
      outro: 'The outpost is still standing, and so are you. Good work.',
      steps: [{ type: 'defend', near: ctx.station.id, waves }],
      rewards: { xp: 130 * waves * d, credits: payOut(150 * waves * d), reputation: { miners: 3, sol_patrol: 1 } },
    };
  }
  if (kind === 'kill') {
    const faction = ctx.factions[Math.floor(r() * ctx.factions.length)];
    const count = 2 + Math.floor(r() * 3) + Math.floor(d / 2);
    return {
      ...base, name: 'Bounty: clear the lanes',
      intro: `Hostiles are harassing traffic out of ${ctx.station.name}. Thin them out and the station pays.`,
      outro: 'Good hunting. The lanes are quieter already.',
      steps: [{ type: 'kill', faction, system: ctx.station.system, count }],
      rewards: { xp: 40 * count * d, credits: payOut(60 * count * d), reputation: { sol_patrol: 2 } },
    };
  }
  if (kind === 'salvage') {
    const count = 3 + Math.floor(r() * 4) + d;
    return {
      ...base, name: 'Bounty: salvage run',
      intro: `Our electronics shop is out of stock. Raiders carry plenty of scrap electronics; take it off them.`,
      outro: 'That will keep the repair crews busy. Thanks.',
      steps: [{ type: 'loot', item: 'scrap_electronics', count }, { type: 'deliver', items: { scrap_electronics: count } }],
      rewards: { xp: 30 * count * d, credits: payOut(40 * count * d), reputation: { traders: 2 } },
    };
  }
  if (kind === 'parts') {
    // (The starter's models: every pilot can make them)
    const fn = ['engine_ion_drive', 'power_cell_reactor', 'cannon_pip', 'utility_mining_laser'][Math.floor(r() * 4)];
    const n = 3 + Math.floor(r() * 4);
    const id2 = `part:alloy:${fn}:sq`;
    return {
      ...base, name: 'Order: spare parts',
      intro: `A ship limped in missing half its ${({ engine_ion_drive: 'ion drives', power_cell_reactor: 'cell reactors', cannon_pip: 'cannons', utility_mining_laser: 'mining lasers' } as Record<string, string>)[fn]}. Fabricate us some new ones.`,
      outro: 'Fitted already. Here is your fee, with thanks from her captain.',
      steps: [{ type: 'deliver', items: { [id2]: n } }],
      rewards: { xp: 35 * n * d, credits: payOut(70 * n * d), reputation: { shipwrights: 2 } },
    };
  }
  const ore = ctx.ores[Math.floor(r() * ctx.ores.length)] ?? 'iron_ore';
  const count = 10 + Math.floor(r() * 4) * 5 + d * 3;
  if (kind === 'mine') {
    return {
      ...base, name: 'Contract: ore run',
      intro: `${ctx.station.name} needs ore, and quickly. Mine it yourself; we pay above market.`,
      outro: 'Weighed, logged and paid. Thanks, pilot.',
      steps: [{ type: 'mine', item: ore, count }, { type: 'deliver', items: { [ore]: count } }],
      rewards: { xp: 6 * count * d, credits: payOut(14 * count * d), reputation: { miners: 2 } },
    };
  }
  // Deliver refined goods
  const goods = ['alloy_plate', 'copper_wire', 'composite_sheet', 'steel_plate'][Math.floor(r() * 4)];
  const n = 4 + Math.floor(r() * 6);
  return {
    ...base, name: 'Contract: supply drop',
    intro: `The yard here is short of ${goods.replace('_', ' ')}. Refine some and bring it in.`,
    outro: 'Delivered in good order. Here is your fee.',
    steps: [{ type: 'deliver', items: { [goods]: n } }],
    rewards: { xp: 20 * n * d, credits: payOut(45 * n * d), reputation: { traders: 2 } },
  };
}

// ---------------------------------------------------------------------------
// Fleet operations (party jobs)
// ---------------------------------------------------------------------------

/** The fleet operations a station posts in a time window */
export function fleetIds(stationId: string, nowMs: number, count = 2): string[] {
  const w = Math.floor(nowMs / BOUNTY_WINDOW_MS);
  return Array.from({ length: count }, (_, i) => `fleet:${stationId}:${w}:${i}`);
}

/** Rebuild a fleet operation from its id: uplinks, convoys and sieges, sized for a party */
export function fleetDef(id: string, ctx: BountyContext): QuestDef | null {
  const m = /^fleet:([^:]+):(\d+):(\d+)$/.exec(id);
  if (!m) return null;
  const slot = Number(m[3]);
  const r = mulberry32(hashString(id));
  const d = Math.max(1, ctx.danger);
  const kinds = ['uplink', 'siege'];
  if (ctx.peers?.length) kinds.push('convoy');
  const offset = Math.floor(mulberry32(hashString(`fleet:${m[1]}:${m[2]}`))() * kinds.length);
  const kind = kinds[(offset + slot) % kinds.length];
  const base = { id, chain: 'fleet', party: 2, giver: ctx.station.id, npc: `${ctx.station.name} operations`, level: 1, repeatable: true };
  if (kind === 'uplink') {
    const seconds = 75 + Math.floor(r() * 3) * 15;
    return {
      ...base, name: 'Fleet op: relay uplink',
      intro: `We're pushing a long-range uplink through the relay beacons near ${ctx.station.name}. Every beacon has to be held at the same moment for the link to charge, and the raiders will jam it if they can. One pilot per beacon, the rest keep them off. It can't be done alone.`,
      outro: 'Link established. Your wing did that together. Drinks are on the station.',
      steps: [{ type: 'uplink', near: ctx.station.id, beacons: 2, seconds }],
      rewards: { xp: 520 * d, credits: 600 * d, reputation: { sol_patrol: 4, traders: 2 }, skillPoints: 0 },
    };
  }
  if (kind === 'convoy') {
    const to = ctx.peers![Math.floor(r() * ctx.peers!.length)];
    const ambushes = 2 + Math.floor(d / 2);
    return {
      ...base, name: 'Fleet op: heavy convoy',
      intro: `A heavy freighter is carrying a whole quarter's cargo, and every raider in the system knows it. It needs a proper escort: split up, cover its flanks, and get it docked.`,
      outro: 'Full cargo, no losses. That is how a wing flies.',
      steps: [{ type: 'escort', from: ctx.station.id, to, ambushes }],
      rewards: { xp: 300 * ambushes * d, credits: 320 * ambushes * d, reputation: { traders: 5 } },
    };
  }
  const waves = 4 + (d >= 4 ? 1 : 0);
  return {
    ...base, name: 'Fleet op: outpost siege',
    intro: `A raider fleet is moving on the outpost near ${ctx.station.name}, more than one pilot can hold off. Wing up, keep the outpost alive, and break every wave.`,
    outro: 'The siege is broken. The miners will remember your names.',
    steps: [{ type: 'defend', near: ctx.station.id, waves }],
    rewards: { xp: 220 * waves * d, credits: 240 * waves * d, reputation: { miners: 5, sol_patrol: 2 } },
  };
}

// ---------------------------------------------------------------------------
// Reputation ranks
// ---------------------------------------------------------------------------

/** Standing needed for each rank (the top one at the most standing there is: REP_MAX) */
export const REP_RANKS = [
  { at: 0, name: 'Unknown' },
  { at: 5, name: 'Noticed' },
  { at: 15, name: 'Known' },
  { at: 35, name: 'Trusted' },
  { at: 70, name: 'Honoured' },
  { at: 100, name: 'Exalted' },
];

/** Standing runs from REP_MIN to REP_MAX */
export const REP_MIN = -100;
export const REP_MAX = 100;

/** A standing after a change, kept in range */
export function addStanding(v: number, n: number): number {
  return Math.max(REP_MIN, Math.min(REP_MAX, v + n));
}

/** A standing's rank (0 = Unknown), and what the next one needs */
export function repRank(v: number): { rank: number; name: string; next?: number; nextName?: string } {
  if (v < 0) return { rank: -1, name: 'Distrusted', next: 0, nextName: 'Unknown' };
  let i = 0;
  while (i + 1 < REP_RANKS.length && v >= REP_RANKS[i + 1].at) i++;
  const n = REP_RANKS[i + 1];
  return { rank: i, name: REP_RANKS[i].name, next: n?.at, nextName: n?.name };
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Skills, each point worth a little less than the one before (SKILL_FALLOFF):
 * the first point gives `first`, the second first × 0.9, and so on, so ten
 * points come to about 6.5 × the first and twenty to 8.8 ×. `per` is what it
 * improves. Levels give a point each until a pilot has SKILL_POINT_CAP (every
 * skill full), jobs' points count towards it too.
 */
export const SKILLS: Record<string, { name: string; max: number; first: number; per: string; sign?: -1 }> = {
  mining: { name: 'Mining', max: 20, first: 0.08, per: 'more ore from every rock' },
  engineering: { name: 'Engineering', max: 20, first: 0.065, per: 'cheaper rebuilds (and at 2, 5 and 9 points: the refinery and fabricator each run one more job at once, and the fabricator queue gains a slot)', sign: -1 },
  navigation: { name: 'Navigation', max: 20, first: 0.065, per: 'more cargo space' },
};

/** Each skill point is worth this much of the one before */
export const SKILL_FALLOFF = 0.9;

/** The most skill points a pilot holds, spent and unspent: every skill at its maximum */
export const SKILL_POINT_CAP = Object.values(SKILLS).reduce((n, s) => n + s.max, 0);

/** What `points` in a skill come to (a fraction: 0.27 = 27%) */
export function skillValue(id: string, points: number): number {
  const s = SKILLS[id];
  const n = Math.max(0, Math.min(s?.max ?? 0, Math.floor(points)));
  return s && n > 0 ? s.first * (1 - dpow(SKILL_FALLOFF, n)) / (1 - SKILL_FALLOFF) : 0;
}

/** Points spent in skills */
export function skillPointsSpent(p: { skills: Record<string, number> }): number {
  return Object.values(p.skills).reduce((n, k) => n + Math.max(0, Math.floor(k) || 0), 0);
}

/** Give up to `n` skill points, never past SKILL_POINT_CAP in all: how many were given */
export function giveSkillPoints(p: { skills: Record<string, number>; skillPoints: number }, n: number): number {
  const k = Math.max(0, Math.min(Math.floor(n), SKILL_POINT_CAP - skillPointsSpent(p) - p.skillPoints));
  p.skillPoints += k;
  return k;
}

/**
 * Points in a skill that's gone (Gunnery) come back to spend, and points past
 * a skill's maximum too. Then the pilot holds what their levels give at least
 * (a point a level, to SKILL_POINT_CAP: levels come from XP, so a gentler
 * curve owes the points it skipped) and no unspent points past the cap (the
 * spent ones are never taken). True if anything changed.
 */
export function refundRetiredSkills(p: { skills: Record<string, number>; skillPoints: number; level?: number }): boolean {
  let back = 0;
  for (const [id, n] of Object.entries(p.skills)) {
    const s = SKILLS[id];
    const keep = s ? Math.min(s.max, Math.max(0, Math.floor(n))) : 0;
    back += Math.max(0, Math.floor(n) - keep);
    if (keep) p.skills[id] = keep;
    else delete p.skills[id];
  }
  const was = p.skillPoints;
  p.skillPoints += back;
  const spent = skillPointsSpent(p);
  const owed = Math.min(SKILL_POINT_CAP, Math.max(0, (p.level ?? 1) - 1));
  if (spent + p.skillPoints < owed) p.skillPoints = owed - spent;
  p.skillPoints = Math.max(0, Math.min(p.skillPoints, SKILL_POINT_CAP - spent));
  return back > 0 || p.skillPoints !== was;
}

/** Extra fabricator queue slots (and, in jobLanes, extra jobs run at once, for both refinery and fabricator) from engineering: one at 2, 5 and 9 points */
export function engineeringSlots(points: number): number {
  return [2, 5, 9].filter((k) => points >= k).length;
}
