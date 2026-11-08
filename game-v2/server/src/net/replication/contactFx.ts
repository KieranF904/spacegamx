/**
 * @contract server.replication.contact-fx
 * owns:       contacts' sparks lately, and handing a CAPS.CONTACTS client those of pairs it doesn't find itself
 * needs:      causes/contactsFor ContactWindow (pair), the contact stats it counts into; npm: @space-game/common
 * invariants: a spark a client finds itself is never sent to it — none pinned
 * extend:     a new kind of contact effect rides ServerContactMessage, not a new list here
 */
import type { ServerContactMessage } from '@space-game/common';
import type { ContactWindow } from '../causes/contactsFor.js';

export class ContactFx {
  /** Contacts' sparks lately (CAPS.CONTACTS clients get those of pairs they don't find at their snapshot: contactFxFor) */
  private readonly fxPending: { tick: number; sys: number; a: number; b: number; msg: ServerContactMessage }[] = [];
  /** ...and the tick each such client was handed them up to */
  private readonly fxTo = new WeakMap<object, number>();

  constructor(private readonly contactStats: { fxSent: number; fxFound: number }) {}

  /** A contact's sparks (GameServer notifyContact): every other client got them at once */
  noteContactFx(tick: number, sys: number, a: number, b: number, msg: ServerContactMessage): void {
    this.fxPending.push({ tick, sys, a, b, msg });
    let n = 0;
    while (n < this.fxPending.length && this.fxPending[n].tick < tick - 128) n++;
    if (n) this.fxPending.splice(0, n);
  }

  /** A CONTACTS client's sparks since it was last handed them: those of pairs it doesn't find itself (`found`: its window's) */
  contactFxFor(conn: object, sys: number, found: ContactWindow | null, now: number): ServerContactMessage[] {
    const from = this.fxTo.get(conn) ?? now - 1;
    this.fxTo.set(conn, now);
    const out: ServerContactMessage[] = [];
    for (const f of this.fxPending) {
      if (f.tick <= from || f.tick > now || f.sys !== sys) continue;
      if (found?.pair(f.a, f.b, f.tick)) { this.contactStats.fxFound++; continue; }
      out.push(f.msg);
      this.contactStats.fxSent++;
    }
    return out;
  }
}
