/**
 * Client-side mirror of every modular ship and debris body the server has told
 * us about. Structure comes from shipSync (rebuilt locally with the shared
 * rebuild(), from the exact HP the server rebuilt from), part HP from shipHp.
 */

import {
  Blueprint, Catalog, PlacedGeom, ShipState, ShipTuning, ShipDerived, Vec2,
  ServerShipSyncMessage, ServerShipHpMessage, ServerShipHpBatchMessage,
  blueprintGeometry, createShipState, rebuildShip,
} from '@space-game/common';

/** What the ship renderer, HUD and hangar read from. */
export interface ShipSource {
  readonly catalog: Catalog;
  readonly tuning: ShipTuning;
  readonly bodies: Map<number, ShipState>;
  get(id: number): ShipState | undefined;
  geometry(ship: ShipState): PlacedGeom[];
}

/** Ships' structures as the store has them: each kept by its rebuild's tick too, with CAPS.STRUCTS (ShipStore.derivedAt) */
export interface StructSource {
  get(id: number): ShipState | undefined;
  geometry(ship: ShipState): PlacedGeom[];
  derivedAt?(id: number, t: number): ShipDerived | undefined;
  rebuildAt?(id: number, t: number): { from: Vec2; to: Vec2 } | null | undefined;
}

/** A ship as it was on a tick, for the hits struck then (ShipStore.asOf) */
interface HitShipSource {
  get(id: number): ShipState | undefined;
  /** The ship as a hit on tick t struck it: before a rebuild sync whose rebuild came on t or after, else as it is */
  asOf?(id: number, t: number): ShipState | undefined;
}

export class ShipStore implements ShipSource, StructSource {
  readonly bodies = new Map<number, ShipState>();
  private geomCache = new WeakMap<Blueprint, PlacedGeom[]>();
  private lastSeen = new Map<number, number>();

  /** A sync came without a blueprint for a ship we don't have: ask for the whole thing */
  onMissing: ((id: number) => void) | null = null;
  /** Designs by hash: the server sends another ship of a design we have by its hash alone */
  private designs = new Map<string, Blueprint>();
  /**
   * Each ship's structures by the tick of the rebuild that made them, oldest first (CAPS.STRUCTS: every rebuild tick's
   * sync comes, stamped `at`): the one it flew on any tick since the first. A sync without `at` starts it over
   */
  private structs = new Map<number, { at: number; derived: ShipDerived }[]>();
  /** Debris only to be seen (a boss's shed plates): it knocks nothing */
  readonly aloof = new Set<number>();
  /**
   * Each ship as it was before its latest rebuild syncs (one a sync of a ship it had, stamped with its rebuild's tick:
   * CAPS.STRUCTS), oldest first: its structure, detached and ghost parts, and its HP then, as a view over the ship
   * (asOf). A hit on a tick up to a rebuild struck the structure before it, and is worked out on that and the HP it had
   * (the server does the same on its copy: HitLedger.derive); the sync's own HP, which has those hits in, stands
   */
  private befores = new Map<number, { at: number; view: ShipState }[]>();

  constructor(readonly catalog: Catalog, readonly tuning: ShipTuning) {}

  get(id: number): ShipState | undefined {
    return this.bodies.get(id);
  }

  geometry(ship: ShipState): PlacedGeom[] {
    let g = this.geomCache.get(ship.blueprint);
    if (!g) {
      g = blueprintGeometry(this.catalog, ship.blueprint);
      this.geomCache.set(ship.blueprint, g);
    }
    return g;
  }

  /** Will this sync keep the ship before it for the hits struck up to its rebuild (asOf)? Asked before it's applied */
  keepsBefore(msg: ServerShipSyncMessage): boolean {
    return msg.at !== undefined && msg.design === undefined && !msg.blueprint && this.bodies.has(msg.id);
  }

  /** Returns the parts that came back since the last sync (station repair) */
  onSync(msg: ServerShipSyncMessage): number[] {
    if (msg.blueprint && msg.design) {
      this.designs.delete(msg.design);
      this.designs.set(msg.design, msg.blueprint);
      if (this.designs.size > 300) this.designs.delete(this.designs.keys().next().value!);
    } else if (msg.design) {
      // A design we were sent before
      const bp = this.designs.get(msg.design);
      if (!bp) { this.onMissing?.(msg.id); return []; }
      msg = { ...msg, blueprint: bp };
    }
    const prev = this.bodies.get(msg.id);
    // (A rebuild of the ship we have, stamped with its tick (the server sent no design: not new to us): the ship before it
    // kept for the hits struck up to then, asOf)
    const kept = this.keepsBefore(msg);
    // Without a blueprint it's the ship we have, rebuilt; with one it may be a new design
    if (!msg.blueprint && !prev) { this.onMissing?.(msg.id); return []; }
    const sameShape = !!prev && (!msg.blueprint || sameBlueprint(prev.blueprint, msg.blueprint));
    const wasAlive = sameShape && prev && prev.kind === 'ship' ? [...prev.derived.alive] : null;
    // (A piece of debris's structure before this sync: the one it flew till the rebuild's tick, for its knocks then)
    const before = sameShape && prev?.kind === 'debris' ? prev.derived : undefined;
    this.noteBefore(msg.id, kept && sameShape ? msg.at! : undefined, prev);
    const ship = sameShape
      ? prev!
      : createShipState(this.catalog, this.tuning, msg.id, msg.blueprint!, 0, { kind: msg.kind });
    ship.kind = msg.kind;
    // (Its shells' damage multiplier: a new ship's (design or blueprint: the server's first sync of it) as it says, else
    // only when it says it changed)
    if (msg.design !== undefined || msg.blueprint) ship.dmg = msg.dmg;
    else if (msg.dmg !== undefined) ship.dmg = msg.dmg === 1 ? undefined : msg.dmg;
    if (msg.hp) ship.hp = [...msg.hp];
    // (a boss's hull isn't the blueprint's: its true maximums, so full health draws as full)
    if (msg.maxHp && msg.maxHp.length === ship.maxHp.length) ship.maxHp = [...msg.maxHp];
    else for (const [i, h] of msg.hpd ?? []) ship.hp[i] = h;
    ship.detached = ship.blueprint.parts.map((_, i) => msg.detached.includes(i));
    ship.ghost = ship.blueprint.parts.map((_, i) => !!msg.ghosts?.includes(i));
    rebuildShip(ship, this.catalog, this.tuning);
    ship.rebuilds = msg.rebuilds;
    if (sameShape && prev) ship.angVel = prev.angVel;
    // (A piece of debris: when it spawned, for its grace, and whether it knocks at all: its debris world, DebrisSplits.shape)
    if (msg.born !== undefined) ship.spawnTick = msg.born;
    if (msg.aloof) this.aloof.add(msg.id);
    else if (!sameShape) this.aloof.delete(msg.id);
    this.bodies.set(msg.id, ship);
    this.noteStruct(msg.id, msg.at, ship.derived, !sameShape, before);
    return wasAlive && ship.kind === 'ship' ? ship.derived.alive.map((a, i) => (a && !wasAlive[i] ? i : -1)).filter((i) => i >= 0) : [];
  }

  onHp(msg: ServerShipHpMessage): void {
    const ship = this.bodies.get(msg.id);
    if (!ship) return;
    for (const [i, hp] of msg.hp) ship.hp[i] = hp;
  }

  onHps(msg: ServerShipHpBatchMessage): void {
    for (const [id, hp] of msg.ships) {
      const ship = this.bodies.get(id);
      if (ship) for (const [i, h] of hp) ship.hp[i] = h;
    }
  }

  /**
   * Forget bodies whose entity the client hasn't seen for `graceMs` (a sync can
   * arrive a moment before the snapshot that introduces its entity).
   */
  prune(alive: (id: number) => boolean, now: number, graceMs = 2000): void {
    for (const id of this.bodies.keys()) {
      if (alive(id)) this.lastSeen.set(id, now);
      else if (now - (this.lastSeen.get(id) ?? now) > graceMs) { this.bodies.delete(id); this.lastSeen.delete(id); }
      else if (!this.lastSeen.has(id)) this.lastSeen.set(id, now);
    }
  }

  /**
   * A new connection: every ship goes (the server sends each it shows again, and may give a gone one's id to something
   * else). The designs by hash stay: a hash names the same design whichever session it came in
   */
  clear(): void {
    this.bodies.clear();
    this.lastSeen.clear();
    this.structs.clear();
    this.befores.clear();
    this.aloof.clear();
  }

  remove(id: number): void {
    this.bodies.delete(id);
    this.lastSeen.delete(id);
    this.structs.delete(id);
    this.befores.delete(id);
    this.aloof.delete(id);
  }

  private noteStruct(id: number, at: number | undefined, derived: ShipDerived, fresh: boolean, before?: ShipDerived): void {
    let list = this.structs.get(id);
    if (at === undefined || fresh) { this.structs.delete(id); list = undefined; }
    if (at === undefined) return;
    if (!list) this.structs.set(id, (list = before ? [{ at: -Infinity, derived: before }] : []));
    if (list.length && list[list.length - 1].at >= at) list.length = list.findIndex((e) => e.at >= at);
    list.push({ at, derived });
    if (list.length > 16) list.shift();
  }

  /** A sync about to be applied: the ship before it kept (a rebuild stamped `at`), else what was kept goes */
  private noteBefore(id: number, at: number | undefined, prev: ShipState | undefined): void {
    if (at === undefined || !prev) { this.befores.delete(id); return; }
    const view = Object.create(prev) as ShipState;
    view.hp = [...prev.hp];
    view.detached = [...prev.detached];
    view.ghost = [...prev.ghost];
    view.derived = prev.derived;
    let list = this.befores.get(id);
    if (!list) this.befores.set(id, (list = []));
    if (list.length && list[list.length - 1].at >= at) list.length = list.findIndex((e) => e.at >= at);
    list.push({ at, view });
    if (list.length > 8) list.shift();
  }

  /**
   * The ship as a hit on tick t struck it: before the first rebuild kept on t or after (a ship rebuilds at the end of its
   * tick, after the collision step), else as it is now
   */
  asOf(id: number, t: number): ShipState | undefined {
    const list = this.befores.get(id);
    if (list) for (const e of list) if (e.at >= t) return e.view;
    return this.bodies.get(id);
  }

  /**
   * The structure a ship flew on tick t (it rebuilt at the end of a tick: the one made before t), as its syncs kept it by
   * tick (CAPS.STRUCTS); undefined: none kept from that far back
   */
  derivedAt(id: number, t: number): ShipDerived | undefined {
    const list = this.structs.get(id);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].at < t) return list[i].derived;
    return undefined;
  }

  /**
   * A rebuild on tick t: its centres of mass either side (null: kept, and none on t); undefined: not kept from then
   * (CAPS.STRUCTS)
   */
  rebuildAt(id: number, t: number): { from: Vec2; to: Vec2 } | null | undefined {
    const list = this.structs.get(id);
    if (!list?.length || t <= list[0].at) return undefined;
    for (let i = list.length - 1; i > 0; i--) if (list[i].at === t) return { from: list[i - 1].derived.com, to: list[i].derived.com };
    return null;
  }
}

/** Same design (parts in the same places), without serialising both */
function sameBlueprint(a: Blueprint, b: Blueprint): boolean {
  if (a === b) return true;
  if (a.parts.length !== b.parts.length || a.name !== b.name || a.paint !== b.paint) return false;
  for (let i = 0; i < a.parts.length; i++) {
    const p = a.parts[i], q = b.parts[i];
    if (p.uid !== q.uid || p.fn !== q.fn || p.piece !== q.piece || p.material !== q.material || p.x !== q.x || p.y !== q.y || p.rot !== q.rot
      || p.flip !== q.flip || p.mount !== q.mount || p.facing !== q.facing) return false;
  }
  return true;
}
