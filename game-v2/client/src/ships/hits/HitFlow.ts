/**
 * @contract client.ship.hit-flow
 * owns:       the order in which a frame's confirmed and client-found hits are searched, handed out and corrected around each snapshot
 * needs:      HitFlowHost (hits, selfHits, ownShells, otherGuns, guides, bodies, moves, store, state); npm: @space-game/common
 * invariants: the snapshot window is searched once, before anything that reads HP — none pinned
 *             hits found here are worked out before the told ones, as the server orders them — none pinned
 * extend:     a new hit-related server message is one more call to findHits() before it reads HP
 */

import { EntityType } from '@space-game/common';
import type { ServerMessage, ServerSnapshotMessage, ServerHitsMessage, ServerHitFixMessage, HitReport, EntityState, ServerHpCheckMessage } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipStore } from '../ShipStore';
import type { ConfirmedHits } from './ConfirmedHits';
import { toldHits, type SelfHits } from './SelfHits';
import type { OwnShells } from './OwnShells';
import type { OtherGuns } from '../guns/OtherGuns';
import type { GuideRunner } from '../guides/GuideRunner';
import type { BodyRunner } from '../bodies/BodyRunner';
import type { MoveRunner, TimedMoveMsg } from '../bodies/MoveRunner';
import { fillHull } from './fillHull';

/** The PT timeline's moves (ShipClient.ptMoves) */
export interface PtMoves { stRows(rows: readonly EntityState[]): void; stMsgs(timed: readonly TimedMoveMsg[]): ServerMessage[] }

export interface HitFlowHost {
  readonly store: ShipStore;
  readonly state: GameState;
  readonly hits: ConfirmedHits;
  readonly selfHits: SelfHits;
  readonly ownShells: OwnShells;
  readonly otherGuns: OtherGuns;
  readonly guides: GuideRunner;
  readonly bodies: BodyRunner;
  readonly moves: MoveRunner;
}

export class HitFlow {
  constructor(private readonly h: HitFlowHost) {}
  /** The tick of the snapshot last applied (a confirmed hit's tick counts back from it) */
  snapTick = 0;

  /** Handing out this frame's hits (their projectileHit messages aren't the old way) */
  handingOut = false;

  /** The ships the pairs it found itself touched in the last snapshot's window (their hits told) */
  touched: Set<number> | undefined;

  /**
   * A confirmed hits message (ships/hits/ConfirmedHits.ts): the messages the server would have sent go through
   * `handle` (the usual handlers draw them), then the hull bars, then the spent shells go. Finding hits here
   * (SelfHits on), they're the server's word on this frame's hits, and wait with them for the frame's end
   */
  onHits(msg: ServerHitsMessage, handle: (m: ServerMessage) => void): void {
    // (the snapshot's window searched with these records in: a shell told struck on a tick struck only that, SelfHits.detect)
    this.findHits(msg);
    if (this.h.selfHits.on) { this.h.hits.told(msg, this.snapTick); return; }
    this.handOut(this.h.hits.expand(msg, this.snapTick), handle);
  }

  /**
   * The last snapshot's window searched (SelfHits.detect), once: at its hits message (with its records), or before
   * anything else after it that reads the HP (shipHps, hpCheck, hitFix, the frame's end). The hits found are worked out
   * at once, before the told ones, as the server orders them (HitLedger.plan)
   */
  findHits(told?: ServerHitsMessage): void {
    if (!this.h.selfHits.waiting) return;
    const found = this.h.selfHits.detect(told ? toldHits(told.h, this.snapTick) : undefined);
    if (found.length) this.h.hits.own(found);
  }

  private handOut(r: { msgs: ServerMessage[]; ships: Set<number>; gone: number[] }, handle: (m: ServerMessage) => void): void {
    this.handingOut = true;
    try {
      for (const m of r.msgs) handle(m);
    } finally {
      this.handingOut = false;
    }
    for (const id of r.ships) fillHull(this.h.store, this.h.state.entities, id);
    for (const id of r.gone) { this.h.state.removeShell(id); this.h.guides.remove(id); }
    this.h.selfHits.spent(r.gone);
    this.h.ownShells.gone(r.gone);
    this.h.otherGuns.gone(r.gone);
  }

  /**
   * netCaps: the first after a join says finding hits here starts with the next snapshot (the server's journal starts
   * there too); each says the confirmation level (`lvl`: how often it reports; at STRICT the server tells every hit)
   */
  onNetCaps(lvl?: number): void {
    // (the snapshot before it was searched as it was)
    this.findHits();
    this.h.selfHits.setOn(true, this.snapTick);
    this.h.selfHits.setLevel(lvl);
  }

  /**
   * A snapshot applied (its replicas, rows and removals): its shells onto the tick-faithful layer (rows, and the fire
   * events' shells preSnapshot rebuilt, as the server spawned them); its window is searched with the frame's told
   * records (findHits: the hits found worked out before the frame's shipHps and hpCheck)
   */
  afterSnapshot(m: ServerSnapshotMessage): void {
    this.findHits();
    if (this.h.selfHits.on) {
      // (a fire event's shells, rebuilt exactly; a row's are rounded: they sit out, and the server tells their hits)
      const fired = new Set<number>();
      for (const f of m.fire ?? []) for (let i = 4; i < f.length; i++) fired.add(f[i]);
      for (const e of m.entities) {
        const d = e.data;
        if (e.type !== EntityType.Projectile) continue;
        // (your own built here, CAPS.SHOT_IDS: exact, unless your ship was keyframed in the window: then told, as the server has it)
        const own = this.h.ownShells.freshExact(e.id);
        if (own === false) { this.h.selfHits.row(e.id); continue; }
        if (!fired.has(e.id) && own === undefined) this.h.selfHits.row(e.id);
        else if (d && (d[10] ?? -1) >= 0) this.h.selfHits.addShell(e.id, d[6], d[10], d[3], d[4], d[5], e.vx ?? 0, e.vy ?? 0, d[7]);
      }
    }
    this.h.selfHits.onKeyframes(m.ships);
    this.h.selfHits.onCaused(m.causes);
    this.h.selfHits.onTouched(this.touched);
    this.touched = undefined;
    // (a boss its body flies here: its hits are the server's records until its body has its hit rules, HitLedger 'body')
    for (const id of this.h.bodies.told()) this.h.selfHits.onSync(id);
    // (searched once this frame's told records are in: findHits)
    this.h.selfHits.open(m.tick);
  }

  /** The frame's end: this frame's hits (found here and told) handed out, and into the chain */
  frameEnd(handle: (m: ServerMessage) => void, ptMoves: PtMoves | null): void {
    // (what bodies' moves drew this frame, CAPS.MOVES: as if the server had sent it; on the PT timeline, by it)
    const timed = this.h.moves.takeTimed();
    for (const msg of ptMoves ? ptMoves.stMsgs(timed) : timed.map((t) => t.msg)) handle(msg);
    this.findHits();
    // (Switched off in this frame, its hits still go: the netCaps came after the snapshot's records)
    if (!this.h.selfHits.on && !this.h.hits.hasPending) return;
    const { out, done } = this.h.hits.flushPending();
    this.h.selfHits.settle(done);
    if (done.length || out.gone.length) this.handOut(out, handle);
  }

  /** A correction (hitFix): the hits missed worked out and drawn, the wrong ones taken back, the chain the server's */
  onHitFix(msg: ServerHitFixMessage, handle: (m: ServerMessage) => void): void {
    this.findHits();
    if (!this.h.selfHits.on) return;
    const { missed, wrong } = this.h.selfHits.fix(msg);
    this.handOut(this.h.hits.corrected(missed, msg.t, wrong), handle);
  }

  /** The hit report for this input tick, if one is due (`riding`: an input goes anyway) */
  takeHitReport(riding: boolean): HitReport | undefined {
    return this.h.selfHits.on ? this.h.selfHits.takeReport(riding) : undefined;
  }

  /** The server's check of a ship's HP as this client should have it */
  onHpCheck(msg: ServerHpCheckMessage): void {
    this.findHits();
    this.h.hits.check(msg);
  }
}
