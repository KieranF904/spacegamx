/**
 * @contract server.snapshot.debris-hold
 * owns:       debris splits a client works out itself: each told as a debrisSplit before the ship's sync and snapshot,
 *             its pieces held back until the client confirms them (ackDebris) or their time runs out
 * needs:      DebrisHoldHost (world, ships: debrisNet, replication.causedInWindow, send, ticks), common packers; npm: bitecs
 * invariants: a held piece sends no sync, keyframe, status row or HP until confirmed — server/src/net/snapshot/debrisAcks.test.ts
 *             a wrong confirmation goes in full — server/src/net/snapshot/debrisAcks.test.ts
 * extend:     a new reason a held piece goes in full is one branch in the first loop of holdDebris
 */
import { hasComponent, type IWorld } from 'bitecs';
import { Player, Health, packIds, packRuns, packSheds, TICK_RATE, type ClientSocket, type ServerMessage } from '@space-game/common';
import { syncedShip, type ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import type { Replication } from '../Replication.js';
import { DEBRIS_ACK_TICKS } from './constants.js';

/** What the debris hold needs of the server */
export interface DebrisHoldHost {
  readonly world: IWorld;
  readonly ships: ShipBridge;
  readonly replication: Pick<Replication, 'causedInWindow'>;
  readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  readonly ticks: { readonly currentTick: number };
}

export class DebrisHold {
  private readonly world: IWorld;
  private readonly ships: ShipBridge;
  private readonly replication: Pick<Replication, 'causedInWindow'>;
  private readonly send: (ws: ClientSocket, msg: ServerMessage) => void;
  private readonly ticks: { readonly currentTick: number };

  constructor(host: DebrisHoldHost) {
    this.world = host.world;
    this.ships = host.ships;
    this.replication = host.replication;
    this.send = host.send;
    this.ticks = host.ticks;
  }

  private get currentTick(): number {
    return this.ticks.currentTick;
  }

  /**
   * Debris confirmations: right, wrong (sent in full instead), never (sent in full when its time ran out), and rebuilt
   * (crumbled before it was confirmed, for a client not running it: sent in full), and told (touched by something else
   * before it was confirmed: sent in full)
   */
  readonly debrisAcks = { ok: 0, wrong: 0, late: 0, gone: 0, rebuilt: 0, told: 0 };

  /**
   * Splits this client can work out itself (common ships/debris.ts deriveSplit): it has the ship as it was (its last
   * sync is the structure the split started from) and replicates it. Each goes as a debrisSplit, before the ship's own
   * sync and the snapshot, and its pieces are held back (no sync, keyframe, status row or HP) until the client
   * confirms them (ackDebris), or its time runs out and they go as any ship does. Its own ship's too, with its pose.
   */
  holdDebris(conn: ClientConnection): boolean {
    const now = this.currentTick;
    let sent = false;
    const net = this.ships.debrisNet, live = conn.debrisLive;
    // (Rebuilt since its spawn (a crumble): a client that doesn't run it can't work that out, nor get its sync while held)
    const rebuilt = (id: number) => { const ship = this.ships.bodies.get(id); return !!ship && ship.rebuilds !== net.spawns.get(id)?.rebuilds; };
    for (const [id, h] of conn.debrisHeld) {
      // (A piece removed meanwhile stays held till the removal goes: it has it)
      if (h.until < now && this.ships.has(id)) { conn.debrisHeld.delete(id); this.debrisAcks.late++; }
      else if (h.until < now - 600) conn.debrisHeld.delete(id);
      // (...crumbled in its hold: it goes in full now, as any ship does, its structure from a sync and its place a keyframe)
      else if (!h.live && rebuilt(id)) { conn.debrisHeld.delete(id); this.debrisAcks.rebuilt++; }
      // (...touched by something else in its hold (a shot, a blast: DebrisNet.told): its HP, and its place once a part
      // that took breaks off (what's left recentred), are no longer what it worked out, and nothing of it goes while
      // held: it goes in full now, run by it or not)
      else if (net.told.has(id) && this.ships.has(id)) { conn.debrisHeld.delete(id); this.debrisAcks.told++; }
    }
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
        // (Nor the HP it has of the parts that left: they took damage it wasn't told before the split (a part's blast on
        // the split's tick, the ship gone before its HP could go): the split gives the pieces' HP as the server split them)
        const stale = !runs && !!sp.hp && sp.groups.some((g, k) => g.some((i, j) => had[i] !== sp.hp![k][j]));
        const whole = (!runs && (!com || com[0] !== sp.com[0] || com[1] !== sp.com[1])) || stale;
        if (whole && (!sp.pose || !sp.hp)) continue;
        const told = sp.gone || own || whole;
        if (unsure && !told) continue;
        const until = now + DEBRIS_ACK_TICKS + 2 * Math.ceil(conn.ping / (1000 / TICK_RATE));
        // (Its to run from their spawn, CAPS.DEBRIS: pieces of a ship, or of a piece it runs: it knows when each part crumbles)
        const l = sp.ship.kind !== 'debris' || runs;
        // (A piece crumbled already, before the split is told: one not run there would be worked out as it was spawned,
        // and its sync, before the snapshot, would come ahead of it: the split goes in full)
        if (!l && sp.ids.some(rebuilt)) continue;
        // (...nor one touched by something else already (shot, blasted): what it would work out is off, so in full)
        if (sp.ids.some((id) => net.told.has(id))) continue;
        sp.ids.forEach((id, k) => conn.debrisHeld.set(id, { until, hp: whole ? [...sp.hp![k]] : sp.groups[k].map((i) => had[i] ?? 0), live: l }));
        // (A ship destroyed, or its own: where it was, for what it has of it then isn't sure to be the server's)
        const at = told && sp.pose ? [sp.pose.x, sp.pose.y, sp.pose.angle, sp.pose.vx, sp.pose.vy, sp.pose.angVel] : undefined;
        this.send(conn.ws, {
          type: 'debrisSplit', id: parent, tick: sp.tick, e: packIds(sp.ids), p: packRuns(sp.parts), l: l ? 1 : undefined, g: sp.sheds ? packSheds(sp.sheds) : undefined, s: at,
          c: whole ? [...sp.com] : undefined, h: whole ? sp.hp!.flat() : undefined,
        });
        sent = true;
      }
    }
    return sent;
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
      conn.shipSynced.set(id, syncedShip(ship, sp.rebuilds));
      conn.shipHpSent.set(id, held.hp);
      conn.repKnown.set(id, 1);
      conn.debrisRowOk.add(id);
      if (held.live) (conn.debrisLive ??= new Set()).add(id);
    }
  }
}
