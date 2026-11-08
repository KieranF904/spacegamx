/**
 * @contract client.app.worldQueries
 * owns:       questions about where the pilot is: the current system's data, a pocket's way in, a planet or cave mouth below
 * needs:      GameState (system, entities, tick, threats), data/systems.json, common planetPosition, moonOffset and pocketAt
 * invariants: the current system is looked up once per system, not per frame — none pinned
 * extend:     a new "what is near me" question is one more method here
 */

import { moonOffset, planetPosition, pocketAt, type StarSystemData } from '@space-game/common';
import systemsData from '../../../data/systems.json';
import type { GameState } from '../state/GameState';

export class WorldQueries {
  constructor(private state: GameState) {}

  /** A pocket's way in (a boss's nest), close enough to go in (X enters) */
  pocketWayIn(): string | null {
    const me = this.state.entities.get(this.state.playerId);
    if (!me) return null;
    return pocketAt((systemsData as unknown as { systems: StarSystemData[] }).systems, this.state.systemId, me.renderX, me.renderY)?.pocket?.entrance.name ?? null;
  }

  private systemCache: { id: string; sys: StarSystemData | undefined } | null = null;

  /** The current system's data (looked up once per system, not every frame) */
  currentSystem(): StarSystemData | undefined {
    const id = this.state.systemId;
    if (this.systemCache?.id !== id) {
      this.systemCache = { id, sys: (systemsData as unknown as { systems: StarSystemData[] }).systems.find((s) => s.id === id) };
    }
    return this.systemCache.sys;
  }

  /** A planet you can land on, close enough below you (X descends) */
  planetBelow(): string | null {
    const me = this.state.entities.get(this.state.playerId);
    const sys = this.currentSystem();
    if (!me || !sys) return null;
    // On a surface: a cave's mouth here
    if (sys.surface) {
      for (const s of (systemsData as unknown as { systems: StarSystemData[] }).systems) {
        const u = s.surface?.under;
        if (u && u.surface === sys.id && Math.hypot(me.renderX - u.x, me.renderY - u.y) < u.radius) return u.name ?? s.name;
      }
      return null;
    }
    if (!sys.planets) return null;
    for (const p of sys.planets) {
      const tick = this.state.getRawServerTick();
      const at = planetPosition(p, tick);
      if (p.surface && Math.hypot(me.renderX - at.x, me.renderY - at.y) < p.radius + 900) return p.name;
      // Moons you can land on (a party's siege)
      for (let i = 0; i < (p.moons?.length ?? 0); i++) {
        const m = p.moons![i];
        if (!m.surface) continue;
        const o = moonOffset(p, i, tick);
        const threat = this.state.threats[m.surface];
        if (Math.hypot(me.renderX - at.x - o.x, me.renderY - at.y - o.y) < m.radius + 900) return `${m.name ?? 'the moon'} (siege${threat ? `, threat ${threat}` : ''})`;
      }
    }
    return null;
  }
}
