/**
 * Pockets (systems.json `pocket`): small systems of their own, each reached
 * from a spot in another system (X close by takes you in; fly out past its
 * edge and you're back beside the way in). The server's travel and every
 * client's prompt, route and drawing all ask these the same questions.
 */

import type { NestData, StarSystemData } from '../data/schemas.js';

/** The pockets whose way in is in this system */
export function pocketsFrom(systems: readonly StarSystemData[], id: string): StarSystemData[] {
  return systems.filter((s) => s.pocket?.entrance.system === id);
}

/** The pocket whose way in (in system `id`) is close enough to (x, y) to go in */
export function pocketAt(systems: readonly StarSystemData[], id: string, x: number, y: number): StarSystemData | null {
  for (const s of systems) {
    const e = s.pocket?.entrance;
    if (e && e.system === id && Math.hypot(x - e.x, y - e.y) < e.radius) return s;
  }
  return null;
}

/** Where flying out of a pocket leaves you: beside its way in, on the side you came out (`angle`, from the pocket's centre) */
export function pocketExit(pocket: StarSystemData, angle: number): { system: string; x: number; y: number } | null {
  const e = pocket.pocket?.entrance;
  if (!e) return null;
  const d = e.radius + 700;
  return { system: e.system, x: e.x + Math.cos(angle) * d, y: e.y + Math.sin(angle) * d };
}

/** A pocket's way in, as a nest to draw (still, at the entrance), if it has a look */
export function entranceNest(pocket: StarSystemData): NestData | null {
  const e = pocket.pocket?.entrance;
  if (!e?.look) return null;
  return {
    id: `way_in_${pocket.id}`, name: e.name, faction: e.look.faction, kind: e.look.kind,
    orbit: { radius: Math.hypot(e.x, e.y), phase: Math.atan2(e.y, e.x), period: 0 },
    ...(e.look.scale ? { scale: e.look.scale } : {}),
  };
}
