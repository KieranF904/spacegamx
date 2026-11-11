/**
 * @contract common.tutorial.types
 * owns:       the shapes of data/tutorial.json (steps, training objects, the yard, the starter pack), the events the
 *             server's step engine listens to, and the per-pilot saved state
 * needs:      nothing (leaf module)
 * invariants: the data passes validateTutorialData — common/src/tutorial/tutorial.test.ts
 * extend:     a new step is an entry in data/tutorial.json; a new trigger kind is a member of TutorialTriggerKind plus a
 *             case in server/src/game/tutorial/TutorialSteps.ts; a new event is a member of TutorialEvent
 */

/** What a training object is. `drone` is a real (stationary) asteroid entity every pilot collides with; `ring`/`zone`/`exit` are markers that collide with nothing. (The mining lesson uses the yard's own asteroid belt: data/systems.json) */
export type TutorialObjectKind = 'drone' | 'ring' | 'zone' | 'exit';

/** A point in the yard, as an offset from `yard.center` (the whole yard moves with one number) */
export interface TutorialPoint { x: number; y: number }

export interface TutorialObjectDef {
  id: string;
  kind: TutorialObjectKind;
  /** The step this object belongs to: once a pilot has done that step the object is inert for them (no damage, drawn ghosted; before they reach it, not drawn at all) */
  step: string;
  /** Offset from yard.center */
  at: TutorialPoint;
  /** Body size (drone) or trigger radius (ring/zone/exit) */
  radius: number;
  /** drone: damage one pilot must deal (their own counter) before it "breaks" for them */
  hp?: number;
  /** Label the client may draw on the marker */
  label?: string;
}

export type TutorialTriggerKind =
  | 'ack'            // the pilot pressed Continue (the welcome card)
  | 'rings'          // every object in `objects` passed
  | 'zoneStop'       // stopped inside the zone in `objects[0]`
  | 'objectsBroken'  // every object in `objects` broken (for this pilot)
  | 'collect'        // `count` ore (of `items`, when given) taken into the hold since the step began
  | 'panel'          // the client opened `panel`, or every one of `panels` (hold, hangar, bank, guide, map ...)
  | 'docked'         // docked at the yard station
  | 'refined'        // refined `item` once
  | 'partPlaced'     // placed one part in the hangar
  | 'powered'        // a generator is wired and the ship is powered
  | 'jumped'         // finished a jump inside the `objects[0]` exit marker
  | 'graduate';      // grant the pack and leave

export interface TutorialTrigger {
  kind: TutorialTriggerKind;
  objects?: string[];
  panel?: string;
  /** Several panels, all to be opened (in any order) */
  panels?: string[];
  item?: string;
  /** collect: only these items count toward `count` (any item, if absent) */
  items?: string[];
  count?: number;
}

/**
 * One line of a step's card: plain text, or one text per control mode (`screen`: mouse-steer, WASD push the ship around the
 * screen; `helm`: A/D turn, W/S thrust along the nose). Either may use `{action}` key placeholders and `{wasd}` (the four move keys)
 */
export type TutorialLine = string | { screen: string; helm: string };

export interface TutorialStepDef {
  id: string;
  title: string;
  /** One or two short lines; key names are written as `{action}` and filled in by the client from the pilot's bindings */
  lines: TutorialLine[];
  /** What the card's counter calls the step's targets ("Rings" -> "Rings 2/3"): `trigger.objects` as the server reports them done,
   * or on a collecting step what was taken of `trigger.count` (the state's `got`: "Ore 12/20") */
  counter?: string;
  trigger: TutorialTrigger;
  /** Objects the client highlights (arrow/ring) while this is the current step */
  targets?: string[];
  /** Items granted when the step starts (so the lesson has what it needs) */
  grant?: Record<string, number>;
  /**
   * UI controls the step needs, in the order the pilot meets them: each entry is a CSS selector (list) the client makes glow
   * until clicked (prefer the stable data-tab / data-key / data-tut attributes). Of the entries not yet clicked, the last one whose
   * control is on screen glows; `.tp kbd` is the card's own key caps
   */
  highlight?: string[];
}

export interface TutorialYardDef {
  system: string;
  /** The yard station (data/stations.json, `tutorial: true`) */
  station: string;
  /** World position of the yard (fixed: nothing in it orbits) */
  center: TutorialPoint;
  /** New pilots appear this far from the centre, at an angle taken from their ship id */
  spawnRadius: number;
  /** Past this distance from the centre a trainee is stopped (a soft wall) and asked whether to leave */
  leash: number;
  /** Slower than this (units a tick) inside a zone counts as stopped... */
  stopSpeed: number;
  /** ...for this many ticks */
  stopTicks: number;
}

export interface TutorialPackDef {
  credits: number;
  items: Record<string, number>;
}

export interface TutorialData {
  version: number;
  yard: TutorialYardDef;
  steps: TutorialStepDef[];
  objects: TutorialObjectDef[];
  starterPack: TutorialPackDef;
}

/** Asteroid index of training object `i` (the Nth in data.objects): above any belt's, so clients tell them apart */
export const TUTORIAL_INDEX_BASE = 900_000;
/** The asteroid definition training drones are made from (a real type in data/mining.json) */
export const TUTORIAL_ROCK_TYPE = 'asteroid_metal';
/** The first step's id (a new pilot starts here) */
export const TUTORIAL_FIRST_STEP = 'welcome';

/** Per-pilot saved progress (PlayerProfile.tutorial) */
export interface TutorialProfile {
  /** The current step id ('' once left) */
  step: string;
  done: string[];
  left: boolean;
  /** Damage this pilot has dealt to each training object (their own counter; at the object's hp it is broken for them) */
  hits?: Record<string, number>;
}

/** What the step engine hears (`pid` is passed beside it). The foundation emits the first group; the rest are for the step engine and the other modules */
export type TutorialEvent =
  // ---- seen by the foundation
  | { kind: 'objectBroken'; object: string; step: string }
  | { kind: 'ringPassed'; ring: string; step: string }
  | { kind: 'zoneStopped'; zone: string; step: string }
  | { kind: 'docked'; station: string }
  | { kind: 'jumped'; x: number; y: number; exit?: string }
  | { kind: 'collected'; item: string; n: number }
  // ---- reported by the client (tutorialReport) or seen by other modules
  | { kind: 'ack'; step: string }
  | { kind: 'panelOpened'; panel: string }
  /** Ore went through the refinery and the plate came out (`item`: the first ore used) */
  | { kind: 'refined'; item: string }
  | { kind: 'partPlaced'; fn?: string }
  | { kind: 'powered' }
  // ---- engine to itself
  | { kind: 'graduate' };

/** Panels the client may report opening (tutorialReport) */
export const TUTORIAL_PANELS = ['hold', 'hangar', 'bank', 'guide', 'map', 'refinery', 'fabricator', 'pickup'] as const;
export type TutorialPanel = (typeof TUTORIAL_PANELS)[number];
