/**
 * Surfaces' rock on the client (data/terrain/<surface id>.json, common's
 * terrain.ts): the same data the server collides against, so a pilot's own
 * prediction and the replicas push ships out of it exactly as the server does,
 * and the boss's beams can be drawn stopping at it.
 */

import { buildTerrain, withArenaGates, type ArenaDef, type Terrain, type TerrainFile } from '@space-game/common';
import systemsData from '../../../data/systems.json';

const FILES: Record<string, TerrainFile> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../data/terrain/*.json', { eager: true, import: 'default' }) as Record<string, TerrainFile>)
    .map(([path, file]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), file]),
);
const built = new Map<string, Terrain>();
/** Boss arenas by system id: their barriers are part of the rock (world/gates.ts), as on the server */
const ARENAS = new Map((systemsData as unknown as { systems: { id: string; arena?: ArenaDef }[] }).systems.flatMap((s) => (s.arena ? [[s.id, s.arena] as const] : [])));

/** A system's boss arena, if it has one */
export function arenaFor(systemId: string | null | undefined): ArenaDef | null {
  return (systemId && ARENAS.get(systemId)) || null;
}

/** A system's rock, or null where there's none */
export function terrainFor(systemId: string | null | undefined): Terrain | null {
  if (!systemId) return null;
  let t = built.get(systemId);
  if (t) return t;
  const file = withArenaGates(FILES[systemId], ARENAS.get(systemId));
  if (!file) return null;
  built.set(systemId, (t = buildTerrain(file)));
  return t;
}
