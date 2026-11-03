/**
 * Siege tuning: the shapes of a moon's siege (profiles, turrets, the shop's
 * prices, the nights' budget) and their defaults, which data/rules.json
 * `sieges` merges over, and the siege's text (data/strings.json overrides).
 */

export const SECOND = 60;
export const BASTION = 'siege_bastion';

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
  /** How it fights (roles/: sapper, runner, artillery, escort), from night `roleFrom` (else from its first) */
  role?: string;
  roleFrom?: number;
}

/** A ship to spawn, tuned */
export interface SiegeSpawn {
  ship: string; faction?: string; hp: number; damage?: number; range?: number; aggro?: number; plating?: number;
  /** Its role (roles/), what it cost from the night's budget (what killing it scores), and whether it's the night's boss */
  role?: string; cost?: number; boss?: boolean;
}

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
  objectives: { from: number; everySeconds: number; kinds: string[]; nest: { design: string; faction: string } };
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
  /** Fortifications are built this many grades better than what comes at them, up to `fortMaxGrade` (0: the same grade; at +1 a moon's turrets held the early nights alone) */
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
  /**
   * At night: building on a pad costs × `buildCost`, from within `buildReach` of it. A pilot staying within `mend.reach`
   * of a damaged turret for `mend.seconds` mends it (+`heal` of its hull for `cost` supplies); the bastion likewise
   * (`bastionMend`). A pilot can mark a hostile for every turret in reach to focus on for `focus.seconds`, once every
   * `focus.cooldownSeconds` for the party.
   */
  night: {
    buildCost: number; buildReach: number;
    mend: { reach: number; seconds: number; cost: number; heal: number };
    bastionMend: { reach: number; seconds: number; cost: number; heal: number };
    focus: { seconds: number; cooldownSeconds: number };
  };
  /**
   * A night's score: each kill's budget cost × `perKill`, each objective, the bastion's hull kept × `hullKept`, and
   * `perfect` for a perfect night (no turret lost, the bastion at `perfectHull` or more). Perfect nights in a row
   * add `streakStep` each to dawn's supplies, up to `streakMax`.
   */
  score: { perKill: number; objective: number; hullKept: number; perfect: number; perfectHull: number; streakStep: number; streakMax: number };
  /** The last stand: the bastion under `below` of its hull at night: kills pay × `killSupplies`, and its first mend of the night is free */
  breach: { below: number; killSupplies: number };
  /** Bigger parties: a front more for every `frontPer` pilots past the first, and `streamPerPilot` more of the night streams in */
  party: { frontPer: number; streamPerPilot: number };
}

export const DEFAULT_SIEGE_RULES: SiegeRules = {
  duskSeconds: 6,
  emptySeconds: 60,
  lostSeconds: 12,
  startSupplies: 150,
  killSupplies: 4,
  fortGradeBonus: 0,
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
        { ship: 'scrap_crawler', cost: 3, from: 2, role: 'sapper', roleFrom: 4 },
        { ship: 'scrap_swarmer', cost: 2, from: 3, group: 3, role: 'runner' },
        { ship: 'scrap_hulk', cost: 6, from: 4, hp: 1.6 },
        { ship: 'pirate_skiff', cost: 2, from: 5 },
        { ship: 'scrap_lobber', cost: 5, from: 6, range: 1350, aggro: 2600, role: 'artillery' },
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
        { ship: 'scrap_lobber', cost: 5, from: 3, range: 1350, aggro: 2600, role: 'artillery' },
        { ship: 'frost_bulwark', cost: 7, from: 4, hp: 1.5, role: 'escort' },
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
        { ship: 'cinder_zealot', cost: 4, from: 1, role: 'runner', roleFrom: 2 },
        { ship: 'scrap_hulk', cost: 6, from: 3, hp: 1.6 },
        { ship: 'pirate_raider', cost: 3.5, from: 4 },
        { ship: 'cinder_brand', cost: 9, from: 6 },
        { ship: 'scrap_lobber', cost: 5, from: 7, range: 1350, aggro: 2600, role: 'artillery' },
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
        { ship: 'scrap_lobber', cost: 5, from: 4, range: 1350, aggro: 2600, role: 'artillery' },
        { ship: 'scrap_hulk', cost: 6, from: 4, hp: 1.6 },
        { ship: 'pirate_gunship', cost: 8, from: 1 },
        { ship: 'cinder_brand', cost: 10, from: 3 },
        { ship: 'maw_lurker', cost: 9, from: 2, role: 'sapper' },
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
        { ship: 'scrap_lobber', cost: 4, from: 2, range: 1350, aggro: 2600, role: 'artillery' },
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
  wave: { base: 5, perWave: 4.5, perWave2: 0.18, solo: 0.7, perPilot: 0.3, leanChance: 0.55, leanSpread: 3, maxPicks: 90 },
  objectives: {
    distance: [2600, 4800],
    cache: { holdSeconds: 8, radius: 330, lifeSeconds: 75, supplies: 45, suppliesPerNight: 6, credits: 12 },
    nest: { hp: 1, lifeSeconds: 120, releaseSeconds: 7, supplies: 70, suppliesPerNight: 8, credits: 25 },
  },
  dawn: { xpBase: 25, xpPerNight: 20, creditsBase: 8, creditsPerNight: 6, suppliesBase: 60, suppliesPerNight: 12 },
  partialHaul: 0.5,
  night: {
    buildCost: 1.5, buildReach: 450,
    mend: { reach: 300, seconds: 3, cost: 20, heal: 0.15 },
    bastionMend: { reach: 560, seconds: 5, cost: 45, heal: 0.1 },
    focus: { seconds: 8, cooldownSeconds: 20 },
  },
  score: { perKill: 10, objective: 50, hullKept: 100, perfect: 100, perfectHull: 0.9, streakStep: 0.1, streakMax: 0.5 },
  breach: { below: 0.3, killSupplies: 2 },
  party: { frontPer: 2, streamPerPilot: 0.05 },
};

/** The turrets as built in (data/rules.json can change them for a server) */
export const SIEGE_TURRETS: Record<string, SiegeTurretDef> = DEFAULT_SIEGE_RULES.turrets;

export const MARKS = ['I', 'II', 'III'];
export const DEG = Math.PI / 180;
/** A front is seen coming this long before it arrives */
export const FRONT_WARN = 4 * 60;

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
  'sieges.banner.breach': 'Night {night} · LAST STAND · {left} hostile{s} left',
  'sieges.padTaken': 'Pad {pad} already has a turret',
  'sieges.tooFarToBuild': 'Fly to pad {pad} to build there at night',
  'sieges.nightBuild': '{turret} on pad {pad} (night price)',
  'sieges.onlyByDay': 'Only by day',
  'sieges.mended': '{what} mended (+{heal}%, {cost} supplies)',
  'sieges.mendedFree': '{what} patched (last stand: free)',
  'sieges.mendShort': 'Not enough supplies to mend ({cost} needed)',
  'sieges.focus': '{who} marked a target: turrets in reach focus on it',
  'sieges.focusWait': 'Focus fire is ready in {secs}s',
  'sieges.focusBad': 'Target a hostile first (Tab, or T on one)',
  'sieges.orders': '{turret} on pad {pad}: {orders}',
  'sieges.turretLost': '{turret} on pad {pad} destroyed',
  'sieges.breach': 'The bastion is under 30%: last stand. Kills pay double, and its first mend tonight is free',
  'sieges.perfect': 'Perfect night: {streak} in a row, +{bonus}% supplies at dawn',
  'sieges.orders.nearest': 'Nearest',
  'sieges.orders.bastion': 'Closest to the bastion',
  'sieges.orders.toughest': 'Toughest first',
  'sieges.orders.fastest': 'Fastest first',
  'sieges.role.sapper': 'Sapper',
  'sieges.role.sapperNote': 'goes for your turrets, nearest first',
  'sieges.role.runner': 'Runner',
  'sieges.role.runnerNote': 'ignores pilots and dives at the bastion',
  'sieges.role.artillery': 'Artillery',
  'sieges.role.artilleryNote': 'shells the bastion from long range',
  'sieges.role.escort': 'Escort',
  'sieges.role.escortNote': "guards its front's biggest ship",
};

