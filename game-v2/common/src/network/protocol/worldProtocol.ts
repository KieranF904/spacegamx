/**
 * @contract protocol.world
 * owns:       station fire, boss, world-event, objective, siege and combat-effect server messages
 * needs:      nothing beyond type imports
 * invariants: message shapes are the wire contract — serverMessages.json
 * extend:     a new world-event message is an interface here and a line in serverMessage.ts
 */
export interface ServerStationFireMessage {
  type: 'stationFire';
  station: number;
  target: number;
  /** Which of its turrets */
  turret?: number;
}

/** A boss is engaged for the first time: title card */
export interface ServerBossIntroMessage {
  type: 'bossIntro';
  bodyId: number;
  name: string;
  title: string;
  text: string;
}

/** A boss is charging a nova (a ring of `kind` shots in `ticks`) */
export interface ServerBossChargeMessage {
  type: 'bossCharge';
  bodyId: number;
  kind: string;
  ticks: number;
}

/**
 * A boss's warning of what's coming, shown for `ticks` and brightening to the
 * moment it lands: a line (a charge's path, a dash, a beam's start) from
 * (x, y) along `angle` for `length`, `width` across; or a circle (where a
 * shell comes down) of `radius` at (x, y). With `bodyId` it rides that body:
 * (x, y) is an offset in its own frame (world units, its nose along +x) and
 * `angle` is from its heading.
 */
export interface ServerBossTelegraphMessage {
  type: 'bossTelegraph';
  shape: 'line' | 'circle';
  x: number;
  y: number;
  angle?: number;
  length?: number;
  width?: number;
  radius?: number;
  ticks: number;
  bodyId?: number;
  /** 'charge' (red: get out of the way), 'lance' (red: a beam gathering), 'dash' (orange: where it's going), 'impact' (shells landing), 'magma' (a ball swelling on a turret: x, y on the body) */
  kind: string;
}

/**
 * A boss's sweeping beam: from (x, y) on the body (its own frame, world units,
 * nose along +x), turning from `a0` to `a1` (radians from its heading) over
 * `ticks`, `length` long and `width` wide
 */
export interface ServerBossBeamMessage {
  type: 'bossBeam';
  bodyId: number;
  x: number;
  y: number;
  a0: number;
  a1: number;
  ticks: number;
  length: number;
  width: number;
  /** 'crystal' (white-hot: the Pyreclast's heart); absent, a molten lance */
  kind?: string;
}

/** A boss blows away what was under one of its parts (`part`: a skeleton's piece under it), one after another between stages */
export interface ServerBossBlowMessage {
  type: 'bossBlow';
  bodyId: number;
  part: number;
}

/** A boss entered a new phase */
export interface ServerBossPhaseMessage {
  type: 'bossPhase';
  bodyId: number;
  phase: number;
  text: string;
}

/** Something is happening in this system (a raid, a wreck): announce it and mark it */
export interface ServerWorldEventMessage {
  type: 'worldEvent';
  id: number;
  kind: 'raid' | 'salvage' | 'warband' | 'peak';
  title: string;
  text: string;
  x: number;
  y: number;
  /** Seconds until it's over at the latest */
  seconds: number;
}

export interface ServerWorldEventEndMessage {
  type: 'worldEventEnd';
  id: number;
}

/** An objective banner for pilots in a system (a planet's siege): replaces any earlier one with the same id */
export interface ServerObjectiveMessage {
  type: 'objective';
  id: string;
  title: string;
  text: string;
  /** A bar under it (pylons standing, the structure's hull) */
  meter?: { label: string; value: number; max: number };
  /** Shown in red: fighting is on */
  danger?: boolean;
  /** Where it's happening (a nav marker) */
  at?: { x: number; y: number };
  /** How dark it is (0 day .. 1 night): a moon siege's nights */
  night?: number;
}

/** A moon siege's day panel (Sieges.ts): supplies, the shop, who's ready */
export interface ServerSiegeStateMessage {
  type: 'siegeState';
  active: boolean;
  title?: string;
  phase?: 'day' | 'dusk' | 'night' | 'lost';
  wave?: number;
  supplies?: number;
  ready?: { name: string; ready: boolean }[];
  youReady?: boolean;
  pads?: { free: number; total: number };
  shop?: { id: string; label: string; cost: number; note: string }[];
  /**
   * What's built on each pad (null: empty), with what upgrading costs (absent: top mark) and what scrapping it gives
   * back; its kind, reach and target orders, its kills tonight, and how far a pilot holding at it has got mending it (0..1)
   */
  turrets?: ({ label: string; mark: number; hull: number; upgrade?: number; refund: number; kind?: string; range?: number; orders?: string; kills?: number; mend?: number } | null)[];
  /** Your haul so far, paid out when you claim and leave by day (half, with no bonus, if you leave any other way or the bastion falls) */
  haul?: { xp: number; credits: number; nights: number; bonus: number; nextBonusAt: number; nextBonus: number };
  /** This moon's siege, and (by day) the boss tonight brings */
  profile?: { name: string; about: string };
  nextBoss?: string;
  /** The target orders a turret can be given */
  orders?: { id: string; label: string }[];
  /** Fronts on their way tonight (from dusk): where they land, the server tick they land at, how many ships, a boss among them */
  incoming?: { x: number; y: number; at: number; ships: number; boss?: boolean }[];
  /** Tonight (from dusk): which night, its boss, the kinds new tonight, the roles some of tonight's ships play (`id`: sapper, runner...) */
  tonight?: { night: number; boss?: string; newKinds: string[]; roles: { id?: string; name: string; ship: string; note: string }[] };
  /** The bastion's hull (%), hostiles still to beat tonight, and under 30%: the last stand (kills pay double, one free patch) */
  bastion?: number;
  left?: number;
  breach?: boolean;
  /** Pads whose turret was shot down tonight (scorched) */
  padsLost?: number[];
  /** Tonight's score so far, perfect nights in a row, the best night's score this siege */
  score?: { night: number; streak: number; best: number };
  /** Dawn: the night just held (sent by day until the next dusk) */
  summary?: {
    night: number; kills: number; yourKills: number; turretKills: number; mvp?: { label: string; kills: number }; hullLost: number;
    turretsLost: number; objectives: number; supplies: number; streakBonus: number; perfect: boolean; streak: number; score: number; best: boolean;
  };
  /** Focus fire: the tick it can be used again, the hostile the turrets are on and until when */
  focus?: { readyAt: number; target?: number; until?: number };
  /** At night: building costs × buildCost within buildReach of the pad; holding still within mendReach of a damaged turret (or the bastion) mends it */
  night?: { buildCost: number; buildReach: number; mendReach: number; mendSeconds: number; mendCost: number; mendHeal: number; bastionReach: number; bastionCost: number; bastionHeal: number };
  /** Mending the bastion: how far a pilot holding at it has got (0..1) */
  bastionMend?: number;
}

export interface ServerObjectiveEndMessage {
  type: 'objectiveEnd';
  id: string;
}

/** A boss died */
export interface ServerBossDefeatedMessage {
  type: 'bossDefeated';
  bodyId: number;
  name: string;
  x: number;
  y: number;
}

/** A ship's part caught fire (incendiary hit): flames for `ticks` */
export interface ServerIgniteMessage {
  type: 'ignite';
  bodyId: number;
  part: number;
  ticks: number;
  /**
   * A spreading fire's (a Burn modifier's, ships/fire.ts): its generation + 1 (1: the shot's own fire; 2 and up: one
   * that spread from a part beside it, or burned on past its time). Absent on any other fire
   */
  gen?: number;
}

/**
 * Point defence (common/src/ships/support.ts) fired: part `part` of ship `bodyId` (its muzzle at fx, fy) hit shot
 * `proj` at (x, y); `down`: that brought it down (it's gone, its warhead never went off). Sent as a plain message (no
 * compact row: the wire tables are unchanged).
 */
export interface ServerInterceptMessage {
  type: 'intercept';
  bodyId: number;
  part: number;
  proj: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  down: boolean;
}

/** A warhead went off (flak burst, missile, EMP): for effects */
export interface ServerDetonationMessage {
  type: 'detonation';
  kind: string;
  x: number;
  y: number;
  radius: number;
  /** Lightning: where it leapt from */
  from?: [number, number];
  /** A mob's burst: which kind (data/mobs.json) */
  mob?: string;
  /**
   * A blast where a shot left a hull it went right through (a weapon modifier's piercing shot with a blast: server
   * game/Weapons.ts, bridge/beamFx.ts): the shot's heading there, whole degrees 0..359. Absent on every other detonation
   */
  out?: number;
}

/**
 * A ship part was destroyed. `how`: 'blast' = it blew up (size = blast radius),
 * 'break' = shot or crushed apart, 'crumble' = a loose part decaying (size = part size).
 * `vx, vy` is the body's velocity, so fragments fly on with it.
 */
export interface ServerPartDestroyedMessage {
  type: 'partDestroyed';
  bodyId: number;
  part: number;
  fn: string;
  how: 'blast' | 'break' | 'crumble';
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
}

/** Two bodies collided at (x, y) along normal (nx, ny), closing at `speed` units per tick */
export interface ServerContactMessage {
  type: 'contact';
  x: number;
  y: number;
  nx: number;
  ny: number;
  speed: number;
}

