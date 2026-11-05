/**
 * Data Schemas - TypeScript interfaces for game data files
 */

// ============================================
// ITEM DATA
// ============================================

export type ItemSlot = 'leftWeapon' | 'rightWeapon' | 'booster' | 'cockpit';
export type ItemType = 'weapon' | 'equipment' | 'resource' | 'consumable';
export type WeaponTypeString = 'cannon' | 'laser' | 'scatter' | 'missile' | 'pulse' | 'mine' | 'mining' | 'warp';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'quest';

export interface ItemData {
  id: string;
  name: string;
  type: ItemType;
  tier?: number;
  rarity: Rarity;
  description: string;
  
  // Weapon-specific
  slot?: ItemSlot;
  weaponType?: WeaponTypeString;
  damage?: number;
  speed?: number;
  fireRate?: number;
  range?: number;
  spread?: number;
  projectileCount?: number;
  maxCharge?: number;
  homing?: number;
  splashRadius?: number;
  maxMines?: number;
  miningSpeed?: number;
  
  // Equipment-specific
  thrustMultiplier?: number;
  fuelCapacity?: number;
  regenRate?: number;
  hpBonus?: number;
  shieldBonus?: number;
  radarRange?: number;
  accelBonus?: number;
  turnBonus?: number;
  
  // Resource-specific
  stackSize?: number;
  value?: number;
}

// ============================================
// STAR SYSTEM DATA
// ============================================

export interface Vector2 {
  x: number;
  y: number;
}

/**
 * A ring of rocks about the system centre. A `stationary` one's rocks keep still (no orbit): spread evenly
 * over the ring, each always at the same spot, wherever and whenever it's made (a rock grows back where it
 * was); its `lane` is kept clear, a straight way in `width` wide from the ring's outer edge to its inner one
 * at `angle` (radians: 0 east, π/2 south), the rocks that would be in it pushed out to its sides.
 */
export interface AsteroidRingData {
  innerRadius: number;
  outerRadius: number;
  count: number;
  stationary?: boolean;
  lane?: { angle: number; width: number };
}

export interface AsteroidBeltData extends AsteroidRingData {
  /** More belts further out (indices after the main belt's), each with its own field of rocks if it names one */
  extra?: (AsteroidRingData & { field?: string })[];
}

export interface PortalData {
  id: string;
  targetSystem: string;
  position: Vector2;
}

/** A rift: fly into it and it fast-travels you to a fixed spot, possibly in another system. */
export interface RiftData {
  id: string;
  position: Vector2;
  destination: { system: string; x: number; y: number };
  /** Vortex colour (0-360) */
  hue?: number;
  /** Shown on the system map */
  label?: string;
}

/** Planet surface styles (the client's planet shader has one look per kind) */
export type PlanetKind = 'rocky' | 'desert' | 'ice' | 'gas' | 'lava' | 'ocean' | 'toxic';

/**
 * How each field of a planet's `look` is shaped (client/src/rendering/planet-proto/planetProto.ts PlanetLook, which
 * documents what each does): `rgb` a colour as three numbers 0..1, `vec3` three numbers, `pal` three colours.
 */
export const PLANET_LOOK_FIELDS = {
  pal: 'pal', atmoColor: 'rgb', sunsetColor: 'rgb', atmo: 'vec3', atmo2: 'vec3', limb: 'vec3', edge: 'vec3', edge2: 'vec3', detail: 'vec3', bands: 'vec3',
  storm: 'vec3', stormColor: 'vec3', storm2: 'vec3', emitColor: 'rgb', sea: 'vec3', spin: 'number', ring: 'vec3', ringCol0: 'rgb', ringCol1: 'rgb',
} as const;
type LookFieldValue<S> = S extends 'number' ? number : S extends 'pal' ? [number[], number[], number[]] : S extends 'rgb' ? number[] : [number, number, number];
/** A planet's (or a brown dwarf's) look over its kind's defaults: any of the fields, each replacing the default's */
export type PlanetLookData = { -readonly [K in keyof typeof PLANET_LOOK_FIELDS]?: LookFieldValue<(typeof PLANET_LOOK_FIELDS)[K]> };

/**
 * A planet: scenery on a slow circular orbit about the system centre (fly
 * over it freely). Position at a tick comes from planetPosition().
 */
export interface PlanetData {
  id: string;
  name: string;
  kind: PlanetKind;
  radius: number;
  orbit: {
    radius: number;
    /** Angle at tick 0, radians */
    phase: number;
    /** Minutes per revolution (0 = fixed in place) */
    period: number;
  };
  /** Base hue (0-360); each kind has a sensible default */
  hue?: number;
  /** Ring system, as multiples of the planet radius */
  rings?: { inner: number; outer: number; hue?: number };
  /** Moons (a moon with `surface` can be landed on, like a planet) */
  moons?: { radius: number; distance: number; period: number; phase: number; name?: string; surface?: string }[];
  description?: string;
  /** Its surface (a system id with `surface`): X in orbit close by descends to it */
  surface?: string;
  /** Its look from space over its kind's defaults (storms, bands, palette...; see PLANET_LOOK_FIELDS) */
  look?: PlanetLookData;
}

/** A planet's surface: a small bounded system of its own, reached from orbit */
export interface SurfaceData {
  /** The system it's in, and the planet (and which of its moons, for a moon's surface) */
  of: string;
  planet: string;
  moon?: number;
  /** A bastion to hold through the night (Sieges.ts): where, and the pads turrets can be built on */
  /**
   * A moon siege's bastion and its turret pads. `grade` (Mk I-V) is what the
   * nights' ships, the bastion and its turrets are built of (and scales the
   * pay); `offset` skips that many of the roster's first nights (night 1 there
   * is the roster's night offset + 1).
   */
  bastion?: {
    x: number; y: number; slots: { x: number; y: number }[]; grade?: number; offset?: number;
    /** Its siege (data/rules.json sieges.profiles): who comes, from where, how hard */
    profile?: string;
    /** The platform's shape (sides, radius) and ramparts round it (arcs, in degrees: 0 east, -90 north) */
    platform?: { sides: number; radius: number };
    walls?: { from: number; to: number; radius: number }[];
  };
  /** Ground and sky look (a cavern: underground, dark, its floor cracked with glowing seams) */
  kind: 'terran' | 'rocky' | 'desert' | 'ice' | 'lava' | 'toxic' | 'cavern';
  /** Fly past this far from the centre and you climb back to orbit */
  radius: number;
  seed?: number;
  /** A city: its districts are built around it, its shield pylons defended in sieges */
  city?: { name: string; x: number; y: number; radius: number; pylons: { x: number; y: number }[] };
  /** Raiders lay siege to the city every so often while pilots are here */
  siege?: { everySeconds: number; waves: number; faction?: string };
  /**
   * A job's private battleground (Arenas.ts): no way down from orbit; a job
   * sends you (and your party) to your own copy, where its boss waits at
   * `boss` and you arrive at `entry`
   */
  arena?: { boss: { x: number; y: number }; entry: { x: number; y: number } };
  /** Where you come down from orbit (default: on the side you came in from, near the edge) */
  landing?: { x: number; y: number };
  /**
   * Entered from another surface, not from orbit (a cave): its mouth on that
   * surface (within `radius` of x, y, X goes in), and what it's called; flying
   * out past its edge comes back up beside the mouth
   */
  under?: { surface: string; x: number; y: number; radius: number; name?: string };
  /** The music turns ominous nearing this point (a boss's lair): none past `from` away, all the way within `full` */
  dread?: { x: number; y: number; from: number; full: number };
  /**
   * Its rock never changes (an enclosed arena): a shot flying straight there works out where it meets the rock once,
   * as it's fired, not every tick (what moves, ships and asteroids, it's still tested against every tick). Only for
   * places whose walls are fixed
   */
  fixedWalls?: boolean;
}

/**
 * A pocket of space of its own, entered from a spot in another system (world/pockets.ts): within
 * `entrance.radius` of it there, X takes you in, arriving at `landing`; fly out past `radius` from the
 * pocket's centre and you're back beside the way in. Its way in is drawn there as a nest of `look`'s kind
 * in its faction's colours, and marked on the map
 */
export interface PocketData {
  entrance: { system: string; x: number; y: number; radius: number; name: string; look?: { kind: NestData['kind']; faction: string; scale?: number } };
  landing: Vector2;
  radius: number;
  /** The music turns ominous nearing this point (a boss's lair): none past `from` away, all the way within `full` */
  dread?: { x: number; y: number; from: number; full: number };
}

/** A wrecked ship hulk (a pre-made blueprint, battered) that players can break up for salvage. */
export interface DerelictData {
  id: string;
  name: string;
  /** File name in data/ships/blueprints/ */
  blueprint: string;
  position: Vector2;
  angle?: number;
  /** Credits for whoever lands the final blow (XP is a quarter of it) */
  salvage?: number;
  /**
   * Its log, filed as a record (data/codex.json) for a pilot who flies within
   * reading range of the hulk (a scan step's range is inside it) or lands the
   * salvage kill on it
   */
  log?: { codex: string };
}

/** A comet on an eccentric orbit about the system centre (scenery; position from cometPosition()). */
export interface CometData {
  id: string;
  name: string;
  /** Nucleus radius, world units */
  nucleus: number;
  orbit: {
    /** Semi-major axis */
    a: number;
    /** Eccentricity (0..0.98) */
    e: number;
    /** Direction of perihelion, radians */
    argP: number;
    /** Minutes per orbit */
    period: number;
    /** Mean anomaly at tick 0, radians */
    phase: number;
  };
  /** Tail hue (ion tail); the dust tail is a warmer tint */
  hue?: number;
  description?: string;
}

/**
 * A large built structure (scenery), a ring about the system centre.
 * 'solar_ring': collector panels; 'ruin_ring': the broken arcs of a Halden ring
 * (`segments` slots, some empty, some knocked out of true).
 */
export interface StructureData {
  id: string;
  name: string;
  kind: 'solar_ring' | 'ruin_ring';
  radius: number;
  segments: number;
  /** solar_ring: a run of segments that are older Halden work (drawn in their style) */
  oldArc?: { from: number; count: number };
  description?: string;
}

/** What's left of a stillstone: whole, scarred (a dead stretch, a weaker field), dead or shattered (no field) */
export type LodestoneState = 'active' | 'scarred' | 'dead' | 'shattered';

/**
 * A stillstone (a "lodestone" in the code): a huge body of grey stone whose
 * field charges a jump drive (ships/jumpFields.ts; what it does is tuning.json
 * jump.lodestone*). It orbits the system centre slowly, as planets do, or sits
 * still at `position`. Its field reaches jump.lodestoneField past its `size`.
 */
export interface LodestoneData {
  id: string;
  /** Absent: tuning.json jump.lodestoneName */
  name?: string;
  orbit?: { radius: number; phase: number; period: number };
  position?: Vector2;
  /** Its radius, world units (absent: tuning.json jump.lodestoneSize) */
  size?: number;
  /** Absent: active. Scarred: the field is weaker (jump.lodestoneScarred*); dead and shattered have none */
  state?: LodestoneState;
  /** A scarred one's dead stretch: degrees round it, in its own (turning) frame; only drawn */
  scar?: { from: number; to: number };
  /** One of the few found within living memory: rougher, irregular veins, a different glow (only drawn) */
  rough?: boolean;
  /** A spot zone of this system centred on it (factions.json can camp a pack there): only a fixed one can have it */
  zone?: string;
  description?: string;
}

/**
 * A hostile nest: the home a faction's packs launch from, roam round and come
 * back to (factions.json `spawns.<system>.nests` says who and how many). It
 * orbits the system centre, or `around` a planet (or that planet's moon
 * `moon`), as planets do (world/nests.ts). Not destructible: clearing its
 * packs quiets it until they're rebuilt.
 */
export interface NestData {
  id: string;
  name: string;
  /** Whose it is (factions.json): its colour on the maps */
  faction: string;
  /** What it looks like: a Redtooth dig rig, a Scrapborn junk nest, a pirate den, a Frost Brood roost, a scavenger sift, a Cinder shrine, a debris knot, a Helios drone dock */
  kind: 'dig' | 'scrap' | 'den' | 'roost' | 'sift' | 'shrine' | 'knot' | 'dock';
  /** A planet of this system it circles (else the system centre) */
  around?: string;
  /** That planet's moon (index) it circles instead */
  moon?: number;
  /** About what it circles: minutes per revolution as for planets (0: it stays put, at `phase` and `radius`) */
  orbit: { radius: number; phase: number; period: number };
  description?: string;
  /** Drawn this many times its size (a pocket's way in: world/pockets.ts entranceNest) */
  scale?: number;
  /** No structure to see (a den's posts: its packs keep to the spot, nothing is drawn there or on the maps) */
  hidden?: boolean;
}

/** A civilian ship flying a loop between stations (pilotless, server-driven). */
export interface TrafficData {
  id: string;
  name: string;
  /** File name in data/ships/blueprints/ */
  blueprint: string;
  /** Station ids, visited in order, looping */
  route: string[];
}

export type SystemHazard = 'cold' | 'radiation' | 'low_visibility' | 'darkness' | 'gravitational_anomalies';

/**
 * Central body configuration for a star system.
 * Defaults to a sun when omitted (hasCentralBody defaults true).
 */
export interface CentralBodyData {
  /** 'sun' | 'binary' | 'black_hole' | 'pulsar' | 'brown_dwarf' (a failed star: dim, banded, smouldering) | 'none' */
  type: 'sun' | 'binary' | 'black_hole' | 'pulsar' | 'brown_dwarf' | 'none';
  /** Radius in world units (sun/pulsar) */
  radius?: number;
  /** Base hue 0-360 (sun/pulsar) */
  hue?: number;
  /** Sun shader style id from sun-shader-defs ('granular', 'flow', etc.) */
  sunStyle?: string;
  /** Corona shader style id ('softGlow', 'plasmaStreams') */
  coronaStyle?: string;
  /** Per-style parameter overrides keyed by param key */
  sunStyleParams?: Record<string, number>;
  coronaStyleParams?: Record<string, number>;
  /** Binary companion offset (type='binary' only) */
  companionOffsetX?: number;
  companionOffsetY?: number;
  companionHue?: number;
  companionRadius?: number;
  /** Black hole accretion disk hue */
  diskHue?: number;
  /** Pulsar beam hue */
  beamHue?: number;
  /** Gravity well at the origin (black holes): a = strength / max(r, minRadius)²; inside `horizon` ships are destroyed */
  gravity?: { strength: number; minRadius: number; horizon?: number };
  /**
   * Detail-star mode: full fBM/warp/plasma control (sandbox detail_sun look).
   * When true, detailParams/detailColors drive the sun shader.
   */
  detailStar?: boolean;
  /** Detail-star parameters (octaves, lacunarity, gain, warp, plasma, edge...) */
  detailParams?: Record<string, number>;
  /** Detail-star colors (darkColor, midColor, brightColor, edgeColor, plasmaColor, centerColor) */
  detailColors?: Record<string, string>;
  /** A brown dwarf's look over its defaults (drawn as a planet: PlanetLookData) */
  look?: PlanetLookData;
  /** A star's look (type 'sun'; STAR_PLASMA_FIELDS): anything not given comes from its palette */
  plasma?: StarPlasmaData;
}

/**
 * A star's plasma look (`centralBody.plasma`; client/src/rendering/sun/plasmaSun.ts PlasmaParams documents each field):
 * each number's allowed range, or `colour` ('#rrggbb'), or `iridescence` (multicolour: { mode: 'rainbow' | 'tints',
 * colors?, strength?, drift?, spread? }).
 */
export const STAR_PLASMA_FIELDS = {
  scale: [1, 40], warp: [0, 5], contrast: [0, 3], core: [0, 3], heat: [0.1, 2], softEdge: [0, 0.2],
  limbDarkening: [0, 1], limbPower: [0.05, 4], limbContrast: [0, 1], limbTint: 'colour', limbTintStrength: [0, 1], bump: [0, 2],
  rim: [0, 3], rimColor: 'colour', rimWidth: [0, 0.1], halo: [0, 3], spicules: [0, 0.5],
  evolve: [0, 0.2], warpEvolve: [0, 0.2], warpWander: [0, 2],
  threads: [0, 4], threadFlow: [0, 2], granulation: [0, 2], fineContrast: [0, 3], fineOnset: [-2, 2],
  iridescence: 'iridescence',
} as const;
type PlasmaFieldValue<S> = S extends 'colour' ? string : S extends 'iridescence' ? { mode: 'rainbow' | 'tints'; colors?: string[]; strength?: number; drift?: number; spread?: number } : number;
export type StarPlasmaData = { -readonly [K in keyof typeof STAR_PLASMA_FIELDS]?: PlasmaFieldValue<(typeof STAR_PLASMA_FIELDS)[K]> };

/**
 * Data-driven visual configuration for a star system.
 * All fields optional — sensible defaults are derived from starColor/starRadius
 * when omitted, so a minimal system entry still looks good.
 */
export interface SystemVisualsData {
  /** Background starfield hue shift (-180..180) */
  starHueShift?: number;
  /** Chance 0-1 of special colored stars */
  specialStarChance?: number;
  /** Hue for special stars */
  specialStarHue?: number;
  /** Custom starfield layers (rarely needed) */
  starLayers?: unknown[];
  /** Nebula presence + hue */
  hasNebula?: boolean;
  nebulaHue?: number;
  /** The system's ambient music (client/src/audio/MusicEngine.ts; default: Sol's) */
  music?: MusicMoodData;
  /** Share of its (non-ice) rocks drawn veined with greyseam (default a third) */
  greyseam?: number;
  /** Ambient light level (default: from its sky) */
  ambient?: number;
}

/** A generative-music mood: key, harmony, tempo and timbre */
export interface MusicMoodData {
  /** MIDI note of the tonic */
  root: number;
  /** A named mode, or scale steps in semitones from the root */
  scale: 'major' | 'lydian' | 'dorian' | 'aeolian' | 'phrygian' | number[];
  /** Chord roots as scale degrees (0-based), one per bar */
  progression: number[];
  /** Seconds per bar */
  bar: number;
  /** Pad oscillator */
  pad: 'sine' | 'square' | 'sawtooth' | 'triangle';
  /** Pad filter cutoff, Hz */
  brightness: number;
  /** Bell notes per bar (average) */
  bells: number;
  /** Octave offset of the bells */
  bellOctave: number;
}

/** A named ring of a system, between two distances from its centre */
export interface SystemZoneData {
  id: string;
  name: string;
  inner: number;
  outer: number;
  /** A spot rather than a ring round the star: inner/outer are measured from here */
  x?: number;
  y?: number;
  color?: string;
  description?: string;
}

/**
 * A band of a system by distance from its centre (out to `outer`, from the
 * previous band's edge): how dangerous it is there. `safe` bands are kept
 * clear of hostiles and dying there costs little (game/regions.ts).
 */
export interface SystemRegionData {
  id: string;
  name: string;
  outer: number;
  danger: 'safe' | 'contested' | 'hostile';
  description?: string;
}

export interface StarSystemData {
  id: string;
  name: string;
  /** 1 (safe) .. 7 (deadly): enemy strength, rarer ores, gem seams */
  danger?: number;
  /** Where players can fight each other: the whole system, or away from its stations */
  pvp?: { mode: 'all' | 'outer'; safeRadius?: number };
  description: string;
  starColor: string;
  starRadius: number;
  position: Vector2;
  /** Sector grouping for map organization */
  sector?: string;
  /** Central body config; defaults to a sun when omitted */
  centralBody?: CentralBodyData;
  /** Named rings of the system (shown on the map; factions.json can give them packs of their own) */
  zones?: SystemZoneData[];
  /** Danger bands, innermost first (shown on the map and HUD) */
  regions?: SystemRegionData[];
  /** A planet's surface rather than a star system (not on the galaxy map) */
  surface?: SurfaceData;
  /** Copies of this system kept for parties (its `slots` at once) */
  instance?: { slots: number };
  /** Not on the galaxy map, reached only its own way (a pilot's station) */
  private?: boolean;
  /** A pocket of space reached from a spot in another system rather than by gate (a boss's nest; not on the galaxy map) */
  pocket?: PocketData;
  /** A lair boss's enclosed arena: its barrier is solid both ways, passed by interact (world/gates.ts) */
  arena?: import('../world/gates.js').ArenaDef;
  /** Data-driven visual overrides */
  visuals?: SystemVisualsData;
  /** Visual hazard tags (the screen treatment) */
  hazards: SystemHazard[];
  /** Hazard ratings 0-5 (ships/hazards.ts): what a ship's build has to stand up to here */
  hazardRatings?: Record<string, number>;
  asteroidDensity: number;
  asteroidBelt: AsteroidBeltData;
  asteroidField?: string;  // Optional field ID for definition-based asteroid generation
  stations: string[];
  portals: PortalData[];
  rifts?: RiftData[];
  planets?: PlanetData[];
  derelicts?: DerelictData[];
  comets?: CometData[];
  structures?: StructureData[];
  /** Jump-drive charging fields away from the star */
  lodestones?: LodestoneData[];
  /** Hostile nests: where its packs launch from */
  nests?: NestData[];
  traffic?: TrafficData[];
  /** A boss den's features (server game/dens: a registry by `kind`), e.g. the Pyreclast cavern's Kiln */
  den?: DenFeatureData[];
}

/**
 * A floor of vents erupting in a fixed cycle from the server tick (world/denVents.ts): vent `order[k]` starts its
 * tell at tick k × `every` into each cycle of `order.length × every`, burns from `tell` ticks after that for `burn`
 * ticks, setting fire to every pilot within `radius` (`dps` thermal, at penetration `pen`)
 */
export interface DenVentsData {
  kind: 'vents';
  id: string;
  at: [number, number][];
  order: number[];
  every: number;
  tell: number;
  burn: number;
  radius: number;
  dps: number;
  pen: number;
}

/**
 * A crust holding loot (a pinned body of `material` armour blocks, `cells` across, painted `paint`): `hp` dealt by
 * pilots cracks it; each who hurt it gets `loot` (rolled per pilot, at most once per `everyMinutes`), and it grows
 * back `regrowSeconds` later
 */
export interface DenCacheData {
  kind: 'cache';
  id: string;
  name: string;
  x: number;
  y: number;
  cells: number;
  material: string;
  paint?: string;
  hp: number;
  everyMinutes: number;
  regrowSeconds: number;
  loot: { item: string; chance: number; min: number; max: number }[];
}

export type DenFeatureData = DenVentsData | DenCacheData;

// ============================================
// ENEMY DATA
// ============================================

export interface DropData {
  itemId: string;
  chance: number;
  minCount: number;
  maxCount: number;
}

export interface SpawnInfo {
  maxCount: number;
  spawnInterval: number;
  minRadius: number;
  maxRadius: number;
  systems: string[];
}

export interface EnemyVisuals {
  color: string;
  glowColor: string;
  trailColor: string;
  shape: string;
}

export interface EnemyAI {
  detectionRange: number;
  loseAggroRange: number;
  attackPattern: string;
  fleeThreshold: number;
  groupBehavior: boolean;
  teleportCooldown?: number;
  teleportRange?: number;
  burrowCooldown?: number;
  territoryRadius?: number;
}

export type EnemyBehavior = 'aggressive' | 'flanker' | 'sniper' | 'swarm' | 'territorial' | 'teleport' | 'burrow' | 'flee_when_damaged';

export interface EnemyTypeData {
  id: string;
  name: string;
  description: string;
  hp: number;
  damage: number;
  xp: number;
  speed: number;
  radius: number;
  attackRange: number;
  attackCooldown: number;
  projectileSpeed: number;
  behaviors: EnemyBehavior[];
  drops: DropData[];
  spawnInfo: SpawnInfo;
  visuals: EnemyVisuals;
  ai: EnemyAI;
}

// ============================================
// NPC DATA
// ============================================

export interface NPCDialogue {
  greeting: string;
  idle: string[];
  farewell: string;
}

export interface ShopItem {
  itemId: string;
  stock: number;  // -1 = unlimited
  price: number;
}

export interface ShopData {
  buyMultiplier: number;
  sellMultiplier: number;
  inventory: ShopItem[];
}

export type NPCService = 'repair' | 'heal' | 'refuel';

export interface NPCData {
  id: string;
  name: string;
  title: string;
  description: string;
  system: string;
  position: Vector2;
  radius: number;
  sprite: string;
  dialogue: NPCDialogue;
  quests: string[];
  shop: ShopData | null;
  services: NPCService[];
}

// ============================================
// STATION DATA
// ============================================

export type StationService = 'repair' | 'storage' | 'refinery' | 'fabricator' | 'market' | 'shipyard' | 'refuel' | 'shop' | 'bank' | 'quests';

/** A station's defence battery: turrets that fire on hostile ships near it */
export interface StationDefenceData {
  weapon: 'laser' | 'flak' | 'lance';
  turrets: number;
}

export interface StationData {
  id: string;
  name: string;
  description: string;
  system: string;
  position: Vector2;
  radius: number;
  sprite: string;
  /** How it looks: ring (habitat ring), outpost, observatory, bastion, shipyard, refinery */
  design?: 'ring' | 'outpost' | 'observatory' | 'bastion' | 'shipyard' | 'refinery' | 'citadel';
  /** Armed stations (hostile sectors) shoot hostiles near them; the rest don't */
  defence?: StationDefenceData;
  dockingRadius: number;
  orbit?: OrbitData;
  services: StationService[];
  shop?: ShopData;
  /** What the station's market sells, and the price multipliers it pays for items it wants */
  market?: { sells: string[]; demand: Record<string, number>; note?: string };
  repairCostPerHp: number;
  refuelCostPerUnit: number;
  /** Outer-ring stations: credits a berth costs pilots of DOCK_FEE_LEVEL and up */
  dockingFee?: number;
}

/** Pilot level from which outer-ring stations charge their docking fee */
export const DOCK_FEE_LEVEL = 10;

export interface OrbitData {
  orbitType: number;
  semiMajorAxis: number;
  eccentricity: number;
  argPeriapsis: number;
  meanAnomaly0: number;
  epochTick?: number;
}

// ============================================
// QUEST DATA
// ============================================

export type QuestStageType = 'travel' | 'kill' | 'gather' | 'interact' | 'action' | 'acquire';

export interface QuestObjective {
  // Travel
  system?: string;
  distance?: number;
  
  // Kill
  enemy?: string;
  count?: number;
  weaponType?: WeaponTypeString;
  
  // Gather/Acquire
  item?: string;
  
  // Interact
  npc?: string;
  station?: string;
  
  // Action
  action?: string;
}

export interface QuestStageDialogue {
  start: string;
  complete?: string;
}

export interface QuestStage {
  id: string;
  type: QuestStageType;
  description: string;
  objective: QuestObjective;
  dialogue: QuestStageDialogue;
}

export interface LegacyQuestRewards {
  xp: number;
  credits: number;
  items: string[];
}

export interface QuestData {
  id: string;
  name: string;
  description: string;
  giver: string;
  level: number;
  stages: QuestStage[];
  rewards: LegacyQuestRewards;
  prerequisites: string[];
  repeatable: boolean;
}

// ============================================
// DATA FILE ROOTS
// ============================================

export interface SystemsFile {
  systems: StarSystemData[];
}

export interface EnemiesFile {
  enemies: EnemyTypeData[];
}

export interface NPCsFile {
  npcs: NPCData[];
}

export interface StationsFile {
  stations: StationData[];
}
