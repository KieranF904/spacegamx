/**
 * @contract client.rendering.terrain-data
 * owns:       surfaces' rock on the client: each system's terrain file as a chunk of its own, loaded before the system's
 *             messages are handled, then the built terrain (arena gates and gun range walls in it) by system id
 * needs:      @space-game/common buildTerrain/withArenaGates/withGunRange, data/terrain/*.json, data/systems.json
 * invariants: a system's rock is in before its playerState/systemInfo is handled (terrainHold), so the first predicted
 *             tick there has it — client/src/rendering/terrainLoad.test.ts
 *             the client's rock is the server's, piece for piece — client/src/rendering/terrainData.test.ts
 * extend:     a new surface is one data/terrain/<system id>.json: its chunk and its hold come with it
 */

/**
 * Surfaces' rock on the client (data/terrain/<surface id>.json, common's terrain.ts): the same data the server collides
 * against, so a pilot's own prediction and the replicas push ships out of it exactly as the server does, and the boss's
 * beams can be drawn stopping at it.
 *
 * Each file is a chunk of its own (most systems have no rock, and the files are large): the game holds a system's
 * messages until its rock is in (terrainHold, app/frameGate.ts), and fetches the rest soon after the first join
 * (preloadTerrain), so going to a surface later doesn't wait. terrainFor stays synchronous.
 */

import { buildTerrain, withArenaGates, withGunRange, type ArenaDef, type GunRangeDef, type ServerMessage, type Terrain, type TerrainFile } from '@space-game/common';
import systemsData from '../../../data/systems.json';

/** Each surface's rock file, fetched on demand (its own chunk) */
const LOADERS: Record<string, () => Promise<TerrainFile>> = Object.fromEntries(
  Object.entries(import.meta.glob('../../../data/terrain/*.json', { import: 'default' }) as Record<string, () => Promise<TerrainFile>>)
    .map(([path, load]) => [path.replace(/^.*\//, '').replace(/\.json$/, ''), load]),
);
/** Files in so far, and loads under way (a failed load is logged and leaves its system without rock) */
const FILES = new Map<string, TerrainFile>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();
const built = new Map<string, Terrain>();
type SystemRow = { id: string; arena?: ArenaDef; gunRange?: GunRangeDef };
const SYSTEMS = (systemsData as unknown as { systems: SystemRow[] }).systems;
/** Boss arenas by system id: their barriers are part of the rock (world/gates.ts), as on the server */
const ARENAS = new Map(SYSTEMS.flatMap((s) => (s.arena ? [[s.id, s.arena] as const] : [])));
/** Gun ranges by system id: their rooms' walls are solid terrain (gunRange/layout.ts), as on the server */
const RANGES = new Map(SYSTEMS.flatMap((s) => (s.gunRange ? [[s.id, s.gunRange] as const] : [])));

/** A system's boss arena, if it has one */
export function arenaFor(systemId: string | null | undefined): ArenaDef | null {
  return (systemId && ARENAS.get(systemId)) || null;
}

/** A system's gun range (its rooms), if it is one */
export function gunRangeFor(systemId: string | null | undefined): GunRangeDef | null {
  return (systemId && RANGES.get(systemId)) || null;
}

/** A system's rock, or null where there's none (or its file isn't in yet: nothing asks before terrainHold lets it) */
export function terrainFor(systemId: string | null | undefined): Terrain | null {
  if (!systemId) return null;
  let t = built.get(systemId);
  if (t) return t;
  // (Not built without its file: the arena's gates alone would be kept as the system's rock)
  if (LOADERS[systemId] && !FILES.has(systemId) && !failed.has(systemId)) return null;
  const file = withGunRange(withArenaGates(FILES.get(systemId), ARENAS.get(systemId)), RANGES.get(systemId));
  if (!file) return null;
  built.set(systemId, (t = buildTerrain(file)));
  return t;
}

/** Fetches a system's rock file: null when there's nothing to wait for (no file, already in, or its load failed) */
export function loadTerrain(systemId: string | null | undefined): Promise<void> | null {
  if (!systemId || !LOADERS[systemId] || FILES.has(systemId) || failed.has(systemId)) return null;
  let p = loading.get(systemId);
  if (!p) {
    p = LOADERS[systemId]().then(
      (file) => { FILES.set(systemId, file); },
      // (Marked failed, so nothing waits on it again: the system is flown without rock, as a mismatch the server corrects)
      (err) => { failed.add(systemId); console.error(`terrain for ${systemId} didn't load`, err); },
    ).finally(() => loading.delete(systemId));
    loading.set(systemId, p);
  }
  return p;
}

let preloaded = false;
/** Fetches every surface's rock in the background (once, after the first join): going to one later doesn't wait */
export function preloadTerrain(): void {
  if (preloaded) return;
  preloaded = true;
  setTimeout(() => { for (const id of Object.keys(LOADERS)) void loadTerrain(id); }, 1000);
}

/**
 * What a message has to wait for before it's handled: the rock of the system it puts the pilot in (playerState and
 * systemInfo name it on a join and on every system change), or null to go now (app/frameGate.ts holds the messages)
 */
export function terrainHold(msg: ServerMessage): Promise<void> | null {
  if (msg.type !== 'playerState' && msg.type !== 'systemInfo') return null;
  preloadTerrain();
  return loadTerrain(msg.systemId);
}
