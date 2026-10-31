/**
 * The snapshot path: what each client is sent of the world as it changes. Moved verbatim from GameServer (bodies
 * unchanged; the host's pieces are plain fields copied once at construction, so the per-tick loops read fields,
 * not an interface, and nothing is allocated here that the old bodies did not allocate).
 *
 * - `sendMapDots`: the system map's ships past the ship view, to clients with the map open.
 * - `updateShipView`: which of a system's ships a client sees.
 * - `enterSystem`: a client's first snapshot in a system (briefings, the asteroid seed, a clean slate).
 * - `sendPlayerState` / `sendSystemInfo`: HUD numbers, and the system visuals when the system changes.
 *
 * GameServer builds it once in its constructor (after every module it reads) and keeps one-line delegates for
 * the names its own code calls. Nothing here imports GameServer.
 */
import { hasComponent, entityExists, type IWorld } from 'bitecs';
import {
  Position, Velocity, InSystem, Player, Dead, Health, Boost, ASTEROID_SEED, MAP_DOT_SLACK,
  mapDotFlags, legAt, packMapLeg, packMapRoute, unpackMapLegs, nearerThan,
  type Leg, type ClientSocket, type ServerMessage, type ServerAsteroidSeedMessage, type StarSystemData, type AsteroidSpawnData,
} from '@space-game/common';
import type { GameData } from '../data/GameData.js';
import type { ClientConnection } from './ClientConnection.js';
import type { ShipBridge } from '../ships/ShipBridge.js';
import type { SimLod } from '../ships/SimLod.js';
import type { Enemies } from '../game/Enemies.js';
import type { Party } from '../game/Party.js';
import type { Events } from '../game/Events.js';
import type { Surfaces } from '../game/Surfaces.js';
import { SHIP_VIEW_IN, SHIP_VIEW_OUT } from './snapshot/constants.js';

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

/** What the snapshot path needs of the server (GameServer builds one, once) */
export interface SnapshotHost {
  readonly world: IWorld;
  readonly gameData: GameData;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly scene: 'sectors' | 'empty';
  readonly ships: ShipBridge;
  readonly enemies: Enemies;
  readonly lod: SimLod;
  readonly party: Party;
  readonly events: Events;
  readonly surfaces: Surfaces;
  /** Asteroids by system (the seed's), when each system's seed was laid, each one's belt index, and the ones grown back */
  readonly asteroidIdsBySystem: ReadonlyMap<number, number[]>;
  readonly asteroidSeedTickBySystem: ReadonlyMap<number, number>;
  readonly asteroidIndexById: ReadonlyMap<number, number>;
  readonly respawnedAsteroids: ReadonlySet<number>;
  send(ws: ClientSocket, msg: ServerMessage): void;
  /** Names (and kinds) of pilotless ships that have one: 1 = derelict, 2 = traffic, 3 = hostile */
  namedBody(eid: number): { name: string; kind: number } | undefined;
  flying(eid: number): boolean;
  asteroidSpawnData(eid: number): AsteroidSpawnData;
}

export class SnapshotBuilder {
  private readonly world: IWorld;
  private readonly gameData: GameData;
  private readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  private readonly scene: 'sectors' | 'empty';
  private readonly ships: ShipBridge;
  private readonly enemies: Enemies;
  private readonly lod: SimLod;
  private readonly party: Party;
  private readonly events: Events;
  private readonly surfaces: Surfaces;
  private readonly asteroidIdsBySystem: ReadonlyMap<number, number[]>;
  private readonly asteroidSeedTickBySystem: ReadonlyMap<number, number>;
  private readonly asteroidIndexById: ReadonlyMap<number, number>;
  private readonly respawnedAsteroids: ReadonlySet<number>;
  private readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  private readonly namedBody: (eid: number) => { name: string; kind: number } | undefined;
  private readonly flying: (eid: number) => boolean;
  private readonly asteroidSpawnData: (eid: number) => AsteroidSpawnData;
  /** The server itself, for its tick (read, never held) */
  private readonly ticks: { readonly currentTick: number };

  constructor(host: SnapshotHost, ticks: { readonly currentTick: number }) {
    this.world = host.world;
    this.gameData = host.gameData;
    this.clients = host.clients;
    this.scene = host.scene;
    this.ships = host.ships;
    this.enemies = host.enemies;
    this.lod = host.lod;
    this.party = host.party;
    this.events = host.events;
    this.surfaces = host.surfaces;
    this.asteroidIdsBySystem = host.asteroidIdsBySystem;
    this.asteroidSeedTickBySystem = host.asteroidSeedTickBySystem;
    this.asteroidIndexById = host.asteroidIndexById;
    this.respawnedAsteroids = host.respawnedAsteroids;
    this.send = host.send;
    this.namedBody = host.namedBody;
    this.flying = host.flying;
    this.asteroidSpawnData = host.asteroidSpawnData;
    this.ticks = ticks;
  }

  private get currentTick(): number {
    return this.ticks.currentTick;
  }

  /**
   * The system map's ships past the snapshot's ship view, once a second to
   * clients with their map open (mapView): derelicts, traffic, hostiles
   * (distant ones too: ships/SimLod.ts) and other pilots. Only what's changed
   * goes: each dot is a leg in closed form the client carries on exactly as
   * it's reckoned here (common ships/farRoute.ts), or for one on patrol round
   * a home that stays put, the patrol itself (the client works out its legs
   * as SimLod does). So a distant ship is sent again only when its route
   * changes (a patrol not at all while it's on it), a live one when it's
   * strayed MAP_DOT_SLACK from where the client has it; a new one's look
   * (kind, rank, faction, rating) once and when it changes, and the ones gone.
   */
  sendMapDots(due: boolean): void {
    type Row = { eid: number; name?: string; look: number; rating: number; leg: Leg; seq: number; patrol?: NonNullable<ReturnType<SimLod['track']>>['patrol'] };
    const bySystem = new Map<number, Row[]>();
    const rowsFor = (num: number) => {
      let rows = bySystem.get(num);
      if (rows) return rows;
      rows = [];
      const add = (eid: number, kind: number, name: string | undefined, foe?: ReturnType<Enemies['info']>) => {
        // A distant ship's leg from its route; a live one's as it's going now, held
        const far = this.lod.track(eid);
        const leg = far?.leg ?? { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], wx: Velocity.x[eid], wy: Velocity.y[eid], thrust: -1 };
        const look = mapDotFlags({ kind, rank: foe?.boss ? 2 : foe?.elite ? 1 : 0, calm: !!foe && this.enemies.isCalm(eid), faction: foe?.factionIndex ?? -1 });
        rows!.push({ eid, name, look, rating: Math.round(foe?.rating ?? 0), leg, seq: far?.seq ?? -1, patrol: far?.patrol });
      };
      for (const [eid, ship] of this.ships.bodies) {
        if (InSystem.systemId[eid] !== num || ship.kind !== 'ship' || hasComponent(this.world, Player, eid)) continue;
        const named = this.namedBody(eid);
        if (named) add(eid, named.kind, named.name, named.kind === 3 ? this.enemies.info(eid) : undefined);
      }
      // Other pilots, wherever they are in the system
      for (const c of this.clients.values()) if (this.flying(c.playerId) && InSystem.systemId[c.playerId] === num) add(c.playerId, 4, c.username);
      bySystem.set(num, rows);
      return rows;
    };
    const now = this.currentTick;
    for (const conn of this.clients.values()) {
      if (!conn.mapOpen || !(due || conn.mapDotsDue) || !conn.ws.isOpen() || !hasComponent(this.world, Player, conn.playerId)) continue;
      conn.mapDotsDue = false;
      const sent = (conn.mapSent ??= new Map());
      const full = conn.mapFresh === true;
      conn.mapFresh = false;
      const dots: number[] = [], routes: number[] = [], info: number[] = [], gone: number[] = [];
      const names: (number | string)[] = [];
      const on = new Set<number>();
      for (const r of rowsFor(InSystem.systemId[conn.playerId])) {
        if (r.eid === conn.playerId || conn.shipView.has(r.eid)) continue;
        on.add(r.eid);
        const was = sent.get(r.eid);
        // (A live one: how far it's strayed from where the client has it, carried on along what it was sent)
        const off = was && r.seq < 0 ? (() => { const p = legAt(was.leg, now - was.tick); return Math.hypot(p.x - r.leg.x, p.y - r.leg.y); })() : 0;
        if (!was || was.seq !== r.seq || off > MAP_DOT_SLACK) {
          const at = dots.length;
          if (r.patrol) packMapRoute(routes, r.eid, now, r.patrol.p, r.patrol.s);
          else packMapLeg(dots, r.eid, r.leg);
          sent.set(r.eid, { leg: r.patrol ? r.leg : unpackMapLegs(dots.slice(at))[0].leg, tick: now, seq: r.seq, look: was?.look ?? -1 });
        }
        const s = sent.get(r.eid)!;
        if (s.look !== r.look * 4096 + r.rating) { s.look = r.look * 4096 + r.rating; info.push(r.eid, r.look, r.rating); }
        if (r.name && !conn.mapNamed.has(r.eid)) { conn.mapNamed.add(r.eid); names.push(r.eid, r.name); }
      }
      for (const id of sent.keys()) if (!on.has(id)) { gone.push(id); sent.delete(id); }
      // (Nothing's changed: nothing to say)
      if (!full && !dots.length && !routes.length && !info.length && !gone.length && !names.length) continue;
      this.send(conn.ws, { type: 'mapDots', tick: now, dots, ...(routes.length ? { routes } : {}), ...(info.length ? { info } : {}), ...(gone.length ? { gone } : {}), ...(names.length ? { names } : {}), ...(full ? { full: 1 as const } : {}) });
    }
  }

  /**
   * Which of a system's ships a client sees (see SHIP_VIEW_IN): updates its view
   * and returns the ships that just left it.
   */
  updateShipView(conn: ClientConnection, systemId: number, px: number, py: number): number[] {
    const was = conn.shipView;
    const now = new Set<number>();
    const party = this.party.partyId(conn) ? new Set(this.party.members(conn).map((m) => m.playerId)) : null;
    const target = this.ships.targetOf(conn.playerId);
    const left: number[] = [];
    for (const eid of this.ships.bodies.keys()) {
      if (InSystem.systemId[eid] !== systemId) continue;
      if (eid === conn.playerId || nearerThan(Position.x[eid] - px, Position.y[eid] - py, was.has(eid) ? SHIP_VIEW_OUT : SHIP_VIEW_IN) || party?.has(eid) || eid === target) now.add(eid);
      else if (was.has(eid)) left.push(eid);
    }
    // (Ships gone from the system entirely are removals, sent as before)
    conn.shipView = now;
    return left;
  }

  /** A client's first snapshot in a system: world events, the asteroid seed, and a clean slate */
  enterSystem(conn: ClientConnection, playerSystemId: number): void {
    conn.lastSystemId = playerSystemId;
    for (const m of this.events.briefing(playerSystemId)) this.send(conn.ws, m);
    for (const m of this.surfaces.briefing(playerSystemId)) this.send(conn.ws, m);
    conn.knownEntities.clear();
    conn.shipSynced.clear();
    conn.shipHpSent.clear();
    conn.sentNames.clear();
    conn.repKnown.clear();
    conn.shipView.clear();
    conn.mapNamed.clear();
    conn.mapSent?.clear();
    conn.mapFresh = true;

    const systemData = this.gameData.getSystemByNum(playerSystemId);
    const belt = systemData?.asteroidBelt;
    const idsAll = this.asteroidIdsBySystem.get(playerSystemId) || [];
    const alive = idsAll.filter(eid => entityExists(this.world, eid) && !hasComponent(this.world, Dead, eid));
    // The seed only describes the original belt; asteroids that grew back follow as spawns
    const ids = alive.filter(eid => !this.respawnedAsteroids.has(eid));
    const regrown = alive.filter(eid => this.respawnedAsteroids.has(eid));
    const indices = ids.map(eid => this.asteroidIndexById.get(eid) ?? 0);
    const seedTick = this.asteroidSeedTickBySystem.get(playerSystemId) ?? this.currentTick;

    if (belt && ids.length > 0) {
      for (const id of ids) conn.knownEntities.add(id);
      this.send(conn.ws, {
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
        ids,
        indices,
      } as ServerAsteroidSeedMessage);
      if (regrown.length) {
        for (const id of regrown) conn.knownEntities.add(id);
        this.send(conn.ws, { type: 'asteroidSpawn', tick: this.currentTick, asteroids: regrown.map((eid) => this.asteroidSpawnData(eid)) });
      }
    }
  }

  sendPlayerState(conn: ClientConnection): void {
    const eid = conn.playerId;
    if (!hasComponent(this.world, Player, eid)) return;
    
    const systemData = this.gameData.getSystemByNum(InSystem.systemId[eid]);
    
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
    if (key !== conn.playerStateKey || this.currentTick % 600 === 0) {
      conn.playerStateKey = key;
      this.send(conn.ws, state);
    }

    // Push data-driven system visuals whenever the player's system changes
    if (systemData && conn.lastSystemInfoId !== systemData.id) {
      conn.lastSystemInfoId = systemData.id;
      this.sendSystemInfo(conn, systemData);
    }
  }

  /**
   * Send data-driven system visuals (central body + background config)
   * to a client. Derived from systems.json with sensible defaults.
   */
  private sendSystemInfo(conn: ClientConnection, system: StarSystemData): void {
    const cb = system.centralBody;
    // Default: a sun derived from starColor/starRadius. The empty scene has no central body.
    const centralBody = this.scene === 'empty'
      ? { type: 'none' as const, radius: 0, hue: 0 }
      : cb
      ? { ...cb }
      : {
          type: 'sun' as const,
          radius: system.starRadius,
          hue: hexToHue(system.starColor),
        };

    this.send(conn.ws, {
      type: 'systemInfo',
      systemId: system.id,
      name: system.name,
      sector: system.sector,
      centralBody,
      visuals: system.visuals ?? {},
      hazards: this.scene === 'empty' ? [] : system.hazards ?? [],
      // (Prediction charges the jump drive in their fields exactly as the server does)
      ...(this.scene !== 'empty' && system.lodestones?.length ? { lodestones: system.lodestones } : {}),
      ...(this.scene !== 'empty' && system.hazardRatings ? { hazardRatings: system.hazardRatings, hazardRadius: system.starRadius } : {}),
    });
  }
}
