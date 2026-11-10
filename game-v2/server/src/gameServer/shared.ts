/**
 * @contract server.gameserver.shared
 * owns:       module constants and queries shared by the gameServer modules
 * needs:      bitecs, common
 * invariants: a removal remembers the system the entity was in when it was added — server/src/gameServer/serverParts.test.ts
 * extend:      a new shared constant goes here
 */

import { defineQuery, enterQuery, exitQuery } from 'bitecs';
import { Position, Velocity, Lifetime, Projectile, Bullet, MiningShot, Asteroid, InSystem, Dead } from '@space-game/common';
import { stationTable } from '@space-game/common';
import { WEAPON_KIND_TYPE } from '@space-game/common';
import { playerQuery } from '../net/SnapshotBuilder.js';

/** A station site by id */
export const stationPerksSite = (id: string | undefined) => (id ? stationTable()?.sites.find((s) => s.id === id) : undefined);

/** Projectile weapon kinds by their snapshot WeaponType (a shot's mining tool: hurtAsteroid) */
export const KIND_OF_TYPE = new Map(Object.entries(WEAPON_KIND_TYPE).map(([k, t]) => [t, k]));

// (playerQuery, projectileQuery, droppedItemQuery: net/SnapshotBuilder.ts, the same queries)
export const bulletQuery = defineQuery([Bullet, Position, Velocity]);
export const miningProjectileQuery = defineQuery([MiningShot, Position, Velocity, Projectile]);
export const asteroidQuery = defineQuery([Asteroid, Position]);

/** A client's game loop silent this long (3 s) lets go of its controls */
export const INPUT_TIMEOUT_TICKS = 180;
export const lifetimeQuery = defineQuery([Lifetime]);
export const deadQuery = defineQuery([Dead]);

/** Fly within this distance of a rift's centre to be pulled through */
export const RIFT_TRIGGER_RADIUS = 200;
export const RIFT_COOLDOWN_TICKS = 180;
/** Freighters: replacement delay, how close counts as arrived, how long they stay */
export const TRAFFIC_RESPAWN_TICKS = 60 * 120;
export const TRAFFIC_ARRIVE_RADIUS = 700;
export const TRAFFIC_DWELL_TICKS = 60 * 6;
/** A derelict's log (systems.json `log`) is read by flying this close (a scan step's 700 is inside it) */
export const DERELICT_LOG_RANGE = 900;

// Enter/exit queries for tracking removed entities
export const playerEnter = enterQuery(playerQuery);
export const playerExit = exitQuery(playerQuery);
export const deadEnter = enterQuery(deadQuery);

/** A pilot this close past a gate's or rift's edge has where it goes brought back (SystemMemory), before they're through */
export const MEMORY_GATE_MOUTH = 3000;

/** Entities removed this tick and the system each was in (so only clients there are told) */
export class RemovalSet extends Map<number, number> {
  add(eid: number): this {
    this.set(eid, InSystem.systemId[eid]);
    return this;
  }
}

// setImmediate is Node-only; fall back to setTimeout when running in a browser (proto mode).
export const scheduleImmediate: (fn: () => void) => unknown =
  typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
/** The game loop's last stretch before a tick is due: too short to sleep (timers fire on whole ms), so it doesn't */
export const LOOP_SPIN_MS = 0.25;

/** No asteroids: what a ghost round's rock query is (it flies through them) */
export const NO_ROCKS: number[] = [];
