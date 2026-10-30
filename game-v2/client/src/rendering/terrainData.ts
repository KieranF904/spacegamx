/**
 * Surfaces' rock on the client (data/terrain/<surface id>.json, common's
 * terrain.ts): the same data the server collides against, so a pilot's own
 * prediction and the replicas push ships out of it exactly as the server does,
 * and the boss's beams can be drawn stopping at it.
 */

import { buildTerrain, type Terrain, type TerrainFile } from '@space-game/common';

const FILES: Record<string, TerrainFile> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../data/terrain/*.json', { eager: true, import: 'default' }) as Record<string, TerrainFile>)
    .map(([path, file]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), file]),
);
const built = new Map<string, Terrain>();

/** A system's rock, or null where there's none */
export function terrainFor(systemId: string | null | undefined): Terrain | null {
  if (!systemId || !FILES[systemId]) return null;
  let t = built.get(systemId);
  if (!t) built.set(systemId, (t = buildTerrain(FILES[systemId])));
  return t;
}
