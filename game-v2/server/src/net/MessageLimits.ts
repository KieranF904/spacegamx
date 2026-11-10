/**
 * @contract server.net.limits
 * owns:       per-connection token-bucket rate limits for expensive or player-reaching client messages
 * needs:      nothing imported; a WeakMap keyed by connection
 * invariants: a message type with a limit is dropped past its burst and passes under it —
 *             server/src/net/dispatch.test.ts
 * extend:     a new limited message is one entry in the limits table below (per minute, burst)
 */

/**
 * MessageLimits: per-connection rate limits for client messages that are
 * expensive (a design rebuilt and saved, every market priced, every account
 * ranked) or reach other players (chat, invites). Token buckets: `per` a
 * minute, up to a burst of `burst`. Generous: a person clicking never meets
 * them; a script spamming does, and its extra messages are dropped.
 *
 * Kept in a WeakMap by connection, so a closed connection's buckets go with it.
 * (Inputs have their own cap, MAX_INPUTS_PER_TICK; shareDesign, mapPing and the
 * contributor notes have their own cooldowns.)
 */

interface Limit { per: number; burst: number }

export const MESSAGE_LIMITS: Readonly<Record<string, Limit>> = {
  // Broadcast to everyone
  chat: { per: 40, burst: 8 },
  // The clock sync (the client pings every 2 s, 30 a minute)
  ping: { per: 120, burst: 20 },
  // Every market priced (the client asks every 20 s)
  marketScan: { per: 12, burst: 4 },
  // Every account sorted
  rankings: { per: 30, burst: 6 },
  ribbons: { per: 30, burst: 6 },
  // A design parsed, checked, rebuilt and the profile saved
  shipEdit: { per: 60, burst: 10 },
  slotSave: { per: 60, burst: 10 },
  designSave: { per: 60, burst: 10 },
  designDelete: { per: 60, burst: 10 },
  // A field plan diffed against the live ship and validated part by part (game/field/plan.ts), the ship refitted
  fieldPlan: { per: 60, burst: 10 },
  fieldPlanClear: { per: 60, burst: 10 },
  fieldRecycle: { per: 120, burst: 20 },
  // The gun range: going in sets a profile aside and moves the ship; a weapon pick rebuilds the cheat ship (game/gunRange)
  gunRangeEnter: { per: 20, burst: 4 },
  gunRangeWeapon: { per: 90, burst: 12 },
  // A weapon-group change refits the live ship (net/handlers/weaponGroups.ts)
  weaponGroups: { per: 60, burst: 10 },
  // Items moved into the repair bank and the profile saved
  bankDeposit: { per: 120, burst: 20 },
  // Popups on other people's screens
  partyInvite: { per: 20, burst: 6 },
  tradeRequest: { per: 20, burst: 6 },
  // Friends and private messages (game/social/Social.ts has its own, tighter windows that answer the sender)
  whisper: { per: 60, burst: 12 },
  friendRequest: { per: 20, burst: 6 },
  friendRespond: { per: 60, burst: 20 },
  friendRemove: { per: 30, burst: 10 },
  setStatus: { per: 20, burst: 6 },
  // The whole map sent again
  mapView: { per: 60, burst: 10 },
  // A loot pod each
  itemJettison: { per: 120, burst: 20 },
  pilotInfo: { per: 120, burst: 20 },
  // A ship's whole design resent (a client entering a crowded system asks for many at once)
  shipNeed: { per: 1200, burst: 200 },
  // Every part's HP of a few ships resent (confirmed hits: a client whose copy is off)
  hpResync: { per: 600, burst: 20 },
  packedResync: { per: 60, burst: 3 },
  // A Mine Bay's drop (each a decision every holder is told: about 4 a second)
  mineDrop: { per: 240, burst: 4 },
  // Docking Clamps: a press each (the lock, a swap of who steers, letting go: ships/features/clamp), about 4 a second
  clampDock: { per: 240, burst: 8 },
  clampSwap: { per: 240, burst: 8 },
  clampUndock: { per: 240, burst: 8 },
  // What it kept of cells it dropped (CAPS.FOCUS: one a few seconds at a cruise, a burst after a jump)
};

class Bucket {
  private tokens: number;
  private at: number;
  constructor(private limit: Limit, now: number) { this.tokens = limit.burst; this.at = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.limit.burst, this.tokens + ((now - this.at) / 60_000) * this.limit.per);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class MessageLimiter {
  private buckets = new WeakMap<object, Map<string, Bucket>>();
  /** Messages dropped, by type (admin stats, tests) */
  readonly dropped = new Map<string, number>();

  constructor(private now: () => number = () => Date.now(), private limits: Readonly<Record<string, Limit>> = MESSAGE_LIMITS) {}

  /** May this connection send one more of this type now? (Types without a limit always may) */
  allow(conn: object, type: string): boolean {
    const limit = Object.hasOwn(this.limits, type) ? this.limits[type] : undefined;
    if (!limit) return true;
    let mine = this.buckets.get(conn);
    if (!mine) { mine = new Map(); this.buckets.set(conn, mine); }
    const t = this.now();
    let b = mine.get(type);
    if (!b) { b = new Bucket(limit, t); mine.set(type, b); }
    if (b.take(t)) return true;
    this.dropped.set(type, (this.dropped.get(type) ?? 0) + 1);
    return false;
  }
}
