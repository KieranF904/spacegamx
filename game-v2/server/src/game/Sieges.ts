/**
 * Moon sieges: a pilot's (or a party's) own copy of a moon (an instanced
 * surface with a `bastion`), held night after night. Solo or together: the
 * nights grow with the number of pilots down there.
 *
 *   day    rest. Spend the party's supplies on patching the bastion and
 *          turrets, building turrets on its pads, upgrading them (three
 *          marks each) or scrapping them for half back; anyone can refit
 *          their own ship for free. Everyone down on the moon clicks Ready
 *          to bring on the night, or claims their haul and leaves.
 *   dusk   a few seconds of failing light
 *   night  the night comes at the bastion from the dark (headlights on): in
 *          fronts, one after another, and a trickle streaming in between.
 *          Each night's budget grows (faster as the nights go on), its ships
 *          get tougher (hull × hpPerNight a night) and harder, rarer kinds
 *          mix in; some nights a boss comes with it. Out on the moon, small
 *          objectives come up (a supply drop to hold, a nest to burn out)
 *          that pay supplies and haul for leaving the bastion's guns.
 *
 * Each moon is its own siege (its `profile`, SiegeRules.profiles): who comes,
 * how hard, from where (all round, set lanes, an arc, a pincer), how much
 * streams in, which bosses and when, and which objectives come up.
 *
 * Clear a wave and it's day again: each pilot there adds to their haul (more
 * each night) and the party earns supplies (kills add a little more). The
 * haul is paid when you claim it and leave by day, with a bonus for every
 * five nights you held (haulBonus). Leave any other way (out past the edge
 * at night, shot down, disconnected) or lose the bastion and you get half,
 * with no bonus. Lose the bastion and the siege is over: everyone goes back
 * to orbit and the moon is cleared for the next party. A copy nobody's on
 * for a while is cleared too.
 *
 * Pilots on the moon get the `objective` banner (with `night`, which the
 * client turns into darkness) and `siegeState` (the day's panel: supplies,
 * the shop, who's ready).
 */

import type { ServerMessage, StarSystemData } from '@space-game/common';
import type { PilotConn } from './Pilots.js';
import { mergeRules, texts, type RulesPatch, type StringsFile, type Texts } from '../data/rules.js';

export interface SiegeHost {
  tick(): number;
  instances(id: string): number[];
  /** The party (0: none) and everyone in it */
  partyId(conn: PilotConn): number;
  name(conn: PilotConn): string;
  pilots(num: number): { conn: PilotConn; eid: number; x: number; y: number }[];
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
  /** A turret: aims at (leading by `shot`, its shells' speed; 0: no lead) and fires on hostiles within range, its damage × `damage` */
  arm(eid: number, opts: { range: number; shot: number; damage: number }): void;
  /** Hostiles (built in `grade`) at a point, sent at another: each its hull × `hp`, its reach and aggro if given (factions found from the designs unless given) */
  spawnHostiles(num: number, ships: SiegeSpawn[], x: number, y: number, at: { x: number; y: number }, grade: number): number[];
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

const SECOND = 60;
const BASTION = 'siege_bastion';

export interface SiegeTurretDef {
  label: string;
  note: string;
  range: number;
  shot: number;
  damage: number;
  marks: { design: string; cost: number }[];
}

/** One kind of ship a siege sends: what it costs from a night's budget, the nights it comes, and how it's tuned */
export interface SiegeUnit {
  ship: string;
  cost: number;
  from: number;
  /** Last night it comes (the cheap stuff thins out) */
  until?: number;
  /** Its faction, if its design isn't one of a faction's own */
  faction?: string;
  /** Hull × this (the tanks), and its guns' damage × this (bosses, as they are out in the systems) */
  hp?: number;
  damage?: number;
  /** Fights from this far (artillery) and picks fights from this far */
  range?: number;
  aggro?: number;
  /** Comes this many at a time (for its cost) */
  group?: number;
}

/** A ship to spawn, tuned */
export interface SiegeSpawn { ship: string; faction?: string; hp: number; damage?: number; range?: number; aggro?: number; plating?: number }

/**
 * A moon's siege. The night's budget × `difficulty`; `approach`: where it comes
 * from (`radius`: how far out, of the moon's; `angles`/`spread` in degrees, 0
 * east, -90 north): `ring` anywhere, `lanes` down set lanes, `arc` across one
 * side (`angles[0]`, or a new side each night), `pincer` from two opposite sides
 * by turns. A front more every `fronts.every` nights; `stream.share` of it
 * trickles in one at a time instead. A boss on every `bosses.every`th night.
 */
export interface SiegeProfile {
  name: string;
  about: string;
  difficulty: number;
  roster: SiegeUnit[];
  approach: { kind: 'ring' | 'lanes' | 'arc' | 'pincer'; angles?: number[]; spread?: number; radius: number };
  fronts: { every: number; max: number; gapSeconds: number };
  stream: { from: number; share: number; everySeconds: number };
  bosses: { every: number; from: number; ships: SiegeUnit[] };
  /** Every ship's hull × (1 + this × (night − 1)) */
  hpPerNight: number;
  /** Objectives out on the moon, from this night, one at a time, about every `everySeconds` */
  objectives: { from: number; everySeconds: number; kinds: ('cache' | 'nest')[]; nest: { design: string; faction: string } };
}

/** Siege tuning (data/rules.json `sieges`; these are the defaults) */
export interface SiegeRules {
  /** Seconds of failing light before a night */
  duskSeconds: number;
  /** A copy nobody's on is cleared after this */
  emptySeconds: number;
  /** After the bastion falls, the copy is cleared this long later */
  lostSeconds: number;
  startSupplies: number;
  /** Supplies each kill pays in */
  killSupplies: number;
  /** Fortifications are built this many grades better than what comes at them, up to `fortMaxGrade` */
  fortGradeBonus: number;
  fortMaxGrade: number;
  /** Each moon's siege (its bastion's `profile`; `defaultProfile` otherwise) */
  profiles: Record<string, SiegeProfile>;
  defaultProfile: string;
  turrets: Record<string, SiegeTurretDef>;
  repair: { id: string; label: string; cost: number; note: string; heal: number };
  /** What scrapping a turret gives back, of what was spent on it */
  scrapBack: number;
  /** Claiming your haul by day: +`per` for every `every` nights you held */
  haulBonus: { per: number; every: number };
  /** Night budget: (base + wave × perWave + wave² × perWave2) × the profile's difficulty × (solo + perPilot × pilots); toughest-recent pick chance and spread */
  wave: { base: number; perWave: number; perWave2: number; solo: number; perPilot: number; leanChance: number; leanSpread: number; maxPicks: number };
  /**
   * Objectives out on the moon (`distance` from the bastion): a supply drop
   * (hold it `holdSeconds` within `radius`) or a nest (burn it out; it sends
   * one of the night's cheapest ships every `releaseSeconds`). Each pays
   * supplies (+ per night) and credits to the haul of whoever's on the moon.
   */
  objectives: {
    distance: [number, number];
    cache: { holdSeconds: number; radius: number; lifeSeconds: number; supplies: number; suppliesPerNight: number; credits: number };
    nest: { hp: number; lifeSeconds: number; releaseSeconds: number; supplies: number; suppliesPerNight: number; credits: number };
  };
  /** Dawn's pay: xp/credits (base + perNight × roster night) × grade reward; supplies base + perNight × night */
  dawn: { xpBase: number; xpPerNight: number; creditsBase: number; creditsPerNight: number; suppliesBase: number; suppliesPerNight: number };
  /** What leaving any way but claiming by day keeps of the haul */
  partialHaul: number;
}

export const DEFAULT_SIEGE_RULES: SiegeRules = {
  duskSeconds: 6,
  emptySeconds: 60,
  lostSeconds: 12,
  startSupplies: 150,
  killSupplies: 4,
  fortGradeBonus: 1,
  fortMaxGrade: 5,
  profiles: {
    // Selene: the Scrapborn come down three lanes from their scrapyards, slow and many
    selene: {
      name: 'Scrap Tide', about: 'Scrapborn down three lanes from their scrapyards: slow, but more every night, and their hulks soak up fire',
      difficulty: 1,
      roster: [
        // The first nights are all slow Scrapborn (half a starter ship's speed); faster ships come later
        { ship: 'scrap_mite', cost: 1, from: 1, until: 12 },
        { ship: 'scrap_spitter', cost: 1.5, from: 1 },
        { ship: 'scrap_crawler', cost: 3, from: 2 },
        { ship: 'scrap_swarmer', cost: 2, from: 3, group: 3 },
        { ship: 'scrap_hulk', cost: 6, from: 4, hp: 1.6 },
        { ship: 'pirate_skiff', cost: 2, from: 5 },
        { ship: 'scrap_lobber', cost: 5, from: 6, range: 1350, aggro: 2600 },
        { ship: 'pirate_raider', cost: 3.5, from: 7 },
        { ship: 'pirate_gunship', cost: 7, from: 10 },
        { ship: 'cinder_zealot', cost: 6, from: 11 },
        { ship: 'scav_harvester', cost: 9, from: 13, hp: 1.4 },
        { ship: 'frost_warden', cost: 9, from: 15 },
        { ship: 'void_reaver', cost: 13, from: 18 },
        { ship: 'maw_lurker', cost: 14, from: 21 },
      ],
      approach: { kind: 'lanes', angles: [-90, 30, 150], spread: 12, radius: 0.5 },
      fronts: { every: 4, max: 4, gapSeconds: 10 },
      stream: { from: 3, share: 0.25, everySeconds: 4 },
      bosses: { every: 5, from: 5, ships: [{ ship: 'boss_scrap_mother', cost: 0, from: 5, faction: 'scrapborn', hp: 1.6, damage: 0.6 }, { ship: 'boss_rustjaw', cost: 0, from: 10, faction: 'pirates', hp: 1, damage: 0.15 }] },
      hpPerNight: 0.07,
      objectives: { from: 2, everySeconds: 50, kinds: ['cache', 'nest'], nest: { design: 'scrap_nest', faction: 'scrapborn' } },
    },
    // Rimeholt: a whiteout front out of the north, frost ships that hit from range behind walls of ice
    rimeholt: {
      name: 'Whiteout', about: 'Everything comes out of the north in a blizzard front: frost ships that fight from range, and bulwarks that shrug off fire',
      difficulty: 1.15,
      roster: [
        { ship: 'scrap_mite', cost: 1, from: 1, until: 8 },
        { ship: 'scrap_spitter', cost: 1.5, from: 1 },
        { ship: 'frost_shard', cost: 3.5, from: 2 },
        { ship: 'scrap_lobber', cost: 5, from: 3, range: 1350, aggro: 2600 },
        { ship: 'frost_bulwark', cost: 7, from: 4, hp: 1.5 },
        { ship: 'scrap_hulk', cost: 6, from: 5, hp: 1.6 },
        { ship: 'frost_warden', cost: 8, from: 6 },
        { ship: 'pirate_gunship', cost: 7, from: 9 },
        { ship: 'void_phantom', cost: 8, from: 12 },
        { ship: 'maw_lurker', cost: 14, from: 16 },
      ],
      approach: { kind: 'arc', angles: [-90], spread: 50, radius: 0.5 },
      fronts: { every: 3, max: 4, gapSeconds: 12 },
      stream: { from: 2, share: 0.2, everySeconds: 5 },
      bosses: { every: 5, from: 5, ships: [{ ship: 'boss_hoarfrost', cost: 0, from: 5, faction: 'frost', hp: 2.5, damage: 0.4 }] },
      hpPerNight: 0.08,
      objectives: { from: 2, everySeconds: 55, kinds: ['cache', 'cache', 'nest'], nest: { design: 'scrap_nest', faction: 'scrapborn' } },
    },
    // Cinderhold: zealots rush in from every side, in a constant stream
    cinderhold: {
      name: 'Ember Rush', about: 'Cinder zealots rush in from every side, a stream of them all night: short reach, but they never stop coming',
      difficulty: 1.3,
      roster: [
        { ship: 'scrap_mite', cost: 1, from: 1, until: 6 },
        { ship: 'scrap_swarmer', cost: 2, from: 1, group: 3 },
        { ship: 'cinder_zealot', cost: 4, from: 1 },
        { ship: 'scrap_hulk', cost: 6, from: 3, hp: 1.6 },
        { ship: 'pirate_raider', cost: 3.5, from: 4 },
        { ship: 'cinder_brand', cost: 9, from: 6 },
        { ship: 'scrap_lobber', cost: 5, from: 7, range: 1350, aggro: 2600 },
        { ship: 'scav_harvester', cost: 9, from: 9, hp: 1.4 },
        { ship: 'void_reaver', cost: 13, from: 13 },
      ],
      approach: { kind: 'ring', radius: 0.45 },
      fronts: { every: 3, max: 5, gapSeconds: 8 },
      stream: { from: 1, share: 0.4, everySeconds: 3 },
      bosses: { every: 4, from: 4, ships: [{ ship: 'boss_cinder_warden', cost: 0, from: 4, faction: 'cinder', hp: 2.5, damage: 0.45 }] },
      hpPerNight: 0.09,
      objectives: { from: 1, everySeconds: 45, kinds: ['nest', 'cache'], nest: { design: 'scrap_nest', faction: 'scrapborn' } },
    },
    // Lastlight: the Maw's things close from two sides at once, by turns
    lastlight: {
      name: "The Maw's Pincer", about: "The Maw's things close from two opposite sides by turns: split your guns, or lose a flank",
      difficulty: 1.45,
      roster: [
        { ship: 'pirate_raider', cost: 3, from: 1 },
        { ship: 'scrap_lobber', cost: 5, from: 4, range: 1350, aggro: 2600 },
        { ship: 'scrap_hulk', cost: 6, from: 4, hp: 1.6 },
        { ship: 'pirate_gunship', cost: 8, from: 1 },
        { ship: 'cinder_brand', cost: 10, from: 3 },
        { ship: 'maw_lurker', cost: 9, from: 2 },
        { ship: 'void_reaver', cost: 12, from: 7 },
        { ship: 'maw_colossus', cost: 18, from: 10, hp: 1.3 },
      ],
      approach: { kind: 'pincer', spread: 20, radius: 0.5 },
      fronts: { every: 2, max: 6, gapSeconds: 9 },
      stream: { from: 2, share: 0.25, everySeconds: 4 },
      bosses: { every: 5, from: 5, ships: [{ ship: 'boss_maw_heart', cost: 0, from: 5, faction: 'maw', hp: 2.5, damage: 0.5 }] },
      hpPerNight: 0.09,
      objectives: { from: 1, everySeconds: 50, kinds: ['cache', 'nest'], nest: { design: 'scrap_nest', faction: 'scrapborn' } },
    },
    // Gloam: wraiths out of nowhere, close in, from anywhere
    gloam: {
      name: 'Shadowfall', about: 'Wraiths slip out of the dark close in, anywhere: the bastion gets little warning, and they are few but deadly',
      difficulty: 1.8,
      roster: [
        { ship: 'scrap_lobber', cost: 4, from: 2, range: 1350, aggro: 2600 },
        { ship: 'void_phantom', cost: 4, from: 1 },
        { ship: 'frost_bulwark', cost: 5, from: 2, hp: 1.5 },
        { ship: 'void_reaver', cost: 6, from: 2 },
        { ship: 'maw_lurker', cost: 8, from: 4 },
        { ship: 'maw_colossus', cost: 12, from: 7, hp: 1.3 },
      ],
      approach: { kind: 'ring', radius: 0.22 },
      fronts: { every: 2, max: 5, gapSeconds: 14 },
      stream: { from: 2, share: 0.3, everySeconds: 6 },
      bosses: { every: 5, from: 5, ships: [{ ship: 'boss_void_leviathan', cost: 0, from: 5, faction: 'wraiths', hp: 3, damage: 0.45 }, { ship: 'boss_prism_colossus', cost: 0, from: 10, faction: 'scavengers', hp: 2, damage: 0.25 }] },
      hpPerNight: 0.1,
      objectives: { from: 1, everySeconds: 60, kinds: ['cache', 'nest'], nest: { design: 'scrap_nest', faction: 'scrapborn' } },
    },
  },
  defaultProfile: 'selene',
  /**
   * The turrets, each in three marks (an upgrade swaps in the next, at full hull).
   * Priced by what they do: per mark-I turret, roughly
   *   cannon   ~84 dps at one target; slow shells, so led, but they still miss quick ships
   *   flak     ~75 dps in 170-wide bursts: the answer to swarms
   *   laser    charged pulses (one every 1.2s, its damage in a flare at the peak), hits whatever it's aimed at, from far out
   *   missile  ~90 dps, homing, with splash, from furthest out
   * `shot`: shell speed, to lead targets by (0: no need: beams and homing missiles).
   * `damage`: a multiplier on the weapon's own damage.
   */
  turrets: {
    cannon: {
      label: 'Cannon turret', note: 'Steady fire at one target', range: 1500, shot: 48, damage: 1,
      marks: [{ design: 'siege_turret_cannon', cost: 100 }, { design: 'siege_turret_cannon_2', cost: 90 }, { design: 'siege_turret_cannon_3', cost: 140 }],
    },
    flak: {
      label: 'Flak turret', note: 'Bursts that shred swarms', range: 1250, shot: 34, damage: 1,
      marks: [{ design: 'siege_turret_flak', cost: 130 }, { design: 'siege_turret_flak_2', cost: 110 }, { design: 'siege_turret_flak_3', cost: 170 }],
    },
    laser: {
      label: 'Laser turret', note: 'Never misses; short reach', range: 940, shot: 0, damage: 1.5,
      marks: [{ design: 'siege_turret_laser', cost: 140 }, { design: 'siege_turret_laser_2', cost: 120 }, { design: 'siege_turret_laser_3', cost: 180 }],
    },
    missile: {
      label: 'Missile turret', note: 'Homing, splash, longest reach', range: 2400, shot: 0, damage: 1.3,
      marks: [{ design: 'siege_turret_missile', cost: 170 }, { design: 'siege_turret_missile_2', cost: 140 }, { design: 'siege_turret_missile_3', cost: 200 }],
    },
  },
  repair: { id: 'repair', label: 'Patch the bastion and turrets', cost: 60, note: '+30% hull to each', heal: 0.3 },
  scrapBack: 0.5,
  haulBonus: { per: 0.25, every: 5 },
  wave: { base: 4, perWave: 3, perWave2: 0.12, solo: 0.7, perPilot: 0.3, leanChance: 0.55, leanSpread: 3, maxPicks: 90 },
  objectives: {
    distance: [2600, 4800],
    cache: { holdSeconds: 8, radius: 330, lifeSeconds: 75, supplies: 45, suppliesPerNight: 6, credits: 12 },
    nest: { hp: 1, lifeSeconds: 120, releaseSeconds: 7, supplies: 70, suppliesPerNight: 8, credits: 25 },
  },
  dawn: { xpBase: 25, xpPerNight: 20, creditsBase: 8, creditsPerNight: 6, suppliesBase: 70, suppliesPerNight: 15 },
  partialHaul: 0.5,
};

/** The turrets as built in (data/rules.json can change them for a server) */
export const SIEGE_TURRETS: Record<string, SiegeTurretDef> = DEFAULT_SIEGE_RULES.turrets;

const MARKS = ['I', 'II', 'III'];
const DEG = Math.PI / 180;
/** A front is seen coming this long before it arrives */
const FRONT_WARN = 4 * 60;

/** Siege text (data/strings.json; these are the defaults) */
export const SIEGE_STRINGS = {
  'sieges.fallenRetry': "Your party's bastion on {name} has fallen. It's being cleared; try again in a moment",
  'sieges.full': 'Every landing site on {name} is taken. Try again soon',
  'sieges.notAtNight': 'Not while the night is on',
  'sieges.refitted': 'Ship refitted',
  'sieges.bastionName': '{name} bastion',
  'sieges.lost': 'The bastion has fallen. Your party held {name} for {nights} night{s}. Half your haul is saved',
  'sieges.dusk': 'Night {night} is falling. Get to the bastion',
  'sieges.duskBoss': 'Night {night} is falling, and {boss} comes with it. Get to the bastion',
  'sieges.banner.nightBoss': 'Night {night} · {boss} · {left} hostile{s} left',
  'sieges.obj.cache': 'Supply drop',
  'sieges.obj.cacheText': 'Hold it for {secs}s to bring it in · {left}s before it is lost',
  'sieges.obj.cacheMeter': 'Brought in',
  'sieges.obj.nest': 'Scrap nest',
  'sieges.obj.nestText': 'Burn it out before it buries itself ({left}s): it keeps sending raiders',
  'sieges.obj.nestMeter': 'Nest',
  'sieges.obj.up': '{what} out on the moon: {how}',
  'sieges.obj.upCache': 'hold it to bring in supplies',
  'sieges.obj.upNest': 'burn it out',
  'sieges.obj.done': '{what}: +{supplies} supplies, +{credits} cr to the haul',
  'sieges.obj.lost': '{what} lost',
  'sieges.dawn': 'Dawn: night {night} held. +{supplies} supplies, +{credits} cr to your haul{milestone}',
  'sieges.dawnMilestone': '. {nights} nights held: claim now for ×{bonus}',
  'sieges.claimed': '{name}: {nights} night{s} held. Haul claimed{bonus}: {credits} cr, {xp} XP',
  'sieges.claimedBonus': ' (×{bonus} bonus)',
  'sieges.halfSaved': '{name}: half your haul saved: {credits} cr, {xp} XP',
  'sieges.shortOfSupplies': 'Not enough supplies ({cost} needed)',
  'sieges.nothingToPatch': 'Nothing needs patching',
  'sieges.padsFull': 'Every turret pad is built on. Scrap one to make room',
  'sieges.fullyUpgraded': 'That turret is fully upgraded',
  'sieges.scrapped': 'scrapped a {turret} (+{back})',
  'sieges.announce': '{who}: {what}',
  'sieges.turretName': '{label} {mark}',
  'sieges.banner.title': 'Siege of {name}',
  'sieges.banner.day': 'Day {day} · rest, repair and build · {ready}/{pilots} ready',
  'sieges.banner.dusk': 'Night {night} falls in {secs}s',
  'sieges.banner.night': 'Night {night} · {left} hostile{s} left',
  'sieges.banner.lost': 'The bastion has fallen',
  'sieges.banner.meter': 'Bastion',
};

/** The day's shop: patching, and building each kind of turret (on the first free pad) */
function siegeShop(rules: SiegeRules): { id: string; label: string; cost: number; note: string }[] {
  const { id, label, cost, note } = rules.repair;
  return [
    { id, label, cost, note },
    ...Object.entries(rules.turrets).map(([k, t]) => ({ id: `turret_${k}`, label: t.label, cost: t.marks[0].cost, note: t.note })),
  ];
}
export const SIEGE_SHOP = siegeShop(DEFAULT_SIEGE_RULES);

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

interface Turret {
  eid: number;
  kind: string;
  /** 0, 1, 2: marks I, II, III */
  mark: number;
  /** Supplies put into it, for scrapping */
  spent: number;
}

interface Run {
  key: number;
  num: number;
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
  fronts: { at: number; ships: SiegeSpawn[]; pos?: { x: number; y: number } }[];
  stream: SiegeSpawn[];
  nextStream: number;
  /** Tonight's side (arc), or the pincer's first */
  side: number;
  frontNo: number;
  /** Tonight's boss (its name), if any */
  boss: string;
  /** Ships an objective sent (they don't hold back the dawn: they go with it) */
  extras: number[];
  objective: { kind: 'cache' | 'nest'; x: number; y: number; until: number; held: number; eid: number; release: number } | null;
  nextObjective: number;
  next: number;
  lastPilots: number;
  shown: Map<PilotConn, string>;
  banner: string;
}

export class Sieges {
  private runs = new Map<number, Run>();
  private solo = new Map<PilotConn, number>();

  readonly rules: SiegeRules;
  /** The day's shop, from the rules */
  readonly shop: { id: string; label: string; cost: number; note: string }[];
  private t: Texts<keyof typeof SIEGE_STRINGS>;

  /** `rules`: data/rules.json `sieges` (over the defaults); `strings`: data/strings.json */
  constructor(private host: SiegeHost, rules?: RulesPatch<SiegeRules>, strings?: StringsFile) {
    this.rules = mergeRules(DEFAULT_SIEGE_RULES, rules);
    this.shop = siegeShop(this.rules);
    this.t = texts(SIEGE_STRINGS, strings);
  }

  /** Fortifications are built a grade better than what comes at them (Selene's: steel) */
  private fortGrade(grade: number): number {
    return Math.min(this.rules.fortMaxGrade, grade + this.rules.fortGradeBonus);
  }

  private turretName(label: string, mark: number): string {
    return this.t('sieges.turretName', { label, mark: MARKS[mark] });
  }

  /** A pilot going down to a siege moon: their party's copy, or their own if they're alone (made if need be), or why not */
  enter(conn: PilotConn, surface: StarSystemData): { num: number; x: number; y: number } | string {
    const name = surface.name;
    const party = this.host.partyId(conn);
    if (!party && !this.solo.has(conn)) this.solo.set(conn, -1 - this.solo.size);
    const key = party || this.solo.get(conn)!;
    let run = [...this.runs.values()].find((r) => r.key === key && r.sys.id === surface.id);
    if (run?.phase === 'lost') return this.t('sieges.fallenRetry', { name });
    if (!run) {
      const free = this.host.instances(surface.id).find((n) => !this.runs.has(n));
      if (free === undefined) return this.t('sieges.full', { name });
      run = this.open(key, free, surface);
    }
    const b = surface.surface!.bastion!;
    return { num: run.num, x: b.x + (Math.random() - 0.5) * 600, y: b.y + 1400 };
  }

  /** A pilot's request from the day's panel */
  handle(conn: PilotConn, msg: { action?: string; item?: string; pad?: number }, eid: number): void {
    const run = [...this.runs.values()].find((r) => this.host.pilots(r.num).some((p) => p.conn === conn));
    if (!run) return;
    if (run.phase !== 'day') return this.host.toast(conn, this.t('sieges.notAtNight'), 'warn');
    if (msg.action === 'claim') return this.claim(run, conn);
    if (msg.action === 'ready') run.ready.add(conn);
    else if (msg.action === 'unready') run.ready.delete(conn);
    else if (msg.action === 'refit') { this.host.refit(eid); this.host.toast(conn, this.t('sieges.refitted'), 'good'); }
    else if (msg.action === 'buy') this.buy(run, conn, String(msg.item ?? ''));
    else if (msg.action === 'upgrade') this.upgrade(run, conn, Number(msg.pad));
    else if (msg.action === 'scrap') this.scrap(run, conn, Number(msg.pad));
    this.sendState(run, true);
  }

  /** A pilot dropping out (disconnected): paid what they're owed, and lifted to orbit so they don't log back in to an empty moon */
  leave(conn: PilotConn): void {
    for (const run of this.runs.values()) {
      if (!run.haul.has(conn) && !run.shown.has(conn)) continue;
      const here = this.host.pilots(run.num).find((p) => p.conn === conn);
      this.settle(run, conn, run.phase === 'day');
      this.forget(run, conn);
      if (here) this.host.toOrbit(conn, run.sys, Math.atan2(here.y, here.x));
    }
    this.solo.delete(conn);
  }

  /** What a siege moon's early nights are rated (its third night, flown solo): for the maps and the descend hint */
  threat(sys: StarSystemData): number {
    const b = sys.surface?.bastion;
    if (!b) return 0;
    return this.host.rateShips(waveRoster(3 + (b.offset ?? 0), 1, () => 0.5, this.rules, siegeProfile(this.rules, b.profile)), b.grade ?? 1);
  }

  /** The siege a system copy holds (tests, admin) */
  runOf(num: number): Readonly<Run> | undefined {
    return this.runs.get(num);
  }

  tick(): void {
    const now = this.host.tick();
    if (now % 10 !== 0) return;
    for (const run of [...this.runs.values()]) this.step(run, now);
  }

  // ---------------------------------------------------------------------------

  private open(key: number, num: number, sys: StarSystemData): Run {
    const b = sys.surface!.bastion!;
    const grade = b.grade ?? 1;
    const run: Run = {
      key, num, sys, name: sys.name, grade, offset: b.offset ?? 0, phase: 'day', wave: 0, supplies: this.rules.startSupplies, ready: new Set(),
      bastion: this.host.spawnStructure(BASTION, num, b.x, b.y, this.t('sieges.bastionName', { name: sys.name }), this.fortGrade(grade)),
      turrets: b.slots.map(() => null), haul: new Map(), raiders: [], next: 0, lastPilots: this.host.tick(), shown: new Map(), banner: '',
      profile: siegeProfile(this.rules, b.profile), fronts: [], stream: [], nextStream: 0, side: 0, frontNo: 0, boss: '', extras: [], objective: null, nextObjective: 0,
    };
    this.runs.set(num, run);
    return run;
  }

  private close(run: Run): void {
    // Whoever's still owed (the bastion fell): half
    for (const c of [...run.haul.keys()]) this.settle(run, c, false);
    for (const r of run.raiders) this.host.removeHostile(r);
    this.endObjective(run, null);
    for (const r of run.extras) this.host.removeHostile(r);
    for (const t of run.turrets) if (t !== null) this.host.removeStructure(t.eid);
    this.host.removeStructure(run.bastion);
    for (const p of this.host.pilots(run.num)) this.host.toOrbit(p.conn, run.sys, Math.atan2(p.y, p.x));
    for (const c of run.shown.keys()) this.host.send(c, { type: 'siegeState', active: false } as ServerMessage);
    this.runs.delete(run.num);
  }

  private step(run: Run, now: number): void {
    const R = this.rules;
    const pilots = this.host.pilots(run.num);
    if (pilots.length) run.lastPilots = now;
    else if (now - run.lastPilots > R.emptySeconds * SECOND) return this.close(run);
    for (const p of pilots) if (!run.haul.has(p.conn)) run.haul.set(p.conn, { xp: 0, credits: 0, nights: 0 });
    // Left the moon (out past the edge, or shot down): paid (in full only by day) and no longer counted
    for (const c of new Set([...run.shown.keys(), ...run.haul.keys()])) {
      if (pilots.some((p) => p.conn === c)) continue;
      this.settle(run, c, run.phase === 'day');
      this.forget(run, c);
    }
    // Shot down: the pad's free again (and the wreck forgotten)
    run.turrets = run.turrets.map((t) => {
      if (t === null || this.host.shipAt(t.eid)) return t;
      this.host.removeStructure(t.eid);
      return null;
    });
    // Kills pay a little into the supplies
    const alive = run.raiders.filter((e) => this.host.hostileAlive(e));
    const extras = run.extras.filter((e) => this.host.hostileAlive(e));
    run.supplies += (run.raiders.length - alive.length + run.extras.length - extras.length) * R.killSupplies;
    run.raiders = alive;
    run.extras = extras;
    const bastion = this.host.shipAt(run.bastion);

    if (run.phase === 'lost') {
      if (now >= run.next) this.close(run);
      return;
    }
    if (!bastion) {
      run.phase = 'lost';
      run.next = now + R.lostSeconds * SECOND;
      for (const p of pilots) this.host.toast(p.conn, this.t('sieges.lost', { name: run.name, nights: run.wave - 1, s: run.wave === 2 ? '' : 's' }), 'bad');
      this.sendState(run, true);
      this.sendBanner(run, now);
      return;
    }

    switch (run.phase) {
      case 'day': {
        const here = pilots.map((p) => p.conn);
        if (here.length && here.every((c) => run.ready.has(c))) {
          run.phase = 'dusk';
          run.next = now + R.duskSeconds * SECOND;
          run.wave++;
          const boss = siegeBoss(run.profile, run.wave + run.offset);
          run.boss = boss ? this.host.shipName(boss.ship) : '';
          for (const c of here) this.host.toast(c, boss ? this.t('sieges.duskBoss', { night: run.wave, boss: run.boss }) : this.t('sieges.dusk', { night: run.wave }), 'warn');
          this.sendState(run, true);
        }
        break;
      }
      case 'dusk':
        if (now >= run.next) {
          run.phase = 'night';
          this.planNight(run, pilots.length, now);
        }
        break;
      case 'night': {
        // A front shows where it's coming in a few seconds before it does
        for (const f of run.fronts) if (!f.pos && now >= f.at - FRONT_WARN) {
          f.pos = this.frontPoint(run);
          this.host.effect?.(run.num, f.pos.x, f.pos.y, 'warning');
        }
        while (run.fronts.length && now >= run.fronts[0].at) { const f = run.fronts.shift()!; this.spawnFront(run, f.ships, f.pos); }
        if (run.stream.length && now >= run.nextStream) {
          this.spawnFront(run, [run.stream.shift()!]);
          run.nextStream = now + run.profile.stream.everySeconds * SECOND * (0.6 + Math.random() * 0.8);
        }
        this.stepObjective(run, pilots, now);
        if (!run.fronts.length && !run.stream.length && !run.raiders.length) this.dawn(run, pilots);
        break;
      }
    }
    this.sendBanner(run, now);
    this.sendState(run, false);
  }

  /**
   * Tonight: the plan (and its boss) split into fronts, a front more every few
   * nights, each mixing the night's kinds, and a share held back to stream in.
   */
  private planNight(run: Run, pilots: number, now: number): void {
    const P = run.profile, night = run.wave + run.offset;
    const tough = 1 + P.hpPerNight * (night - 1);
    const spawn = (u: SiegeUnit): SiegeSpawn[] => Array.from({ length: u.group ?? 1 }, () => ({ ship: u.ship, faction: u.faction, hp: (u.hp ?? 1) * tough, damage: u.damage, range: u.range, aggro: u.aggro }));
    const plan = wavePlan(night, pilots, Math.random, this.rules, P);
    // The stream: a share of the night, one at a time (from its night)
    const stream: SiegeSpawn[] = [], main: SiegeSpawn[][] = [];
    for (const u of plan) {
      const ships = spawn(u);
      if (night >= P.stream.from && Math.random() < P.stream.share) stream.push(...ships);
      else main.push(ships);
    }
    const n = Math.max(1, Math.min(P.fronts.max, 1 + Math.floor((run.wave - 1) / P.fronts.every)));
    const fronts: SiegeSpawn[][] = Array.from({ length: n }, () => []);
    main.forEach((g, i) => fronts[i % n].push(...g));
    const boss = siegeBoss(P, night);
    if (boss) fronts[0].unshift(...spawn(boss).map((s) => ({ ...s, plating: 1 })));
    run.fronts = fronts.filter((f) => f.length).map((ships, i) => ({ at: now + FRONT_WARN + i * P.fronts.gapSeconds * SECOND, ships }));
    run.stream = stream;
    run.nextStream = now + 5 * SECOND;
    run.frontNo = 0;
    // An arc's side: its set one, or a new one each night
    run.side = (P.approach.angles?.length && P.approach.kind === 'arc' ? P.approach.angles[0] * DEG : Math.random() * Math.PI * 2);
    run.nextObjective = now + P.objectives.everySeconds * SECOND * (0.3 + Math.random() * 0.4);
  }

  /** Where the next lot comes from, by the moon's approach */
  private approachAngle(run: Run): number {
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
  private frontPoint(run: Run): { x: number; y: number } {
    const R = run.sys.surface!.radius, b = run.sys.surface!.bastion!;
    const a = this.approachAngle(run);
    // Out of the dark, but not so far that slow drones take all night to arrive
    const k = run.profile.approach.radius;
    return { x: b.x + Math.cos(a) * R * k, y: b.y + Math.sin(a) * R * k };
  }

  /** Some of the night, from the dark, for the bastion (`pos`: where it was seen coming) */
  private spawnFront(run: Run, ships: SiegeSpawn[], pos = this.frontPoint(run)): void {
    const b = run.sys.surface!.bastion!;
    this.host.effect?.(run.num, pos.x, pos.y, 'warpIn');
    run.raiders.push(...this.host.spawnHostiles(run.num, ships, pos.x, pos.y, { x: b.x, y: b.y }, run.grade));
  }

  // ---------------------------------------------------------------------------
  // Objectives out on the moon
  // ---------------------------------------------------------------------------

  private stepObjective(run: Run, pilots: { conn: PilotConn; x: number; y: number }[], now: number): void {
    const P = run.profile, O = this.rules.objectives, b = run.sys.surface!.bastion!;
    const night = run.wave + run.offset;
    const o = run.objective;
    if (!o) {
      if (night < P.objectives.from || now < run.nextObjective || !P.objectives.kinds.length) return;
      const kind = P.objectives.kinds[Math.floor(Math.random() * P.objectives.kinds.length)];
      const a = Math.random() * Math.PI * 2, d = O.distance[0] + Math.random() * (O.distance[1] - O.distance[0]);
      const x = b.x + Math.cos(a) * d, y = b.y + Math.sin(a) * d;
      let eid = -1;
      if (kind === 'nest') {
        [eid] = this.host.spawnHostiles(run.num, [{ ship: P.objectives.nest.design, faction: P.objectives.nest.faction, hp: O.nest.hp * (1 + P.hpPerNight * (night - 1)) }], x, y, { x, y }, run.grade);
        if (eid === undefined || eid < 0) { run.nextObjective = now + P.objectives.everySeconds * SECOND; return; }
        this.host.pin(eid);
      }
      const life = kind === 'nest' ? O.nest.lifeSeconds : O.cache.lifeSeconds;
      run.objective = { kind, x, y, until: now + life * SECOND, held: 0, eid, release: now + O.nest.releaseSeconds * SECOND };
      const what = this.t(kind === 'nest' ? 'sieges.obj.nest' : 'sieges.obj.cache');
      for (const p of pilots) this.host.toast(p.conn, this.t('sieges.obj.up', { what, how: this.t(kind === 'nest' ? 'sieges.obj.upNest' : 'sieges.obj.upCache') }), 'info');
      return this.sendObjective(run, now);
    }
    if (o.kind === 'cache') {
      const there = pilots.filter((p) => Math.hypot(p.x - o.x, p.y - o.y) < O.cache.radius);
      if (there.length) o.held += 10;
      if (o.held >= O.cache.holdSeconds * SECOND) return this.endObjective(run, there.map((p) => p.conn));
    } else {
      if (!this.host.hostileAlive(o.eid)) return this.endObjective(run, pilots.map((p) => p.conn));
      // It keeps sending the night's cheapest
      if (now >= o.release) {
        o.release = now + O.nest.releaseSeconds * SECOND;
        const open = P.roster.filter((r) => r.from <= night && (r.until === undefined || night <= r.until)).sort((a, c) => a.cost - c.cost);
        const u = open[0];
        if (u) run.extras.push(...this.host.spawnHostiles(run.num, [{ ship: u.ship, faction: u.faction, hp: (u.hp ?? 1) * (1 + P.hpPerNight * (night - 1)), range: u.range, aggro: u.aggro }], o.x, o.y, { x: b.x, y: b.y }, run.grade));
      }
    }
    if (now >= o.until) return this.endObjective(run, null);
    this.sendObjective(run, now);
  }

  /** An objective's over: done (paying `by`, the pilots who did it), or lost/gone (null) */
  private endObjective(run: Run, by: PilotConn[] | null): void {
    const o = run.objective;
    if (!o) return;
    run.objective = null;
    run.nextObjective = this.host.tick() + run.profile.objectives.everySeconds * SECOND * (0.7 + Math.random() * 0.6);
    if (o.eid >= 0) this.host.removeHostile(o.eid);
    const pilots = this.host.pilots(run.num);
    for (const p of [...pilots.map((q) => q.conn), ...run.shown.keys()]) this.host.send(p, { type: 'objectiveEnd', id: `moonobj:${run.num}` } as ServerMessage);
    const what = this.t(o.kind === 'nest' ? 'sieges.obj.nest' : 'sieges.obj.cache');
    if (!by) {
      if (run.phase === 'night') for (const p of pilots) this.host.toast(p.conn, this.t('sieges.obj.lost', { what }), 'warn');
      return;
    }
    const O = o.kind === 'nest' ? this.rules.objectives.nest : this.rules.objectives.cache;
    const night = run.wave + run.offset;
    const supplies = Math.round(O.supplies + O.suppliesPerNight * night);
    const credits = Math.round(O.credits * this.host.gradeReward(run.grade) * (1 + night * 0.1));
    run.supplies += supplies;
    for (const c of by) {
      const h = run.haul.get(c);
      if (h) h.credits += credits;
    }
    for (const p of pilots) this.host.toast(p.conn, this.t('sieges.obj.done', { what, supplies, credits }), 'good');
    this.sendState(run, true);
  }

  private sendObjective(run: Run, now: number): void {
    const o = run.objective;
    if (!o) return;
    const O = this.rules.objectives;
    const left = Math.max(0, Math.ceil((o.until - now) / SECOND));
    const msg = o.kind === 'cache'
      ? { type: 'objective', id: `moonobj:${run.num}`, title: this.t('sieges.obj.cache'), text: this.t('sieges.obj.cacheText', { secs: O.cache.holdSeconds, left }),
        meter: { label: this.t('sieges.obj.cacheMeter'), value: Math.round((o.held / (O.cache.holdSeconds * SECOND)) * 100), max: 100 }, at: { x: o.x, y: o.y } }
      : { type: 'objective', id: `moonobj:${run.num}`, title: this.t('sieges.obj.nest'), text: this.t('sieges.obj.nestText', { left }), danger: true,
        meter: { label: this.t('sieges.obj.nestMeter'), value: Math.round((this.host.shipAt(o.eid)?.hull ?? 0) * 100), max: 100 }, at: { x: o.x, y: o.y } };
    for (const p of this.host.pilots(run.num)) this.host.send(p.conn, msg as ServerMessage);
  }

  private dawn(run: Run, pilots: { conn: PilotConn }[]): void {
    run.phase = 'day';
    run.ready.clear();
    run.boss = '';
    // Whatever's out on the moon goes with the dark
    this.endObjective(run, null);
    for (const r of run.extras) this.host.removeHostile(r);
    run.extras = [];
    // Pay goes with how hard the night was: the roster's night, and the moon's grade
    const d = this.rules.dawn;
    const w = run.wave, rw = run.wave + run.offset, gk = this.host.gradeReward(run.grade);
    const xp = Math.round((d.xpBase + d.xpPerNight * rw) * gk), credits = Math.round((d.creditsBase + d.creditsPerNight * rw) * gk), supplies = d.suppliesBase + d.suppliesPerNight * w;
    run.supplies += supplies;
    for (const p of pilots) {
      const h = run.haul.get(p.conn) ?? { xp: 0, credits: 0, nights: 0 };
      h.xp += xp; h.credits += credits; h.nights++;
      run.haul.set(p.conn, h);
      const milestone = h.nights % this.rules.haulBonus.every === 0 ? this.t('sieges.dawnMilestone', { nights: h.nights, bonus: haulBonus(h.nights, this.rules) }) : '';
      this.host.toast(p.conn, this.t('sieges.dawn', { night: w, supplies, credits, milestone }), 'good');
    }
    this.sendState(run, true);
  }

  /** Pay a pilot their haul: in full (with the bonus) when they claim it by day, half otherwise */
  private settle(run: Run, conn: PilotConn, full: boolean): void {
    const h = run.haul.get(conn);
    run.haul.delete(conn);
    if (!h || (!h.xp && !h.credits)) return;
    const k = full ? haulBonus(h.nights, this.rules) : this.rules.partialHaul;
    const xp = Math.round(h.xp * k), credits = Math.round(h.credits * k);
    this.host.reward(conn, xp, credits, `siege:${run.name}`);
    this.host.toast(conn, full
      ? this.t('sieges.claimed', { name: run.name, nights: h.nights, s: h.nights === 1 ? '' : 's', bonus: k > 1 ? this.t('sieges.claimedBonus', { bonus: k }) : '', credits, xp })
      : this.t('sieges.halfSaved', { name: run.name, credits, xp }), full ? 'good' : 'warn');
  }

  /** No longer on the moon: off the ready list, the panel and the banner */
  private forget(run: Run, conn: PilotConn): void {
    run.shown.delete(conn);
    run.ready.delete(conn);
    this.host.send(conn, { type: 'siegeState', active: false } as ServerMessage);
    this.host.send(conn, { type: 'objectiveEnd', id: `moon:${run.num}` } as ServerMessage);
    this.host.send(conn, { type: 'objectiveEnd', id: `moonobj:${run.num}` } as ServerMessage);
  }

  /** By day: take the haul (with its bonus) and go back to orbit; the last one out ends the siege */
  private claim(run: Run, conn: PilotConn): void {
    const me = this.host.pilots(run.num).find((p) => p.conn === conn);
    this.settle(run, conn, true);
    this.forget(run, conn);
    if (me) this.host.toOrbit(conn, run.sys, Math.atan2(me.y, me.x));
    if (!this.host.pilots(run.num).some((p) => p.conn !== conn)) this.close(run);
    else this.sendState(run, true);
  }

  private buy(run: Run, conn: PilotConn, id: string): void {
    const repair = this.rules.repair;
    if (id === repair.id) {
      if (run.supplies < repair.cost) return this.host.toast(conn, this.t('sieges.shortOfSupplies', { cost: repair.cost }), 'warn');
      const worn = [run.bastion, ...run.turrets.map((t) => t?.eid ?? -1)].filter((e) => (this.host.shipAt(e)?.hull ?? 1) < 0.999);
      if (!worn.length) return this.host.toast(conn, this.t('sieges.nothingToPatch'), 'info');
      for (const e of worn) this.host.healStructure(e, repair.heal);
      run.supplies -= repair.cost;
      return this.announce(run, conn, repair.label);
    }
    const kind = id.replace(/^turret_/, '');
    const def = this.rules.turrets[kind];
    if (!def) return;
    const cost = def.marks[0].cost;
    if (run.supplies < cost) return this.host.toast(conn, this.t('sieges.shortOfSupplies', { cost }), 'warn');
    const slot = run.turrets.findIndex((t) => t === null);
    if (slot < 0) return this.host.toast(conn, this.t('sieges.padsFull'), 'warn');
    if (!this.place(run, slot, kind, 0, cost)) return;
    run.supplies -= cost;
    this.announce(run, conn, this.turretName(def.label, 0));
  }

  /** The next mark for the turret on a pad, at full hull */
  private upgrade(run: Run, conn: PilotConn, slot: number): void {
    const t = run.turrets[slot];
    if (!t) return;
    const def = this.rules.turrets[t.kind], next = def.marks[t.mark + 1];
    if (!next) return this.host.toast(conn, this.t('sieges.fullyUpgraded'), 'info');
    if (run.supplies < next.cost) return this.host.toast(conn, this.t('sieges.shortOfSupplies', { cost: next.cost }), 'warn');
    this.host.removeStructure(t.eid);
    run.turrets[slot] = null;
    if (!this.place(run, slot, t.kind, t.mark + 1, t.spent + next.cost)) return;
    run.supplies -= next.cost;
    this.announce(run, conn, this.turretName(def.label, t.mark + 1));
  }

  /** Take a turret down for some of what it cost back (to build something else there) */
  private scrap(run: Run, conn: PilotConn, slot: number): void {
    const t = run.turrets[slot];
    if (!t) return;
    const back = Math.floor(t.spent * this.rules.scrapBack);
    this.host.removeStructure(t.eid);
    run.turrets[slot] = null;
    run.supplies += back;
    this.announce(run, conn, this.t('sieges.scrapped', { turret: this.rules.turrets[t.kind].label.toLowerCase(), back }));
  }

  private place(run: Run, slot: number, kind: string, mark: number, spent: number): boolean {
    const def = this.rules.turrets[kind];
    const b = run.sys.surface!.bastion!, pad = b.slots[slot];
    const eid = this.host.spawnStructure(def.marks[mark].design, run.num, b.x + pad.x, b.y + pad.y, this.turretName(def.label, mark), this.fortGrade(run.grade));
    if (eid < 0) return false;
    this.host.arm(eid, { range: def.range, shot: def.shot, damage: def.damage });
    run.turrets[slot] = { eid, kind, mark, spent };
    return true;
  }

  private announce(run: Run, conn: PilotConn, what: string): void {
    for (const p of this.host.pilots(run.num)) this.host.toast(p.conn, this.t('sieges.announce', { who: this.host.name(conn), what }), 'info');
  }

  /** The banner: the phase, and the bastion's hull */
  private sendBanner(run: Run, now: number): void {
    const b = this.host.shipAt(run.bastion);
    const pilots = this.host.pilots(run.num);
    const left = run.raiders.length + run.stream.length + run.fronts.reduce((n, f) => n + f.ships.length, 0);
    const ready = pilots.filter((p) => run.ready.has(p.conn)).length;
    const dusk = this.rules.duskSeconds * SECOND;
    const text = run.phase === 'day' ? this.t('sieges.banner.day', { day: run.wave + 1, ready, pilots: pilots.length })
      : run.phase === 'dusk' ? this.t('sieges.banner.dusk', { night: run.wave, secs: Math.max(0, Math.ceil((run.next - now) / SECOND)) })
      : run.phase === 'night' ? this.t(run.boss ? 'sieges.banner.nightBoss' : 'sieges.banner.night', { night: run.wave, boss: run.boss, left, s: left === 1 ? '' : 's' })
      : this.t('sieges.banner.lost');
    const night = run.phase === 'night' || run.phase === 'lost' ? 1 : run.phase === 'dusk' ? 1 - Math.max(0, (run.next - now) / dusk) : 0;
    const bs = run.sys.surface!.bastion!;
    const msg = {
      type: 'objective', id: `moon:${run.num}`, title: this.t('sieges.banner.title', { name: run.name }), text,
      meter: { label: this.t('sieges.banner.meter'), value: Math.round((b?.hull ?? 0) * 100), max: 100 },
      danger: run.phase === 'night' || run.phase === 'lost', at: { x: bs.x, y: bs.y }, night: Math.round(night * 20) / 20,
    } as ServerMessage;
    const key = JSON.stringify(msg);
    if (key === run.banner) {
      // Newcomers still need it
      for (const p of pilots) if (!run.shown.has(p.conn)) this.host.send(p.conn, msg);
      return;
    }
    run.banner = key;
    for (const p of pilots) this.host.send(p.conn, msg);
  }

  /** The day's panel, to each pilot on the moon (when something changed, or `force`) */
  private sendState(run: Run, force: boolean): void {
    const pilots = this.host.pilots(run.num);
    const ready = pilots.map((p) => ({ name: this.host.name(p.conn), ready: run.ready.has(p.conn) }));
    const free = run.turrets.filter((t) => t === null).length;
    const turrets = run.turrets.map((t) => {
      if (!t) return null;
      const def = this.rules.turrets[t.kind];
      return {
        label: this.turretName(def.label, t.mark), mark: t.mark + 1, hull: Math.round((this.host.shipAt(t.eid)?.hull ?? 0) * 100),
        upgrade: def.marks[t.mark + 1]?.cost, refund: Math.floor(t.spent * this.rules.scrapBack),
      };
    });
    const every = this.rules.haulBonus.every;
    // By day: whether tonight brings a boss
    const boss = run.phase === 'day' ? siegeBoss(run.profile, run.wave + 1 + run.offset) : null;
    const comingBoss = boss ? this.host.shipName(boss.ship) : undefined;
    for (const p of pilots) {
      const h = run.haul.get(p.conn) ?? { xp: 0, credits: 0, nights: 0 };
      const nextBonusAt = (Math.floor(h.nights / every) + 1) * every;
      const msg = {
        type: 'siegeState', active: true, title: run.name, phase: run.phase, wave: run.wave, supplies: run.supplies,
        profile: { name: run.profile.name, about: run.profile.about }, nextBoss: comingBoss,
        ready, youReady: run.ready.has(p.conn), pads: { free, total: run.turrets.length }, shop: this.shop, turrets,
        haul: { xp: h.xp, credits: h.credits, nights: h.nights, bonus: haulBonus(h.nights, this.rules), nextBonusAt, nextBonus: haulBonus(nextBonusAt, this.rules) },
      } as ServerMessage;
      const key = JSON.stringify(msg);
      if (!force && run.shown.get(p.conn) === key) continue;
      run.shown.set(p.conn, key);
      this.host.send(p.conn, msg);
    }
  }
}
