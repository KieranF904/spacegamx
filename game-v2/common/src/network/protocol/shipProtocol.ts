/**
 * @contract protocol.ship
 * owns:       ship sync, hp, hits, cells, crowd, dock and ship-edit message types
 * needs:      nothing beyond type imports
 * invariants: message shapes are the wire contract — serverMessages.json
 * extend:     a new ship-state message is an interface here and a line in serverMessage.ts
 */
import type { Blueprint } from '../../ships/types.js';
export interface ServerDockResultMessage {
  type: 'dockResult';
  ok: boolean;
  /** Station name when docked */
  station?: string;
  error?: string;
}

/**
 * Confirmed hits (hits.ts packHits): shells that hit ships since the snapshot just sent, for a client that announced
 * CAPS.HITS. It works out each one's damage, part HP, fire, hit point and end itself, as the server's legacy messages
 * would have told it (client ships/hits/ConfirmedHits.ts). Comes after the snapshot and before the shipHps that
 * corrects anything it got wrong.
 */
export interface ServerHitsMessage {
  type: 'hits';
  h: number[];
}

/** Confirmed hits: the server's copy of a ship's part HP as this client should have it (hits.ts hpChecksum) */
export interface ServerHpCheckMessage {
  type: 'hpCheck';
  id: number;
  sum: number;
}

/**
 * Client-detected hits (hits.ts CAPS.SELF_HITS, docs/design/confirmed-hits.md part D): the client's hit chain and the
 * server's stopped agreeing, so here is every hit after tick `s` up to tick `t`, as records (packHits, each `ago` from
 * `t`, D always set), and the server's chain as of `t` (`c`, 32 bits). The client keeps the hits it had that are in
 * the list, draws the ones it missed, asks for the HP of ships it hit wrongly (hpResync), takes `c` plus its own hits
 * since `t` as its chain, and counts this correction (`e`, mod 4) on its reports from now on. The ships in the list
 * get all their HP again with the next snapshot.
 */
export interface ServerHitFixMessage {
  type: 'hitFix';
  s: number;
  t: number;
  c: number;
  e: number;
  h: number[];
}

/**
 * Its netcode's start, after its first snapshot (every client runs the full set, hits.ts DEFAULT_CAPS): finding its
 * own hits (SELF_HITS) runs from the snapshot just sent on. Sent again whenever its confirmation level changes.
 */
export interface ServerNetCapsMessage {
  type: 'netCaps';
  /** Coalescing (CAPS.COALESCE): how many ticks a frame with nothing urgent may wait (the client widens its interpolation delay by as much) */
  hold?: number;
  /**
   * Adaptive validation (CAPS.ROUGH): the confirmation level (hits.ts CONFIRM) from the snapshot just sent on; sent
   * again whenever it changes. Absent: NORMAL
   */
  lvl?: number;
}

/** A projectile struck something at (x, y): clients end its tracer there and throw sparks. */
export interface ServerProjectileHitMessage {
  type: 'projectileHit';
  id: number;
  x: number;
  y: number;
}

/**
 * A modular ship or debris body, sent when a client first sees it and after
 * every server rebuild. `hp` is exact and is what the server rebuilt from, so
 * the client's rebuild() reproduces the server's derived stats.
 */
export interface ServerShipSyncMessage {
  type: 'shipSync';
  id: number;
  kind: 'ship' | 'debris';
  /** Sent the first time a client sees this ship; later syncs (after a rebuild) reuse it */
  blueprint?: Blueprint;
  /**
   * The design's hash. With a blueprint, the client keeps it under this; alone,
   * the client already has that design (another ship of it), so it isn't resent.
   */
  design?: string;
  /** Every part's HP (a new ship), or... */
  hp?: number[];
  /** ...after a rebuild, just the parts whose HP the client doesn't have: [part, hp] */
  hpd?: [number, number][];
  /** Every part's most HP, when it isn't the blueprint's (a boss's scaled hull): with `hp` */
  maxHp?: number[];
  /** Part indices that have left this body as debris */
  detached: number[];
  /** Part indices not built yet (hangar ghosts) */
  ghosts?: number[];
  rebuilds: number;
  /**
   * The tick of the rebuild that made this structure (CAPS.STRUCTS): it flew it from the tick after. Each rebuild tick's
   * goes, in order, so the client keeps them all (ShipStore.derivedAt)
   */
  at?: number;
  /** A piece of debris, new to the client: the tick it spawned at (its grace, common ships/debris.ts DEBRIS_GRACE_TICKS) */
  born?: number;
  /** ...and only to be seen: it knocks nothing (1) */
  aloof?: number;
  /**
   * Its shells' damage multiplier (a boss's `damage` and rage), on a new ship's sync when it isn't 1 and on any sync
   * after it changed: hits by its guns are worked out with it (ShipState.dmg, hitRules.ts gunShell)
   */
  dmg?: number;
}

/** Part HP changes between rebuilds (visual only: the client doesn't rebuild on these) */
export interface ServerShipHpMessage {
  type: 'shipHp';
  id: number;
  /** [part index, hp] */
  hp: [number, number][];
}

/** Every ship's part HP changes since the last snapshot, in one message: [ship id, [part index, hp][]] */
export interface ServerShipHpBatchMessage {
  type: 'shipHps';
  ships: [number, [number, number][]][];
}

/**
 * A ship lost parts that broke away as debris, and this client can work the pieces out itself (ships/debris.ts
 * deriveSplit) instead of being sent each: `id` the ship, `tick` the split's, `e` the pieces' entity ids in group order
 * (packIds), `p` the parts that left (packRuns). It confirms each piece (ClientInputMessage.acks); a piece it gets
 * wrong, or doesn't confirm in time, is sent as before (protocol 25)
 */
export interface ServerDebrisSplitMessage {
  type: 'debrisSplit';
  id: number;
  tick: number;
  e: number[];
  p: number[];
  /**
   * The pieces are this client's to run from their spawn (CAPS.DEBRIS, common ships/debrisLife.ts): their parts crumble
   * on their own ticks, worked out here, and nothing more is sent of them but their removal (1)
   */
  l?: number;
  /**
   * What it shed whole first (a boss's plates; common ships/debris.ts packSheds): each [fling, crumble, aloof, then
   * each group's length and parts]; its pieces come first in `e`, before those of `p`
   */
  g?: number[][];
  /** The ship was destroyed: its pose as the split took it [x, y, angle, vx, vy, angVel] (common ships/debris.ts splitPose) */
  s?: number[];
  /**
   * The client's copy isn't the structure the split started from (rebuilt again since its last sync): that structure's
   * centre of mass (grid), and every piece's parts' HP in order, to a tenth; `s` then too
   */
  c?: number[];
  h?: number[];
}

/**
 * Ships leaving and coming back into its view (CAPS.FOCUS, network/cells.ts AwayShips), sent just before the snapshot of
 * `tick`, applied in this order: `b` ids away that are in its view again with that snapshot (put back what was kept of
 * them: their keyframe is in the snapshot, their row only if it changed, structure and HP only as syncs of what
 * changed); `k` ids leaving its view with it (in its `out`): keep their structure and status row
 */
export interface ServerCellsMessage {
  type: 'cells';
  tick: number;
  b?: number[];
  k?: number[];
}

/**
 * Its system's crowd level (CAPS.CROWD, protocol 41; network/crowd.ts), from system tick `tick` on: `lv` the level,
 * `f` the focus radius (the ghost fade is its last km), `w` the snapshot window (ticks), `r` the system's ticks a
 * second (60: none slowed; less: its clock turns at `tick`). Sent on a change and on entering a system that has one
 */
export interface ServerCrowdMessage {
  type: 'crowd';
  tick: number;
  lv: number;
  f: number;
  w: number;
  r: number;
}

/** The client has no blueprint for this ship (it was dropped): send a full sync */
export interface ClientShipNeedMessage {
  type: 'shipNeed';
  id: number;
}

export interface ServerShipEditResultMessage {
  type: 'shipEditResult';
  ok: boolean;
  errors: string[];
}

