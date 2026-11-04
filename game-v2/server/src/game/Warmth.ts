/**
 * Cold on pilots' ships (common/src/ships/warmth.ts; data/hazards.json `warmth`). A few times a second each pilot's
 * warmth is stepped: in a cold place (the system's cryo rating) it runs down, slower through an insulated hull, unless
 * there's heat close by (a star, a station, a ship on fire, a lava world), which brings it back; anywhere else it comes
 * back by itself. Frozen through, the ship seizes up (ShipBridge.warm). Ships without a pilot (frost-gemmed foes) only
 * ever lose warmth to hits: they get it back here at the ambient rate.
 *
 * The pilot is told its warmth in its snapshot (data[PILOT_ROW.warmth]) and gets a word when it slips a stage (a toast).
 */

import { hazardsAt, insulationOf, stepWarmth, starHeat, warmthStage, warmthPercent, planetPosition, type HazardRules, type StarSystemData, type WarmthRules, type WarmthStageName, dhypot } from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { PilotConn } from './Pilots.js';

export interface WarmthHost {
  /** Pilots flying now (docked ones too), and their ship entities */
  flying(): Iterable<{ conn: PilotConn; eid: number }>;
  system(eid: number): StarSystemData | undefined;
  /** The system an entity is in (to match ships on fire with it) */
  systemNum(eid: number): number;
  position(eid: number): { x: number; y: number };
  /** Berthed at a station */
  docked(eid: number): boolean;
  /** The stations in an entity's system: where, and their hull's radius */
  stations(eid: number): Iterable<{ x: number; y: number; radius: number }>;
  toast(conn: PilotConn, text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  tick(): number;
}

/** Ticks between steps */
const STEP = 15;

/** What a pilot is told when it slips into a stage */
const TOLD: Partial<Record<WarmthStageName, { text: string; kind: 'warn' | 'bad' }>> = {
  chilled: { text: 'Chilled: any colder and your drive goes numb. Stars, stations and fires warm you back up', kind: 'warn' },
  numb: { text: 'Numb with cold: thrust and steering are down too. Get near heat', kind: 'bad' },
  frozen: { text: 'Frozen through: your ship seizes up', kind: 'bad' },
};
const ORDER: WarmthStageName[] = ['warm', 'chilled', 'numb', 'frozen'];

export class Warmth {
  /** The coldest stage each pilot has been told of (forgotten once it's warm again) */
  private told = new Map<number, WarmthStageName>();

  constructor(private host: WarmthHost, private ships: ShipBridge, private rules: HazardRules) {}

  private get w(): WarmthRules | undefined {
    return this.rules.warmth;
  }

  /** Heat coming in a second at a pilot's ship: the best source in reach */
  heatAt(eid: number, sys: StarSystemData, x: number, y: number): number {
    const src = this.w?.sources;
    if (!src) return 0;
    let heat = 0;
    // (Any star: as hazardsAt has it, not a black hole and not a surface's 'none')
    const type = sys.centralBody?.type ?? 'sun';
    if (src.star && type !== 'black_hole' && type !== 'none') heat = Math.max(heat, starHeat(this.w!, dhypot(x, y), sys.centralBody?.radius ?? sys.starRadius ?? 0));
    if (src.station) {
      if (this.host.docked(eid)) heat = Math.max(heat, src.station.docked);
      else for (const st of this.host.stations(eid)) if (dhypot(st.x - x, st.y - y) < st.radius + src.station.margin) heat = Math.max(heat, src.station.rate);
    }
    if (src.burning && heat < src.burning.rate) {
      const num = this.host.systemNum(eid);
      for (const b of this.ships.burning()) {
        if (this.host.systemNum(b.eid) !== num) continue;
        const p = this.host.position(b.eid);
        if (dhypot(p.x - x, p.y - y) < src.burning.radius) { heat = Math.max(heat, src.burning.rate); break; }
      }
    }
    if (src.planet && heat < src.planet.rate) {
      for (const pl of sys.planets ?? []) {
        if (!src.planet.kinds.includes(pl.kind)) continue;
        const p = planetPosition(pl, this.host.tick());
        if (dhypot(p.x - x, p.y - y) < pl.radius + src.planet.margin) { heat = Math.max(heat, src.planet.rate); break; }
      }
    }
    return heat;
  }

  tick(): void {
    const w = this.w, now = this.host.tick();
    if (!w || now % STEP) return;
    const dt = STEP / 60;
    const pilots = new Set<number>();
    for (const { conn, eid } of this.host.flying()) {
      pilots.add(eid);
      const ship = this.ships.get(eid);
      const sys = this.host.system(eid);
      if (!ship || ship.kind !== 'ship' || !sys) continue;
      const { x, y } = this.host.position(eid);
      const cryo = hazardsAt(this.rules, sys, x, y).cryo ?? 0;
      const was = this.ships.warmthOf(eid);
      if (cryo <= 0 && was >= 1) { this.told.delete(eid); continue; }
      const next = stepWarmth(w, was, dt, cryo, insulationOf(ship.derived), this.heatAt(eid, sys, x, y));
      this.ships.warm(eid, next - was, w.seizeTicks);
      this.tell(conn, eid, next);
    }
    // Ships with no pilot only lose warmth to hits: it comes back by itself
    for (const eid of [...this.ships.chilled()]) if (!pilots.has(eid)) this.ships.warm(eid, w.ambient * dt, w.seizeTicks);
    for (const eid of this.told.keys()) if (!pilots.has(eid)) this.told.delete(eid);
  }

  /** A word when a pilot slips into a colder stage than it's been told of (once each, till it's warm again) */
  private tell(conn: PilotConn, eid: number, warmth: number): void {
    const pct = warmthPercent(warmth);
    const stage = warmthStage(pct).name;
    if (pct >= 75) { this.told.delete(eid); return; }
    const before = this.told.get(eid) ?? 'warm';
    if (ORDER.indexOf(stage) <= ORDER.indexOf(before)) return;
    this.told.set(eid, stage);
    const t = TOLD[stage];
    if (t) this.host.toast(conn, t.text, t.kind);
  }
}
