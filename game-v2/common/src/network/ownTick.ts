/**
 * A pilot's own ship on its tick-aligned layer (CAPS.OWN_SIM; docs/design/confirmed-hits.md part G). The client builds
 * it itself: its own inputs at the ticks the server ran them (the input's target tick), stepped with the shared replica
 * step (ships/replica.ts), plus the few things that moved the ship which its inputs don't say, each sent as its cause
 * at its tick (a snapshot's `own` rows) and worked out here alike on both sides:
 *
 *   PULL     [ago, 0, dvx, dvy]: a pull's push on the ship's velocity (on the PULL_PLACES grid). TEMPORARY: boss and
 *            weapon pulls (a Scrap Mother's magnets, a collapsing star) come from server-side decisions; they go as
 *            their push until those decisions are inputs the client steps itself
 *   CONTACT  [ago, 1, other, flags, (x, y, angle, vx, vy)]: the ship touched another body; the push is worked out
 *            here (ships/contact.ts contactPair), from the other's pose as the client has it (its replica), or as the
 *            row gives it (CONTACT_FLAG.STATE: the client's replica of it isn't the server's on that tick, e.g. a boss
 *            whose drive isn't replicated: TEMPORARY until AI decisions are inputs)
 *   REBUILD  [ago, 2]: the ship was rebuilt (parts lost or regrown) on that tick: it flew the structure it had until
 *            then (the client keeps it when the new one comes, shipSync) and its centre moved with its centre of mass
 *
 * Nothing here sends the ship's resulting state: a client works every push out. The server runs the same functions
 * on its shadow of the ship (net/Replication.ts), so it knows the client has its ship exactly; the client also hashes
 * its own state (OwnCheck) onto inputs it sends anyway, a check against anything neither side foresaw.
 */

import type { FlightBody } from '../ships/flight.js';
import type { PlacedGeom } from '../ships/grid.js';
import type { Vec2 } from '../ships/types.js';
import { quantizeShipBody, SHIP_PRECISION } from '../ships/physics.js';
import { contactPieces, contactPair, recentreShift, type ContactBody } from '../ships/contact.js';
import { dpow } from '../math/detTrig.js';
import { hpChecksum, CONFIRM, CAPS } from './hits.js';

/** Do these caps have the client step its own ship itself (OWN_SIM, with OWN_SHOTS)? */
export function ownSimCaps(caps: number | undefined): boolean {
  return ((caps ?? 0) & (CAPS.OWN_SHOTS | CAPS.OWN_SIM)) === (CAPS.OWN_SHOTS | CAPS.OWN_SIM);
}

/** A tick-layer cause's kind (a snapshot's `own` row's second value) */
export const OWN_CAUSE = { PULL: 0, CONTACT: 1, REBUILD: 2 } as const;

/** A CONTACT row's flags */
export const CONTACT_FLAG = {
  /** The other body is pinned (it doesn't give: all the push is the ship's) */
  OTHER_PINNED: 1,
  /** The other's pose and velocity follow, as the server's contact pass had them */
  STATE: 2,
  /** The ship was the pair's second body (the pass takes pairs in its own order; the maths isn't symmetric to the bit) */
  SECOND: 4,
  /** The ship itself is pinned */
  SELF_PINNED: 8,
  /** The other was rebuilt after the contact, in this window: it had the structure from before (the client's, before its shipSync) */
  OTHER_BEFORE: 16,
} as const;

/** TEMPORARY (with boss decisions as inputs it goes): a pull's push, rounded to this many places so it is sent exactly */
export const PULL_PLACES = 5;

const PULL_K = dpow(10, PULL_PLACES);
export function quantizePull(v: number): number {
  const r = Math.round(v * PULL_K) / PULL_K;
  return r === 0 ? 0 : r;
}

/** What a contact needs of a body's structure: its parts' outlines, which stand, its centre of mass, mass and reach */
export interface OwnShape {
  geom: readonly PlacedGeom[];
  alive: readonly boolean[];
  com: Vec2;
  mass: number;
  radius: number;
  /** More parts than the contact pass transforms whole (bridge core BIG_BODY): only its pieces near the other count */
  big: boolean;
}

/** Bodies with more parts than this only have the pieces near what they touch put in world space (the server's BIG_BODY) */
export const CONTACT_BIG_BODY = 40;

/** What applying one tick's causes needs (each side supplies its own: the server its shadow's, the client its layer's) */
export interface OwnCauseEnv {
  cellSize: number;
  restitution: number;
  /** The ship's structure on that tick (before a rebuild on it) */
  self: OwnShape | null;
  /** Another body's structure, and where it was on that tick as this side has it */
  other(id: number): { shape: OwnShape; body: ContactBody & { angle: number } } | null;
  /** A rebuild on that tick: where its centre of mass was and went (grid units) */
  rebuilt(): { from: Vec2; to: Vec2 } | null;
}

/**
 * One tick's causes (rows without their `ago`: [kind, ...]), in the order the server's step had them, onto the ship's
 * body after its own step; then it is rounded as every body is at a tick's end. False: one couldn't be worked out
 * here (a structure not had); the body is then left as far as it got.
 */
export function applyOwnCauses(body: FlightBody, rows: readonly (readonly number[])[], env: OwnCauseEnv): boolean {
  const ok = applyCauseRows(body, rows, env);
  quantizeShipBody(body);
  return ok;
}

/**
 * The causes alone, unrounded (as the server's step has a body between them: a contact later in the same tick reads it
 * so). False: one couldn't be worked out here
 */
export function applyCauseRows(body: FlightBody, rows: readonly (readonly number[])[], env: OwnCauseEnv): boolean {
  let ok = true;
  for (const r of rows) {
    switch (r[0]) {
      case OWN_CAUSE.PULL:
        body.vx += r[1];
        body.vy += r[2];
        break;
      case OWN_CAUSE.CONTACT: {
        const id = r[1], flags = r[2];
        const o = env.other(id), self = env.self;
        if (!o || !self) { ok = false; break; }
        const ob = flags & CONTACT_FLAG.STATE ? { x: r[3], y: r[4], angle: r[5], vx: r[6], vy: r[7] } : { ...o.body };
        const ps = contactPieces(self.geom, self.alive, self.com, env.cellSize, body, self.big ? { x: ob.x, y: ob.y, r: o.shape.radius } : undefined);
        const po = contactPieces(o.shape.geom, o.shape.alive, o.shape.com, env.cellSize, ob, o.shape.big ? { x: body.x, y: body.y, r: self.radius } : undefined);
        const invS = flags & CONTACT_FLAG.SELF_PINNED ? 0 : 1 / self.mass, invO = flags & CONTACT_FLAG.OTHER_PINNED ? 0 : 1 / o.shape.mass;
        if (flags & CONTACT_FLAG.SECOND) contactPair(po, ps, ob, body, invO, invS, env.restitution);
        else contactPair(ps, po, body, ob, invS, invO, env.restitution);
        break;
      }
      case OWN_CAUSE.REBUILD: {
        const rb = env.rebuilt();
        if (!rb) { ok = false; break; }
        const w = recentreShift(rb.from, rb.to, env.cellSize, body.angle);
        if (w) { body.x += w[0]; body.y += w[1]; }
        break;
      }
      default:
        ok = false;
    }
  }
  return ok;
}

// ---- The check: a hash of the client's tick-aligned own state, on inputs it sends anyway ----

/**
 * What a client says of its own ship as of a snapshot's tick (protocol 34, an input's flags2 0x80: 3 bytes): 8 bits
 * of its state's hash (place, velocity, heading, turn, the jump drive, the hold, and the controls it flew that tick
 * with, the engines' power among them), 4 of its part HP's (hpChecksum), and the tick's low 12
 */
export interface OwnCheck { body: number; hp: number; tick: number }

const q = (v: number, places: number) => Math.round(v * dpow(10, places));
const mix = (h: number, v: number) => Math.imul(h ^ (v | 0), 0x9e3779b1) ^ (Math.imul(h, 0x85ebca6b) >>> 13);

/** The low byte of a mix of the own ship's state at a tick and the controls it flew it with */
export function ownBodyHash(b: FlightBody, bits: number, aimQ: number): number {
  let h = 0x2545f491;
  h = mix(h, q(b.x, SHIP_PRECISION.pos)); h = mix(h, q(b.y, SHIP_PRECISION.pos));
  h = mix(h, q(b.vx, SHIP_PRECISION.vel)); h = mix(h, q(b.vy, SHIP_PRECISION.vel));
  h = mix(h, q(b.angle, SHIP_PRECISION.angle)); h = mix(h, q(b.angVel, SHIP_PRECISION.angVel));
  h = mix(h, b.jump ?? 0); h = mix(h, q(b.jumpScale ?? 1, 4)); h = mix(h, q(b.cargo ?? 0, 2)); h = mix(h, (b.dodge ?? 0) * 16 + (b.dodgeDir ?? 0));
  h = mix(h, bits); h = mix(h, aimQ);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return ((h ^ (h >>> 12)) >>> 0) & 0xff;
}

/** 4 bits of the own ship's part HP, as the server's copy of what the client has (hpChecksum) */
export function ownHpHash(hp: readonly number[]): number {
  const s = hpChecksum(hp);
  return (s ^ (s >>> 4) ^ (s >>> 8) ^ (s >>> 12)) & 15;
}

/** A tick from its low 12 bits: the one nearest `near` (an own check's tick, 34 s either way) */
export function unwrapTick12(low: number, near: number): number {
  const d = ((low - near) % 4096 + 4096 + 2048) % 4096 - 2048;
  return near + d;
}

/**
 * How often a client checks its own state, by its level (CONFIRM: the part E levels, here the client's own record:
 * NORMAL to start, ROUGH after a clean stretch, STRICT after a fix): at least `ride` input ticks between two checks
 * (they ride an input that goes anyway), and after `alone` one goes on its own, if its state changed since the last
 */
export const OWN_CHECK_RULES: readonly { ride: number; alone: number }[] = [
  { ride: 60, alone: 600 },
  { ride: 15, alone: 120 },
  { ride: 3, alone: 6 },
];

export function ownCheckRules(level: number): { ride: number; alone: number } {
  return OWN_CHECK_RULES[level] ?? OWN_CHECK_RULES[CONFIRM.NORMAL];
}
