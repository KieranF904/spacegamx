/**
 * Contacts the own ship is predicted to make past the newest snapshot (its prediction: what is drawn). On ticks a
 * snapshot has covered, its contacts are the server's pass's to the bit (told CONTACT rows, or the pairs the tick layer
 * finds itself: ContactWorld). Past the newest one nothing is told yet and ContactWorld finds nothing (the other ships
 * aren't final there), so without this the ship drawn flew straight into a hull for as many ticks as it leads the
 * server, and was put back only when the snapshot came: against a big pinned body (the weapons range's dummies, a
 * boss) it sank deep into it.
 *
 * Here its own ship's pairs on such a tick are found as the server's pass finds them (each body near enough by both
 * reaches, in the pass's order: by ids) and worked out with the same contact maths on the real part geometry
 * (network/ownTick.ts applyCauseRows, ships/contact.ts), against each other ship as this client last had it, carried
 * on at its velocity: a CONTACT row with its state (CONTACT_FLAG.STATE) and CHECK. Nothing is sent and nothing is
 * kept: every snapshot steps those ticks again from what it says (OwnTick.onSnapshot), and where the prediction was
 * right that is the same state.
 *
 * Whether the other gives: a pinned ship (its first shipSync said so: ShipStore.pinned) takes none of the push, from
 * the first touch; any other by the mass shares, as the server's pass.
 */
import {
  CONTACT_FLAG, OWN_CAUSE, ReplicaMode, contactJumping, dhypot, pairPlace,
  type CauseRow, type FlightBody, type ShipReplicaSet, type ShipTuning,
} from '@space-game/common';
import type { StructSource } from '../ShipStore.js';

export interface AheadHost {
  reps: ShipReplicaSet;
  store: StructSource;
  tuning: ShipTuning;
  self(): number;
}

/**
 * Ticks at most another ship's last known state is carried on (past that it isn't predicted against). A pinned one is
 * carried any length: it stays where it was (a quiet stretch sends few snapshots, and its hull is still there)
 */
const CARRY_TICKS = 60;

/**
 * Its own ship's predicted contacts on tick t (past the newest snapshot), from its body after that tick's step (`body`)
 * and its reach: rows in the pass's order, each with its place (undefined: none)
 */
export function aheadContacts(h: AheadHost, t: number, body: FlightBody, reach: number, pinned: (id: number) => boolean): CauseRow[] | undefined {
  const { reps, store, tuning } = h, self = h.self();
  if (!(reach > 0) || contactJumping(body.jump, tuning)) return undefined;
  // (A clamped pair flies as one body: the pass leaves the two out of each other's pairs)
  const link = reps.clampPartner(self, t);
  let out: CauseRow[] | undefined;
  for (const id of reps.ids()) {
    if (id === self || id === link) continue;
    const mode = reps.modeOf(id);
    if (mode === undefined || mode === ReplicaMode.Docked || mode === ReplicaMode.Drift) continue;
    const ship = store.get(id), d = ship?.kind === 'ship' ? store.derivedAt?.(id, t) ?? ship.derived : undefined;
    if (!d || !(d.mass > 0) || reps.clampPartner(id, t) === self) continue;
    // (As this client last had it, at t or before: no ship is stepped here, it's part way through its own ship's step)
    const last = reps.lastOf(id), pin = pinned(id);
    if (last === undefined || (t - last > CARRY_TICKS && !pin)) continue;
    const k = Math.min(t, last), st = reps.ring.get(id, k);
    if (!st) continue;
    const b = st.body, dt = t - k;
    if (contactJumping(b.jump, tuning)) continue;
    const x = b.x + b.vx * dt, y = b.y + b.vy * dt;
    // (The pass's candidates: centres within both reaches)
    if (dhypot(x - body.x, y - body.y) > reach + d.radius) continue;
    const flags = CONTACT_FLAG.STATE | CONTACT_FLAG.CHECK | (id < self ? CONTACT_FLAG.SECOND : 0) | (pin ? CONTACT_FLAG.OTHER_PINNED : 0);
    (out ??= []).push({ seq: pairPlace(self, id), row: [OWN_CAUSE.CONTACT, id, flags, x, y, b.angle + b.angVel * dt, b.vx, b.vy] });
  }
  return out?.sort((a, b) => a.seq - b.seq);
}
