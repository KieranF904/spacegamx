/**
 * Trading between pilots: ask someone nearby to trade, both put up items and
 * credits, both accept, and the swap happens at once (all or nothing).
 *
 * Changing an offer clears both acceptances, so nobody can switch the goods at
 * the last moment. Offers come from your hold (plus storage at a station); what
 * you receive goes to storage, which every station shares. Flying apart,
 * leaving or dying calls it off.
 */

import { Bag, ServerMessage, TradeOfferView, countOf } from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';

/** Pilots must stay this close to trade */
export const TRADE_RANGE = 2500;
const REQUEST_MS = 45_000;

export interface TradeHost {
  send(conn: PilotConn, msg: ServerMessage): void;
  byEntity(eid: number): PilotConn | undefined;
  /** Distance between two pilots' ships (Infinity if apart or not flying) */
  distance(a: PilotConn, b: PilotConn): number;
  now(): number;
  log?(text: string): void;
}

interface Offer { items: Bag; credits: number }
interface Session { a: PilotConn; b: PilotConn; offers: Map<PilotConn, Offer>; accepted: Set<PilotConn> }

export class Trade {
  private sessions = new Map<PilotConn, Session>();
  private requests = new Map<PilotConn, { from: PilotConn; at: number }>();

  constructor(private host: TradeHost, private pilots: Pilots) {}

  request(conn: PilotConn, msg: { id: number }): void {
    const other = this.host.byEntity(Number(msg.id));
    if (!other || other === conn) return;
    if (this.sessions.has(conn)) return this.pilots.toast(conn, 'Finish your current trade first', 'warn');
    if (this.sessions.has(other)) return this.pilots.toast(conn, `${other.username} is busy trading`, 'warn');
    if (this.host.distance(conn, other) > TRADE_RANGE) return this.pilots.toast(conn, `Fly within ${TRADE_RANGE / 1000} km of ${other.username} to trade`, 'warn');
    // They asked us already: that's a yes
    if (this.requests.get(conn)?.from === other) { this.requests.delete(conn); this.open(other, conn); return; }
    this.requests.set(other, { from: conn, at: this.host.now() });
    this.host.send(other, { type: 'tradeRequest', from: conn.username, id: conn.playerId });
    this.pilots.toast(conn, `Asked ${other.username} to trade`, 'info');
  }

  respond(conn: PilotConn, msg: { accept: boolean }): void {
    const r = this.requests.get(conn);
    this.requests.delete(conn);
    if (!r || this.host.now() - r.at > REQUEST_MS) return this.pilots.toast(conn, 'That trade request has expired', 'warn');
    if (!msg.accept) return this.pilots.toast(r.from, `${conn.username} doesn't want to trade`, 'info');
    if (this.sessions.has(conn) || this.sessions.has(r.from)) return this.pilots.toast(conn, 'One of you is already trading', 'warn');
    if (this.host.distance(conn, r.from) > TRADE_RANGE) return this.pilots.toast(conn, `You're too far from ${r.from.username}`, 'warn');
    this.open(r.from, conn);
  }

  private open(a: PilotConn, b: PilotConn): void {
    const s: Session = { a, b, offers: new Map([[a, { items: {}, credits: 0 }], [b, { items: {}, credits: 0 }]]), accepted: new Set() };
    this.sessions.set(a, s);
    this.sessions.set(b, s);
    this.update(s);
  }

  /** Set what you're offering (replaces the whole offer) */
  offer(conn: PilotConn, msg: { items: Bag; credits: number }): void {
    const s = this.sessions.get(conn);
    const p = this.pilots.get(conn);
    if (!s || !p) return;
    const items: Bag = {};
    for (const [id, raw] of Object.entries(msg.items ?? {})) {
      const n = Math.floor(Number(raw));
      if (!this.pilots.econ.items.has(id) || !(n > 0)) continue;
      const have = this.have(conn, id);
      if (have <= 0) continue;
      items[id] = Math.min(n, have);
    }
    if (Object.keys(items).length > 12) return this.pilots.toast(conn, 'Twelve kinds of item at most per trade', 'warn');
    const credits = Math.max(0, Math.min(p.credits, Math.floor(Number(msg.credits) || 0)));
    s.offers.set(conn, { items, credits });
    s.accepted.clear();
    this.update(s);
  }

  accept(conn: PilotConn): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    s.accepted.add(conn);
    if (s.accepted.size < 2) { this.update(s); return; }
    this.execute(s);
  }

  cancel(conn: PilotConn, reason = 'cancelled'): void {
    const s = this.sessions.get(conn);
    if (!s) return;
    this.close(s, `${conn.username} ${reason} the trade`);
  }

  /** Disconnected, died or jumped away */
  remove(conn: PilotConn): void {
    this.requests.delete(conn);
    if (this.sessions.has(conn)) this.cancel(conn, 'left');
  }

  /** Twice a second: trades between pilots who've drifted apart are off */
  tick(tick: number): void {
    if (tick % 30) return;
    for (const s of new Set(this.sessions.values())) {
      if (this.host.distance(s.a, s.b) > TRADE_RANGE * 1.3) this.close(s, 'You flew too far apart: trade cancelled');
    }
  }

  private have(conn: PilotConn, id: string): number {
    const p = this.pilots.get(conn)!;
    return countOf(p.cargo, id) + (this.pilots.atStation(conn) ? countOf(p.storage, id) : 0);
  }

  private execute(s: Session): void {
    const pa = this.pilots.get(s.a), pb = this.pilots.get(s.b);
    const oa = s.offers.get(s.a)!, ob = s.offers.get(s.b)!;
    if (!pa || !pb) return this.close(s, 'Trade failed');
    // Check everything is still there before anything moves
    const ok = (conn: PilotConn, o: Offer) => this.pilots.get(conn)!.credits >= o.credits && Object.entries(o.items).every(([id, n]) => this.have(conn, id) >= n);
    if (!ok(s.a, oa) || !ok(s.b, ob)) {
      s.accepted.clear();
      for (const c of [s.a, s.b]) this.pilots.toast(c, 'Something offered is no longer there: check the offers and accept again', 'warn');
      return this.update(s);
    }
    const from = (conn: PilotConn) => (this.pilots.atStation(conn) ? 'any' : 'cargo') as 'any' | 'cargo';
    if (!this.pilots.take(s.a, oa.items, from(s.a)) || !this.pilots.take(s.b, ob.items, from(s.b))) return this.close(s, 'Trade failed');
    this.pilots.addCredits(s.a, ob.credits - oa.credits);
    this.pilots.addCredits(s.b, oa.credits - ob.credits);
    if (Object.keys(ob.items).length) this.pilots.give(s.a, ob.items, { toStorage: true, source: 'trade' });
    if (Object.keys(oa.items).length) this.pilots.give(s.b, oa.items, { toStorage: true, source: 'trade' });
    for (const c of [s.a, s.b]) { this.pilots.bumpStat(c, 'trades'); this.pilots.sendItems(c); this.pilots.saveNow(c); }
    this.host.log?.(`trade ${s.a.username} ⇄ ${s.b.username}: ${JSON.stringify(oa)} for ${JSON.stringify(ob)}`);
    this.close(s, 'Trade complete: what you received is in storage', true);
  }

  private close(s: Session, text: string, good = false): void {
    this.sessions.delete(s.a);
    this.sessions.delete(s.b);
    for (const c of [s.a, s.b]) {
      this.host.send(c, { type: 'trade', open: false, with: '', mine: { items: {}, credits: 0 }, theirs: { items: {}, credits: 0 }, myAccept: false, theirAccept: false });
      this.pilots.toast(c, text, good ? 'good' : 'info');
    }
  }

  private update(s: Session): void {
    for (const [me, them] of [[s.a, s.b], [s.b, s.a]] as const) {
      const view = (o: Offer): TradeOfferView => ({ items: { ...o.items }, credits: o.credits });
      this.host.send(me, {
        type: 'trade', open: true, with: them.username, withId: them.playerId,
        mine: view(s.offers.get(me)!), theirs: view(s.offers.get(them)!),
        myAccept: s.accepted.has(me), theirAccept: s.accepted.has(them),
      });
    }
  }
}
