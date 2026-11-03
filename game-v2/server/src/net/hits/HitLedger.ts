/**
 * Confirmed hits, the server's side (docs/design/confirmed-hits.md part C). A client that announced CAPS.HITS is told
 * "shell s hit part p of ship t" (common network/hits.ts, about 3 bytes) instead of the hit's projectileHit, damage,
 * shipHps entry, removal and effects, and works those out itself with the shared rules (common ships/hitRules.ts).
 * Every other client gets exactly today's messages, at the same moments.
 *
 *   shellHit  a shell hit a ship (bridge hitProjectile): legacy clients are told now; the hit is kept for the rest
 *   hitFx     what the hit set off that a client can work out (fire, a pierce flash, the shell's burst): same
 *   end       the shell is spent
 *   plan      per capable client, as its snapshot is built: which hits it can work out (else they go the old way),
 *             what it will get wrong (the record's extras), and its copy of the part HP (ClientConnection.shipHpSent)
 *             brought to what it will have, so the shipHps after the records corrects anything it got wrong
 *   write     after its snapshot: its damage sums less what the records cover, the records, the hits gone the old way
 *   dropShells  its snapshot's removed list: the shells' pass counts go, as on its client
 *   check     one ship a second it worked out: the server's copy of its HP as a checksum (hpCheck); a client that
 *             disagrees asks for them all again (hpResync)
 *
 * Switching a client's caps takes effect at a snapshot's end (endSnapshot), so a hit is never told both ways.
 */
import type { IWorld } from 'bitecs';
import {
  CAPS, Position, Projectile, InSystem, packHits, hpChecksum, gunShell, deriveShellHit, igniteRule, hitEndFx,
  type ClientSocket, type ServerMessage, type ShellHitRecord, type ShipState,
} from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import { damageMessage, projectileHitMessage, type Outbox } from '../snapshot/Outbox.js';

/** What the ledger needs of the server (GameServer itself) */
export interface HitLedgerHost {
  readonly world: IWorld;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly currentTick: number;
  readonly net: Outbox;
  getShips(): ShipBridge;
}

/** What bridge hitProjectile says of a shell's hit on a ship */
export interface ShellHitInfo { target: number; part: number; dealt: number; glancing: boolean; soak: number; rebuilds: number }

/** One shell's hit on a ship this snapshot */
interface Hit extends ShellHitInfo {
  proj: number;
  owner: number;
  gun: number;
  sys: number;
  tick: number;
  x: number;
  y: number;
  gone: boolean;
  /** The target's state at the hit (a respawn or a reused id makes a new one: that hit goes the old way) */
  state: ShipState | undefined;
  /** The part it set burning (-1: none), and for how long */
  ignite: number;
  igniteTicks: number;
  /** The detonation it was told with (a pierce pass, its end), or null */
  end: { kind: string; radius: number } | null;
  /** The effect messages it set off (sent to legacy clients at once; to a capable one only if it goes the old way) */
  fx: ServerMessage[];
}

/** One capable client's share of a snapshot's hits */
interface Plan {
  recs: ShellHitRecord[];
  /** Each record's damage sum (target, source, glancing) */
  keys: string[];
  /** Hits it gets the old way */
  legacy: Hit[];
  /** Shells the records end (left out of its removed list) */
  gone: Set<number>;
  /** Damage the records cover, by sum */
  covered: Map<string, number>;
}

const keyOf = (target: number, source: number, glancing: boolean) => `${target},${source},${glancing ? 1 : 0}`;

/** One ship a second it worked out gets an hpCheck */
const CHECK_TICKS = 60;

export class HitLedger {
  /** Some client has HITS on this snapshot (else every hit goes as ever, and nothing is kept) */
  private on = false;
  private hits: Hit[] = [];
  /** Each shell's latest hit this snapshot */
  private byProj = new Map<number, Hit>();
  /** The hit just made (Weapons.onShipHit's effects belong to it) */
  private last: Hit | null = null;
  private plans = new Map<ClientConnection, Plan>();
  /** Per client: the ships it has passed through, by shell (as its client counts them: records that didn't end it) */
  private passes = new WeakMap<ClientConnection, Map<number, number>>();
  /** Per client: ships it worked out since their last check, and when it was last checked */
  private checks = new WeakMap<ClientConnection, { due: Set<number>; at: number }>();
  /** Counters (the netcode probe, the admin's `hits` command) */
  readonly stats = { hits: 0, records: 0, legacy: 0, d: 0, s: 0, i: 0, checks: 0, why: {} as Record<string, number> };

  constructor(private host: HitLedgerHost) {}

  /** Does this snapshot keep hits (some client takes records)? */
  get active(): boolean {
    return this.on;
  }

  /** Is this client taking records this snapshot? */
  wants(conn: ClientConnection): boolean {
    return this.on && !!((conn.caps ?? 0) & CAPS.HITS);
  }

  // ---- During the tick ----

  /** A projectile hit something at (x, y) (with `hit`: a shell on a ship) */
  shellHit(proj: number, x: number, y: number, hit?: ShellHitInfo): void {
    if (!this.on || !hit) {
      this.last = null;
      this.host.net.broadcastProjectileHit(proj, x, y);
      return;
    }
    this.host.net.broadcastProjectileHit(proj, x, y, CAPS.HITS);
    const h: Hit = {
      ...hit, proj, owner: Projectile.ownerId[proj], gun: Projectile.gun[proj], sys: InSystem.systemId[proj], tick: this.host.currentTick,
      x, y, gone: false, state: this.host.getShips().get(hit.target), ignite: -1, igniteTicks: 0, end: null, fx: [],
    };
    this.hits.push(h);
    this.byProj.set(proj, h);
    this.last = h;
    this.stats.hits++;
  }

  /** What the hit just made set off (Weapons.atHit): told to legacy clients now, kept for the rest. False: not ours */
  hitFx(proj: number, msg: ServerMessage): boolean {
    const h = this.last;
    if (!this.on || !h || h.proj !== proj) return false;
    if (msg.type === 'ignite') { h.ignite = msg.part; h.igniteTicks = msg.ticks; }
    else if (msg.type === 'detonation') h.end = { kind: msg.kind, radius: msg.radius };
    h.fx.push(msg);
    this.host.net.broadcastToSystem(h.sys, msg, CAPS.HITS);
    return true;
  }

  /** The shell is spent (its latest hit ended it) */
  end(proj: number): void {
    const h = this.byProj.get(proj);
    if (h) h.gone = true;
  }

  // ---- Per client, as its snapshot goes ----

  /**
   * Works out what this client will make of each hit, in order (its HP copy is brought to that), and which go the
   * old way. `known`: shells it has (a row, or a fire event, now or before). Returns the shells the records end
   * (left out of its removed list); null if it takes no records.
   */
  plan(conn: ClientConnection, known: (id: number) => boolean): ReadonlySet<number> | null {
    if (!this.wants(conn)) return null;
    const plan: Plan = { recs: [], keys: [], legacy: [], gone: new Set(), covered: new Map() };
    this.plans.set(conn, plan);
    if (!this.hits.length) return plan.gone;
    let passes = this.passes.get(conn);
    if (!passes) this.passes.set(conn, (passes = new Map()));
    let check = this.checks.get(conn);
    if (!check) this.checks.set(conn, (check = { due: new Set(), at: -Infinity }));
    const ships = this.host.getShips(), tick = this.host.currentTick, sys = InSystem.systemId[conn.playerId];
    for (const h of this.hits) {
      // (another system's: nothing of it goes to this client either way)
      if (h.sys !== sys) continue;
      const why = this.derive(conn, h, ships, known, passes, plan, tick);
      if (why) {
        plan.legacy.push(h);
        this.stats.legacy++;
        this.stats.why[why] = (this.stats.why[why] ?? 0) + 1;
        continue;
      }
      check.due.add(h.target);
    }
    return plan.gone;
  }

  /** One hit for one client: a record (null), or why it goes the old way */
  private derive(conn: ClientConnection, h: Hit, ships: ShipBridge, known: (id: number) => boolean, passes: Map<number, number>, plan: Plan, tick: number): string | null {
    // The target as the client has it: in view, synced, not rebuilt since the hit (a rebuild's sync carries its HP)
    const ship = ships.get(h.target);
    if (!ship || ship !== h.state || ship.rebuilds !== h.rebuilds) return 'rebuilt';
    if (!conn.shipView.has(h.target) || conn.debrisHeld.has(h.target)) return 'view';
    const synced = conn.shipSynced.get(h.target), sent = conn.shipHpSent.get(h.target);
    if (!synced || synced.ship !== ship || synced.rebuilds !== ship.rebuilds || !sent || sent.length !== ship.hp.length) return 'sync';
    // The shell: one it has, from a gun of a ship it has as the server does
    if (h.gun < 0 || !known(h.proj)) return 'shell';
    const owner = ships.get(h.owner), os = conn.shipSynced.get(h.owner);
    if (!owner || !os || os.ship !== owner || os.rebuilds !== owner.rebuilds) return 'owner';
    // (as near as its damage number would go)
    if (!this.host.net.nearClient(conn, h.sys, Position.x[h.target], Position.y[h.target], h.owner)) return 'far';
    const sh = gunShell(ships.tuning, owner, h.gun);
    if (!sh) return 'gun';
    // What it draws at the shell's end must be what the server told (a dry round, out of ammunition, has no effects)
    const fx = hitEndFx(sh.kind, sh.def, h.gone);
    if (fx ? !h.end || h.end.kind !== fx.kind || h.end.radius !== fx.radius : !!h.end) return 'fx';
    if (h.ignite >= 0 && h.igniteTicks !== sh.def.ignite?.ticks) return 'fire';
    // Its copy of the target: the HP it has, no shield (it doesn't know it)
    const view = Object.create(ship) as ShipState;
    view.hp = sent;
    view.shield = 0;
    const p = passes.get(h.proj) ?? 0;
    const rec: ShellHitRecord = { shell: h.proj, ago: tick - h.tick, target: h.target, part: h.part, gone: h.gone, glancing: h.glancing };
    let ignite: number;
    if (h.soak > 0) {
      // (A shield took some: it leaves the HP to the shipHps after)
      rec.shield = true;
      rec.d10 = Math.round(h.dealt * 10);
      ignite = igniteRule(view, h.part, sh.def);
      this.stats.s++;
    } else {
      const out = deriveShellHit({ ctx: ships, ship: view, struck: h.part, kind: sh.kind, def: sh.def, grade: sh.grade, strength: sh.strength, passes: p });
      if (!(Math.abs(out.dealt - h.dealt) <= 1e-3)) { rec.d10 = Math.round(h.dealt * 10); this.stats.d++; }
      ignite = out.ignite;
    }
    if (ignite !== h.ignite) { rec.ignite = h.ignite; this.stats.i++; }
    // (and the HP diff after the records runs for it)
    synced.hpAt = undefined;
    if (h.gone) { plan.gone.add(h.proj); passes.delete(h.proj); } else passes.set(h.proj, p + 1);
    const key = keyOf(h.target, h.owner, h.glancing);
    plan.recs.push(rec);
    plan.keys.push(key);
    plan.covered.set(key, (plan.covered.get(key) ?? 0) + h.dealt);
    this.stats.records++;
    return null;
  }

  /** Does this client get records this snapshot (it must get the snapshot they count from)? */
  pending(conn: ClientConnection): boolean {
    return !!this.plans.get(conn)?.recs.length;
  }

  /** After its snapshot: its damage (less what the records cover), the records, the hits gone the old way */
  write(conn: ClientConnection): void {
    const plan = this.plans.get(conn);
    if (!plan) return;
    const net = this.host.net;
    let quiet: Set<string> | null = null;
    for (const e of net.heldDamage) {
      if (!net.nearClient(conn, e.sys, Position.x[e.target], Position.y[e.target], e.source)) continue;
      const key = keyOf(e.target, e.source, e.glancing), cov = plan.covered.get(key) ?? 0;
      // (The records say it all: it sums them itself. Something else too, a blast: the sum goes as ever, the records show no number)
      if (cov > 0 && e.amount - cov <= 0.05) continue;
      if (cov > 0) (quiet ??= new Set()).add(key);
      const amount = Math.round(e.amount * 10) / 10;
      if (amount > 0) net.send(conn.ws, damageMessage(e, amount));
    }
    if (plan.recs.length) {
      if (quiet) for (let i = 0; i < plan.recs.length; i++) if (quiet.has(plan.keys[i])) plan.recs[i].d10 = 0;
      net.send(conn.ws, { type: 'hits', h: packHits(plan.recs) });
    }
    for (const h of plan.legacy) {
      if (net.nearClient(conn, h.sys, h.x, h.y)) net.send(conn.ws, projectileHitMessage(h.proj, h.x, h.y));
      for (const m of h.fx) net.sendAsSystem(conn, h.sys, m);
    }
  }

  /** After its HP diff: one ship it worked out, once a second, checked */
  check(conn: ClientConnection): void {
    const c = this.checks.get(conn), tick = this.host.currentTick;
    if (!c || !c.due.size || tick - c.at < CHECK_TICKS) return;
    const id = c.due.values().next().value!;
    c.due.delete(id);
    const sent = conn.shipHpSent.get(id);
    if (!sent || !conn.shipView.has(id) || conn.debrisHeld.has(id)) return;
    c.at = tick;
    this.stats.checks++;
    this.host.net.send(conn.ws, { type: 'hpCheck', id, sum: hpChecksum(sent) });
  }

  // ---- After the snapshot ----

  /**
   * The shells this client's snapshot removed (its removed list, after its records are planned): their pass counts
   * go, as its client forgets them after the hits message that follows (ConfirmedHits.forget). Only what it's told:
   * a shell it never hears removed keeps its count on both sides alike
   */
  dropShells(conn: ClientConnection, ids: readonly number[]): void {
    const m = this.passes.get(conn);
    if (m?.size) for (const id of ids) m.delete(id);
  }

  /** The snapshot's gone: drop its hits, switch any client's caps, and see whether the next one keeps hits */
  endSnapshot(): void {
    this.hits.length = 0;
    this.byProj.clear();
    this.plans.clear();
    this.last = null;
    let on = false;
    for (const c of this.host.clients.values()) {
      if (c.capsNext !== undefined && c.capsNext !== c.caps) {
        c.caps = c.capsNext;
        if (!(c.caps & CAPS.HITS)) { this.passes.delete(c); this.checks.delete(c); }
      }
      if ((c.caps ?? 0) & CAPS.HITS) on = true;
    }
    this.on = on;
  }

  /** A client's copy of these ships' HP is off (hpResync): every part goes with the next snapshot */
  resync(conn: ClientConnection, ids: readonly unknown[]): void {
    for (const id of ids.slice(0, 32)) {
      if (typeof id !== 'number') continue;
      conn.shipHpSent.get(id)?.fill(NaN);
      const s = conn.shipSynced.get(id);
      if (s) s.hpAt = undefined;
    }
  }
}
