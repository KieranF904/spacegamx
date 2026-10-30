/**
 * Moving markets and faction quartermasters.
 *
 * Every station's prices are its standing demand, this cycle's shift (a few
 * goods wanted, a couple glutted; common/src/econ/market.ts) and saturation:
 * what's been sold there lately, which recovers by half every half hour. Prices
 * are the same for everyone, so other pilots selling the same ore move them too.
 *
 * Quartermasters sell faction gear (kits, components, plate) to pilots in
 * good standing, cheaper the higher your rank.
 */

import {
  Economy, StationData, ServerMessage, VendorView, QuestsFile,
  marketShift, unitSellPrice, saleTotal, vendorPrice, repRank, REP_RANKS, RANK_DISCOUNT, MARKET_CYCLE_MS, MARKET_RECOVERY_MS,
} from '@space-game/common';
import type { Pilots, PilotConn } from './Pilots.js';

export interface MarketHost {
  now(): number;
  send(conn: PilotConn, msg: ServerMessage): void;
  stations(): StationData[];
  systemName(id: string): string;
  /** The station this pilot is at, or null */
  stationAt(conn: PilotConn): StationData | null;
}

export class Market {
  /** station → item → units sold lately (as of `at`) */
  private sat = new Map<string, Map<string, { n: number; at: number }>>();

  constructor(private host: MarketHost, private econ: Economy, private pilots: Pilots, private reps: QuestsFile['reputations']) {}

  /** Units sold here lately, decayed to now */
  saturation(station: string, id: string): number {
    const e = this.sat.get(station)?.get(id);
    if (!e) return 0;
    const n = e.n * Math.pow(0.5, (this.host.now() - e.at) / MARKET_RECOVERY_MS);
    return n < 0.5 ? 0 : n;
  }

  /** Standing demand × this cycle's shift */
  demand(st: StationData, id: string): number {
    const shift = marketShift(st.id, this.host.now(), this.econ.items);
    return (st.market?.demand?.[id] ?? 1) * (shift.wanted[id] ?? shift.glut[id] ?? 1);
  }

  /** What the next unit sells for here */
  price(st: StationData, id: string): number {
    return unitSellPrice(this.econ.items, id, this.demand(st, id), this.saturation(st.id, id));
  }

  /** Sell n here: returns the credits (and records the sale) */
  sell(st: StationData, id: string, n: number): number {
    const sat = this.saturation(st.id, id);
    const total = saleTotal(this.econ.items, id, n, this.demand(st, id), sat);
    const m = this.sat.get(st.id) ?? new Map();
    m.set(id, { n: sat + n, at: this.host.now() });
    this.sat.set(st.id, m);
    return total;
  }

  /** What the station screen shows: demand (standing × shift), saturation, and this cycle's wants */
  view(st: StationData): { demand: Record<string, number>; sat: Record<string, number>; wanted: string[]; glut: string[]; cycleEndsIn: number } {
    const now = this.host.now();
    const shift = marketShift(st.id, now, this.econ.items);
    const demand: Record<string, number> = { ...(st.market?.demand ?? {}) };
    for (const [id, k] of Object.entries({ ...shift.wanted, ...shift.glut })) demand[id] = (demand[id] ?? 1) * k;
    const sat: Record<string, number> = {};
    for (const id of this.sat.get(st.id)?.keys() ?? []) {
      const n = this.saturation(st.id, id);
      if (n > 0) sat[id] = Math.round(n * 10) / 10;
    }
    return { demand, sat, wanted: Object.keys(shift.wanted), glut: Object.keys(shift.glut), cycleEndsIn: MARKET_CYCLE_MS - (now % MARKET_CYCLE_MS) };
  }

  /** Where else pays best for these items, and what every market wants this cycle */
  scan(conn: PilotConn, ids: string[]): void {
    const here = this.host.stationAt(conn)?.id;
    const markets = this.host.stations().filter((s) => s.services.includes('market' as never) && s.id !== here);
    const best: Record<string, { station: string; name: string; system: string; price: number }[]> = {};
    for (const id of ids.slice(0, 80)) {
      if (!this.econ.items.has(id)) continue;
      best[id] = markets.map((s) => ({ station: s.id, name: s.name, system: this.host.systemName(s.system), price: this.price(s, id) }))
        .sort((a, b) => b.price - a.price).slice(0, 3);
    }
    this.host.send(conn, { type: 'marketScan', best });
  }

  // ---------------------------------------------------------------------------
  // Quartermasters
  // ---------------------------------------------------------------------------

  vendors(conn: PilotConn): void {
    const st = this.host.stationAt(conn);
    const p = this.pilots.get(conn);
    if (!st || !p) return;
    const out: VendorView[] = [];
    for (const [faction, r] of Object.entries(this.reps)) {
      if (!r.vendor?.stations.includes(st.id)) continue;
      const standing = p.reputation[faction] ?? 0;
      const rank = repRank(standing);
      out.push({
        faction, name: r.name, description: r.description, standing, rank: rank.rank, rankName: rank.name, next: rank.next, nextName: rank.nextName,
        discount: RANK_DISCOUNT[Math.max(0, rank.rank)] ?? 0,
        stock: r.vendor.stock.filter((s) => this.econ.items.has(s.item)).map((s) => ({
          item: s.item, price: vendorPrice(this.econ.items, s.item, rank.rank), rank: s.rank, rankName: REP_RANKS[s.rank]?.name ?? REP_RANKS[0].name,
          locked: rank.rank < s.rank,
        })),
      });
    }
    this.host.send(conn, { type: 'vendors', station: st.id, vendors: out });
  }

  buy(conn: PilotConn, msg: { faction: string; item: string; n: number }): void {
    const st = this.host.stationAt(conn);
    const p = this.pilots.get(conn);
    const r = this.reps[String(msg.faction)];
    if (!st || !p || !r?.vendor?.stations.includes(st.id)) return this.pilots.toast(conn, "That quartermaster isn't here", 'warn');
    const line = r.vendor.stock.find((s) => s.item === msg.item);
    if (!line || !this.econ.items.has(line.item)) return;
    const rank = repRank(p.reputation[msg.faction] ?? 0).rank;
    if (rank < line.rank) return this.pilots.toast(conn, `${r.name} only sells that to pilots they know better`, 'warn');
    const n = Math.max(1, Math.min(99, Math.floor(Number(msg.n) || 1)));
    const price = vendorPrice(this.econ.items, line.item, rank);
    if (p.credits < price * n) return this.pilots.toast(conn, 'Not enough credits', 'warn');
    this.pilots.addCredits(conn, -price * n);
    this.pilots.give(conn, { [line.item]: n }, { toStorage: true, source: 'bought' });
    this.pilots.toast(conn, `Bought ${n > 1 ? `${n} × ` : ''}${this.econ.items.name(line.item)} from the ${r.name} quartermaster`, 'good');
    this.pilots.saveNow(conn);
    this.vendors(conn);
  }
}
