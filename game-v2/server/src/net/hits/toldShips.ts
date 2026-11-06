/**
 * The ships whose hits a client finding its own leaves to the server's records this window, beside those keyframed
 * (HitLedger.findable 'keyframed'; client SelfHits.onKeyframes / onCaused / onTouched): every ship a cause record names
 * (a pull, a contact: where it was mid-tick isn't what its replica says at the tick's end), and every ship a contact
 * pair the client found touched. Not a ship that isn't a pilot named only by a REBUILD cause: it rebuilt at the end of
 * its tick, after the collision step, and it is hit-tested where it was at the end of the tick before (it moves after
 * the collision step), so its replica's poses are exact either side of the rebuild, and the client keeps the structure
 * before (CAPS.STRUCTS: ShipStore.asOf). A pilot moves before the collision step: its pose on the rebuild's tick is its
 * replica's before the recentring, so its hits stay told.
 */
import { OWN_CAUSE } from '@space-game/common';

export function toldShips(keyed: ReadonlySet<number>, causes: readonly (readonly number[])[] | undefined, touched: Iterable<number> | undefined, pilot: (id: number) => boolean): ReadonlySet<number> {
  if (!causes?.length && !touched) return keyed;
  const out = new Set(keyed);
  // (network/causes.ts records: [ago, kind, id, (a contact's other), ...])
  for (const r of causes ?? []) {
    if (r[1] === OWN_CAUSE.REBUILD && !pilot(r[2])) continue;
    out.add(r[2]);
    if (r[1] === OWN_CAUSE.CONTACT) out.add(r[3]);
  }
  if (touched) for (const id of touched) out.add(id);
  return out;
}
