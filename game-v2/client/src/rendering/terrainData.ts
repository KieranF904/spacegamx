/**
 * Surfaces' rock on the client (data/terrain/<surface id>.json, common's
 * terrain.ts): the same data the server collides against, so a pilot's own
 * prediction and the replicas push ships out of it exactly as the server does,
 * and the boss's beams can be drawn stopping at it.
 */

import { buildTerrain, withArenaGates, withGunRange, type ArenaDef, type GunRangeDef, type Terrain, type TerrainFile } from '@space-game/common';
import systemsData from '../../../data/systems.json';

const FILES: Record<string, TerrainFile> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../data/terrain/*.json', { eager: true, import: 'default' }) as Record<string, TerrainFile>)
    .map(([path, file]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), file]),
);
const built = new Map<string, Terrain>();
type SystemRow = { id: string; arena?: ArenaDef; gunRange?: GunRangeDef };
const SYSTEMS = (systemsData as unknown as { systems: SystemRow[] }).systems;
/** Boss arenas by system id: their barriers are part of the rock (world/gates.ts), as on the server */
const ARENAS = new Map(SYSTEMS.flatMap((s) => (s.arena ? [[s.id, s.arena] as const] : [])));
/** Gun ranges by system id: their chamber walls are solid terrain (gunRange/layout.ts), as on the server */
const RANGES = new Map(SYSTEMS.flatMap((s) => (s.gunRange ? [[s.id, s.gunRange] as const] : [])));

/** A system's boss arena, if it has one */
export function arenaFor(systemId: string | null | undefined): ArenaDef | null {
  return (systemId && ARENAS.get(systemId)) || null;
}

/** A system's gun range chamber, if it is one */
export function gunRangeFor(systemId: string | null | undefined): GunRangeDef | null {
  return (systemId && RANGES.get(systemId)) || null;
}

/** A system's rock, or null where there's none */
export function terrainFor(systemId: string | null | undefined): Terrain | null {
  if (!systemId) return null;
  let t = built.get(systemId);
  if (t) return t;
  const file = withGunRange(withArenaGates(FILES[systemId], ARENAS.get(systemId)), RANGES.get(systemId));
  if (!file) return null;
  built.set(systemId, (t = buildTerrain(file)));
  return t;
}
