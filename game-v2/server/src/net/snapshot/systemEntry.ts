/**
 * @contract server.snapshot.system-entry
 * owns:       a client entering a system (briefings, the asteroid seed and regrown rocks, your part-worked mining
 *             chunks on them, a clean slate of what it was sent), its HUD numbers (playerState) and the system's visuals and flight world (systemInfo: stillstones, moving landmarks)
 * needs:      EntryHost (world, gameData, scene, events, surfaces, crowd, focus, away, asteroid maps, mineState, landmarks, send, ticks); npm: bitecs
 * invariants: a new system starts the client from scratch (known, synced, names, map) — server/src/net/cells/focusCells.test.ts
 *             playerState only when it changed (or every 600 ticks) — server/src/net/snapshot/snapshotParts.test.ts
 *             systemInfo carries the landmark records the server's steps use — server/src/net/own/landmarkCarry.test.ts
 * extend:     a new per-system thing a client is told on entry is one send in enterSystem
 */
import { hasComponent, entityExists, type IWorld } from 'bitecs';
import {
  InSystem, Player, Dead, Health, Boost, ASTEROID_SEED, packRanges,
  type ClientSocket, type ServerMessage, type ServerAsteroidSeedMessage, type StarSystemData, type AsteroidSpawnData, type Landmark, type LandmarkSet,
} from '@space-game/common';
import type { GameData } from '../../data/GameData.js';
import type { ClientConnection } from '../ClientConnection.js';
import type { Events } from '../../game/Events.js';
import type { Surfaces } from '../../game/Surfaces.js';
import type { FocusCells } from '../cells/FocusCells.js';
import type { AwayNet } from '../cells/AwayNet.js';
import type { CrowdControl } from '../crowd/CrowdControl.js';

/** What entering a system and the HUD need of the server */
export interface EntryHost {
  readonly world: IWorld;
  readonly gameData: GameData;
  readonly scene: 'sectors' | 'empty';
  readonly events: Events;
  readonly surfaces: Surfaces;
  readonly crowd: CrowdControl | null;
  readonly focus: Pick<FocusCells, 'reset'>;
  readonly away: Pick<AwayNet, 'reset'>;
  readonly asteroidIdsBySystem: ReadonlyMap<number, number[]>;
  readonly asteroidSeedTickBySystem: ReadonlyMap<number, number>;
  readonly asteroidIndexById: ReadonlyMap<number, number>;
  readonly respawnedAsteroids: ReadonlySet<number>;
  readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  readonly asteroidSpawnData: (eid: number) => AsteroidSpawnData;
  /** The pilot's part-worked mining chunks on the system's rocks, packed (server Mining.partWorked) */
  readonly mineState?: (miner: number, systemNum: number) => number[];
  readonly ticks: { readonly currentTick: number };
  /** A system's moving landmarks, as its ships' steps have them (GameServer.replicaEnv; common world/landmarks.ts) */
  readonly landmarks?: (systemNum: number) => LandmarkSet | undefined;
}

/** Convert a hex color (#RRGGBB) to hue 0-360 */
function hexToHue(hex: string): number {
  const val = hex.startsWith('#') ? hex.slice(1) : hex;
  const rgb = parseInt(val, 16);
  if (isNaN(rgb)) return 40;
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(h * 60);
}

/** A client's first snapshot in a system: world events, the asteroid seed, and a clean slate */
export function enterSystem(h: EntryHost, conn: ClientConnection, playerSystemId: number): void {
  conn.lastSystemId = playerSystemId;
  h.crowd?.enter(conn, playerSystemId);
  h.focus.reset(conn);
  h.away.reset(conn);
  for (const m of h.events.briefing(playerSystemId)) h.send(conn.ws, m);
  for (const m of h.surfaces.briefing(playerSystemId)) h.send(conn.ws, m);
  conn.knownEntities.clear();
  conn.shipSynced.clear();
  conn.shipHpSent.clear();
  // (Pull fields: the new system's from scratch, its client's last system's forgotten first)
  if (conn.pullsTold?.size) { conn.pullsTold.clear(); conn.pullsReset = true; }
  conn.sentNames.clear();
  conn.repKnown.clear();
  conn.shipView.clear();
  conn.mapNamed.clear();
  conn.mapSent?.clear();
  conn.mapFresh = true;
  conn.popsFresh = true;

  const systemData = h.gameData.getSystemByNum(playerSystemId);
  const belt = systemData?.asteroidBelt;
  const idsAll = h.asteroidIdsBySystem.get(playerSystemId) || [];
  const alive = idsAll.filter(eid => entityExists(h.world, eid) && !hasComponent(h.world, Dead, eid));
  // The seed only describes the original belt; asteroids that grew back follow as spawns
  const ids = alive.filter(eid => !h.respawnedAsteroids.has(eid));
  const regrown = alive.filter(eid => h.respawnedAsteroids.has(eid));
  const indices = ids.map(eid => h.asteroidIndexById.get(eid) ?? 0);
  const seedTick = h.asteroidSeedTickBySystem.get(playerSystemId) ?? h.ticks.currentTick;
  // (Your part-worked mining chunks here, told once: from then on your client steps its own hits to their drops,
  // common econ/miningChunks.ts. On the first of the two below that goes; none, nothing)
  let mine: number[] | undefined = h.mineState?.(conn.playerId, playerSystemId);
  if (!mine?.length) mine = undefined;

  if (belt && ids.length > 0) {
    for (const id of ids) conn.knownEntities.add(id);
    h.send(conn.ws, {
      type: 'asteroidSeed',
      tick: seedTick,
      systemId: systemData?.id || String(playerSystemId),
      seed: ASTEROID_SEED,
      belt: {
        innerRadius: belt.innerRadius,
        outerRadius: belt.outerRadius,
        count: belt.count,
        // (A still field's rocks are placed from these too)
        ...(belt.stationary ? { stationary: true } : {}),
        ...(belt.lane ? { lane: belt.lane } : {}),
        ...(belt.extra ? { extra: belt.extra } : {}),
      },
      asteroidField: systemData?.asteroidField,
      ids: packRanges(ids),
      indices: packRanges(indices),
      ...(mine ? { mine } : {}),
    } as ServerAsteroidSeedMessage);
    mine = undefined;
  }
  // (Outside the belt's seed: a system with no belt, the training yard's, has only these)
  if (regrown.length) {
    for (const id of regrown) conn.knownEntities.add(id);
    h.send(conn.ws, { type: 'asteroidSpawn', tick: h.ticks.currentTick, asteroids: regrown.map((eid) => h.asteroidSpawnData(eid)), ...(mine ? { mine } : {}) });
  }
}

export function sendPlayerState(h: EntryHost, conn: ClientConnection): void {
  const eid = conn.playerId;
  if (!hasComponent(h.world, Player, eid)) return;
  
  const systemData = h.gameData.getSystemByNum(InSystem.systemId[eid]);
  
  const state: ServerMessage = {
    type: 'playerState',
    hp: Math.round(Health.current[eid]),
    maxHp: Math.round(Health.max[eid]),
    boostFuel: Math.round(Boost.fuel[eid] * 10) / 10,
    maxBoostFuel: Math.round(Boost.maxFuel[eid] * 10) / 10,
    xp: Player.xp[eid],
    level: Player.level[eid],
    credits: Player.credits[eid],
    systemId: systemData?.id || 'sol',
  };
  // Only when something changed (or now and then, in case)
  const key = JSON.stringify(state);
  if (key !== conn.playerStateKey || h.ticks.currentTick % 600 === 0) {
    conn.playerStateKey = key;
    h.send(conn.ws, state);
  }

  // Push data-driven system visuals whenever the player's system changes
  if (systemData && conn.lastSystemInfoId !== systemData.id) {
    conn.lastSystemInfoId = systemData.id;
    sendSystemInfo(h, conn, systemData);
  }
}

/**
 * Send data-driven system visuals (central body + background config)
 * to a client. Derived from systems.json with sensible defaults.
 */
function landmarksFor(h: EntryHost, system: StarSystemData): { landmarks?: Landmark[] } {
  const list = h.landmarks?.(h.gameData.getSystemNum(system.id));
  return list?.length ? { landmarks: [...list] } : {};
}

export function sendSystemInfo(h: EntryHost, conn: ClientConnection, system: StarSystemData): void {
  const cb = system.centralBody;
  // Default: a sun derived from starColor/starRadius. The empty scene has no central body.
  const centralBody = h.scene === 'empty'
    ? { type: 'none' as const, radius: 0, hue: 0 }
    : cb
    ? { ...cb }
    : {
        type: 'sun' as const,
        radius: system.starRadius,
        hue: hexToHue(system.starColor),
      };

  h.send(conn.ws, {
    type: 'systemInfo',
    systemId: system.id,
    name: system.name,
    sector: system.sector,
    centralBody,
    visuals: system.visuals ?? {},
    hazards: h.scene === 'empty' ? [] : system.hazards ?? [],
    // (Prediction charges the jump drive in their fields exactly as the server does)
    ...(h.scene !== 'empty' && system.lodestones?.length ? { lodestones: system.lodestones } : {}),
    // (...and carries its own ship with a moving landmark exactly as the server does: the same records)
    ...landmarksFor(h, system),
    ...(h.scene !== 'empty' && system.hazardRatings ? { hazardRatings: system.hazardRatings, hazardRadius: system.starRadius } : {}),
  });
}
