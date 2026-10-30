/**
 * Hazards on pilots' ships (data/hazards.json, ships/hazards.ts). Once a
 * second, each pilot's ship is weighed against where it is: the system's
 * ratings (higher near its star or black hole) less what its build tolerates.
 * What it's short of costs it, per point: radiation wears every part,
 * corrosion wears armour and makes repairs dearer, heat makes beams run hot
 * and shields slow to come back, an electromagnetic storm seizes the ship up
 * now and then. Only what the server works out alone: nothing here moves a
 * ship or changes its battery, so clients' prediction is untouched.
 */

import { hazardsAt, hazardTolerance, hazardDeficit, HAZARDS, type HazardRules, type HazardRatings, type StarSystemData } from '@space-game/common';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { PilotConn } from './Pilots.js';

export interface HazardHost {
  /** Pilots flying now, and their ship entities */
  flying(): Iterable<{ conn: PilotConn; eid: number }>;
  system(eid: number): StarSystemData | undefined;
  position(eid: number): { x: number; y: number };
  toast(conn: PilotConn, text: string, kind: 'info' | 'good' | 'warn' | 'bad'): void;
  tick(): number;
}

const NAME: Record<string, string> = { radiation: 'Radiation', thermal: 'Heat', cryo: 'Cold', corrosive: 'Corrosion', gravitational: 'Gravity', electromagnetic: 'EM storm' };

export class Hazards {
  /** Each pilot ship's shortfall, per hazard */
  private short = new Map<number, HazardRatings>();
  private told = new Map<number, string>();

  constructor(private host: HazardHost, private ships: ShipBridge, private rules: HazardRules) {}

  private effect(h: string, k: string): number {
    const v = this.rules.effects?.[h]?.[k];
    return typeof v === 'number' ? v : 0;
  }

  /** What a ship is short of here (empty: nothing) */
  deficit(eid: number): HazardRatings {
    return this.short.get(eid) ?? {};
  }

  /** Beam heat × this */
  heatScale(eid: number): number {
    return 1 + (this.short.get(eid)?.thermal ?? 0) * this.effect('thermal', 'beamHeat');
  }

  /** Shield regeneration × this */
  shieldScale(eid: number): number {
    return Math.max(0, 1 + (this.short.get(eid)?.thermal ?? 0) * this.effect('thermal', 'shieldRegen'));
  }

  /** Station repairs × this (corrosion, and a hull that's costly to repair) */
  repairScale(eid: number): number {
    const ship = this.ships.get(eid);
    const costly = ship?.derived.makeup.traits.costly_repair ?? 0;
    return (1 + (this.short.get(eid)?.corrosive ?? 0) * this.effect('corrosive', 'repairCost')) * (1 + costly);
  }

  tick(): void {
    const now = this.host.tick();
    if (now % 60) return;
    const seen = new Set<number>();
    for (const { conn, eid } of this.host.flying()) {
      const ship = this.ships.get(eid);
      const sys = this.host.system(eid);
      if (!ship || !sys) continue;
      seen.add(eid);
      const { x, y } = this.host.position(eid);
      const ratings = hazardsAt(this.rules, sys, x, y);
      const tol = hazardTolerance(this.rules, ship.derived);
      const short = hazardDeficit(ratings, tol);
      if (Object.keys(short).length) this.short.set(eid, short); else this.short.delete(eid);
      this.tell(conn, eid, ratings, tol, short);
      // Wear: a share of each part's HP a minute, per point short
      const rad = (short.radiation ?? 0) * this.effect('radiation', 'hullWearPerMin') / 60;
      const cor = (short.corrosive ?? 0) * this.effect('corrosive', 'armourWearPerMin') / 60;
      if (rad > 0 || cor > 0) {
        ship.blueprint.parts.forEach((q, i) => {
          if (!ship.derived.alive[i]) return;
          const f = rad + (q.fn === 'armor' ? cor : 0);
          // Wear never finishes a part off: it leaves it hanging by a thread
          if (f > 0 && ship.hp[i] > ship.maxHp[i] * 0.05) this.ships.damagePartFraction(eid, i, Math.min(f, ship.hp[i] / ship.maxHp[i] - 0.04));
        });
      }
      // A storm seizes the ship up now and then
      const em = short.electromagnetic ?? 0, every = this.effect('electromagnetic', 'empEverySeconds');
      if (em > 0 && every > 0 && (now / 60) % every === 0) this.ships.emp(eid, Math.round(this.effect('electromagnetic', 'empSeconds') * 60));
    }
    for (const eid of this.short.keys()) if (!seen.has(eid)) this.short.delete(eid);
    for (const eid of this.told.keys()) if (!seen.has(eid)) this.told.delete(eid);
  }

  /** When what a pilot is short of changes: what, against what, and what it costs */
  private tell(conn: PilotConn, eid: number, ratings: HazardRatings, tol: HazardRatings, short: HazardRatings): void {
    const key = HAZARDS.filter((h) => short[h]).map((h) => `${h}${Math.round(short[h]!)}`).join(',');
    if (key === (this.told.get(eid) ?? '')) return;
    this.told.set(eid, key);
    if (!key) return this.host.toast(conn, 'Your ship stands up to everything here', 'good');
    const lines = HAZARDS.filter((h) => short[h]).map((h) => `${NAME[h]} ${ratings[h]} against your ${(tol[h] ?? 0).toFixed(1)}: ${this.rules.effects?.[h]?.summary ?? ''}`);
    this.host.toast(conn, lines.join(' · '), 'warn');
  }
}
