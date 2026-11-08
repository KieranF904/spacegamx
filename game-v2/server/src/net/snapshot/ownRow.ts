/**
 * @contract server.snapshot.own-row
 * owns:       a pilot's own ship in its snapshot: whether its own row goes and as a correction (selfRowState), its full
 *             state now for the head hash and ownSyncs (ownNow), its hazards' key, and its check's expectation (noteOwn)
 * needs:      OwnRowHost (world, ships, replication, ownChecks, bodies, guides, ticks), common sim/headHash; npm: bitecs
 * invariants: its own row goes only when its prediction needs correcting or its status changed — server/src/net/own/ownSim.test.ts
 *             a hazard running out on its own is no ownSync — none pinned
 * extend:     a new value its flight depends on is one more slot in selfNow (and ClientConnection.selfState)
 */
import { hasComponent, type IWorld } from 'bitecs';
import {
  Position, Velocity, Rotation, Dead, PILOT_ROW, ownStateHash, ownBodyHash, replicasByte, type OwnExtras, type HazardState,
} from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { Replication } from '../Replication.js';
import type { OwnChecks } from '../own/OwnChecks.js';
import type { BodyNet } from '../decisions/BodyNet.js';
import type { GuideNet } from '../guides/GuideNet.js';
import type { SnapRow } from './rows/keys.js';

/** A pilot's own ship as its client's tick layer should have it at the snapshot's tick (OwnRows.ownNow) */
export interface OwnNow { x: OwnExtras; hash: number }

/**
 * Its hazards as they stand for its next tick (EMP's end, slowing's end, numb's factor), from what its last ownSync told
 * it or from the server's now: the two differ only on a change its client can't foresee. A hazard running out isn't one:
 * its client runs it out itself, on the same tick
 */
export function ownHazardKey(h: Readonly<HazardState>, tick: number): string {
  const next = tick + 1;
  return `${h.empUntil > next ? h.empUntil : 0}|${h.slowUntil > next ? h.slowUntil : 0}|${h.numb}`;
}

/** A number for the self-row compare: anything JSON would have made null (non-numbers, NaN, infinities) is NaN */
const selfNum = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
const selfSame = (a: number, b: number): boolean => a === b || (a !== a && b !== b);

/** What the own-row path needs of the server */
export interface OwnRowHost {
  readonly world: IWorld;
  readonly ships: ShipBridge;
  readonly replication: Replication;
  readonly ownChecks: OwnChecks | null;
  readonly bodies: BodyNet | null;
  readonly guides: GuideNet | null;
  readonly ticks: { readonly currentTick: number };
}

export class OwnRows {
  private readonly world: IWorld;
  private readonly ships: ShipBridge;
  private readonly replication: Replication;
  private readonly ownChecks: OwnChecks | null;
  private readonly bodies: BodyNet | null;
  private readonly guides: GuideNet | null;
  private readonly ticks: { readonly currentTick: number };

  constructor(host: OwnRowHost) {
    this.world = host.world;
    this.ships = host.ships;
    this.replication = host.replication;
    this.ownChecks = host.ownChecks;
    this.bodies = host.bodies;
    this.guides = host.guides;
    this.ticks = host.ticks;
  }

  private get currentTick(): number {
    return this.ticks.currentTick;
  }

  /** The tick a pilot's slowing ends (0: not slowed): its own row goes again when it changes (features/weaponry) */
  private slowEnd(eid: number): number {
    const left = this.ships.slowedTicksLeft(eid);
    return left > 0 ? this.currentTick + left : 0;
  }

  /** Its own ship as its tick-aligned layer has it now (its full state, `now`; docked, its shadow), its HP copy */
  noteOwn(conn: ClientConnection, now: OwnNow | null): void {
    const id = conn.playerId, ship = this.ships.get(id), ctl = this.replication.controlsOf(id);
    if (!ship || !ctl) return;
    // (Docked, its shadow: what its last keyframe carried, Replication.stepOwn; its pose only)
    const held = this.replication.ownHeld(id);
    const own = held ? ownBodyHash(held, ctl.bits, ctl.q) : now?.hash;
    if (own === undefined) return;
    // (Every other ship it holds goes in the check too, and the homing shells it runs)
    let others = this.replication.heldByte(conn.repKnown, id, this.bodies ? (e) => this.bodies!.runs(conn, e) : undefined);
    if (this.guides) others += replicasByte(this.guides.heldSum(conn));
    this.ownChecks!.note(conn, this.currentTick, own, conn.shipHpSent.get(id), others);
  }

  /**
   * Its own ship as its tick layer should have it now (every client steps its own ship; common sim/headHash.ts): its
   * full state (the real ship, the controls it flew, its stores, guns, hazards and priming) and that state's hash.
   * Null when it isn't held (docked, dead, not yet known to it)
   */
  ownNow(conn: ClientConnection): OwnNow | null {
    const id = conn.playerId, ship = this.ships.get(id), ctl = this.replication.controlsOf(id);
    if (!ship || !ctl || !conn.repKnown.has(id) || this.replication.ownHeld(id) || hasComponent(this.world, Dead, id)) return null;
    const x = this.ships.ownExtras(id, this.currentTick);
    if (!x) return null;
    const body = { x: Position.x[id], y: Position.y[id], vx: Velocity.x[id], vy: Velocity.y[id], angle: Rotation.angle[id], angVel: ship.angVel, jump: ship.jump, jumpScale: ship.jumpScale, jumpAim: ship.jumpAim, jumpTo: ship.jumpTo, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir };
    return { x, hash: ownStateHash(id, body, ctl.bits, ctl.q, x, this.currentTick) };
  }

  /**
   * A client's own row this snapshot: whether it goes (`need`: its prediction needs correcting, its status changed, its
   * warmth too) and whether as a correction (`fix`: forced, an input applied late, a new keyframe
   * version, first sight, or a change to what its flight depends on, apart from its HP: its slowing ending too,
   * features/weaponry)
   */
  private readonly selfScratch = { need: false, fix: false, version: 0 };
  readonly selfNow: number[] = [0, 0, 0, 0, 0, 0, 0];
  selfRowState(conn: ClientConnection, r: SnapRow, prevStates: Map<number, string>): { need: boolean; fix: boolean; version: number } {
    const d = r.state.data ?? [];
    // (Numbers compared in place, no key strings: [hp, maxHp, then the five its flight depends on]; a non-number counts as
    // NaN, which equals itself here, as JSON turned them all to null)
    const now = this.selfNow;
    now[0] = selfNum(r.state.hp); now[1] = selfNum(r.state.maxHp);
    now[2] = selfNum(d[4]); now[3] = selfNum(d[5]); now[4] = selfNum(d[PILOT_ROW.field]); now[5] = selfNum(d[PILOT_ROW.warmth]); now[6] = selfNum(this.slowEnd(r.id));
    const was = conn.selfState;
    let flightSame = !!was, hpSame = !!was;
    if (was) {
      for (let i = 2; i < 7; i++) if (!selfSame(now[i], was[i])) { flightSame = false; break; }
      hpSame = selfSame(now[0], was[0]) && selfSame(now[1], was[1]);
    }
    // (Its client steps its own ship, so it goes by its own keyframe version: what its tick layer worked out itself (a
    // contact, a pull) is no correction; its drawn ship follows its tick layer, ShipClient.ownMoved)
    const version = this.replication.ownVersionOf(r.id) ?? this.replication.versionOf(r.id);
    const fix = conn.forceSnapshot || conn.selfLate || version !== conn.selfVersion || !prevStates.has(r.id) || !flightSame;
    // (No copy now and then just in case: its snapshots carry the head hash (sim/headHash.ts), a client that disagrees
    // with it checks at once, and the fix brings the row)
    const sc = this.selfScratch;
    sc.need = fix || !hpSame; sc.fix = fix; sc.version = version;
    return sc;
  }
}
