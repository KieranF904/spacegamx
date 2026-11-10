/**
 * @contract server.replication.types
 * owns:       the shadow records (Shadow, OwnShadow), the host Replication reads, and the core state its modules share
 * needs:      common ships/replica (FlightBody, ReplicaMode, ReplicaEnv, rows), causes/shadowCauses types
 * invariants: a version names one state, whoever holds it (version/cver/dver from one gen count) — server/src/net/replication.test.ts
 *             own and bodied shadows count their versions down from -1, never a shared one — server/src/golden/clampParity.test.ts
 * extend:     a new per-ship replication field is one member of Shadow below
 */
import {
  CTL_POWER_MASK, CTL_SHARE_MASK, CTL_NO_BOOST, quantizeShipBody,
  type FlightBody, type ReplicaMode, type ReplicaEnv, type KeyframeRow, type ControlRow,
} from '@space-game/common';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { CauseEvent, WorkedCauses } from '../causes/shadowCauses.js';
import type { OwnCause } from '../../ships/bridge/ownCauses.js';

export interface ReplicationHost {
  tick(): number;
  /** Gravity, the central body and the lodestones where this entity is */
  env(eid: number): ReplicaEnv;
  /** Berthed at a station: which, and the offset from it */
  dockOf(eid: number): { station: number; ox: number; oy: number } | null;
  /** Every berthed ship this tick (one pass over the clients, instead of dockOf per ship) */
  docks?(): Map<number, { station: number; ox: number; oy: number }>;
  /** Systems with a client in them (nobody sees a shadow anywhere else) */
  occupied?(): Set<number>;
  /** CAPS.OWN_SIM: this pilot's client steps its own ship itself (network/ownTick.ts) */
  ownSim?(eid: number): boolean;
  /** ...with the controls its inputs say for this tick (null: none yet) */
  ownControls?(eid: number): { bits: number; q: number } | null;
  /** ...and an input of its wasn't applied on its target tick since this was last asked (late, or dropped) */
  ownLate?(eid: number): boolean;
}

/** CTL bits a pilot's own client works out itself (its engines' power, share, a refused boost: common sim/ownStep.ts) */
export const OWN_DERIVED_BITS = CTL_POWER_MASK | CTL_SHARE_MASK | CTL_NO_BOOST;

/**
 * A pilot's own ship as its client steps it (CAPS.OWN_SIM). The shadow is then exactly that: stepped with the controls
 * the ship flew, and the causes of anything else that moved it worked out on it by the client's own function; only
 * what that still misses (`hard`: the client can't have it) costs it a keyframe of its own ship.
 */
export interface OwnShadow {
  /** Its own keyframe version (what its client was last given of its own ship: counting down from -1, never one of the shared versions) */
  version: number;
  /** This window's causes (the same events as the shadow's own list) */
  events: CauseEvent[];
  /** The ship flew this window with controls its inputs don't say (the engines short of power, an EMP, the cold...) */
  exc: boolean;
  /** ...on the last tick stepped (the next window starts from those) */
  excLast: boolean;
  /** The controls on the window's first tick (an exceptions row starts from them) */
  first: [number, number, number] | null;
  /**
   * The window's controls as its client flies them (tick, bits, aim: its raw aim, which its own step weighs as the
   * server's does, common sim/aimHold.ts; the shadow's events carry the applied one), as they changed after `first`,
   * and the last tick's (they change against it)
   */
  ctl: number[];
  last?: [number, number];
  /** Something its client can't work out moved it this window: a keyframe of its own ship goes */
  hard: boolean;
  /** Why (the stats) */
  why?: string;
  /** Not flown by its pilot (docked) since its last keyframe, in this mode: no keyframe again till it moves (stepOwn) */
  held?: ReplicaMode;
  heldDock?: Shadow['dock'];
}

/** (A shadow rounded as every body is at a tick's end) */
export const quantizeOwn = (b: FlightBody): void => quantizeShipBody(b);
/** The same pose and motion (a docked ship's shadow against the real one) */
export const sameBody = (a: FlightBody, b: FlightBody) => a.x === b.x && a.y === b.y && a.vx === b.vx && a.vy === b.vy && a.angle === b.angle && a.angVel === b.angVel;

export interface Shadow {
  mode: ReplicaMode;
  body: FlightBody;
  bits: number;
  q: number;
  /** Keyframe version: bumped whenever clients must be resent the real state */
  version: number;
  /** CAPS.CAUSES clients' keyframe version: bumped only when the shadow, its causes worked out, left the ship */
  cver: number;
  /** The count both versions are taken from (so a version names one state, whoever holds it) */
  gen: number;
  /**
   * A piece of debris: the keyframe version of clients running it (CAPS.DEBRIS) or keeping each structure by tick
   * (CAPS.STRUCTS): bumped only when it left what they work out (not for its rebuilds)
   */
  dver: number;
  /** A piece of debris rebuilt this window (those clients worked it out; the rest get a keyframe) */
  lived?: boolean;
  diverged: boolean;
  /** A cause moved it this window (worked out on the shadow: clients without CAUSES get a keyframe) */
  caused: boolean;
  /** This window's causes (CAPS.CAUSES) */
  causes: CauseEvent[];
  /** Its body after this tick's step and before its causes, and those causes (a contact another ship's client works out reads it) */
  pre?: FlightBody;
  preTick?: number;
  worked?: WorkedCauses;
  workedTick?: number;
  rebuilds: number;
  /** Its structure's flight signature (a rebuild that changes it needs a keyframe) */
  sig: string;
  dock: { station: number; ox: number; oy: number } | null;
  /** Control changes since the last snapshot: [tick, bits, q] */
  events: number[];
  /** The aim as of the last snapshot (what clients have: control rows step from it) */
  qSent: number;
  /** This snapshot's keyframe and control row, each packed once for every client that gets it */
  keyRow?: KeyframeRow;
  ctlRow?: ControlRow;
  /** The tick it was last stepped on (a contact on that tick with the replica as stepped: the client has it) */
  stepped?: number;
  /** Its pilot's client steps it itself (CAPS.OWN_SIM) */
  own?: OwnShadow;
  /**
   * Flown by its body (CAPS.BODIES, common bodies/): the ship as a client running the body has it, stepped with the
   * controls and push the body made. Its own keyframe versions (counting down from -1, as an own ship's): a client that
   * runs the body is sent a keyframe only when this leaves the real ship (a contact, a shed, an EMP), never rows
   */
  bodied?: { body: FlightBody; version: number; cver: number; gen: number; diverged: boolean; caused: boolean; rebuilds: number; stepped?: number; pre?: FlightBody; preTick?: number; worked?: WorkedCauses; workedTick?: number };
}

export const sameDock = (a: Shadow['dock'], b: Shadow['dock']) => (!a && !b) || (!!a && !!b && a.station === b.station && a.ox === b.ox && a.oy === b.oy);

/** How long a removed ship's causes are remembered (causedInWindow): longer than the widest snapshot window */
export const GONE_CAUSED_TICKS = 16;

/** A client's kept structures of a ship (CAPS.STRUCTS: ClientConnection.shipSynced kept), its rebuild counts oldest first; undefined: none kept */
export type Kept = (id: number) => readonly number[] | undefined;

export const sameVec = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

/** Pilots' own ships (CAPS.OWN_SIM): causes told, keyframes of their own ship and why, exceptions rows */
export const newOwnStats = () => ({ causes: 0, pull: 0, contact: 0, contactState: 0, rebuild: 0, cargo: 0, keyframes: 0, exc: 0, why: {} as Record<string, number>, pullDerived: 0, pullZero: 0 });
/** Other ships' causes (CAPS.CAUSES): ticks a ship's were worked out, rows sent, contacts sent without state, keyframes for ones a client couldn't work out */
export const newCauseStats = () => ({ worked: 0, failed: {} as Record<string, number>, rows: 0, stateless: 0, unworkable: 0, pullDerived: 0, pullZero: 0 });
/** Contacts its clients found themselves (CAPS.CONTACTS): rows not sent (own rows, records' sides), ships left out */
export const newContactStats = () => ({ found: 0, ownRows: 0, records: 0, leftOut: 0, windows: 0, fxSent: 0, fxFound: 0 });
/** Bodies' clients' shadow of a ship its body flies (Shadow.bodied) */
export const newBodyStats = () => ({ stepped: 0, keyframes: 0, why: {} as Record<string, number> });

/**
 * What the replication modules (step, ownShip, forClient) share of Replication: its shadows, the window's lists, the
 * stats, and the few helpers every path uses. Replication is the one implementation
 */
export interface ReplicationCore {
  readonly host: ReplicationHost;
  readonly ships: ShipBridge;
  readonly shadows: Map<number, Shadow>;
  /** Pairs of debris that knocked since the last snapshot */
  readonly knocks: [number, number][];
  /** Ships removed lately that had causes in their last window, and when */
  readonly goneCaused: Map<number, number>;
  /** Pullers whose clients' replicas weren't the real ship as a tick began, by tick */
  readonly pullOff: Map<number, Set<number>>;
  /** Each client's last tick its pulls were judged through (by its `known` map) */
  readonly pullsJudged: WeakMap<object, number>;
  /** Docking Clamps' envs, one per host env */
  readonly clampEnvs: WeakMap<ReplicaEnv, ReplicaEnv>;
  keyframes: number;
  readonly ownStats: ReturnType<typeof newOwnStats>;
  readonly causeStats: ReturnType<typeof newCauseStats>;
  readonly contactStats: ReturnType<typeof newContactStats>;
  readonly bodyStats: ReturnType<typeof newBodyStats>;
  why(r: string): void;
  ownWhy(w: string): void;
  /** The real ship's flight state now */
  real(eid: number): FlightBody;
  keyNow(eid: number, known: Map<number, number>, ships: KeyframeRow[]): void;
  /**
   * In a snapshot round (beginSnapshot to endSnapshot): a system's ships (kind 'ship') with a shadow, worked out once a
   * round for every client there (nothing it reads moves within the round). Null outside a round
   */
  shipsIn(systemId: number): ReadonlySet<number> | null;
  /** Work a shadow's causes out for one tick (replication/step.ts work); a method so tests can watch it */
  work(eid: number, s: Shadow, causes: OwnCause[], tick: number): WorkedCauses | null;
}
