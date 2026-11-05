/**
 * A den's vent floor (systems.json `den` kind `vents`; the Kiln's six): each vent in turn glows and rumbles (its tell,
 * a `bossTelegraph` circle, kind `vent`), then erupts (`detonation` eruptions) and sets fire to every pilot within its
 * radius for as long as it burns (thermal, through the ship bridge's ignite, as a boss's vents do; rock between keeps
 * the fire off). The cycle is the server tick's (common world/denVents.ts), no dice; nothing is sent while nobody's in.
 */

import { Position, dhypot, rayTerrain, ventAge, type DenVentsData } from '@space-game/common';
import type { DenFactory } from './types.js';

/** While a vent burns, everyone in reach is set alight again this often (ticks), the fire lasting a little past it */
const CATCH = 30;
const CATCH_TICKS = 60;
/** An eruption's flare this often while it burns */
const FLARE = 60;

export const ventFloor: DenFactory<DenVentsData> = (host, num, v) => {
  const hit = { type: 'thermal' as const, pen: v.pen };
  return {
    tick(now, players) {
      if (!players.length) return;
      v.at.forEach(([x, y], i) => {
        const age = ventAge(v, i, now);
        if (age === 0) host.send(num, { type: 'bossTelegraph', shape: 'circle', kind: 'vent', x, y, radius: v.radius, ticks: v.tell });
        const burning = age - v.tell;
        if (burning < 0 || burning >= v.burn) return;
        if (burning % FLARE === 0) host.send(num, { type: 'detonation', kind: 'eruption', x, y, radius: Math.round(v.radius * 0.6) });
        if (burning % CATCH !== 0) return;
        const t = host.terrain(num);
        for (const q of players) {
          if (dhypot(Position.x[q] - x, Position.y[q] - y) > v.radius) continue;
          if (t && rayTerrain(t, x, y, Position.x[q], Position.y[q]) < 1) continue;
          const part = host.ships.ignite(q, x, y, v.dps, CATCH_TICKS, 1.2, -1, hit);
          if (part >= 0) host.send(num, { type: 'ignite', bodyId: q, part, ticks: CATCH_TICKS });
        }
      });
    },
  };
};
