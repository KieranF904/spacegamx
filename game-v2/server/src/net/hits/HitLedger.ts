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
 * Switching a client's caps takes effect at a snapshot's end (endSnapshot), so a hit is never told both ways; the
 * client is told (netCaps).
 *
 * Client-detected hits (part D, CAPS.SELF_HITS on top of HITS): such a client finds most of its hits itself. `plan`
 * splits its hits into those it can find (the shell's line and the ship's pose are exact on its tick-faithful layer:
 * findable) and those it can't (told), works them all out on its HP copy as before (the findable ones first, in tick
 * then shell order, as the client applies them), and sends records only for the told ones and for findable ones it
 * would get wrong (an extra). Every hit goes into its journal (SelfHitJournal); its reports (on its inputs) are judged
 * there, and a disagreement that lasts is put right with a hitFix and its ships' HP in full.
 *
 * Adaptive validation (part E, CAPS.ROUGH on top): how closely that client is judged follows its record
 * (ConfirmLevel: ROUGH while it keeps agreeing, STRICT after a correction, every hit told), told to it in netCaps.lvl.
 */
import { hasComponent, entityExists, defineQuery, type IWorld } from 'bitecs';
import {
  CAPS, Position, Projectile, InSystem, Player, Radius, Dead, packHits, hpChecksum, gunShell, deriveShellHit, igniteRule, hitEndFx,
  firesStraight, unwrapTick14, CONFIRM, confirmRules,
  type ClientSocket, type ServerMessage, type ShellHitRecord, type ShipState, type HitReport,
} from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import type { ShipBridge } from '../../ships/ShipBridge.js';
import { damageMessage, projectileHitMessage, type Outbox } from '../snapshot/Outbox.js';
import { COALESCE_TICKS } from '../snapshot/constants.js';
import { SelfHitJournal, type JournalHit } from './SelfHitJournal.js';
import { ConfirmLevel } from './ConfirmLevel.js';
import { ownSimFor } from '../snapshot/ownShots.js';

/** What the ledger needs of the server (GameServer itself) */
export interface HitLedgerHost {
  readonly world: IWorld;
  readonly clients: ReadonlyMap<ClientSocket, ClientConnection>;
  readonly currentTick: number;
  readonly net: Outbox;
  getShips(): ShipBridge;
  /** Bosses flown by their bodies on a client's tick layer (CAPS.BODIES, net/decisions/BodyNet.ts) */
  readonly bodies?: { toldHits(conn: object, eid: number): boolean };
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
  /** Client-detected hits: each record the client finds itself (not sent), and each record's hit */
  own: boolean[];
  hits: Hit[];
}

/** Every shell (a client switched to finding its hits: those already flying are told, endSnapshot) */
const shellQuery = defineQuery([Projectile]);

const keyOf = (target: number, source: number, glancing: boolean) => `${target},${source},${glancing ? 1 : 0}`;

/** One ship a second it worked out gets an hpCheck */
const CHECK_TICKS = 60;
/** Ticks a client's hit report may take beyond its round trip: the input ticks it may wait (client SelfHits REPORT_WAIT), and a margin */
const REPORT_SLACK = 12;
/** The input ticks a NORMAL level's report may wait (part D's; another level adds what it waits beyond: part E) */
const NORMAL_REPORT_EVERY = confirmRules(CONFIRM.NORMAL).reportEvery;

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
  /** Per client finding its own hits: its journal (SelfHitJournal) */
  private journals = new WeakMap<ClientConnection, SelfHitJournal>();
  /** ...and its confirmation level (part E: ConfirmLevel; NORMAL for good without CAPS.ROUGH) */
  private levels = new WeakMap<ClientConnection, ConfirmLevel>();
  /**
   * ...and shells with a hit told it the old way: it doesn't know what they passed through, so it drops them (their
   * projectileHit: ConfirmedHits.oldWay, SelfHits.drop) and their hits, that window's and later, are told
   */
  private oldWayShells = new WeakMap<ClientConnection, Set<number>>();
  /** The view's own say on the last hit derive worked out (glancing, spent), for a client finding it itself */
  private viewSaid = { glancing: false, gone: false };
  /** Counters (the netcode probe, the admin's `hits` command); `own`: records the client found itself, `fixes`: corrections */
  readonly stats = {
    hits: 0, records: 0, legacy: 0, d: 0, s: 0, i: 0, checks: 0, why: {} as Record<string, number>,
    own: 0, told: 0, reports: 0, fixes: 0, fixHits: 0, toldWhy: {} as Record<string, number>,
    /** Confirmation level changes, by the level changed to (part E) */
    levels: [0, 0, 0],
  };

  constructor(private host: HitLedgerHost) {}

  /** Does this snapshot keep hits (some client takes records)? */
  get active(): boolean {
    return this.on;
  }

  /** Is this client taking records this snapshot? */
  wants(conn: ClientConnection): boolean {
    return this.on && !!((conn.caps ?? 0) & CAPS.HITS);
  }

  /** Is this client finding its hits itself this snapshot (part D)? */
  finds(conn: ClientConnection): boolean {
    return this.wants(conn) && !!((conn.caps ?? 0) & CAPS.SELF_HITS);
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
  plan(conn: ClientConnection, known: (id: number) => boolean, keyframed?: ReadonlySet<number>): ReadonlySet<number> | null {
    if (!this.wants(conn)) return null;
    const plan: Plan = { recs: [], keys: [], legacy: [], gone: new Set(), covered: new Map(), own: [], hits: [] };
    this.plans.set(conn, plan);
    if (!this.hits.length) return plan.gone;
    let passes = this.passes.get(conn);
    if (!passes) this.passes.set(conn, (passes = new Map()));
    let check = this.checks.get(conn);
    if (!check) this.checks.set(conn, (check = { due: new Set(), at: -Infinity }));
    const ships = this.host.getShips(), tick = this.host.currentTick, sys = InSystem.systemId[conn.playerId];
    // Finding its own: the hits it can find first, in tick then shell order (as it works them out), then the rest
    const finds = this.finds(conn);
    let order: Hit[] = this.hits, findable = 0;
    if (finds) {
      const mine: Hit[] = [], rest: Hit[] = [];
      for (const h of this.hits) if (h.sys === sys) (this.findable(conn, h, ships, keyframed) ? mine : rest).push(h);
      mine.sort((a, b) => a.tick - b.tick || a.proj - b.proj);
      findable = mine.length;
      order = mine.concat(rest);
    }
    for (let i = 0; i < order.length; i++) {
      const h = order[i];
      // (another system's: nothing of it goes to this client either way)
      if (h.sys !== sys) continue;
      const why = this.derive(conn, h, ships, known, passes, plan, tick);
      if (why) {
        if (finds) this.oldWayOf(conn).add(h.proj);
        plan.legacy.push(h);
        this.stats.legacy++;
        this.stats.why[why] = (this.stats.why[why] ?? 0) + 1;
        continue;
      }
      check.due.add(h.target);
      if (!finds) continue;
      // (Found by the client itself, unless the record would carry something it can't know)
      const r = plan.recs[plan.recs.length - 1];
      plan.hits.push(h);
      plan.own.push(i < findable && r.d10 === undefined && !r.shield && r.ignite === undefined && this.viewSaid.glancing === r.glancing && this.viewSaid.gone === r.gone);
    }
    if (finds) this.close(conn, plan, tick);
    return plan.gone;
  }

  /**
   * Can a client finding its own hits find this one exactly (part D)? Not on its own ship (unless it steps it itself, CAPS.OWN_SIM), debris, or a ship synced to
   * it this snapshot (a rebuild changed its shape mid-window) or keyframed (its path changed: where it was before the
   * keyframe's tick is the client's guess); not by a shell the snapshot will remove (its end tick
   * isn't known), a great orb, one that doesn't fly straight or arms late; not between two pilots
   */
  private findable(conn: ClientConnection, h: Hit, ships: ShipBridge, keyframed?: ReadonlySet<number>): boolean {
    const why = keyframed?.has(h.target) ? 'keyframed' : this.unfindable(conn, h, ships);
    if (why) this.stats.toldWhy[why] = (this.stats.toldWhy[why] ?? 0) + 1;
    return !why;
  }

  private unfindable(conn: ClientConnection, h: Hit, ships: ShipBridge): string | null {
    const world = this.host.world;
    // (STRICT: a client that needed correcting is told every hit for a while: part E)
    if (this.levels.get(conn)?.rules.strict) return 'strict';
    // (Its own ship: exact on its tick layer only when it steps it itself, CAPS.OWN_SIM; client SelfHits.ownExact)
    if (h.target === conn.playerId && !ownSimFor(conn.caps)) return 'self';
    // (A boss its body flies here: how much of a hit it takes (braced, laid open, between stages) is still its brain's,
    // until its body has its hit rules too: decision inputs build stage 4)
    if (this.host.bodies?.toldHits(conn, h.target)) return 'body';
    if (this.oldWayShells.get(conn)?.has(h.proj)) return 'oldWay';
    const target = ships.get(h.target);
    if (!target || target.kind === 'debris') return 'debris';
    // (synced since its last snapshot: a sync can go in a frame with no snapshot, and the client holds it till the next)
    const at = conn.shipSynced.get(h.target)?.at;
    if (at !== undefined && at > conn.lastSnapshotSentTick) return 'synced';
    if (this.removing(h.proj)) return 'removed';
    if (Radius.value[h.proj] >= 19.95) return 'orb';
    const owner = ships.get(h.owner), sh = owner ? gunShell(ships.tuning, owner, h.gun) : null;
    if (!sh || !firesStraight(sh.def) || sh.def.lob || sh.def.arm) return 'curve';
    if (hasComponent(world, Player, h.owner) && hasComponent(world, Player, h.target)) return 'pvp';
    return null;
  }

  /** Will this snapshot remove the shell (dead, and not spent by a ship hit)? */
  private removing(proj: number): boolean {
    const world = this.host.world;
    return (!entityExists(world, proj) || hasComponent(world, Dead, proj)) && !this.byProj.get(proj)?.gone;
  }

  /**
   * A window closes for a client finding its own hits: a findable hit whose shell the snapshot removes after all (its
   * last hit went the old way) is told; then every hit it should have goes into its journal
   */
  private close(conn: ClientConnection, plan: Plan, tick: number): void {
    const world = this.host.world, jh: JournalHit[] = [];
    for (let i = 0; i < plan.recs.length; i++) {
      const h = plan.hits[i], r = plan.recs[i];
      if (plan.own[i] && (!entityExists(world, h.proj) || hasComponent(world, Dead, h.proj)) && !plan.gone.has(h.proj)) {
        plan.own[i] = false;
        this.stats.toldWhy.removed = (this.stats.toldWhy.removed ?? 0) + 1;
      }
      // (a shell with a hit gone the old way this window: the client drops all its hits found here)
      if (plan.own[i] && this.oldWayShells.get(conn)?.has(h.proj)) {
        plan.own[i] = false;
        this.stats.toldWhy.oldWay = (this.stats.toldWhy.oldWay ?? 0) + 1;
      }
      jh.push({ rec: r, tick: h.tick, dealt: h.dealt });
    }
    this.journalOf(conn).close(tick, jh);
  }

  private oldWayOf(conn: ClientConnection): Set<number> {
    let s = this.oldWayShells.get(conn);
    if (!s) this.oldWayShells.set(conn, (s = new Set()));
    return s;
  }

  private journalOf(conn: ClientConnection): SelfHitJournal {
    let j = this.journals.get(conn);
    if (!j) this.journals.set(conn, (j = new SelfHitJournal(this.host.currentTick)));
    return j;
  }

  /** A finding client's confirmation level (part E), made with its journal */
  levelOf(conn: ClientConnection): ConfirmLevel {
    let l = this.levels.get(conn);
    if (!l) this.levels.set(conn, (l = new ConfirmLevel(this.host.currentTick, !!((conn.caps ?? 0) & CAPS.ROUGH))));
    return l;
  }

  /**
   * A shell sent to this client as a projectile row (not a fire event): its row is rounded, so a client finding its own
   * hits doesn't put it on its tick-aligned layer (SelfHits.row), and its hits are told, as a shell told the old way
   */
  rowShell(conn: ClientConnection, id: number): void {
    if (this.finds(conn)) this.oldWayOf(conn).add(id);
  }

  /** A client's hit report (on its input): judged in its journal */
  report(conn: ClientConnection, rep: HitReport): void {
    if (!this.finds(conn) || typeof rep?.tick !== 'number' || typeof rep.hash !== 'number' || typeof rep.epoch !== 'number') return;
    this.stats.reports++;
    this.journalOf(conn).report(unwrapTick14(rep.tick & 0x3fff, this.host.currentTick), rep.hash & 0xff, rep.epoch & 3);
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
      this.viewSaid.glancing = out.glancing;
      this.viewSaid.gone = out.gone;
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
      // (A record whose number shows in a sum sent anyway says so: sent even to a client that found it)
      if (quiet) for (let i = 0; i < plan.recs.length; i++) if (quiet.has(plan.keys[i])) { plan.recs[i].d10 = 0; if (plan.own.length) plan.own[i] = false; }
      let recs = plan.recs;
      if (plan.own.length) {
        recs = [];
        for (let i = 0; i < plan.recs.length; i++) { if (plan.own[i]) this.stats.own++; else { this.stats.told++; recs.push(plan.recs[i]); } }
      }
      if (recs.length) net.send(conn.ws, { type: 'hits', h: packHits(recs) });
    }
    for (const h of plan.legacy) {
      if (net.nearClient(conn, h.sys, h.x, h.y)) net.send(conn.ws, projectileHitMessage(h.proj, h.x, h.y));
      for (const m of h.fx) net.sendAsSystem(conn, h.sys, m);
    }
    // (A told shell spent by its record never comes in a removed list: it goes from the told set here, so a reused id is new)
    const old = this.oldWayShells.get(conn);
    if (old?.size) for (const id of plan.gone) old.delete(id);
    if (this.finds(conn)) this.judge(conn);
  }

  /** A client finding its own hits: what it must have answered for by now, judged; a lasting disagreement put right */
  private judge(conn: ClientConnection): void {
    const now = this.host.currentTick;
    // (A client whose frames are coalesced may hear a window COALESCE_TICKS later: net/snapshot/PackedLink.ts)
    const held = ((conn.caps ?? 0) & (CAPS.PACKED | CAPS.COALESCE)) === (CAPS.PACKED | CAPS.COALESCE) ? COALESCE_TICKS : 0;
    // (Its level's report spacing beyond part D's, and STRICT's later frames: part E)
    const level = this.levelOf(conn), rules = level.rules, journal = this.journalOf(conn);
    const slack = Math.max(0, rules.reportEvery - NORMAL_REPORT_EVERY) + rules.delayTicks;
    const bad = journal.stats.disagreed;
    const fix = journal.judge(now, Math.ceil((conn.ping || 0) / (1000 / 60)) + REPORT_SLACK + held + slack);
    if (journal.stats.disagreed > bad) level.disagreed(now);
    if (!fix) { level.step(now); return; }
    level.corrected(now);
    this.stats.fixes++;
    this.stats.fixHits += fix.hits.length;
    // Every hit since the last agreement, each with its number: the client works out those it missed and takes back those
    // it had wrongly; its copy of the HP is already the one it should come to, so the ships are checked soon (hpCheck)
    const recs = fix.hits.map((x) => ({ ...x.rec, ago: Math.min(7, fix.t - x.tick), d10: Math.round(x.dealt * 10) }));
    this.host.net.send(conn.ws, { type: 'hitFix', s: fix.s, t: fix.t, c: fix.c, e: fix.e, h: packHits(recs) });
    const check = this.checks.get(conn);
    if (check) for (const x of fix.hits) check.due.add(x.rec.target);
  }

  /** The journals' counters summed (the probe, tests) */
  journalStats(conns: Iterable<ClientConnection>): SelfHitJournal['stats'] {
    const t = { hits: 0, reports: 0, stale: 0, agreed: 0, disagreed: 0, fixes: 0, fixHits: 0 };
    for (const c of conns) {
      const j = this.journals.get(c);
      if (j) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += j.stats[k];
    }
    return t;
  }

  /** After its HP diff: one ship it worked out, once a second (a finding client: as often as its level says), checked */
  check(conn: ClientConnection): void {
    const c = this.checks.get(conn), tick = this.host.currentTick;
    const every = this.finds(conn) ? this.levelOf(conn).rules.checkTicks : CHECK_TICKS;
    if (!c || !c.due.size || tick - c.at < every) return;
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
    const o = this.oldWayShells.get(conn);
    if (o?.size) for (const id of ids) o.delete(id);
  }

  /** The snapshot's gone: drop its hits, switch any client's caps, and see whether the next one keeps hits */
  endSnapshot(skip?: { has(system: number): boolean; readonly size: number } | null): void {
    // (A round for some systems only, crowd fallbacks: the others' hits wait for theirs)
    if (skip?.size) {
      this.hits = this.hits.filter((h) => skip.has(h.sys));
      this.byProj.clear();
      for (const h of this.hits) this.byProj.set(h.proj, h);
    } else {
      this.hits.length = 0;
      this.byProj.clear();
    }
    this.plans.clear();
    this.last = null;
    let on = false;
    for (const c of this.host.clients.values()) {
      if (skip?.size && skip.has(InSystem.systemId[c.playerId])) { if ((c.caps ?? 0) & CAPS.HITS) on = true; continue; }
      if (c.capsNext !== undefined && c.capsNext !== c.caps) {
        const was = c.caps ?? 0;
        c.caps = c.capsNext;
        if (!(c.caps & CAPS.HITS)) { this.passes.delete(c); this.checks.delete(c); }
        // (Finding its own hits starts afresh from this snapshot on both sides; the client is told from when. Shells
        // already flying are told on both sides: what they hit before isn't on its layer, SelfHits.setOn)
        this.journals.delete(c);
        this.levels.delete(c);
        this.oldWayShells.delete(c);
        const both = CAPS.HITS | CAPS.SELF_HITS;
        if ((c.caps & both) === both && (was & both) !== both) {
          const told = new Set<number>(), sys = InSystem.systemId[c.playerId];
          for (const id of shellQuery(this.host.world)) if (InSystem.systemId[id] === sys) told.add(id);
          this.oldWayShells.set(c, told);
        }
        if (was !== c.caps) this.host.net.send(c.ws, { type: 'netCaps', caps: c.caps, ...(c.caps & CAPS.COALESCE ? { hold: COALESCE_TICKS } : {}) });
      } else if ((c.caps ?? 0) & CAPS.ROUGH && this.finds(c) && this.levelOf(c).apply(this.host.currentTick)) {
        // (Its confirmation level changes from the next snapshot, on both sides at once: part E)
        this.stats.levels[this.levelOf(c).level]++;
        this.host.net.send(c.ws, { type: 'netCaps', caps: c.caps!, ...(c.caps! & CAPS.COALESCE ? { hold: COALESCE_TICKS } : {}), lvl: this.levelOf(c).level });
      }
      if ((c.caps ?? 0) & CAPS.HITS) on = true;
    }
    this.on = on;
  }

  /**
   * Its client's ticks changed under it (it went to a system on another clock: crowd dilation): its journal and level
   * start afresh, and every shell flying there is told, as when it switches to finding its own hits
   */
  restart(c: ClientConnection): void {
    if (!this.journals.has(c) && !this.levels.has(c)) return;
    this.journals.delete(c);
    this.levels.delete(c);
    this.oldWayShells.delete(c);
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
