/**
 * What a bot can see of the world: stations, rocks, the mining laser's reach. Read straight from the server's world (the
 * same for both drivers), so every bot has perfect, current knowledge of where things are, which a player's eyes do not.
 */
import { defineQuery, hasComponent } from 'bitecs';
import { Position, InSystem, Asteroid, Dead, Station, Radius, stationInteractRadius, sellPrice } from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import { stationQuery } from '../../game/Docking.js';

const asteroidQuery = defineQuery([Asteroid, Position]);

export interface StationView { eid: number; id: string; name: string; x: number; y: number; radius: number; interact: number; system: number }

export interface RockView {
  eid: number; x: number; y: number;
  /** The rock's radius, world units */
  size: number;
  type: string; hardness: number;
  /** Ore units still in it */
  left: number;
  /** The share of its kept ore in each ore (normalised) */
  ores: Record<string, number>;
}

export class BotWorld {
  constructor(readonly server: GameServer) {}

  station(id: string): StationView | null {
    const data = this.server.gameData.getStation(id);
    if (!data) return null;
    const system = this.server.gameData.getSystemNum(data.system);
    for (const st of stationQuery(this.server.world)) {
      if (this.server.gameData.getStationByNum(Station.stationId[st])?.id !== id) continue;
      return { eid: st, id, name: data.name, x: Position.x[st], y: Position.y[st], radius: Radius.value[st], interact: stationInteractRadius(Radius.value[st], data.design), system };
    }
    return null;
  }

  /** The mining laser: its reach (world units) and where its beam is at full strength */
  laser(): { range: number } {
    const m = this.server.getShips().tuning.miner;
    return { range: m?.range ?? 600 };
  }

  /** One rock, placed where it is now (null: gone) */
  rock(eid: number): RockView | null {
    const w = this.server.world;
    if (!hasComponent(w, Asteroid, eid) || hasComponent(w, Dead, eid)) return null;
    const c = this.server.mining.get(eid);
    if (!c) return null;
    this.server.placeAsteroid(eid);
    return { eid, x: Position.x[eid], y: Position.y[eid], size: Asteroid.size[eid], type: c.type, hardness: c.hardness, left: this.server.mining.remaining(eid), ores: c.ores };
  }

  /** Every live rock in a system accepted by `keep`, nearest to (x, y) first */
  rocksNear(system: number, x: number, y: number, keep: (r: RockView) => boolean, limit = 1): RockView[] {
    const best: { r: RockView; d: number }[] = [];
    for (const eid of asteroidQuery(this.server.world)) {
      if (InSystem.systemId[eid] !== system) continue;
      const r = this.rock(eid);
      if (!r || !keep(r)) continue;
      const d = Math.hypot(r.x - x, r.y - y) - r.size;
      best.push({ r, d });
    }
    best.sort((a, b) => a.d - b.d);
    return best.slice(0, limit).map((b) => b.r);
  }

  /** Loot pods (ore chunks) within `r` of a point */
  podsNear(system: number, x: number, y: number, r: number): number[] {
    return this.server.pods.near(system, x, y, r);
  }

  /** What an ore fetches at a station's market (credits each; the server's own price, without moving the market) */
  price(stationId: string, ore: string): number {
    const st = this.server.gameData.getStation(stationId);
    if (!st) return 0;
    return sellPrice(this.server.econ.items, ore, st.market?.demand);
  }
}
