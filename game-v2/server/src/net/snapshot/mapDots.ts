/**
 * @contract server.snapshot.map-dots
 * owns:       what goes past the ship view: the system map's dots (legs, patrol routes, hostiles' places by distance
 *             tier, looks, names, the gone) and the hostile populations (pops) to the clients in their systems
 * needs:      MapHost (world, clients, ships, enemies, lod, namedBody, flying, gameData, focus.ghost, send, ticks),
 *             common map packers (packMapLeg, packMapRoute, mapDotFlags), FEED_TIERS; npm: bitecs
 * invariants: a dot is sent again only when its route changes or it strays MAP_DOT_SLACK — none pinned
 *             map bytes unchanged — server/src/golden/frameHash.test.ts
 * extend:     a new kind of dot is one `add(...)` source in rowsFor (sendMapDots)
 */
import { hasComponent, type IWorld } from 'bitecs';
import {
  Position, Velocity, InSystem, Player, MAP_DOT_SLACK, MAP_PT_SLACK, RING_RANGE, FEED_TIERS, feedMidRadius, mapDotFlags, legAt, packMapLeg,
  packMapRoute, unpackMapLegs, nearerThan, dhypot, type Leg, type ClientSocket, type ServerMessage,
} from '@space-game/common';
import type { GameData } from '../../data/GameData.js';
import type { ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { SimLod } from '../../ships/SimLod.js';
import type { Enemies } from '../../game/Enemies.js';
import type { FocusCells } from '../cells/FocusCells.js';
import { MAP_DOTS_TICKS } from './constants.js';

/** What the map dots and pops need of the server */
export interface MapHost {
  readonly world: IWorld;
  readonly gameData: GameData;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly ships: ShipBridge;
  readonly enemies: Enemies;
  readonly lod: SimLod;
  readonly focus: Pick<FocusCells, 'ghost'>;
  readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  readonly namedBody: (eid: number) => { name: string; kind: number } | undefined;
  readonly flying: (eid: number) => boolean;
  readonly ticks: { readonly currentTick: number };
}

/**
 * Hostile populations (Enemies: nests' and zones' packs, ship by ship) to the clients in their systems: everything
 * once (a new system or connection), then only the spawners that changed (a death, a ship back, a pack loaded or
 * put back to a ghost). The clients work out every ghost's place from it (common world/populations.ts).
 */
export function sendPops(h: MapHost): void {
  const changed = h.enemies.popChanges();
  for (const conn of h.clients.values()) {
    if (!conn.ws.isOpen() || !hasComponent(h.world, Player, conn.playerId)) continue;
    const num = InSystem.systemId[conn.playerId];
    if (conn.popsFresh) {
      conn.popsFresh = false;
      const all = h.enemies.popRows(num);
      h.send(conn.ws, { type: 'pops', p: all.p, full: 1, ...(all.n.length ? { n: all.n } : {}) });
      continue;
    }
    const rows = changed.get(num);
    if (rows?.p.length) h.send(conn.ws, { type: 'pops', p: rows.p, ...(rows.n.length ? { n: rows.n } : {}) });
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
export function sendMapDots(h: MapHost, due: boolean): void {
  type Row = { eid: number; name?: string; look: number; rating: number; leg: Leg; seq: number; patrol?: NonNullable<ReturnType<SimLod['track']>>['patrol'] };
  const bySystem = new Map<number, Row[]>();
  const rowsFor = (num: number) => {
    let rows = bySystem.get(num);
    if (rows) return rows;
    rows = [];
    const add = (eid: number, kind: number, name: string | undefined, foe?: ReturnType<Enemies['info']>) => {
      // A distant ship's leg from its route; a live one's as it's going now, held
      const far = h.lod.track(eid);
      const leg = far?.leg ?? { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], wx: Velocity.x[eid], wy: Velocity.y[eid], thrust: -1 };
      const look = mapDotFlags({ kind, rank: foe?.boss ? 2 : foe?.elite ? 1 : 0, calm: !!foe && h.enemies.isCalm(eid), faction: foe?.factionIndex ?? -1 });
      rows!.push({ eid, name, look, rating: Math.round(foe?.rating ?? 0), leg, seq: far?.seq ?? -1, patrol: far?.patrol });
    };
    for (const [eid, ship] of h.ships.bodies) {
      if (InSystem.systemId[eid] !== num || ship.kind !== 'ship' || hasComponent(h.world, Player, eid)) continue;
      const named = h.namedBody(eid);
      if (named) add(eid, named.kind, named.name, named.kind === 3 ? h.enemies.info(eid) : undefined);
    }
    // Other pilots, wherever they are in the system
    for (const c of h.clients.values()) if (h.flying(c.playerId) && InSystem.systemId[c.playerId] === num) add(c.playerId, 4, c.username);
    bySystem.set(num, rows);
    return rows;
  };
  const now = h.ticks.currentTick;
  // Hostiles (loaded and active: not predictable from the client) go as places at their distance's rate
  // (FEED_TIERS): in the client's ring every round, in the system's first band (inner Sol) every 2 s, past it every 5 s
  const mid = new Map<number, number>();
  const midOf = (num: number) => { let r = mid.get(num); if (r === undefined) mid.set(num, (r = feedMidRadius(h.gameData.getSystemByNum(num), FEED_TIERS))); return r; };
  for (const conn of h.clients.values()) {
    // (Holding cells with its map shut: its ghosts, the ring's ships as legs: CAPS.FOCUS)
    if (!(conn.mapOpen || conn.focus) || !(due || conn.mapDotsDue) || !conn.ws.isOpen() || !hasComponent(h.world, Player, conn.playerId)) continue;
    const ghost = conn.mapOpen ? null : h.focus.ghost(conn);
    conn.mapDotsDue = false;
    const sent = (conn.mapSent ??= new Map());
    const full = conn.mapFresh === true;
    conn.mapFresh = false;
    const dots: number[] = [], routes: number[] = [], info: number[] = [], gone: number[] = [], pts: number[] = [];
    const names: (number | string)[] = [];
    const on = new Set<number>();
    const num = InSystem.systemId[conn.playerId], px = Position.x[conn.playerId], py = Position.y[conn.playerId], midR = midOf(num);
    for (const r of rowsFor(num)) {
      if (r.eid === conn.playerId || conn.shipView.has(r.eid) || (ghost && !ghost(r.eid))) continue;
      on.add(r.eid);
      const was = sent.get(r.eid);
      if ((r.look & 7) === 3) {
        // (A hostile: its place, when its tier's due and it's moved; seq -2 marks a place sent, not a leg)
        const every = nearerThan(r.leg.x - px, r.leg.y - py, RING_RANGE) ? MAP_DOTS_TICKS : nearerThan(r.leg.x, r.leg.y, midR) ? FEED_TIERS.midTicks : FEED_TIERS.farTicks;
        if (!was || was.seq !== -2 || (now - was.tick >= every - 1 && dhypot(was.leg.x - r.leg.x, was.leg.y - r.leg.y) > MAP_PT_SLACK)) {
          const x = Math.round(r.leg.x / 10), y = Math.round(r.leg.y / 10);
          pts.push(r.eid, x, y);
          sent.set(r.eid, { leg: { x: x * 10, y: y * 10, vx: 0, vy: 0, wx: 0, wy: 0, thrust: -1 }, tick: now, seq: -2, look: was?.look ?? -1 });
        }
      } else if (!was || was.seq !== r.seq || (r.seq < 0 && (() => { const p = legAt(was.leg, now - was.tick); return dhypot(p.x - r.leg.x, p.y - r.leg.y); })() > MAP_DOT_SLACK)) {
        // (A live one: sent again once it's strayed from where the client has it, carried on along what it was sent)
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
    if (!full && !dots.length && !routes.length && !info.length && !gone.length && !names.length && !pts.length) continue;
    h.send(conn.ws, { type: 'mapDots', tick: now, dots, ...(routes.length ? { routes } : {}), ...(info.length ? { info } : {}), ...(gone.length ? { gone } : {}), ...(names.length ? { names } : {}), ...(full ? { full: 1 as const } : {}), ...(pts.length ? { pts } : {}) });
  }
}
