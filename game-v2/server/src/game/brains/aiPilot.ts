/**
 * The enemy AI's commander and pilot split (docs/design/decision-inputs.md 6.5): Enemies.ts thinks (its commander: the
 * state, the target, the waypoint, the strafe side, the aim error) and hands this the order it makes of them each tick;
 * this decides what changed (common bodies/decisions.ts: TARGET, SIDE, WANT carrying the order; SYNC when its body
 * takes over, OFF when it can't) and flies the ship by the shared pilot (common bodies/aiPilot.ts), as every client
 * running it does from the same decisions (CAPS.PILOTS).
 *
 * Its body is on while the ship it fights is a pilot's or there's none: a pilotless target (a ward, a siege's prey)
 * is stepped among the pilotless ships in the server's own order, which no client keeps, so then the rows fly it.
 */

import {
  CTL, DECISION, applyDecision, sameWant, syncArgs, aiPilot, bodyKindOf, dequantizeCursorAngle, quantizeCursorAngle,
  type AiPilotOut, type BodyPose, type BodyState, type WantRec,
} from '@space-game/common';
import type { PilotOrders } from '../../ships/ShipBridge.js';

const AI_KIND = bodyKindOf('ai');

export interface AiPilotHost {
  tick(): number;
  /** A decision for the clients that run its body (net/decisions/BodyNet.ts) */
  decide?(eid: number, op: number, args: readonly number[], state: BodyState): void;
}

interface Flown {
  body: BodyState;
  /** The aim it flew with last tick (its held heading) */
  q?: number;
}

export class AiPilots {
  private readonly flown = new Map<number, Flown>();

  constructor(private readonly host: AiPilotHost) {}

  /**
   * This tick's flight for ship `eid`: its target (-1: none), strafe side and order; `bodied` false for a pilot whose
   * flight a boss's brain takes over (Enemies.pilot: no decisions of it, the brain has its own body)
   */
  fly(eid: number, target: number, side: number, want: WantRec, me: BodyPose, tgt: BodyPose | null, centroid: readonly [number, number] | null, bodied: boolean): AiPilotOut {
    const now = this.host.tick();
    let f = this.flown.get(eid);
    if (!f) this.flown.set(eid, (f = { body: { kind: AI_KIND, homeX: 0, homeY: 0, stage: 1, side: 1, target: -1, want, wantAt: now, on: false } }));
    const b = f.body, sd = side > 0 ? 1 : -1;
    if (bodied && !b.on) {
      // (Its body takes over (again): the whole state; the clients running it start from it here)
      b.on = true; b.target = target; b.side = sd; b.want = want; b.wantAt = now;
      this.host.decide?.(eid, DECISION.SYNC, syncArgs(b), b);
    } else if (bodied) {
      if (b.target !== target) this.decide(eid, b, DECISION.TARGET, [target + 1]);
      if (b.side !== sd) this.decide(eid, b, DECISION.SIDE, [sd > 0 ? 1 : 0]);
      if (!sameWant(b.want, want)) this.decide(eid, b, DECISION.WANT, want);
    } else {
      if (b.on) this.decide(eid, b, DECISION.OFF, []);
      b.target = target; b.side = sd;
      if (!sameWant(b.want, want)) { b.want = want; b.wantAt = now; }
    }
    const out = aiPilot(b, me, tgt, centroid, now, eid, f.q ?? quantizeCursorAngle(me.angle));
    f.q = out.q;
    return out;
  }

  /** Its controls as PilotOrders has them (its body's, when it's on: the clients running it make the same) */
  orders(eid: number, out: AiPilotOut, firing: boolean, target: number): PilotOrders {
    const on = this.flown.get(eid)?.body.on;
    const controls = {
      forward: (out.bits & CTL.forward) !== 0, backward: (out.bits & CTL.backward) !== 0, left: (out.bits & CTL.left) !== 0, right: (out.bits & CTL.right) !== 0,
      boost: (out.bits & CTL.boost) !== 0, targetAngle: dequantizeCursorAngle(out.q),
    };
    return { controls, firing, aim: out.aim, aimDist: out.aimDist, target, body: on ? { bits: out.bits, q: out.q, ix: 0, iy: 0 } : undefined };
  }

  /** A ship gone (its pilot forgotten): its body stops on every client running it */
  forget(eid: number): void {
    const f = this.flown.get(eid);
    if (!f) return;
    this.flown.delete(eid);
    if (f.body.on) this.decide(eid, f.body, DECISION.OFF, []);
  }

  private decide(eid: number, b: BodyState, op: number, args: readonly number[]): void {
    applyDecision(b, op, args, this.host.tick());
    this.host.decide?.(eid, op, args, b);
  }
}
