/**
 * @contract server.snapshot.structure
 * owns:       ship structure for each client: a full sync (blueprint or design hash) on first sight, a light one after each
 *             rebuild (the structures between first, CAPS.STRUCTS), part HP deltas otherwise; the HP copies hits derive from
 * needs:      StructureHost (ships, send, hits, ticks), ships/bridge/structLog (nextSync), common hpWire
 * invariants: a design a client has seen goes by its hash — server/src/golden/frameHash.test.ts
 *             syncs go before the snapshot, HP after a hits client's records — server/src/net/hits/selfHits.test.ts
 *             bytes per client unchanged — server/src/golden/frameHash.test.ts
 * extend:     a new field of a ship's structure on the wire is one member of the shipSync in sendShipUpdates
 */
import { InSystem, hpWire, type ShipState, type ClientSocket, type ServerMessage } from '@space-game/common';
import { syncedShip, type ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import { nextSync, type StructEntry } from '../../ships/bridge/structLog.js';
import type { HitLedger } from '../hits/HitLedger.js';

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

/** What ship structure needs of the server */
export interface StructureHost {
  readonly ships: ShipBridge;
  readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  readonly hits: HitLedger | null;
  readonly ticks: { readonly currentTick: number };
}

/**
 * Ship structure for one client: a full sync (blueprint and all) the first time
 * it sees a ship, a light one (part HP and what's detached) after each rebuild,
 * and part HP changes otherwise, all ships' in one message. Ships far from the
 * client wait until it comes near (it only sees them as dots out there).
 */
export class ShipStructure {
  private readonly ships: ShipBridge;
  private readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  private readonly hits: HitLedger | null;
  private readonly ticks: { readonly currentTick: number };
  /** Each ship's part HP as sent (to a tenth), worked out once a snapshot, and the snapshot it last changed at */
  private hpWire = new Map<number, { ship: ShipState; at: number; since: number; hp: number[] }>();
  private snapshotCount = 0;

  constructor(host: StructureHost) {
    this.ships = host.ships;
    this.send = host.send;
    this.hits = host.hits;
    this.ticks = host.ticks;
  }

  private get currentTick(): number {
    return this.ticks.currentTick;
  }

  /** A snapshot round with clients begins: the per-round wire caches move on */
  beginRound(): void {
    this.snapshotCount++;
    for (const id of this.hpWire.keys()) if (!this.ships.has(id)) this.hpWire.delete(id);
    this.syncWire.clear();
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
  keptAfter(conn: ClientConnection, id: number, systemId: number): readonly number[] | undefined {
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
    this.noteBefore(conn, id, e.tick, e.rebuilds, hpd ? had : undefined, conn.shipSynced.get(id)?.ship === ship ? conn.shipSynced.get(id)!.rebuilds : -1);
    conn.shipHpSent.set(id, [...hp]);
    this.send(conn.ws, {
      type: 'shipSync', id, kind: ship.kind, hp: hpd ? undefined : hp, hpd: hpd?.length ? hpd : undefined,
      maxHp: !hpd && ship.scaledHp ? ship.maxHp.map(hpWire) : undefined,
      detached: [...e.detached], rebuilds: e.rebuilds, ghosts: e.ghosts ? [...e.ghosts] : undefined, at: e.tick,
    });
  }

  /**
   * A rebuild sync of a ship this client has, about to go (its HP copy `had` just before it; undefined: it gets the
   * HP whole, or the ship is new to it): kept for the window's hits on the structure before (HitLedger.derive). The
   * rebuild count it had before is the last such sync's this window, else `was` (-1: none)
   */
  private noteBefore(conn: ClientConnection, id: number, at: number | undefined, rebuilds: number, had: readonly number[] | undefined, was: number): void {
    if (!this.hits) return;
    const map = (conn.hpBefore ??= new Map());
    const list = map.get(id);
    if (list === null) return;
    const from = list?.length ? list[list.length - 1].rebuilds : was;
    if (at === undefined || !had || from < 0) { map.set(id, null); return; }
    const e = { at, from, rebuilds, hp: had.slice() };
    if (list) list.push(e); else map.set(id, [e]);
  }

  /**
   * `syncs` and `hps`: a client taking confirmed hits gets its syncs before its snapshot (as everyone does) and its HP
   * after its records (HitLedger: they bring its copy up to date first), so the two go separately
   */
  sendShipUpdates(conn: ClientConnection, systemId: number, syncs = true, hps_ = true): void {
    if (syncs) for (const id of conn.shipSynced.keys()) {
      if (!this.ships.has(id)) { conn.shipSynced.delete(id); conn.shipHpSent.delete(id); }
    }
    const hps: [number, [number, number][]][] = [];
    // (Debris it's working out itself waits for its confirmation: ackDebris)
    // Ships out of view wait (the client keeps what it had, and catches up when one comes back). The view was
    // made this snapshot from the system's bodies in their order (FocusCells.view), so this goes in that order too
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
        const next = nextSync(this.ships.structLog, id, ship, synced);
        const was = fresh ? -1 : synced!.rebuilds;
        for (const e of next.between) this.sendBetween(conn, id, ship, e);
        const kept: number[] | undefined = next.kept, at: number | undefined = next.at;
        // (Its shells' damage multiplier: on a new ship's sync when it isn't 1, then whenever it changed)
        const dmg = this.ships.damageMulOf(id), hadDmg = fresh ? 1 : (synced?.dmg ?? 1);
        // (Pinned as it spawned, told on a new ship's sync: the client's contact pass takes it so, contactsFor.ts)
        const pinned = fresh ? this.ships.isPinned(id) : !!synced?.pinned;
        synced = syncedShip(ship, ship.rebuilds, this.currentTick, kept, dmg, pinned);
        conn.shipSynced.set(id, synced);
        const sync = this.syncWireOf(id, ship);
        const hp = sync.hp;
        // After a rebuild the client has this ship's HP already, bar what changed since
        const had = fresh ? undefined : conn.shipHpSent.get(id);
        const hpd = had && had.length === hp.length ? hp.flatMap((h, i) => (had[i] !== h ? [[i, h] as [number, number]] : [])) : undefined;
        if (fresh) conn.hpBefore?.delete(id);
        this.noteBefore(conn, id, at, ship.rebuilds, hpd ? had : undefined, was);
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
          dmg: dmg !== hadDmg ? dmg : undefined,
          pinned: fresh && pinned ? 1 : undefined,
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
}
