/**
 * A pilot's own ship on its client's tick-aligned layer (CAPS.OWN_SIM; common network/ownTick.ts, docs/design/
 * confirmed-hits.md part G): what the server expects its client's check to say for each snapshot it sent, and what
 * it does when a check says otherwise.
 *
 * The client steps its own ship itself (its inputs, and the causes the snapshots tell it), and Replication runs the
 * same steps on its shadow, so a mismatch means something neither side foresaw (a bug, a lost message, a client
 * that isn't ours). Then: its own ship gets a keyframe with the next snapshot (state hash off), or its part HP again
 * (HP hash off). Checks for snapshots before the fix went out are not judged again. The client chooses how often it
 * checks (OWN_CHECK_RULES by its own record); a lying client only gets its own view wrong.
 */
import { unwrapTick12, ownBodyHash, ownHpHash, type OwnCheck, type FlightBody } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';

/** Snapshots remembered per client (2 s at 20 a second: a check rides its client's next input or goes in 4 s at most) */
const KEEP = 80;

export interface OwnChecksHost {
  tick(): number;
  /** The fix for a state hash off: its own ship's keyframe with the next snapshot */
  rekey(conn: ClientConnection): void;
  /** ...for an HP hash off: its own part HP again */
  resyncHp(conn: ClientConnection): void;
}

interface Expect { ticks: number[]; at: Map<number, number>; fixedAt: number }

export class OwnChecks {
  readonly stats = { checks: 0, agreed: 0, bodyOff: 0, hpOff: 0, stale: 0, unknown: 0 };
  private readonly by = new WeakMap<ClientConnection, Expect>();

  constructor(private readonly host: OwnChecksHost) {}

  /** A snapshot went to it: its own ship then (real: what its own layer has, keyframed or stepped), its controls and HP copy */
  note(conn: ClientConnection, tick: number, body: FlightBody, bits: number, q: number, hp: readonly number[] | undefined, extra = 0): void {
    let e = this.by.get(conn);
    if (!e) this.by.set(conn, (e = { ticks: [], at: new Map(), fixedAt: -Infinity }));
    // (`extra`: every other ship it holds then, Replication.heldByte, and the homing shells it runs)
    e.at.set(tick, ((ownBodyHash(body, bits, q) + extra) & 0xff) | ((hp ? ownHpHash(hp) : 0) << 8));
    e.ticks.push(tick);
    while (e.ticks.length > KEEP) e.at.delete(e.ticks.shift()!);
  }

  /** A check (on an input): judged against that snapshot's; off, the fix goes and the client's level rises (its own rule) */
  check(conn: ClientConnection, c: OwnCheck): void {
    const e = this.by.get(conn);
    this.stats.checks++;
    if (!e) { this.stats.unknown++; return; }
    const tick = unwrapTick12(c.tick & 0xfff, this.host.tick());
    // (Made before the last fix reached it: it says nothing new)
    if (tick <= e.fixedAt) { this.stats.stale++; return; }
    const want = e.at.get(tick);
    if (want === undefined) { this.stats.unknown++; return; }
    const bodyOk = (want & 0xff) === (c.body & 0xff), hpOk = want >>> 8 === (c.hp & 15);
    if (bodyOk && hpOk) { this.stats.agreed++; return; }
    e.fixedAt = this.host.tick();
    if (!bodyOk) { this.stats.bodyOff++; this.host.rekey(conn); }
    if (!hpOk) { this.stats.hpOff++; this.host.resyncHp(conn); }
  }
}
