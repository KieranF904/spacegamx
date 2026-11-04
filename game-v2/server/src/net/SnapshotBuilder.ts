/**
 * The snapshot path: what each client is sent of the world as it changes. Moved verbatim from GameServer (bodies
 * unchanged; the host's pieces are plain fields copied once at construction, so the per-tick loops read fields,
 * not an interface, and nothing is allocated here that the old bodies did not allocate).
 *
 * - `sendSnapshots`: every SNAPSHOT_RATE, one snapshot per client: the rows built once per system (`systemRows`), each
 *   client's view of them (what changed since its last), replicated ship motion, fire events, ship structure
 *   (`sendShipUpdates`), stations and portals once, removals; then the map dots.
 * - `sendMapDots`: the system map's ships past the ship view, to clients with the map open.
 * - `updateShipView`: which of a system's ships a client sees.
 * - `enterSystem`: a client's first snapshot in a system (briefings, the asteroid seed, a clean slate).
 * - `sendPlayerState` / `sendSystemInfo`: HUD numbers, and the system visuals when the system changes.
 *
 * GameServer builds it once in its constructor (after every module it reads) and keeps one-line delegates for
 * the names its own code calls. Nothing here imports GameServer.
 */
import { hasComponent, entityExists, defineQuery, type IWorld } from 'bitecs';
import {
  Position, Velocity, Rotation, Radius, InSystem, Player, Dead, Health, Boost, Input, Projectile, Lifetime, DroppedItem, Station, Portal,
  ASTEROID_SEED, MAP_DOT_SLACK, STATION_DESIGNS, STATION_WEAPONS, EntityType, packCursorWeaponState, quantizeShipValue, packCharge, gunStateAt, packGunState, PILOT_ROW,
  warmthPercent, fartherThan, hpWire, derivedRow, type BlockStore,
  mapDotFlags, legAt, packMapLeg, packMapRoute, unpackMapLegs, nearerThan, packIds, packRuns, packSheds, packRanges, DEBRIS_STATUS, TICK_RATE,
  FOCUS_RANGE, CROWD_BASE_WINDOW, structsFor, cargoFor, debrisFor,
  type Leg, type EntityState, type ShipState, type ClientSocket, type ServerMessage, type ServerAsteroidSeedMessage, type StarSystemData, type AsteroidSpawnData, dhypot,
} from '@space-game/common';
import type { GameData } from '../data/GameData.js';
import type { ClientConnection } from './ClientConnection.js';
import type { ShipBridge } from '../ships/ShipBridge.js';
import { nextSync, type StructEntry } from '../ships/bridge/structLog.js';
import type { SimLod } from '../ships/SimLod.js';
import type { Enemies } from '../game/Enemies.js';
import type { Party } from '../game/Party.js';
import type { Events } from '../game/Events.js';
import type { Surfaces } from '../game/Surfaces.js';
import type { Replication } from './Replication.js';
import type { Mobs } from '../game/Mobs.js';
import type { LootPods } from '../game/LootPods.js';
import type { ServerFeatures } from '../ships/features/host.js';
import { stationQuery } from '../game/Docking.js';
import { portalQuery } from './handlers/flight.js';
import { SELF_SAFETY_TICKS, SNAP_PROJECTILE_RANGE, SNAP_POD_RANGE, SHIP_VIEW_IN, SHIP_VIEW_OUT, MAP_DOTS_TICKS, DEBRIS_ACK_TICKS } from './snapshot/constants.js';
import type { HitLedger } from './hits/HitLedger.js';
import { ownShotsFor, ownVolleyExact, ownSimFor } from './snapshot/ownShots.js';
import { bodiesFor, pilotsFor, focusFor, causesFor, waypointsFor, replicasByte, jumpPhase, jumpTuning } from '@space-game/common';
import { FocusCells } from './cells/FocusCells.js';
import type { CrowdControl } from './crowd/CrowdControl.js';
import { SimPass } from '../sim/SystemClocks.js';

/** The systems a snapshot round is not for (a wider window not come round, a clock of their own): a Set will do */
export interface RoundSkip { has(system: number): boolean; readonly size: number }
import type { BodyNet } from './decisions/BodyNet.js';
import type { GuideNet } from './guides/GuideNet.js';
import type { OwnChecks } from './own/OwnChecks.js';

/** A debris body's status row as its key (rowKey): what a client makes itself for debris it works out (common ships/debris.ts) */
const DEBRIS_ROW_KEY = DEBRIS_STATUS.join(',');

/** Pilots, projectiles and loot pods (GameServer reads the same queries) */
export const playerQuery = defineQuery([Player, Position, Velocity, Rotation, Input, Health, Boost]);
export const projectileQuery = defineQuery([Projectile, Position, Velocity, Lifetime]);
export const droppedItemQuery = defineQuery([DroppedItem, Position, Velocity, Lifetime]);

/** One entity's snapshot state, built once per system per snapshot */
interface SnapRow {
  id: number;
  kind: 'player' | 'ship' | 'projectile' | 'pod' | 'mob';
  x: number;
  y: number;
  /** Without its name (names go separately, once) */
  state: EntityState;
  name?: string;
  /** What decides "changed since the last snapshot" */
  key: string;
  /** Players: the row other pilots get (status only: their motion is replicated) */
  other?: { state: EntityState; key: string; strip?: EntityState };
  /** Its status without where it is (a ship a client already has: one object for all of them, so it's encoded once) */
  strip?: EntityState;
}

/** A blueprint's hash (designs are sent once per client; see ServerShipSyncMessage.design) */
export function designHash(bp: unknown): string {
  const s = JSON.stringify(bp);
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
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
  readonly replication: Replication;
  readonly mobs: Mobs;
  readonly pods: LootPods;
  readonly features: ServerFeatures;
  /** People's craft (out of every fight) and wards (on the pilots' side), by name: a ship row's side */
  readonly personCraft: ReadonlyMap<number, string>;
  readonly wards: ReadonlyMap<number, string>;
  /** Disconnected mid-fight, still in space (their names still go) */
  readonly lingering: ReadonlyMap<number, { conn: ClientConnection; until: number }>;
  /** Entities removed this tick and the system each was in (cleared once every client has been told) */
  readonly pendingRemovedEntities: Map<number, number>;
  /** Each pilot's entities as last sent (playerId -> entity id -> key) */
  readonly lastEntityStates: Map<number, Map<number, string>>;
  /** Confirmed hits (net/hits/HitLedger.ts): a capable client's records, after its snapshot and before its HP */
  readonly hits?: HitLedger | null;
  /** Pilots' checks of their own ships (CAPS.OWN_SIM): what each snapshot should come to (net/own/OwnChecks.ts) */
  readonly ownChecks?: OwnChecks | null;
  /** Bosses' decisions for clients that run their bodies (CAPS.BODIES: net/decisions/BodyNet.ts) */
  readonly bodies?: BodyNet | null;
  /** Homing shells on clients' tick layers (CAPS.WAYPOINTS: net/guides/GuideNet.ts) */
  readonly guides?: GuideNet | null;
  /** Encode-once blocks (CAPS.BLOCKS, Outbox.blocks): told what was removed, so wire ids go back */
  readonly blocks?: BlockStore | null;
  /** Crowd fallbacks (net/crowd/CrowdControl.ts): each system's window and focus radius, charged its rounds' time */
  readonly crowd?: CrowdControl | null;
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
  private readonly replication: Replication;
  private readonly mobs: Mobs;
  private readonly pods: LootPods;
  private readonly features: ServerFeatures;
  /** Scratch for the part features' pilot-row values (spread at once) */
  private readonly fxRow: number[] = [];
  private readonly personCraft: ReadonlyMap<number, string>;
  private readonly wards: ReadonlyMap<number, string>;
  private readonly lingering: ReadonlyMap<number, { conn: ClientConnection; until: number }>;
  private readonly pendingRemovedEntities: Map<number, number>;
  private readonly lastEntityStates: Map<number, Map<number, string>>;
  private readonly hits: HitLedger | null;
  private readonly ownChecks: OwnChecks | null;
  private readonly bodies: BodyNet | null;
  private readonly guides: GuideNet | null;
  private readonly blocks: BlockStore | null;
  private readonly crowd: CrowdControl | null;
  /** Each fire event's row this snapshot (one array for every client, so it's encoded once: CAPS.BLOCKS) */
  private fireRows = new WeakMap<object, number[]>();
  /** The server itself, for its tick (read, never held) */
  private readonly ticks: { readonly currentTick: number };
  /** The focus grid (CAPS.FOCUS: net/cells/FocusCells.ts): capable clients' views by cell, in place of the circle */
  readonly focus: FocusCells;

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
    this.replication = host.replication;
    this.mobs = host.mobs;
    this.pods = host.pods;
    this.features = host.features;
    this.personCraft = host.personCraft;
    this.wards = host.wards;
    this.lingering = host.lingering;
    this.pendingRemovedEntities = host.pendingRemovedEntities;
    this.lastEntityStates = host.lastEntityStates;
    this.hits = host.hits ?? null;
    this.ownChecks = host.ownChecks ?? null;
    this.bodies = host.bodies ?? null;
    this.guides = host.guides ?? null;
    this.blocks = host.blocks ?? null;
    this.crowd = host.crowd ?? null;
    this.ticks = ticks;
    this.focus = new FocusCells({
      bodies: () => this.ships.bodies.keys(),
      has: (eid) => this.ships.has(eid),
      partyOf: (conn) => (this.party.partyId(conn) ? this.party.members(conn).map((m) => m.playerId) : []),
      targetOf: (eid) => this.ships.targetOf(eid),
      runsBody: (conn, eid) => !!this.bodies && bodiesFor(conn.caps) && this.bodies.runs(conn, eid),
      send: (conn, msg) => this.send(conn.ws, msg),
      rowsSent: (conn) => this.lastEntityStates.get(conn.playerId),
      transit: (eid) => jumpPhase(this.ships.get(eid)?.jump ?? 0, jumpTuning(this.ships.tuning)).phase === 'burn',
      focusOf: (system) => this.crowd?.focusOf(system) ?? FOCUS_RANGE,
    }, this.replication);
  }

  /** A client's answer about cells it dropped (cellCache, CAPS.FOCUS) */
  cellCache(conn: ClientConnection, c: readonly unknown[]): void {
    this.focus.reply(conn, c);
  }

  private get currentTick(): number {
    return this.ticks.currentTick;
  }

  /**
   * Ship structure for one client: a full sync (blueprint and all) the first time
   * it sees a ship, a light one (part HP and what's detached) after each rebuild,
   * and part HP changes otherwise, all ships' in one message. Ships far from the
   * client wait until it comes near (it only sees them as dots out there).
   */
  /** Each ship's part HP as sent (to a tenth), worked out once a snapshot, and the snapshot it last changed at */
  private hpWire = new Map<number, { ship: ShipState; at: number; since: number; hp: number[] }>();
  /** The tick a pilot's slowing ends (0: not slowed): its own row goes again when it changes (features/weaponry) */
  private slowEnd(eid: number): number {
    const left = this.ships.slowedTicksLeft(eid);
    return left > 0 ? this.currentTick + left : 0;
  }

  /** The part features' values for the pilot's own row (fills the scratch array; spread it at once) */
  private fxWire(eid: number): number[] {
    const out = this.fxRow;
    out.length = 0;
    this.features.wire(eid, out, 0);
    return out;
  }

  private hpWireOf(id: number, ship: ShipState): { since: number; hp: number[] } {
    const e = this.hpWire.get(id);
    if (e && e.at === this.snapshotCount && e.ship === ship) return e;
    const hp = ship.hp.map(hpWire);
    const same = !!e && e.ship === ship && e.hp.length === hp.length && hp.every((h, i) => h === e.hp[i]);
    const next = { ship, at: this.snapshotCount, since: same ? e!.since : this.snapshotCount, hp };
    this.hpWire.set(id, next);
    return next;
  }

  /** A ship's structure as a sync sends it, worked out once a snapshot for every client that's synced to it (cleared each snapshot) */
  private syncWire = new Map<number, { ship: ShipState; rebuilds: number; hp: number[]; detached: number[]; ghosts?: number[]; maxHp?: number[]; design?: string }>();
  private syncWireOf(id: number, ship: ShipState): { hp: number[]; detached: number[]; ghosts?: number[]; maxHp?: number[]; design?: string } {
    const e = this.syncWire.get(id);
    if (e && e.ship === ship && e.rebuilds === ship.rebuilds) return e;
    const next = {
      ship, rebuilds: ship.rebuilds, hp: ship.rebuildHp.map(hpWire), detached: ship.detached.flatMap((d, i) => (d ? [i] : [])),
      ghosts: ship.ghost.some(Boolean) ? ship.ghost.flatMap((g, i) => (g ? [i] : [])) : undefined,
    };
    this.syncWire.set(id, next);
    return next;
  }

  /**
   * The rebuild counts whose structures a client will keep once this frame's syncs are in (CAPS.STRUCTS; they go after
   * its replication is worked out but before its snapshot: sendShipUpdates)
   */
  private keptAfter(conn: ClientConnection, id: number, systemId: number): readonly number[] | undefined {
    const ship = this.ships.bodies.get(id), synced = conn.shipSynced.get(id);
    if (!ship) return undefined;
    // (Not synced this frame: what it has)
    if (!conn.shipView.has(id) || InSystem.systemId[id] !== systemId || conn.debrisHeld.has(id)) return synced?.ship === ship ? synced.kept : undefined;
    if (synced?.ship === ship && synced.rebuilds === ship.rebuilds) return synced.kept;
    return nextSync(this.ships.structLog, id, ship, synced).kept;
  }

  /** A structure a ship flew between the one a client has and its current one (CAPS.STRUCTS: bridge/structLog.ts), as its sync */
  private sendBetween(conn: ClientConnection, id: number, ship: ShipState, e: StructEntry): void {
    const hp = e.hp.map(hpWire), had = conn.shipHpSent.get(id);
    const hpd = had && had.length === hp.length ? hp.flatMap((h, i) => (had[i] !== h ? [[i, h] as [number, number]] : [])) : undefined;
    conn.shipHpSent.set(id, [...hp]);
    this.send(conn.ws, {
      type: 'shipSync', id, kind: ship.kind, hp: hpd ? undefined : hp, hpd: hpd?.length ? hpd : undefined,
      maxHp: !hpd && ship.scaledHp ? ship.maxHp.map(hpWire) : undefined,
      detached: [...e.detached], rebuilds: e.rebuilds, ghosts: e.ghosts ? [...e.ghosts] : undefined, at: e.tick,
    });
  }

  /**
   * `syncs` and `hps`: a client taking confirmed hits gets its syncs before its snapshot (as everyone does) and its HP
   * after its records (HitLedger: they bring its copy up to date first), so the two go separately
   */
  private sendShipUpdates(conn: ClientConnection, systemId: number, syncs = true, hps_ = true): void {
    if (syncs) for (const id of conn.shipSynced.keys()) {
      if (!this.ships.has(id)) { conn.shipSynced.delete(id); conn.shipHpSent.delete(id); }
    }
    const hps: [number, [number, number][]][] = [];
    // (Debris it's working out itself waits for its confirmation: ackDebris)
    // Ships out of view wait (the client keeps what it had, and catches up when one comes back). The view was
    // made this snapshot from the system's bodies in their order (updateShipView), so this goes in that order too
    // (Debris it runs itself, CAPS.DEBRIS: let go once out of view or gone; told once something else touched it)
    const live = conn.debrisLive;
    if (live?.size) for (const id of live) if (!conn.shipView.has(id) || !this.ships.has(id)) live.delete(id);
    for (const id of conn.shipView) {
      const ship = this.ships.bodies.get(id);
      if (!ship || InSystem.systemId[id] !== systemId || conn.debrisHeld.has(id)) continue;
      let synced = conn.shipSynced.get(id);
      if (live?.has(id)) {
        // (Its crumbling it works out: what it has is the server's, so nothing goes. Told: a sync (it takes that as the
        // word it's told from now on), at least of the structure it has now, and its HP since)
        if (!this.ships.debrisNet.told.has(id) && synced?.ship === ship) {
          if (syncs) { synced.rebuilds = ship.rebuilds; conn.shipHpSent.set(id, this.syncWireOf(id, ship).hp.slice()); }
          continue;
        }
        live.delete(id);
        if (synced?.ship === ship) synced.rebuilds = Math.min(synced.rebuilds, ship.rebuilds - 1);
        else { conn.shipSynced.delete(id); synced = undefined; }
      }
      if (!syncs && !synced) continue;
      // A refit or respawn replaces the ShipState (its rebuild count restarts), so compare both
      if (syncs && (!synced || synced.ship !== ship || synced.rebuilds !== ship.rebuilds)) {
        const fresh = !synced || synced.ship !== ship;
        // (Keeping each structure by its tick, CAPS.STRUCTS: the ones between go first, in order, each with its tick)
        let kept: number[] | undefined, at: number | undefined;
        if (structsFor(conn.caps)) {
          const next = nextSync(this.ships.structLog, id, ship, synced);
          for (const e of next.between) this.sendBetween(conn, id, ship, e);
          kept = next.kept;
          at = next.at;
        }
        synced = { ship, rebuilds: ship.rebuilds, at: this.currentTick, kept };
        conn.shipSynced.set(id, synced);
        const sync = this.syncWireOf(id, ship);
        const hp = sync.hp;
        // After a rebuild the client has this ship's HP already, bar what changed since
        const had = fresh ? undefined : conn.shipHpSent.get(id);
        const hpd = had && had.length === hp.length ? hp.flatMap((h, i) => (had[i] !== h ? [[i, h] as [number, number]] : [])) : undefined;
        conn.shipHpSent.set(id, [...hp]);
        // A design this client has seen (another ship of it) goes by its hash
        const design = fresh ? (sync.design ??= designHash(ship.blueprint)) : undefined;
        const known = design !== undefined && conn.designs.has(design);
        if (design !== undefined) conn.designs.add(design);
        this.send(conn.ws, {
          type: 'shipSync',
          id,
          kind: ship.kind,
          blueprint: fresh && !known ? ship.blueprint : undefined,
          design,
          hp: hpd ? undefined : hp,
          hpd: hpd?.length ? hpd : undefined,
          maxHp: !hpd && ship.scaledHp ? (sync.maxHp ??= ship.maxHp.map(hpWire)) : undefined,
          detached: sync.detached,
          rebuilds: ship.rebuilds,
          ghosts: sync.ghosts,
          at,
          // (A piece of debris new to it: its grace, and whether it knocks at all, as its debris world steps it)
          born: fresh && ship.kind === 'debris' ? ship.spawnTick : undefined,
          aloof: fresh && ship.kind === 'debris' && this.ships.debrisNet.intangible.has(id) ? 1 : undefined,
        });
      }
      if (!hps_ || !synced) continue;
      // HP for the visuals: to a tenth, and only what changed (nothing to look at if it hasn't changed since this client was last brought up to date)
      const wire = this.hpWireOf(id, ship);
      const at = synced.hpAt;
      synced.hpAt = this.snapshotCount;
      if (at !== undefined && at >= wire.since) continue;
      const sent = conn.shipHpSent.get(id)!;
      const changes: [number, number][] = [];
      for (let i = 0; i < wire.hp.length; i++) {
        const h = wire.hp[i];
        if (sent[i] !== h) { changes.push([i, h]); sent[i] = h; }
      }
      if (changes.length) hps.push([id, changes]);
    }
    if (hps.length) this.send(conn.ws, { type: 'shipHps', ships: hps });
  }

  /**
   * What every client in a system sees moving: players, ship bodies, hostiles,
   * projectiles and loot pods. Built once per system per snapshot and shared by
   * every client there; each row's key is its serialised state, so a client is
   * only sent what changed since its last snapshot.
   *
   * Projectiles fly in straight lines, so their key leaves out the position:
   * one is sent when it's fired and again only if its course changes (missiles).
   */
  private systemRows(num: number): SnapRow[] {
    const rows: SnapRow[] = [];
    // (Each key is interned: see internKey. Ships and projectiles are keyed by their values: rowKey)
    const add = (state: EntityState, kind: SnapRow['kind'], name?: string, key?: string) => {
      const row: SnapRow = { id: state.id, kind, x: state.x, y: state.y, state, name, key: key ?? this.internKey(state.id, JSON.stringify(state)) };
      rows.push(row);
      return row;
    };
    const names = new Map<number, string>();
    for (const c of this.clients.values()) names.set(c.playerId, c.username);
    for (const l of this.lingering.values()) names.set(l.conn.playerId, l.conn.username);

    for (const eid of playerQuery(this.world)) {
      if (InSystem.systemId[eid] !== num) continue;
      const beam = this.ships.beamState(eid);
      const ship = this.ships.get(eid);
      // (The charge, packed: the whole gauge, the pool's, and the charge groups (the pool's, then each bank's), energy.ts packCharge)
      const charge = packCharge(ship?.derived, this.ships.chargeOf(eid));
      const field = this.ships.jumpFieldState(eid);
      const row = add({
        id: eid,
        type: EntityType.Player,
        // Ship bodies are already rounded to SHIP_PRECISION each tick; these
        // must match it exactly so client prediction replays from server state
        x: quantizeShipValue('pos', Position.x[eid]),
        y: quantizeShipValue('pos', Position.y[eid]),
        angle: quantizeShipValue('angle', Rotation.angle[eid]),
        vx: quantizeShipValue('vel', Velocity.x[eid]),
        vy: quantizeShipValue('vel', Velocity.y[eid]),
        av: quantizeShipValue('angVel', ship?.angVel ?? 0),
        hp: Math.round(Health.current[eid]),
        maxHp: Math.round(Health.max[eid]),
        // data[0]: cursor/weapon state (see CURSOR_STATE.md); data[1]: the whole charge (the gauge); [8] the pool's, [9] how many
        // charge groups, [13...] each group's charge: the pool's, then each bank's (reconciliation: energy.ts PILOT_ROW, packCharge / unpackCharge)
        data: [
          packCursorWeaponState(Input.targetAngle[eid], beam.hit, this.ships.weaponBeamState(eid).on, beam.on),
          charge.total,
          Math.round(Input.cursorDist[eid]),     // turret convergence (cursor distance)
          ship?.jump ?? 0,                       // jump drive counter (reconciliation + effects)
          Math.round(this.ships.shieldFraction(eid) * 100), // shield charge %
          this.ships.empTicksLeft(eid),          // knocked out by an EMP: ticks left (prediction drifts that long)
          Math.round((ship?.jumpScale ?? 1) * 1000), // this jump's speed scale (prediction)
          field.flags,                           // in a charging field: 1 a star's ring, 2 a lodestone's (bits)
          charge.g,                              // [8] the ship pool's charge %
          charge.count,                          // [9] charge groups that follow from [13] (1 + banks; a ports ship: -(its parts' triples))
          field.prime,                           // a lodestone's priming left, ticks (prediction)
          warmthPercent(this.ships.warmthOf(eid)), // warmth % (common/src/ships/warmth.ts: the frost vignette, and the stage prediction flies and fires with)
          ship?.cargo ?? 0,                      // [12] the hold's cargo mass (common/src/ships/load.ts: prediction flies it)
          ...charge.groups,                      // [13...] the pool's charge %, then each bank's (CHARGE_GROUPS_AT)
          // After the groups, the part features' values in features.wire.json pilotExtra order (features/strafer/strafer.ts
          // pilotExtras reads them): the Burst Strafer's dodge counter and way (ships/features/strafer), what the Tow Beam tows (+1: ships/features/tow)
          ...this.fxWire(eid),
        ],
      }, 'player', names.get(eid));
      // Last, the gun-state correction (own ship only: guns.ts packGunState), after exactly the pilotExtra values
      { const d = row.state.data!, end = gunStateAt(d);
        while (d.length < end) d.push(0);
        d.length = end;
        if (ship) packGunState(ship, d); else d.push(0); }
      // Everyone else: status only (motion is replicated). data: [shield %, EMP'd, mining beam hit (tenths), weapon beam on,
      // mining beam on, cursor distance (hundreds), what its Tow Beam tows, its statuses (bits: marked 1, slowed 2)]
      const status: EntityState = {
        id: eid, type: EntityType.Player, x: row.state.x, y: row.state.y, hp: row.state.hp, maxHp: row.state.maxHp,
        data: [Math.round(this.ships.shieldFraction(eid) * 20) * 5, this.ships.isEmped(eid) ? 1 : 0,
          Math.round(beam.hit * 10), this.ships.weaponBeamState(eid).on ? 1 : 0, beam.on ? 1 : 0, Math.round(Input.cursorDist[eid] / 100),
          // [6] what its Tow Beam tows (entity id + 1, 0 none: ships/features/tow, features.wire.json status)
          this.features.status('tow', eid),
          // [7] marked and slowed (bits: ships/features/weaponry, features.wire.json status)
          this.features.status('weaponry', eid)],
      };
      row.other = { state: status, key: this.internKey(-1 - eid, `${status.hp},${status.maxHp},${status.data!.join(',')}`) };
    }

    // Ship bodies without a pilot (dummies, hostiles, freighters, wrecks, debris)
    for (const [eid] of this.ships.bodies) {
      if (hasComponent(this.world, Player, eid) || InSystem.systemId[eid] !== num) continue;
      const named = this.namedBody(eid);
      const foe = this.enemies.info(eid);
      // Status only: motion is replicated (where it is goes only for creating it on the client)
      // data: [kind (1 derelict, 2 traffic, 3 hostile, 0 other), shield %, EMP'd, faction index, 1 elite / 2 boss, core %, weapon beam on, hull %, rating, 1 calm (a passive pack, unprovoked),
      //        side (1 a ward, on the pilots' side; 2 a person's craft, out of every fight: canDamage, so clients' beams pass through as the server's do)]
      // Core and hull % go as 0: clients work them out from the part HP they have (ShipClient.fillHull)
      const side = this.personCraft.has(eid) ? 2 : this.wards.has(eid) ? 1 : 0;
      const data = [named?.kind ?? 0, Math.round(this.ships.shieldFraction(eid) * 100), this.ships.isEmped(eid) ? 1 : 0,
        foe?.factionIndex ?? -1, foe?.boss ? 2 : foe?.elite ? 1 : 0, 0, this.ships.weaponBeamState(eid).on ? 1 : 0, 0, Math.round(foe?.rating ?? 0), foe && this.enemies.isCalm(eid) ? 1 : 0, side];
      add({
        id: eid,
        type: EntityType.ShipBody,
        x: quantizeShipValue('pos', Position.x[eid]),
        y: quantizeShipValue('pos', Position.y[eid]),
        angle: quantizeShipValue('angle', Rotation.angle[eid]),
        data,
      }, 'ship', named?.name, this.rowKey(eid, data));
    }

    // Single-body enemies: where they are and their HP (data: [their kind's index in data/mobs.json])
    for (const eid of this.mobs.inSystem(num)) {
      const m = this.mobs.info(eid)!;
      const r1 = (v: number) => Math.round(v * 10) / 10;
      add({ id: eid, type: EntityType.Enemy, x: r1(Position.x[eid]), y: r1(Position.y[eid]), angle: Math.round(Rotation.angle[eid] * 1000) / 1000,
        vx: r1(Velocity.x[eid]), vy: r1(Velocity.y[eid]), hp: m.hp, maxHp: m.maxHp, data: [m.index] }, 'mob');
    }

    for (const eid of projectileQuery(this.world)) {
      if (InSystem.systemId[eid] !== num) continue;
      const ownerId = Projectile.ownerId[eid];
      const vx = Math.round(Velocity.x[eid] * 100) / 100, vy = Math.round(Velocity.y[eid] * 100) / 100;
      // data: [weaponType, tier, hue (golden-angle hash of the owner), spawnTick, spawnX, spawnY, ownerId, sizeScale, turret,
      // endTick (a shell that ends at a chosen point: the tick it lands or bursts, 0 none: Weapons.spawn)]
      // (data[10]: the gun that fired it, packed as a fire event's part, -1 none: a client works its hits out from it, HitLedger)
      const data = [
        Projectile.weaponType[eid], Projectile.tier[eid], (ownerId * 137) % 360, Projectile.spawnTick[eid],
        Math.round(Projectile.spawnX[eid] * 10) / 10, Math.round(Projectile.spawnY[eid] * 10) / 10,
        ownerId, Math.round((Projectile.sizeScale[eid] || 1) * 100) / 100, Projectile.turret[eid], Projectile.endTick[eid], Projectile.gun[eid],
      ];
      // Where it is goes only if the client can't work it out (spawn + velocity × age: see GameState)
      const x = Math.round(Position.x[eid] * 100) / 100, y = Math.round(Position.y[eid] * 100) / 100;
      const off = (from: number) => Math.max(Math.abs(data[4] + vx * (this.currentTick - from) - x), Math.abs(data[5] + vy * (this.currentTick - from) - y));
      // (A pilot's shells move on the tick they're fired: they count from the tick before. The two are a
      // whole tick's flight apart, so the nearer is always the right one, and the row's key never flips.)
      if (off(data[3] - 1) < off(data[3])) data[3]--;
      // The rounded velocity drifts from the real one by up to 0.005 a tick
      const onLine = off(data[3]) < 0.5 + 0.006 * (this.currentTick - data[3]);
      const row = add({ id: eid, type: EntityType.Projectile, x: onLine ? undefined! : x, y: onLine ? undefined! : y, vx, vy, data },
        'projectile', undefined, this.rowKey(eid, [vx, vy, ...data]));
      row.x = x; row.y = y;
    }

    for (const eid of droppedItemQuery(this.world)) {
      if (InSystem.systemId[eid] !== num) continue;
      // A drifting pod goes once, as its drift anchor (data[3] its tick): clients work out the rest (podDrift)
      const a = this.pods.anchor(eid);
      const row = a
        ? add({ id: eid, type: EntityType.DroppedItem, x: Math.round(a.x * 10) / 10, y: Math.round(a.y * 10) / 10,
          vx: Math.round(a.vx * 1000) / 1000, vy: Math.round(a.vy * 1000) / 1000, data: [...this.pods.snapshotData(eid), a.t] }, 'pod')
        : add({ id: eid, type: EntityType.DroppedItem, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: this.pods.snapshotData(eid) }, 'pod');
      row.x = Position.x[eid]; row.y = Position.y[eid];
    }
    return rows;
  }

  /**
   * The rows' keys by entity (status keys by -1 - id), the last snapshot's and this one's (see systemRows). A key
   * that hasn't changed since the last snapshot is made the very string it was then, so each pilot's "changed?" test
   * in sendSnapshots is a pointer comparison rather than a character-by-character one.
   */
  private keysWere = new Map<number, { key: string; values?: readonly number[] }>();
  private keysNow = new Map<number, { key: string; values?: readonly number[] }>();
  private internKey(id: number, key: string): string {
    const was = this.keysWere.get(id)?.key;
    const k = was === key ? was : key;
    this.keysNow.set(id, { key: k });
    return k;
  }
  /** A row's key from its values (joined with commas), without joining them again while they're unchanged */
  private rowKey(id: number, values: readonly number[]): string {
    const was = this.keysWere.get(id);
    const same = !!was?.values && was.values.length === values.length && values.every((v, i) => v === was.values![i]);
    const key = same ? was!.key : values.join(',');
    this.keysNow.set(id, { key, values });
    return key;
  }

  /** Its own ship as its tick-aligned layer has it now (the real ship: its shadow is), its controls, its HP copy */
  private noteOwn(conn: ClientConnection): void {
    const id = conn.playerId, ship = this.ships.get(id), ctl = this.replication.controlsOf(id);
    if (!ship || !ctl) return;
    // (Docked, its shadow: what its last keyframe carried, Replication.stepOwn)
    const body = this.replication.ownHeld(id) ?? { x: Position.x[id], y: Position.y[id], vx: Velocity.x[id], vy: Velocity.y[id], angle: Rotation.angle[id], angVel: ship.angVel, jump: ship.jump, jumpScale: ship.jumpScale, cargo: ship.cargo, dodge: ship.dodge, dodgeDir: ship.dodgeDir };
    // (CAPS.CAUSES: every other ship it holds goes in the check too)
    let held = causesFor(conn.caps) ? this.replication.heldByte(conn.repKnown, id, this.bodies ? (e) => this.bodies!.runs(conn, e) : undefined) : 0;
    // (CAPS.WAYPOINTS: the homing shells it runs too; off, they're all SYNCed again)
    if (this.guides && waypointsFor(conn.caps)) held += replicasByte(this.guides.heldSum(conn));
    this.ownChecks!.note(conn, this.currentTick, body, ctl.bits, ctl.q, conn.shipHpSent.get(id), held);
  }

  private snapshotCount = 0;

  /**
   * A client's own row this snapshot: whether it goes (`need`: its prediction needs correcting, its status changed, its
   * warmth too, or now and then) and whether as a correction (`fix`: forced, an input applied late, a new keyframe
   * version, first sight, or a change to what its flight depends on, apart from its HP: its slowing ending too,
   * features/weaponry)
   */
  private selfRowState(conn: ClientConnection, r: SnapRow, prevStates: Map<number, string>): { need: boolean; fix: boolean; key: string; flight: string; version: number } {
    const d = r.state.data ?? [];
    const flight = JSON.stringify([d[4], d[5], d[PILOT_ROW.field], d[PILOT_ROW.warmth], this.slowEnd(r.id)]);
    const key = JSON.stringify([r.state.hp, r.state.maxHp]) + flight;
    const version = this.replication.versionOf(r.id);
    const fix = conn.forceSnapshot || conn.selfLate || version !== conn.selfVersion || !prevStates.has(r.id) || flight !== conn.selfFlight;
    const need = fix || key !== conn.selfKey || this.currentTick - conn.selfSentTick >= SELF_SAFETY_TICKS;
    return { need, fix, key, flight, version };
  }

  /** Base tick of the last round, and each widened system's last (crowd fallbacks: its window, CrowdControl) */
  private lastRound = 0;
  private readonly lastWide = new Map<number, number>();

  /**
   * Once a tick: is a snapshot round due (every CROWD_BASE_WINDOW ticks, as always; false: not this tick)? It is for every
   * system but the ones returned, whose wider window (crowd fallbacks) hasn't come round yet (null: none)
   */
  due(): RoundSkip | null | false {
    const t = this.currentTick;
    if (t - this.lastRound < CROWD_BASE_WINDOW) return false;
    this.lastRound = t;
    let skip: Set<number> | null = null;
    // (Systems with a clock of their own have their rounds in their own passes: ownRound)
    if (!SimPass.all) for (const s of SimPass.own) (skip ??= new Set()).add(s);
    if (this.crowd) {
      for (const [sys, w] of this.crowd.widened()) {
        const last = this.lastWide.get(sys);
        if (last !== undefined && t - last < w) (skip ??= new Set()).add(sys);
        else this.lastWide.set(sys, t);
      }
      for (const sys of this.lastWide.keys()) if (this.crowd.windowOf(sys) <= CROWD_BASE_WINDOW) this.lastWide.delete(sys);
    }
    return skip;
  }

  /** A system with a clock of its own, in its pass: is its round due (its window, in its ticks)? The skip if so */
  ownRound(system: number): RoundSkip | false {
    const t = this.currentTick, last = this.lastOwn.get(system);
    const w = this.crowd?.windowOf(system) ?? CROWD_BASE_WINDOW;
    if (last !== undefined && t - last < w && t > last) return false;
    this.lastOwn.set(system, t);
    return { has: (s: number) => s !== system, size: 1 };
  }
  private readonly lastOwn = new Map<number, number>();

  sendSnapshots(skip: RoundSkip | null = null): void {
    // (A round for some systems only, crowd fallbacks: what's kept for a round is let go only for theirs)
    const due = skip ? (eid: number) => !skip.has(InSystem.systemId[eid]) : undefined;
    // Skip entirely when no clients are connected — avoids building
    // per-entity state objects and JSON keys for nothing.
    if (this.clients.size === 0) {
      this.flushRound(due);
      return;
    }
    this.snapshotCount++;
    for (const id of this.hpWire.keys()) if (!this.ships.has(id)) this.hpWire.delete(id);
    this.syncWire.clear();
    const bySystem = new Map<number, SnapRow[]>();
    this.replication.beginSnapshot(due);
    // (The focus grid's home cells, for the systems with a client holding cells: CAPS.FOCUS)
    const focusSystems = new Set<number>();
    for (const conn of this.clients.values()) if (focusFor(conn.caps) && hasComponent(this.world, Player, conn.playerId) && !skip?.has(InSystem.systemId[conn.playerId])) focusSystems.add(InSystem.systemId[conn.playerId]);
    if (focusSystems.size) this.focus.beginRound(this.currentTick, focusSystems);
    const crowd = this.crowd;
    let t0 = crowd ? performance.now() : 0;

    for (const conn of this.clients.values()) {
      // No snapshot this round: it misses the control changes, so it starts over with keyframes
      if (!conn.ws.isOpen() || !hasComponent(this.world, Player, conn.playerId)) { conn.repKnown.clear(); if (conn.focus) this.focus.reset(conn); continue; }

      const playerSystemId = InSystem.systemId[conn.playerId];
      // (Its system's window hasn't come round: crowd fallbacks)
      if (skip?.has(playerSystemId)) continue;
      if (crowd) { const t1 = performance.now(); crowd.charge(this.chargeTo, t1 - t0); t0 = t1; this.chargeTo = playerSystemId; }
      if (conn.lastSystemId !== playerSystemId) this.enterSystem(conn, playerSystemId);
      let rows = bySystem.get(playerSystemId);
      if (!rows) { rows = this.systemRows(playerSystemId); bySystem.set(playerSystemId, rows); }

      const entities: EntityState[] = [];
      const prevStates = this.lastEntityStates.get(conn.playerId) || new Map<number, string>();
      const newStates = new Map<number, string>();
      const markIfChanged = (state: EntityState) => {
        // (hp and boost fuel ride every snapshot's own row, timed; here they are only the first values, so they are not part of
    // the key: a change in them alone sent a message that the client then wrote over its prediction with)
    const key = JSON.stringify({ ...state, hp: 0, boostFuel: 0 });
        newStates.set(state.id, key);
        if (prevStates.get(state.id) !== key) entities.push(state);
      };

      // Interest management: what's near is sent every snapshot; distant ships every few
      // (the client dead-reckons in between); distant projectiles and loot not at all
      const px = Position.x[conn.playerId], py = Position.y[conn.playerId];
      // Debris it can work out itself: told how (first, before the ship's own sync), and held back till it confirms
      this.holdDebris(conn);
      // Ships that left its view: it forgets them, and gets each again on its own when it comes back
      // (Holding cells, CAPS.FOCUS: the ships homed in its focus cells, net/cells/FocusCells.ts)
      if (conn.focus && !focusFor(conn.caps)) this.focus.reset(conn);
      const out = focusFor(conn.caps) ? this.focus.view(conn, playerSystemId, px, py) : this.updateShipView(conn, playerSystemId, px, py);
      // (its structure too: the client drops a ship it hasn't seen for a moment, so it's synced afresh when it comes back)
      for (const id of out) { conn.sentNames.delete(id); conn.shipSynced.delete(id); conn.shipHpSent.delete(id); }
      // Ship motion: keyframes where needed, control changes otherwise (its own ship's too, when it builds its own
      // shells: its confirmed ship, beside its prediction, snapshot/ownShots.ts)
      const ownShots = ownShotsFor(conn.caps);
      // Bosses flown by their bodies on its tick layer (CAPS.BODIES): their decisions, and from here no rows or drive keyframes of them
      const bodies = this.bodies && bodiesFor(conn.caps) ? this.bodies : null;
      // (its caps switched it off: none run there any more, BodyNet.drop)
      if (!bodies) this.bodies?.drop(conn);
      // (Other ships' causes on its tick layer, CAPS.CAUSES: keyframes only where they don't explain a ship's path)
      const causes = causesFor(conn.caps);
      const decisions = bodies?.forClient(conn, conn.playerId, (e) => InSystem.systemId[e] ?? -1, playerSystemId ?? -1, conn.repKnown, this.currentTick,
        (e) => !conn.shipView || conn.shipView.has(e), (e) => this.replication.keysFor(e, conn.playerId, conn.repKnown, causes), pilotsFor(conn.caps));
      // Homing shells and mobs on its tick layer (CAPS.WAYPOINTS): their SYNCs and records, and from here no rows of them
      const guidesOn = this.guides && waypointsFor(conn.caps) ? this.guides : null;
      if (!guidesOn) this.guides?.drop(conn);
      const guided = guidesOn?.forClient(conn, {
        self: conn.playerId, systemId: playerSystemId,
        near: (e) => !fartherThan(Position.x[e] - px, Position.y[e] - py, SNAP_PROJECTILE_RANGE),
        holds: (e) => conn.shipView.has(e) && conn.repKnown.has(e),
        rekeyed: (e) => this.replication.keysFor(e, conn.playerId, conn.repKnown, causes),
      }, this.currentTick);
      const rep = this.replication.forClient(playerSystemId, conn.playerId, conn.repKnown, this.currentTick, conn.shipView, conn.debrisHeld, ownShots, (id) => conn.shipSynced.get(id)?.rebuilds, bodies ? (id) => bodies.runs(conn, id) : undefined, causes, structsFor(conn.caps) ? (id) => this.keptAfter(conn, id, playerSystemId) : undefined,
        // (A ship a body it runs reads, keyframed now: the body's ship goes again too, Replication.forClient)
        bodies ? (ships) => bodies.readersOf(conn, conn.playerId, ships) : undefined, cargoFor(conn.caps), conn.debrisLive);
      // Shots from ships it replicates go as fire events: it builds the shells itself (launch.ts).
      // Not for a ship it's only now getting a keyframe for (it can't place it back then), nor its
      // own unless it replicates that too; those shells, and any flying in from further off, go as rows.
      const keyed = new Set(rep.ships.map((k) => k[0]));
      // Its own row: whether it goes, and whether to correct its prediction
      const selfRow = rows.find((r) => r.id === conn.playerId);
      const self = selfRow ? this.selfRowState(conn, selfRow, prevStates) : null;
      const fire: number[][] = [];
      const covered = new Set<number>();
      for (const f of this.ships.fired) {
        // (its own, CAPS.OWN_SIM: not one fired before a rebuild in this window: it's built from the structure it has now)
        if (f.owner === conn.playerId) { if (!ownShots || keyed.has(f.owner) || !conn.repKnown.has(f.owner) || !ownVolleyExact(this.ships, f) || (rep.ownRebuild !== undefined && f.tick <= rep.ownRebuild)) continue; }
        else if (!conn.shipView.has(f.owner) || keyed.has(f.owner) || !conn.repKnown.has(f.owner)) continue;
        if (InSystem.systemId[f.owner] !== playerSystemId) continue;
        // (the ammunition rides on the part: part + 256 × its code, + 65536 for an augmented shot, power/ports.ts)
        let row = this.fireRows.get(f);
        if (!row) { row = [f.owner, this.currentTick - f.tick, f.part + 256 * (f.ammo ?? 0) + (f.aug ? 65536 : 0), f.aimQ, ...f.ids]; this.fireRows.set(f, row); }
        fire.push(row);
        for (const id of f.ids) covered.add(id);
      }
      for (const r of rows) {
        if ((r.kind === 'player' || r.kind === 'ship') && !conn.shipView.has(r.id)) continue;
        // (Debris it's working out itself: nothing till it confirms; once it has, the status row it made itself counts as sent)
        if (conn.debrisHeld.has(r.id)) continue;
        if (conn.debrisRowOk.size && conn.debrisRowOk.delete(r.id) && r.key === DEBRIS_ROW_KEY) { newStates.set(r.id, r.key); continue; }
        if (r.kind === 'projectile' && covered.has(r.id)) { newStates.set(r.id, r.key); continue; }
        // (a homing shell it runs, its row once sent: it flies it itself)
        if (r.kind === 'projectile' && guidesOn?.runs(conn, r.id) && prevStates.has(r.id)) { newStates.set(r.id, r.key); continue; }
        // (a mob it runs: its row again only when its HP changes)
        if (r.kind === 'mob' && guidesOn?.runs(conn, r.id)) {
          const k = `hp:${r.state.hp},${r.state.maxHp}`;
          newStates.set(r.id, k);
          if (prevStates.get(r.id) !== k) entities.push(r.state);
          continue;
        }
        if ((r.kind === 'projectile' || r.kind === 'mob') && fartherThan(r.x - px, r.y - py, SNAP_PROJECTILE_RANGE)) continue;
        if (r.kind === 'pod' && fartherThan(r.x - px, r.y - py, SNAP_POD_RANGE)) continue;
        if (r.id === conn.playerId && self) {
          // Its own ship: only when its prediction needs correcting, its status changed (its warmth too), or now and then
          newStates.set(r.id, 'self');
          if (!self.need) continue;
          conn.selfRowQuiet = !self.fix;
          conn.selfLate = false;
          conn.selfVersion = self.version;
          conn.selfKey = self.key;
          conn.selfFlight = self.flight;
          conn.selfSentTick = this.currentTick;
        }
        let v = r.other && r.id !== conn.playerId ? r.other : r;
        if (r.id !== conn.playerId) {
          newStates.set(r.id, v.key);
          if (prevStates.get(r.id) === v.key) continue;
          // Another ship it already has: its motion is replicated, so the status goes without where it is
          if ((r.kind === 'player' || r.kind === 'ship') && prevStates.has(r.id)) {
            v = { ...v, state: v.strip ??= { ...v.state, x: undefined!, y: undefined!, angle: undefined } };
          }
        }
        // (A shell as a row isn't exact on its client (rounded): one finding its own hits leaves it to the server's records)
        if (r.kind === 'projectile') this.hits?.rowShell(conn, r.id);
        // Names go once (the client keeps them)
        if (r.name !== undefined && conn.sentNames.get(r.id) !== r.name) {
          conn.sentNames.set(r.id, r.name);
          entities.push(derivedRow(v.state, { name: r.name }));
        } else {
          entities.push(v.state);
        }
      }
      // Ship structure: full sync on first sight and after every rebuild, HP deltas otherwise
      // (A client taking confirmed hits: its HP after its records, below; first, what it'll make of each hit)
      const hitsOn = !!this.hits?.wants(conn);
      this.sendShipUpdates(conn, playerSystemId, true, !hitsOn);
      // (Hits on a ship its causes moved this window are told, as on one keyframed: its client leaves them, SelfHits.onCaused)
      const gone = hitsOn ? this.hits!.plan(conn, (id) => prevStates.has(id) || newStates.has(id) || covered.has(id), rep.caused ? new Set([...keyed, ...rep.caused]) : keyed) : null;

      // Stations — sent once per system (they never move)
      for (const eid of stationQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        conn.knownEntities.add(eid);
        // data: [stationId, orbitType (255 = fixed), a, e, argP, M0, epoch, orbitTimeScale, radius, design, turrets, weapon]
        const def = this.gameData.getStationByNum(Station.stationId[eid]);
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
      for (const eid of portalQuery(this.world)) {
        if (InSystem.systemId[eid] !== playerSystemId) continue;
        if (conn.knownEntities.has(eid)) continue;
        conn.knownEntities.add(eid);
        markIfChanged({ id: eid, type: EntityType.Portal, x: Math.round(Position.x[eid]), y: Math.round(Position.y[eid]), data: [Portal.targetSystem[eid], Portal.kind[eid], Portal.hue[eid]] });
      }

      // Removals this client cares about: only what it was sent (a row, a fire event's shell, a seeded rock, a station) or
      // made itself (debris it worked out: conn.debrisHeld). A shell 60 km off it never had costs it nothing
      const removed: number[] = [];
      for (const [eid] of this.pendingRemovedEntities) {
        // (a shell a confirmed hit ends: the record says so)
        if (gone?.has(eid)) continue;
        // (Debris it worked out: held, or confirmed but its row not yet counted as sent, debrisRowOk: it has it all the same)
        const made = conn.debrisHeld.delete(eid) || conn.debrisRowOk.delete(eid);
        if (!prevStates.has(eid) && !conn.knownEntities.has(eid) && !made) continue;
        removed.push(eid);
        conn.sentNames.delete(eid);
        conn.mapNamed.delete(eid);
      }
      if (hitsOn && removed.length) this.hits!.dropShells(conn, removed);

      // HUD numbers (fuel, XP) once a second, whether or not anything else goes (the round in each second's first window)
      if (this.currentTick % 60 < (crowd ? crowd.windowOf(playerSystemId) : CROWD_BASE_WINDOW)) this.sendPlayerState(conn);

      // (Records count from the snapshot they follow: one always goes with them)
      const shouldSend = conn.forceSnapshot || entities.length > 0 || removed.length > 0 || rep.ships.length > 0 || rep.ctl.length > 0 || out.length > 0 || fire.length > 0 || !!rep.own?.length || !!rep.causes?.length || !!decisions?.length || !!guided?.active || !!guided?.rows.length
        || (hitsOn && this.hits!.pending(conn));
      if (!shouldSend) {
        this.lastEntityStates.set(conn.playerId, newStates);
        if (hitsOn) this.afterHits(conn, playerSystemId);
        if (conn.focus) this.focus.after(conn);
        continue;
      }

      this.send(conn.ws, {
        type: 'snapshot',
        tick: this.currentTick,
        lastProcessedInput: conn.lastInputSeq,
        entities,
        removed,
        ships: rep.ships.length ? rep.ships : undefined,
        ctl: rep.ctl.length ? rep.ctl : undefined,
        out: out.length ? out : undefined,
        fire: fire.length ? fire : undefined,
        own: rep.own,
        decisions: decisions?.length ? decisions : undefined,
        causes: rep.causes,
        guides: guided?.rows.length ? guided.rows : undefined,
      });

      conn.forceSnapshot = false;
      conn.lastSnapshotSentTick = this.currentTick;
      this.lastEntityStates.set(conn.playerId, newStates);
      if (hitsOn) this.afterHits(conn, playerSystemId);
      // What its check of its own ship should say for this snapshot (CAPS.OWN_SIM: net/own/OwnChecks.ts)
      if (this.ownChecks && ownSimFor(conn.caps) && conn.repKnown.has(conn.playerId)) this.noteOwn(conn);
      // ...and of the bodies it runs (CAPS.BODIES: net/decisions/BodyNet.ts)
      bodies?.note(conn, this.currentTick);
      // (Cells leaving its focus dropped, cells back settled: CAPS.FOCUS)
      if (conn.focus) this.focus.after(conn);
    }

    if (crowd) { crowd.charge(this.chargeTo, performance.now() - t0); this.chargeTo = -1; }
    // Clear pending removed entities after sending to all clients
    // Also remove from knownEntities so they can be re-sent if respawned
    for (const [eid] of this.pendingRemovedEntities) {
      if (due && !due(eid)) continue;
      for (const conn of this.clients.values()) conn.knownEntities.delete(eid);
    }
    // (Encode-once blocks: the removed give their wire ids back, flushRound; ones no block has named for a while too)
    this.flushRound(due, true);
    this.replication.endSnapshot(due);
    this.guides?.sweep();
    [this.keysWere, this.keysNow] = [this.keysNow, this.keysWere];
    this.keysNow.clear();
    const dotsDue = this.currentTick - this.lastMapDotsTick >= MAP_DOTS_TICKS;
    if (dotsDue) this.lastMapDotsTick = this.currentTick;
    this.sendMapDots(dotsDue);
  }

  private lastMapDotsTick = -Infinity;
  /** The system the time since the last charge goes to (crowd fallbacks; -1: none) */
  private chargeTo = -1;

  /**
   * What a round lets go of, for the systems it was for (all: due undefined): removals (encode-once wire ids back),
   * fire events, debris splits told
   */
  private flushRound(due: ((eid: number) => boolean) | undefined, sweep = false): void {
    if (!due) {
      this.blocks?.removed(this.pendingRemovedEntities.keys());
      if (sweep) this.blocks?.sweep(this.currentTick);
      this.pendingRemovedEntities.clear();
      this.ships.fired.length = 0;
      this.ships.debrisNet.afterSnapshot((id) => this.ships.has(id));
      return;
    }
    const gone: number[] = [];
    for (const [eid] of this.pendingRemovedEntities) if (due(eid)) gone.push(eid);
    this.blocks?.removed(gone);
    if (sweep) this.blocks?.sweep(this.currentTick);
    for (const eid of gone) this.pendingRemovedEntities.delete(eid);
    const fired = this.ships.fired;
    let n = 0;
    for (const f of fired) if (!due(f.owner)) fired[n++] = f;
    fired.length = n;
    this.ships.debrisNet.afterSnapshot((id) => this.ships.has(id), due);
  }

  /** A client taking confirmed hits, after its snapshot: its records (and what goes the old way), then its HP, then a check */
  private afterHits(conn: ClientConnection, systemId: number): void {
    this.hits!.write(conn);
    this.sendShipUpdates(conn, systemId, false, true);
    this.hits!.check(conn);
  }

  /** Debris confirmations: right, wrong (sent in full instead), and never (sent in full when its time ran out) */
  readonly debrisAcks = { ok: 0, wrong: 0, late: 0, gone: 0 };

  /**
   * Splits this client can work out itself (common ships/debris.ts deriveSplit): it has the ship as it was (its last
   * sync is the structure the split started from) and replicates it. Each goes as a debrisSplit, before the ship's own
   * sync and the snapshot, and its pieces are held back (no sync, keyframe, status row or HP) until the client
   * confirms them (ackDebris), or its time runs out and they go as any ship does. Its own ship's too, with its pose.
   */
  private holdDebris(conn: ClientConnection): void {
    const now = this.currentTick;
    for (const [id, h] of conn.debrisHeld) {
      // (A piece removed meanwhile stays held till the removal goes: it has it)
      if (h.until < now && this.ships.has(id)) { conn.debrisHeld.delete(id); this.debrisAcks.late++; }
      else if (h.until < now - 600) conn.debrisHeld.delete(id);
    }
    const net = this.ships.debrisNet, live = conn.debrisLive;
    for (const [parent, splits] of net.splits) {
      // (Its own ship's too: the split says where it was)
      const own = parent === conn.playerId;
      if ((!own && !conn.shipView.has(parent)) || !conn.repKnown.has(parent)) continue;
      // (A piece of debris something moved this window: its replica there is off till its keyframe, so its pieces would be)
      if (net.touched.has(parent)) continue;
      // (Dead or gone, with causes this window: those never reach it, so its pose at a split is off there unless the split
      // says it: sent in full)
      const dead = !this.ships.has(parent) || (hasComponent(this.world, Player, parent) && Health.current[parent] <= 0);
      const unsure = dead && this.replication.causedInWindow(parent);
      const synced = conn.shipSynced.get(parent), had = conn.shipHpSent.get(parent);
      if (!synced || !had) continue;
      // (A piece it runs, as the server has it: it worked its crumbling out, so it has it as it was whatever its last sync)
      const runs = !!live?.has(parent) && !net.told.has(parent);
      // (Its copy is the structure the split started from if its centre of mass is that one: HP-band rebuilds don't move it)
      const com = net.comAt(parent, synced.rebuilds);
      for (const sp of splits) {
        if (synced.ship !== sp.ship) continue;
        // (Not the structure it has (rebuilt again in the window, say): the split says all it needs, the centre of mass it
        // started from, where it was and the pieces' HP; it has the design)
        const whole = !runs && (!com || com[0] !== sp.com[0] || com[1] !== sp.com[1]);
        if (whole && (!sp.pose || !sp.hp)) continue;
        const told = sp.gone || own || whole;
        if (unsure && !told) continue;
        const until = now + DEBRIS_ACK_TICKS + 2 * Math.ceil(conn.ping / (1000 / TICK_RATE));
        // (Its to run from their spawn, CAPS.DEBRIS: pieces of a ship, or of a piece it runs: it knows when each part crumbles)
        const l = debrisFor(conn.caps) && (sp.ship.kind !== 'debris' || runs);
        sp.ids.forEach((id, k) => conn.debrisHeld.set(id, { until, hp: whole ? [...sp.hp![k]] : sp.groups[k].map((i) => had[i] ?? 0), live: l }));
        // (A ship destroyed, or its own: where it was, for what it has of it then isn't sure to be the server's)
        const at = told && sp.pose ? [sp.pose.x, sp.pose.y, sp.pose.angle, sp.pose.vx, sp.pose.vy, sp.pose.angVel] : undefined;
        this.send(conn.ws, {
          type: 'debrisSplit', id: parent, tick: sp.tick, e: packIds(sp.ids), p: packRuns(sp.parts), l: l ? 1 : undefined, g: sp.sheds ? packSheds(sp.sheds) : undefined, s: at,
          c: whole ? [...sp.com] : undefined, h: whole ? sp.hp!.flat() : undefined,
        });
      }
    }
  }

  /** A client's confirmations of debris it worked out ([id, check, ...], on its input): right, it counts as sent */
  ackDebris(conn: ClientConnection, acks: readonly number[]): void {
    for (let i = 0; i + 1 < acks.length; i += 2) {
      const id = acks[i], held = conn.debrisHeld.get(id);
      if (!held) continue;
      const sp = this.ships.debrisNet.spawns.get(id), ship = this.ships.bodies.get(id);
      // (Gone meanwhile: it stays held till its removal goes, or the client keeps the piece it worked out for ever)
      if (!sp || !ship) { this.debrisAcks.gone++; continue; }
      conn.debrisHeld.delete(id);
      // (Wrong: it goes to this client in full, keyframe and all. A piece in its grace knocked nothing meanwhile, so that's
      // all that's off; one past it, what it knocked into is off too: it's keyframed for everyone)
      if (sp.hash !== acks[i + 1]) {
        this.debrisAcks.wrong++;
        conn.repKnown.delete(id);
        if (!this.ships.debrisNet.young(ship, this.currentTick)) this.ships.debrisNet.touched.add(id);
        continue;
      }
      this.debrisAcks.ok++;
      conn.shipSynced.set(id, { ship, rebuilds: sp.rebuilds });
      conn.shipHpSent.set(id, held.hp);
      conn.repKnown.set(id, 1);
      conn.debrisRowOk.add(id);
      if (held.live) (conn.debrisLive ??= new Set()).add(id);
    }
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
      // (Holding cells with its map shut: its ghosts, the ring's ships as legs: CAPS.FOCUS)
      if (!(conn.mapOpen || conn.focus) || !(due || conn.mapDotsDue) || !conn.ws.isOpen() || !hasComponent(this.world, Player, conn.playerId)) continue;
      const ghost = conn.mapOpen ? null : this.focus.ghost(conn);
      conn.mapDotsDue = false;
      const sent = (conn.mapSent ??= new Map());
      const full = conn.mapFresh === true;
      conn.mapFresh = false;
      const dots: number[] = [], routes: number[] = [], info: number[] = [], gone: number[] = [];
      const names: (number | string)[] = [];
      const on = new Set<number>();
      for (const r of rowsFor(InSystem.systemId[conn.playerId])) {
        if (r.eid === conn.playerId || conn.shipView.has(r.eid) || (ghost && !ghost(r.eid))) continue;
        on.add(r.eid);
        const was = sent.get(r.eid);
        // (A live one: how far it's strayed from where the client has it, carried on along what it was sent)
        const off = was && r.seq < 0 ? (() => { const p = legAt(was.leg, now - was.tick); return dhypot(p.x - r.leg.x, p.y - r.leg.y); })() : 0;
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
    this.crowd?.enter(conn, playerSystemId);
    this.focus.reset(conn);
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
        ids: packRanges(ids),
        indices: packRanges(indices),
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
