/**
 * Modular ship data types.
 *
 * Grid space: one unit = one cell, x right, y down (same as the engine).
 * A ship's forward direction is -y in grid space.
 */

export type Vec2 = [number, number];

/** Arc angles are in degrees, measured like Math.atan2 in y-down space (0 = +x, 90 = +y). */
export type Segment =
  | { type: 'line'; a: Vec2; b: Vec2 }
  | { type: 'arc'; c: Vec2; r: number; a0: number; a1: number };

export type Side = 'N' | 'E' | 'S' | 'W';
/** 'NW' is the "\" diagonal (NW corner to SE corner), 'NE' is the "/" diagonal (SW corner to NE corner). */
export type Diag = 'NE' | 'NW';

export type Connector =
  | { cell: Vec2; side: Side }
  | { cell: Vec2; diag: Diag };

/** data/ships/pieces.json: geometry only */
export interface PieceDef {
  id: string;
  cells: Vec2[];
  outline: Segment[];
  connectors: Connector[];
  tier: number;
  /** Share of a collision's damage a part of this shape takes (a wedge nose turns blows aside); default 1 */
  contact?: number;
  /**
   * A bespoke piece (data/ships/bespoke): one design's own hull shape, any
   * polygon, off the grid. Its cells are worked out from its shape, it joins
   * whatever it touches (grid.ts computeJoins), and it never goes in a
   * player's design.
   */
  bespoke?: boolean;
  /** Bespoke pieces that point out (engines, weapons, bays): see PieceMount */
  mount?: PieceMount;
  /** Bespoke pieces: how it's drawn (look only): its relief, its turret's size (cells), the detail on it */
  relief?: PieceRelief;
  turret?: number;
  detail?: PieceDetail[];
  /** Look only (a bespoke hull's core): the metal frame under the whole hull, seen where parts are gone */
  frame?: PieceFrame;
  /**
   * Look only: drawn as this skeleton (lit geometry, client ships/skeletonBuild.ts) under the hull instead of as hull
   * plating (a boss's skeleton, seen as its carapace comes off)
   */
  skeleton?: PieceSkeleton;
  /**
   * Beneath the rest (a boss's next stage, hidden under the hull it has now): drawn first, and while a part over it
   * still covers it, what would hurt it hurts that instead
   */
  under?: boolean;
  /**
   * Which of a boss's stages it belongs to (1 its first, outermost: what comes off first). While any part of an
   * earlier stage still stands, what would hurt a later stage's part hurts the nearest part of the earliest one
   * standing instead (ShipBridge.hurt)
   */
  stage?: number;
  /** Worn out, it isn't lost: it stays on, ruined (stages.ts RUIN_HP), shots passing it by, until its boss blows its stage away */
  ruin?: boolean;
}

/**
 * How a bespoke piece stands: a raised plate (default), sunk into the hull, a
 * crystal (faces meeting along its length), or a plate of armour laid over
 * others (overhanging them: it casts a shadow on them and shows its thickness)
 */
export type PieceRelief = 'raise' | 'recess' | 'ridge' | 'plate' | 'round';

/**
 * Look-only detail on a bespoke piece (drawn with it, hurt with it, gone with
 * it; never hit, never weighed). Points in the same grid units as its piece.
 *   raise   a plate standing proud of it (`poly`)
 *   recess  sunk into it (`poly`): dark, its walls lit from inside
 *   vent    a recess with `fins` across it and a glowing floor (`poly`)
 *   channel a narrow recessed groove, glowing along its floor (`poly`)
 *   shard   a crystal from `at` out along `dir`, `r` long and `w` wide, two faces meeting along its ridge
 *   ring    a raised ring round `at`, `r` out and `w` wide (`sides`: 6 a hex, else round)
 *   glow    light round `at`, `r` out (`sides` as ring): `color` at its rim, white-hot at its middle
 *   nozzle  a drive's mouth at `at`, `r` across: a housing, rings within, light deep inside
 *   bell    a drive's bell: its mouth at `at`, `r` across, its housing `w` long back from it against `dir`
 *   vein    a vein of light along the path `poly`, `w` wide at its root, tapering
 *   halo    a thin ring of light round `at`, `r` out and `w` wide (`sides`: 8 an octagon)
 */
export interface PieceDetail {
  kind: 'raise' | 'recess' | 'vent' | 'channel' | 'shard' | 'ring' | 'glow' | 'nozzle' | 'vein' | 'halo' | 'bell' | 'cable' | 'beam';
  poly?: Vec2[];
  at?: Vec2;
  dir?: Vec2;
  r?: number;
  w?: number;
  sides?: number;
  fins?: number;
  /** '#rrggbb': the detail's own colour (default: its piece's) */
  color?: string;
  /** Crystal (shards, ridges): its look */
  crystal?: boolean;
}

/**
 * Where a bespoke piece points out of (a grid piece has its `facing` edge
 * instead): the middle of its business edge, the way out (any direction), and
 * how wide that edge is (cells; default 1)
 */
export interface PieceMount { at: Vec2; dir: Vec2; width?: number }

/** data/ships/bespoke/*.json: a design's own pieces, each a polygon (grid units, y down) and maybe a mount */
/** A hull's frame (cells, in the ship's own frame): girders (x0, y0, x1, y1, width) and the gussets where they meet (x, y, size) */
export interface PieceFrame {
  beams: [number, number, number, number, number][];
  nodes: [number, number, number][];
}

/**
 * A skeleton (cells, the ship's own frame): its rim (a loop round its outline, `rimW` wide), its bones (each a line of
 * points and its width at each; layer 0 the main frame, 1 the finer one beneath; `lava`: a channel of it down the bone),
 * and its inner workings beneath them
 */
export interface PieceSkeleton {
  rim: Vec2[];
  rimW: number;
  bones: { pts: Vec2[]; w: number[]; layer: 0 | 1; lava?: boolean }[];
  /** Its frames cast whole (the bones closed into one plate each, as designed): each an outline and the holes in it */
  plates?: { layer: 0 | 1; outer: Vec2[]; holes: Vec2[][] }[];
  parts: SkeletonPart[];
  /** Its colours ('#rrggbb'; each absent, the Pyreclast's): its bones, the finer frame, its workings and their edges, bolts, what glows */
  palette?: { bone?: string; fine?: string; part?: string; edge?: string; bolt?: string; hot?: string; hotCore?: string };
}
export type SkeletonPart =
  | { kind: 'pipe'; pts: Vec2[]; w: number; glow?: boolean }
  | { kind: 'cable'; pts: Vec2[]; w: number }
  | { kind: 'drum'; at: Vec2; r: number }
  | { kind: 'coil'; a: Vec2; b: Vec2; amp: number; turns: number }
  | { kind: 'rack'; poly: Vec2[]; pods: Vec2[]; r: number }
  | { kind: 'fins'; poly: Vec2[]; n: number };

export interface BespokeFile {
  pieces: { id: string; polygon: Vec2[]; mount?: PieceMount; contact?: number; relief?: PieceRelief; turret?: number; detail?: PieceDetail[]; frame?: PieceFrame; skeleton?: PieceSkeleton; under?: boolean; stage?: number; ruin?: boolean }[];
}

export type FunctionId = string;

/** data/ships/functions.json */
export interface FunctionDef {
  id: FunctionId;
  /** A mining beam that draws gas from gas pockets (and nothing from rock) */
  siphon?: boolean;
  /** which pieces may take this function */
  pieces: string[] | '*';
  /** Only the game's own ships carry it ('boss', or a faction's id): never in a player's design, never salvaged, never an item */
  exclusive?: string;
  /** Launch bays: what they launch (data/mobs.json), how many a wave, and ticks between waves */
  launches?: { mob: string; count: number; every: number };
  /** What a boss's brain does with it (server/src/game/brains): 'lance', 'mortar', 'vent'... */
  ability?: string;
  /** Dash coils: the burst of speed a dash gives (world units a tick, before the ship's mass share), and ticks to recharge */
  dash?: { speed: number; cooldown: number };
  hpScale: number;
  /** Armour it adds over its material's (armour plate: 1): see damage.ts */
  armour?: number;
  /** Mass × this (armour plate is heavy) */
  massScale?: number;
  /** (Unused since power runs along wires, wires.ts: kept in the data for old tools) */
  carriesFlow?: boolean;
  /** per unit of area (generators) */
  produce?: number;
  demand?: number;
  priority?: 1 | 2 | 3;
  /** (Unused: conduits are plain structure now that power runs along wires) */
  loss?: number;
  /** per unit of area, pushes opposite to `facing` */
  thrust?: number;
  /** Engines: how much harder they push while boosting (× thrust), and how fast that drains the boost battery (× the usual) */
  boost?: number;
  boostDrain?: number;
  /**
   * Energy routing (docs/design/energy-routing-impl.md §2.4; read from P1, power/layout.ts), per unit of area, scaled
   * like `demand`. Engines and Burst Strafers: E a second their own buffer refills at. Stores: their Takes, the most E a
   * second they accept (with `store` their Holds and `discharge` their Gives)
   */
  intake?: number;
  /** Energy routing: an engine's or Burst Strafer's own buffer, E per unit of area (it burns `demand`, boosted as today) */
  buffer?: number;
  /** ticks (weapons) */
  fireInterval?: number;
  /** Weapon models: its firing model and its numbers (guns.ts stepGuns; docs/design/rework-2026-11.md §3). Legacy guns: none (rebuild.ts fireOf) */
  fire?: FireSpec;
  /** cargo space per unit of area (cargo holds) */
  capacity?: number;
  /** Jump coils: cells of hull each cell of coil serves (flight.ts jumpDriveStats; better grades a little more) */
  jumpCapacity?: number;
  /** scan range in world units (scanners) */
  range?: number;
  /**
   * Burst Strafer (ships/features/strafer/strafer.ts): a dodge, pushing away from its nozzle. `kick` its push per cell while a burst
   * runs (force, as an engine's thrust), `ticks` how long a burst lasts, `cooldown` ticks from one burst's start to
   * the next. It draws its `demand` per cell a second while a burst runs, from the bank it touches first
   */
  strafe?: { kick: number; ticks: number; cooldown: number };
  /** Tow Beam (ships/features/tow/tow.ts): latches onto a wreck, debris or a pod and pulls it on a tether; draws its `demand` while towing */
  tow?: boolean;
  /** Gyro (ships/features/gyro/gyro.ts): turning torque per unit of area, both ways, wherever it sits; draws its `demand` per cell a second turning flat out, less turning gently */
  gyro?: number;
  /** weapons: which weapon this is (data/ships/tuning.json weapons.<kind>) */
  weapon?: string;
  /**
   * Weapon models: how it's mounted, its own and not the pilot's choice ('fixed' fires out of its facing, aimed with
   * the ship; 'turret' aims within a window). A placed part's `mount` counts only where this is absent (legacy
   * graded weapons, enemies' and bosses'): see blueprint.ts partMount.
   */
  mount?: Mount;
  /**
   * Weapon models: how it may be fitted (ships/mounting.ts, docs/parts-redesign.md §Mounting). Absent: unrestricted
   * (legacy weapons, enemies' and bosses'). Read it through mountingOf, which fills in the defaults.
   */
  mounting?: MountingRules;
  /** shield capacity per unit of area (shield generators) */
  shield?: number;
  /**
   * Shield generators: points a second each cell of it puts back, and the ticks a hit holds that back. Absent: the
   * ship-wide tuning.json `shield` (a share of the part's own capacity a second, after its delay). 0: none (a Flash Screen)
   */
  shieldRegen?: number;
  shieldDelay?: number;
  /** Flash Screen (ships/features/flash): no slow regen; when the shield breaks it comes back whole after a wait, or at once for 4 E a point from a Capacitor bank touching it */
  flash?: boolean;
  /** Plating: × the damage a blast does to it (0.5: half of the splash). Hits and beams are unchanged */
  splashTaken?: number;
  /** Jump coils: × the jump drive's cooldown (0.8: 20% faster). The best one a ship has counts; they do not stack */
  jumpCooldown?: number;
  /** battery capacity per unit of area (batteries; × the material's output): energy.ts */
  store?: number;
  /** A bank member's kind: 'drive' a Drive Cell (feeds engines and strafers it touches); else a Capacitor. A store that isn't a bank member is a pool battery, whatever this says (legacy drive and weapon batteries) */
  pool?: 'drive' | 'weapon';
  /** The most a store gives a second, per unit of area (× its output): past it the ship browns out (circuits.ts; absent: tuning energy.discharge by kind) */
  discharge?: number;
  /** A bank member (with `pool: 'drive'` a Drive Cell, else a Capacitor): touching ones of a kind make one bank, which feeds the consumers of its kind it touches first (circuits.ts) */
  bank?: boolean;
  /** A bank charger (the Pulse Dynamo): energy a second it puts into each bank it touches (× its health), never along wires (circuits.ts) */
  dynamo?: number;
  /** Must point a facing edge out (engines and weapons do anyway: this is for the rest, e.g. mining lasers) */
  facing?: boolean;
  /**
   * Energy routing (docs/design/energy-routing-impl.md §1.1; power/layout.ts): a Diode. A relay that passes power one
   * way only, out of its `facing` edge into the part across it; every other part touching it may only feed it
   */
  oneWay?: boolean;
  /**
   * Energy routing (§1.3 step 6; power/layout.ts): a pass-through relay (the Conduit, and a Diode implicitly): a
   * Pulse Dynamo never tops it up. Data sets it from P4
   */
  relayOnly?: boolean;

  // The ports energy core (power/ports.ts; docs/design/energy-ports-2026-11.md), for ships whose blueprint says `power: 'ports'`
  /** Its power ports, in its own frame (N the nose, `cell` the index along that side, `rate` E a second): power crosses only out → in over a shared edge */
  ports?: { dir: 'in' | 'out'; side: Side; cell?: number; rate: number }[];
  /** Weapons: the shape of its draw. `passive` E/s leaked while held, `discharge`/`rest` s its ports shut after a shot / a burst, `burst` lights only when full, `steady` its floor: the E/s its lines must deliver while it fills, or what it gathered collapses */
  profile?: { passive?: number; discharge?: number; rest?: number; burst?: boolean; steady?: number };
  /**
   * Weapons, ports ships: a second input with its own buffer (docs/design/energy-ports-2026-11.md section 17). It fires
   * without it; a shot fired while this buffer holds `cost` E (a beam: `cost` E a second while it burns) is augmented:
   * `mods` on top of its own, and a beam's dps x `mods.mul.dps`. Its port is at `side`/`cell` in the gun's frame, taking at
   * most `rate` E/s; `floor` E/s it must be fed while it fills or it collapses; it holds `buffer` shots (a beam: seconds)
   */
  augment?: { name: string; say: string; side: Side; cell?: number; rate: number; floor?: number; cost: number; buffer?: number; mods: WeaponMods };
  /** Feed layer: a tank of one material (tuning.json feeds), `holds` units per cell */
  tank?: { feed: string; holds: number };
  /** Feed layer: where its pipes join, in its own frame (a tank's, a pipe's, a Passthrough's; a Selector's are its two inputs then its output) */
  feedPoints?: { side: Side; cell?: number }[];
  /** Feed layer: a Selector (switches which of its two inputs reaches its output), a plain pipe, a Combiner (puts its network's material onto its power line), a Passthrough (a conduit a pipe crosses) */
  selector?: boolean;
  pipe?: boolean;
  combiner?: boolean;
  pipeThrough?: boolean;
  /** Feed layer, guns and engines: the materials it takes (its feed buffer holds one at a time), units a shot or a second, its buffer in units (absent: 10 uses), and its own multipliers over the material's */
  takes?: string[];
  feedUse?: number;
  feedBuf?: number;
  feedMods?: Record<string, Record<string, number>>;
  /** Weapons, ports ships: its role in arming a ship (simple: runs off a reactor; dual: the same, and an augment input that makes it something more; heavy and super: a floor that only heavy infrastructure meets), its draw there (E/s; absent: its demand) and its damage x */
  infra?: { tier: 'simple' | 'dual' | 'heavy' | 'super'; damage: number; draw?: number };
  /** Feed layer: its own feed input beside its power input (a pipe joins it there); `required`: it does nothing without material */
  feedPort?: { side: Side; cell?: number; required?: boolean };
  /** A mining laser (a beam that cuts rock while the pilot mines): `miner` itself, and the models of its family */
  mining?: boolean;

  // Models (docs/parts-redesign.md §1): fixed named modules, each its own piece(s), material and numbers
  /** A player model: in the hangar palette, fabricated from its own recipe (data/ships/models.json) */
  model?: boolean;
  /** Its family (cannon, ion...): the palette's grouping and what legacy parts become */
  family?: string;
  /** The material it's built of: its HP, mass and resistances (never a stat multiplier) */
  material?: string;
  /** Its tech tier 1..5: penetration, armour, kill pay and build points, in place of its material's grade */
  grade?: number;
  /** Build points per cell (in place of GRADE_BUILD_COST) */
  points?: number;
  /** The pilot level it's learned at (a weapon never earlier; the boss legendaries are gated by their artefact, in the recipe) */
  unlock?: { level: number };
  /** Weapons: its own changes to its kind's tuning, applied before gems (launch.ts gunDef) */
  weaponMods?: WeaponMods;
  /** Engines: the speed (world units a tick) its thrust fades out towards (flight.ts) */
  rated?: number;
  /** What it does when destroyed (in place of tuning.json partBlast by function id; absent: it just breaks) */
  blast?: { radius: number; damage: number; delayTicks: number[] };
  /** The old material-graded functions: enemies' ships and migration only, never shown, fabricated or an item */
  legacy?: boolean;

  // Presentation (how the part is named, shown and heard; none of it changes what it does)
  /** Display name ("Pulse Laser"); item names are "<Material> <name> · <size>" */
  name?: string;
  /** Item rarity of its parts (default common) */
  rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  /** Item description of its parts */
  description?: string;
  /** Fabricator tab: weapons, power, engines, shields, utility, core; structure isn't fabricated */
  category?: string;
  /** Order within its fabricator tab */
  fabOrder?: number;
  /** Part colour in the hangar and on ships ('#rrggbb') */
  color?: string;
  /** Glow colour of its hardware (charge cells, engine bells, weapon emitters) */
  glow?: string;
  /** Which hardware is drawn on it (client/src/ships/partDecor.ts DECOR_SHAPES): none, battery, ion, afterburner, plasma, miner, cannon, flak, laser, railgun, lance, missile, emp, exotic */
  decor?: string;
  /** Weapons: the sound of a shot (client/src/audio), and of a turret's shot if different */
  sfx?: string;
  sfxTurret?: string;
  /** Beam weapons: the loop that plays while firing */
  sfxLoop?: string;
  /** The field guide's parts gallery: its short name, a line on what it's for, the piece pictured (default sq), and its place */
  guide?: { name: string; blurb: string; piece?: string; order: number };
}

export type TraitId = string;

/** data/ships/materials.json */
export interface MaterialDef {
  id: string;
  /** Display name (Alloy, Steel...) */
  name?: string;
  /** Only the game's own ships are made of it ('boss', or a faction's id): never a pilot's, never an item */
  exclusive?: string;
  /** Mk I-V (ships/grades.ts); default 1 */
  grade?: number;
  /** Weapon damage, generator power and shield strength multiplier; graded parts draw that much more power too. Default 1 */
  output?: number;
  color: string;
  density: number;
  toughness: number;
  /** What it is (ships/hazards.ts MATERIAL_TRAITS): heavy, brittle, conductive... */
  traits?: TraitId[];
  /** Hazard tolerance (0-5) a hull made wholly of it has; a ship's is the share of its cells (rebuild.ts makeup) */
  hazards?: Record<string, number>;
  /** The share of cold it keeps out (0..1; warmth.ts): a hull wholly of it builds up cold that much slower */
  insulation?: number;
  /** The share of each damage type it takes (damage.ts: 0.6 shrugs much of it off, 1.3 takes more); absent: 1 */
  resist?: Partial<Record<'kinetic' | 'explosive' | 'thermal' | 'energy' | 'cryo' | 'exotic', number>>;
}

export type Rot = 0 | 1 | 2 | 3;

/** a saved ship */
export interface Blueprint {
  name: string;
  catalogVersion: number;
  parts: PlacedPart[];
  /** Hull paint (#rrggbb): tints the hull and armour */
  paint?: string;
  /** Engine output, 0.1..1 (default 1): worn-out drives, like the Scrapborn's. Never more than 1 in a design (parseBlueprint); only a boss the server builds (bosses.json `speed`) runs hotter, up to MAX_DRIVE. */
  drive?: number;
  /**
   * A boss's turning (bosses.json `turn`, only on a design the server builds): its turning acceleration × this, and it
   * turns as a big hull should, braking in time to stop on its heading (flight.ts) rather than overshooting
   */
  turn?: number;
  /**
   * Flies as built whatever comes off (a boss's: its mass, centre, inertia, reach and engines are its whole design's
   * throughout, its brain changing how it flies by stage): so its hull, drawn once, never moves about its centre
   */
  rigid?: boolean;
  /**
   * Power wires (wires.ts): segments between neighbouring grid cells (8-neighbour), each end a cell's integer
   * coordinates. Absent: auto-wired (wires.ts autoWire), as enemies' ships and old designs are
   */
  wires?: WireSeg[];
  /** 'ports': runs on the ports energy core (power/ports.ts): power crosses between parts only through their ports, no wires. Absent: the pool and banks (energy.ts) */
  power?: 'ports';
}

/** A wire segment: from cell (x0, y0) to the neighbouring cell (x1, y1) */
export type WireSeg = [number, number, number, number];

export interface PlacedPart {
  /** 0..255, unique within the blueprint */
  uid: number;
  piece: string;
  fn: string;
  material: string;
  /** origin cell */
  x: number;
  y: number;
  rot: Rot;
  flip: boolean;
  /** thrusters and weapons: the free edge they point out of */
  facing?: Side;
  /**
   * Legacy weapons (enemies', bosses'): 'fixed' fires straight out of `facing`; 'turret' aims within a window around
   * it. Default 'fixed'. A model weapon's mount is its model's (FunctionDef.mount): this is ignored, and dropped when
   * the design is parsed. Read it through partMount.
   */
  mount?: Mount;
  /** weapons: changes to its kind's tuning that this one gun carries (gems, ammunition: launch.ts WeaponMods). Set by the server, never by a design. */
  mods?: WeaponMods;
  /** weapons: the cut gems in its sockets (econ/gems.ts), which its mods come from */
  gems?: string[];
}

/**
 * Changes to a weapon kind's tuning (tuning.json weapons) carried by one gun:
 * `mul` scales a number (damage: -0.15 is 15% less), `add` adds to one
 * (burst, pierce), `set` gives it a field outright (ignite, split, pull...).
 * Shells are built from the result on both sides, so it rides the blueprint.
 */
export interface WeaponMods {
  mul?: Partial<Record<WeaponModNumber, number>>;
  add?: Partial<Record<'burst' | 'pierce' | 'pierceKeep' | 'pen', number>>;
  set?: Record<string, unknown>;
}
/**
 * A gun's firing model (guns.ts stepGuns; docs/design/rework-2026-11.md §3): its one trigger verb.
 * - cycle: fires on a fixed beat while held; each shot's energy is drawn as it reloads (`spin`: the beat eases from
 *   `from` to `to` ticks over `up` ticks of fire, back over `down`)
 * - clip: `clip` rounds at `interval`; empty, or 60 ticks after the last shot with a partial clip, it reloads for
 *   `reload` ticks drawing `reloadE` × missing / clip (`regrow`: one round back every `regrow` ticks instead, each
 *   drawing `reloadE / clip`)
 * - charge: held, it charges over `charge` ticks drawing `chargeE`, fires itself at full and cools for `cooldown`;
 *   let go early, the charge drains away over 15 ticks and nothing fires
 * - ammo: a cycle paid for with `rounds` (default 1) from the hold (server Ammo.ts), no energy
 * - beam: burns its draw every tick held (`windup`: its damage ramps up from 0 over that many ticks)
 * - auto: fires on its own (Point Defence)
 * `burst` and `salvo` are carried for the family units (the shells a volley still come from the kind's tuning).
 */
export type FireModel = 'cycle' | 'clip' | 'charge' | 'ammo' | 'beam' | 'auto';
export interface FireSpec {
  model: FireModel;
  /** Ticks between shots (cycle, clip, ammo, auto) */
  interval: number;
  clip?: number;
  reload?: number;
  reloadE?: number;
  regrow?: number;
  charge?: number;
  cooldown?: number;
  chargeE?: number;
  /**
   * Energy routing (docs/design/energy-routing-impl.md §1.4, §5.1; read from P1), per whole part. Shot models (not
   * beams): `shot` E a shot (a clip spends it per round), from a buffer of `buffer` shots (a clip's is its clip) refilled
   * at `intake` E a second; `shot` is derived in models.mjs so that at full supply the beat is unchanged
   */
  shot?: number;
  intake?: number;
  buffer?: number;
  /** Beams: `burn` E a second while lit, from a buffer of `bufferE` E refilled at `intake`; it relights at `relight` of the buffer (absent: tuning energy.relight) */
  burn?: number;
  bufferE?: number;
  relight?: number;
  burst?: { n: number; gap: number };
  salvo?: number;
  spin?: { from: number; to: number; up: number; down: number };
  windup?: number;
  rounds?: number;
  /** Semi-automatic: one click is one shot (guns.ts stepGuns): the trigger has to be pressed again for each, and the guns of its kind take turns */
  semi?: boolean;
}

/** rate: fire rate (rebuild.ts interval); hp: the part's own HP (blueprint.ts partMaxHp); splashDamage, splashRadius: its burst's; the rest scale its tuning */
export type WeaponModNumber = 'damage' | 'speed' | 'life' | 'size' | 'spread' | 'range' | 'dps' | 'armorBonus' | 'homing' | 'accel' | 'maxSpeed' | 'fuse' | 'rate' | 'hp' | 'width' | 'splashDamage' | 'splashRadius';
export const WEAPON_MOD_NUMBERS: WeaponModNumber[] = ['damage', 'speed', 'life', 'size', 'spread', 'range', 'dps', 'armorBonus', 'homing', 'accel', 'maxSpeed', 'fuse', 'rate', 'hp', 'width', 'splashDamage', 'splashRadius'];
/** What `set` may give a gun */
export const WEAPON_MOD_SETS = ['ignite', 'split', 'pull', 'frost', 'splash', 'emp', 'pierceKeep', 'homing', 'fuse', 'color', 'bane'];

export type Mount = 'fixed' | 'turret';

/**
 * A weapon model's mounting rules (FunctionDef.mounting; ships/mounting.ts):
 * - attach: which edge must bolt to the ship. 'back': its attach edge (opposite where it fires; a right-angle
 *   mount's, the side `angle` says) must be joined to another part. 'any' (default): any join will do.
 * - angle: 'straight' (default) fires away from its attach edge; 'right' fires out of a side perpendicular to it,
 *   the part's `flip` mirroring which.
 * - arc: a turret's traverse in degrees, centred on where it fires (default: tuning.turret.halfArcDeg × 2). Fixed
 *   guns keep their small gimbal.
 * - clear: cells that must hold no part (barrel clearance), in the gun's own frame: [right, ahead], ahead 1 being the
 *   cell just past its firing edge, counted from each cell of that edge (a wide gun clears a wide lane); `flip`
 *   mirrors right.
 */
export interface MountingRules {
  attach?: 'back' | 'any';
  angle?: 'straight' | 'right';
  arc?: number;
  clear?: [number, number][];
}

/** data/ships/inventory.json */
export interface InventoryStub {
  pieces: Record<string, number>;
  materials: string[];
}
