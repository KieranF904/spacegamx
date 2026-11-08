/**
 * @contract server.snapshot.frameParts
 * owns:       three parts of one client's snapshot, each called once per client: its fire events (shots it builds
 *             itself, or works out from gun lanes and its own shot log), the stations and portals it hasn't had, and
 *             the removals it cares about (renamed to shot-id names where it works the shell out)
 * needs:      FireHost (ships.fired, gunNet, ownShotLog, otherShotLog, fireRows, ticks), RemovalHost (pending removals,
 *             shot logs, hits), world + GameData for stations, Docking/flight queries
 * invariants: a fire event's row is made once a snapshot for every client (encode-once) — server/src/net/snapshot/shotIds.test.ts
 *             a client is told only of removals it was sent or made — server/src/net/snapshot/shotIds.test.ts
 *             fire and removal bytes unchanged — server/src/golden/frameHash.test.ts
 * extend:     a new kind of fire a client works out itself is one `continue` branch in collectFire's loop
 */
import type { IWorld } from 'bitecs';
import {
  Position, Radius, InSystem, Lifetime, Station, Portal, STATION_DESIGNS, STATION_WEAPONS, EntityType, otherShotWire, TELL_PD,
  type EntityState,
} from '@space-game/common';
import type { GameData } from '../../data/GameData.js';
import type { ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { GunNet, GunClient } from '../guns/GunNet.js';
import type { HitLedger } from '../hits/HitLedger.js';
import { ownVolleyExact, OwnShotLog } from './ownShots.js';
import { stationQuery } from '../../game/Docking.js';
import { portalQuery } from '../handlers/flight.js';

/** What a client's fire events need of the server */
export interface FireHost {
  readonly ships: ShipBridge;
  readonly gunNet: GunNet | null;
  readonly ownShotLog: OwnShotLog;
  readonly otherShotLog: OwnShotLog;
  /** Each fire event's row this snapshot (one array for every client, so it's encoded once: CAPS.BLOCKS) */
  readonly fireRows: WeakMap<object, number[]>;
  readonly ticks: { readonly currentTick: number };
}

/**
 * Shots from ships it replicates go as fire events: it builds the shells itself (launch.ts). Not for a ship it's only
 * now getting a keyframe for (it can't place it back then), nor its own unless it replicates that too; those shells,
 * and any flying in from further off, go as rows. Fills `fire` and `covered` (the shells a fire event carries)
 */
export function collectFire(h: FireHost, conn: ClientConnection, playerSystemId: number, guns: GunClient | null, keyed: ReadonlySet<number>, ownRebuild: number | undefined, fire: number[][], covered: Set<number>): void {
  const currentTick = h.ticks.currentTick;
  for (const f of h.ships.fired) {
    // (Another ship's guns it steps itself: no record of what its lane fired too; a point-defence shot told, GunNet)
    if (guns && f.owner !== conn.playerId) {
      if (f.ammo === TELL_PD) {
        if (guns.steps(f.owner, f.tick)) { fire.push([f.owner, currentTick - f.tick, f.part + 256 * TELL_PD, 0]); h.gunNet!.stats.pdRecs++; }
        continue;
      }
      if (guns.derives(f.owner, f.tick)) {
        if (f.ids.length) h.otherShotLog.derive(conn, f, otherShotWire);
        h.gunNet!.stats.derivedRecs++;
        continue;
      }
    } else if (f.ammo === TELL_PD) continue;
    if (f.owner === conn.playerId && OwnShotLog.derivable(h.ships, f)) {
      h.ownShotLog.derive(conn, f);
      // (its own shells since the last snapshot it was sent: its client builds them all with the next it gets)
      (conn.ownWindow ??= []).push(...f.ids);
      continue;
    }
    // (its own, CAPS.OWN_SIM: not one fired before a rebuild in this window: it's built from the structure it has now)
    if (f.owner === conn.playerId) { if (keyed.has(f.owner) || !conn.repKnown.has(f.owner) || !ownVolleyExact(h.ships, f) || (ownRebuild !== undefined && f.tick <= ownRebuild)) continue; }
    else if (!conn.shipView.has(f.owner) || keyed.has(f.owner) || !conn.repKnown.has(f.owner)) continue;
    if (InSystem.systemId[f.owner] !== playerSystemId) continue;
    // (the ammunition rides on the part: part + 256 × its code, + 65536 for an augmented shot, power/ports.ts)
    let row = h.fireRows.get(f);
    if (!row) { row = [f.owner, currentTick - f.tick, f.part + 256 * (f.ammo ?? 0) + (f.aug ? 65536 : 0), f.aimQ, ...f.ids]; h.fireRows.set(f, row); }
    fire.push(row);
    for (const id of f.ids) covered.add(id);
  }
  if (guns) { for (const r of guns.none) fire.push(r); }
}

/** Stations and portals of its system it hasn't had: sent once per system (they never move) */
export function staticRows(world: IWorld, gameData: GameData, conn: ClientConnection, playerSystemId: number, markIfChanged: (state: EntityState) => void): void {
  // Stations — sent once per system (they never move)
  for (const eid of stationQuery(world)) {
    if (InSystem.systemId[eid] !== playerSystemId) continue;
    if (conn.knownEntities.has(eid)) continue;
    conn.knownEntities.add(eid);
    // data: [stationId, orbitType (255 = fixed), a, e, argP, M0, epoch, orbitTimeScale, radius, design, turrets, weapon]
    const def = gameData.getStationByNum(Station.stationId[eid]);
    markIfChanged({
      id: eid,
      type: EntityType.Station,
      x: Math.round(Position.x[eid]),
      y: Math.round(Position.y[eid]),
      data: [Station.stationId[eid], Station.orbitType[eid], Station.semiMajorAxis[eid], Station.eccentricity[eid], Station.argPeriapsis[eid],
        Station.meanAnomaly0[eid], Station.epochTick[eid], Station.orbitTimeScale[eid], Radius.value[eid],
        Math.max(0, STATION_DESIGNS.indexOf(def?.design ?? 'ring')), def?.defence?.turrets ?? 0, Math.max(0, STATION_WEAPONS.indexOf(def?.defence?.weapon ?? 'laser'))],
      name: def?.name,
    });
  }

  // Portals — sent once per system (they never move)
  for (const eid of portalQuery(world)) {
    if (InSystem.systemId[eid] !== playerSystemId) continue;
    if (conn.knownEntities.has(eid)) continue;
    conn.knownEntities.add(eid);
    markIfChanged({ id: eid, type: EntityType.Portal, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: [Portal.targetSystem[eid], Portal.kind[eid], Portal.hue[eid]] });
  }
}

/** What a client's removals need of the server */
export interface RemovalHost {
  /** Entities removed this tick and the system each was in */
  readonly pendingRemovedEntities: ReadonlyMap<number, number>;
  readonly ownShotLog: OwnShotLog;
  readonly otherShotLog: OwnShotLog;
  readonly hits: HitLedger | null;
}

/**
 * Removals this client cares about: only what it was sent (a row, a fire event's shell, a seeded rock, a station) or
 * made itself (debris it worked out: conn.debrisHeld). A shell 60 km off it never had costs it nothing. `gone`: the
 * shells a confirmed hit of its ends (their records say so); `goneAway`: ships it kept while away that are gone
 */
export function removalsFor(h: RemovalHost, conn: ClientConnection, prevStates: ReadonlyMap<number, string>, gone: ReadonlySet<number> | null, goneAway: readonly number[]): number[] {
  const removed: number[] = [];
  // (its own shells it works out, CAPS.SHOT_IDS: removed by their shot-id names, and only those it can't work out)
  let renamed: Map<number, number> | null = null;
  for (const [eid] of h.pendingRemovedEntities) {
    const log = h.ownShotLog.has(conn, eid) ? h.ownShotLog : h.otherShotLog.has(conn, eid) ? h.otherShotLog : null;
    if (log) {
      // (ended before its life did: a rock, point defence. Expired: its client removes it itself; spent by a hit: its record says so)
      const wire = log.removed(conn, eid, Lifetime.remaining[eid] > 0, !!gone?.has(eid));
      if (wire !== null) { removed.push(eid); (renamed ??= new Map()).set(eid, wire); }
      continue;
    }
    // (a shell a confirmed hit ends: the record says so)
    if (gone?.has(eid)) continue;
    // (Debris it worked out: held, or confirmed but its row not yet counted as sent, debrisRowOk: it has it all the same)
    const made = conn.debrisHeld.delete(eid) || conn.debrisRowOk.delete(eid);
    if (!prevStates.has(eid) && !conn.knownEntities.has(eid) && !made) continue;
    removed.push(eid);
    conn.sentNames.delete(eid);
    conn.mapNamed.delete(eid);
  }
  // (Ships it kept while they were away that are gone: told by id)
  if (goneAway.length) for (const id of goneAway) if (!removed.includes(id)) removed.push(id);
  if (h.hits && removed.length) h.hits.dropShells(conn, removed);
  if (renamed) for (let i = 0; i < removed.length; i++) removed[i] = renamed.get(removed[i]) ?? removed[i];
  return removed;
}
