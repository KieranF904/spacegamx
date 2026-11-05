/**
 * Where you are, as the music sees it (musicProfiles.ts MusicPlace): the system, the region band and zone ring you're
 * in, the planet you're near, docked, inside a boss's arena, or with a boss fight in view. Each area has an edge
 * margin (hysteresis: you leave it only well past where you entered), so the music doesn't flip on a boundary.
 */

import { insideArena, planetPosition, type StarSystemData } from '@space-game/common';
import { pickArea, type MusicPlace } from './musicProfiles';

/** How far past a region's or zone's edge you're still in it */
const BAND_MARGIN = 2500;
/** A planet's music within this many of its radii (plus a fixed reach), kept out to EXIT_SCALE × that */
const PLANET_RADII = 3;
const PLANET_REACH = 3000;
const EXIT_SCALE = 1.35;
/** How far past an arena's edge you're still in it */
const ARENA_MARGIN = 800;

export interface PlaceInput {
  systemId: string;
  sys: StarSystemData | undefined;
  /** Your ship's position (none: only the system and situation count) */
  x?: number;
  y?: number;
  /** The server tick (planets orbit) */
  tick: number;
  docked: boolean;
  /** A boss fight in view: its bosses.json id */
  boss: string | null;
}

/** Distance outside a band [inner, outer] (0 inside it) */
function outside(r: number, inner: number, outer: number): number {
  return Math.max(0, inner - r, r - outer);
}

export class MusicPlaceTracker {
  private region: string | null = null;
  private zone: string | null = null;
  private planet: string | null = null;
  private arena = false;
  private systemId = '';

  update(inp: PlaceInput): MusicPlace {
    if (inp.systemId !== this.systemId) {
      this.systemId = inp.systemId;
      this.region = this.zone = this.planet = null;
      this.arena = false;
    }
    const { sys, x, y } = inp;
    const place: MusicPlace = { system: inp.systemId, docked: inp.docked, boss: inp.boss };
    if (!sys || x === undefined || y === undefined) return place;
    const r = Math.hypot(x, y);
    // Regions: bands out from the centre, each from the last one's outer edge
    if (sys.regions?.length) {
      const sorted = [...sys.regions].sort((a, b) => a.outer - b.outer);
      this.region = pickArea(sorted.map((g, i) => ({ id: g.id, d: outside(r, i ? sorted[i - 1].outer : 0, g.outer), enter: 0, exit: BAND_MARGIN })), this.region);
    }
    // Zones: rings round the centre (or round their own point)
    if (sys.zones?.length) {
      this.zone = pickArea(sys.zones.map((z) => {
        const d = z.x !== undefined ? Math.hypot(x - z.x, y - (z.y ?? 0)) : r;
        return { id: z.id, d: outside(d, z.inner, z.outer), enter: 0, exit: BAND_MARGIN };
      }), this.zone);
    }
    // Planets: the one you're near
    if (sys.planets?.length) {
      this.planet = pickArea(sys.planets.map((p) => {
        const at = planetPosition(p, inp.tick), enter = p.radius * PLANET_RADII + PLANET_REACH;
        return { id: p.id, d: Math.hypot(x - at.x, y - at.y), enter, exit: enter * EXIT_SCALE };
      }), this.planet);
    }
    // A boss's arena: in once past its barrier, out once a little way back past it
    if (sys.arena) {
      const a = sys.arena;
      this.arena = insideArena(this.arena ? { ...a, radius: a.radius + ARENA_MARGIN } : a, x, y);
      if (this.arena) place.arena = a.boss;
    }
    place.region = this.region;
    place.zone = this.zone;
    place.planet = this.planet;
    return place;
  }
}
