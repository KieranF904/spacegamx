/**
 * Confirmed hits, the client's side (docs/design/confirmed-hits.md part C). The server tells a client that announced
 * CAPS.HITS only "shell s hit part p of ship t" (common network/hits.ts); this works out the rest with the shared
 * rules (common ships/hitRules.ts), on the same copy of the ships the server worked it out on for this client:
 *
 *   the hit point   the shell's line at the hit's tick, cast against the part it struck where the ship was then
 *   the damage      deriveShellHit (or the record's D), summed per target, source and glancing as the server sums it
 *   the part's HP   straight into the ship store (not when a shield took some: the shipHps after the records has it)
 *   the fire        igniteRule (or the record's I)
 *   the end         hitEndFx; the shell removed when the record says it's spent
 *
 * Each record becomes the messages the server would have sent (projectileHit, ignite, detonation, damage), which go
 * through the usual handlers, so a hit looks just as it does without confirmed hits. What it can't work out (a shell
 * or ship it doesn't have) it asks the server to put right (hpResync), as it does when an hpCheck disagrees.
 *
 * Client-detected hits (part D, CAPS.SELF_HITS: SelfHits.ts finds them) go through the same rules, but in three steps
 * over one frame: `own` (the hits it found, as the snapshot arrives: their HP at once, so the shipHps and hpCheck
 * later in the frame meet the HP the server expects), `told` (the server's records for what it couldn't find or would
 * get wrong: a record for a hit it found too puts that one right), `oldWay` (a shell the server told the old way: its
 * own hit is dropped), then `flush` at the frame's end hands out the messages.
 */
import {
  unpackHits, gunShell, deriveShellHit, igniteRule, hitEndFx, hpChecksum, castParts, worldToLocalDir, shipPointToWorld,
  type ClientMessage, type ServerMessage, type ServerHitsMessage, type ServerHpCheckMessage, type ShipState, type HitCtx, type PlacedGeom,
  hpWire, type ShellHitRecord, type HitEndFx,
} from '@space-game/common';

/** A line that misses the struck part is cast again this thick (world units) before falling back to its middle */
const GRAZE = 2;

/** A shell as the client has it: who fired it, from which gun (a fire event's packing), and its straight line */
export interface HitShell { owner: number; gun: number; spawnTick: number; x: number; y: number; vx: number; vy: number }

export interface ConfirmedHitsHost {
  /** The ships (ShipStore): the rules read their blueprints and geometry, and the hits change their HP */
  readonly store: HitCtx & { get(id: number): ShipState | undefined };
  /** A shell it has (a projectile row, or a fire event's), null if none or not from a gun */
  shell(id: number): HitShell | null;
  /**
   * Where a ship was at the end of a tick, null if unknown: its replica's state, the local ship's predicted pose
   * (GameState.selfPoseAt), else where it is
   */
  pose(id: number, tick: number): { x: number; y: number; angle: number } | null;
  /** Is it flown by a pilot (the local ship too)? A pilot moves before the server's collision step, the rest after */
  pilot(id: number): boolean;
  send(msg: ClientMessage): void;
}

/** What a hits message comes to */
export interface HitsOutcome {
  /** The messages the server would have sent, in order */
  msgs: ServerMessage[];
  /** Ships whose HP changed */
  ships: Set<number>;
  /** Shells spent */
  gone: number[];
}

/** A hit this client found itself (SelfHits): the struck part, the tick, where on the line */
export interface OwnHit { shell: number; tick: number; target: number; part: number; x: number; y: number }

/** One hit worked out: what its messages will say, and how to take its HP back */
export interface HitDone {
  shell: number;
  target: number;
  /** The part the line struck (before a boss's cover): what the hit chain counts */
  part: number;
  tick: number;
  owner: number;
  glancing: boolean;
  gone: boolean;
  dealt: number;
  ignite: number;
  igniteTicks: number;
  fx: HitEndFx | null;
  at: [number, number];
  /** It found this one itself (else the server's record) */
  own: boolean;
  /** The HP part it changed, what it was before and after, to take back (a shield's record, or the old way) */
  undo: { part: number; hp: number; after: number } | null;
  /** The shell's pass count before it */
  prev: number;
}

export class ConfirmedHits {
  /** Ships each shell has passed through (records that didn't end it), as the server counts them for this client */
  private passes = new Map<number, number>();
  /**
   * Shells the snapshot just applied removed, kept for the hits message that follows it: a record can name one (a
   * pierce's earlier pass, when its last went the old way or it expired). Their pass counts go once that message is
   * handled, as the server forgets them after it plans the records (HitLedger.dropShells)
   */
  private dropped = new Map<number, HitShell>();
  private dropping: readonly number[] = [];
  /** Ships whose HP it should be sent again (hpResync), gathered while handling a message */
  private resync = new Set<number>();
  /** Client-detected hits: this frame's, waiting for the server's records and the frame's end */
  private pending: HitDone[] = [];
  /** ...and spent shells whose records couldn't be worked out */
  private lostGone: number[] = [];
  /** Shells worked out lately (shellOf) */
  private recent = new Map<number, HitShell>();
  /** Counters (tests, the console) */
  readonly stats = { records: 0, missed: 0, checks: 0, mismatches: 0, resyncs: 0, own: 0, overridden: 0, oldWay: 0 };

  constructor(private host: ConfirmedHitsHost) {}

  /**
   * A shell as the client has it: the game's, one the snapshot just removed, or one worked out lately (a correction
   * can name a shell gone since)
   */
  private shellOf(id: number): HitShell | null {
    const s = this.host.shell(id) ?? this.dropped.get(id) ?? this.recent.get(id) ?? null;
    if (s && !this.recent.has(id)) {
      this.recent.set(id, s);
      if (this.recent.size > 512) this.recent.delete(this.recent.keys().next().value!);
    }
    return s;
  }

  /** A shell's ship passes so far (its pierce count, as the server counts it for this client) */
  passesOf(shell: number): number {
    return this.passes.get(shell) ?? 0;
  }

  /** One hits message, `snapTick` the tick of the snapshot just applied (a record's hit tick counts back from it) */
  expand(msg: ServerHitsMessage, snapTick: number): HitsOutcome {
    const done: HitDone[] = [], lost: number[] = [];
    for (const r of unpackHits(msg.h)) {
      const d = this.record(r, snapTick - r.ago, true);
      if (d) done.push(d); else if (r.gone) lost.push(r.shell);
    }
    const out = this.messages(done);
    // (a spent shell goes even if its hit couldn't be worked out)
    out.gone.push(...lost);
    this.settle();
    this.flush();
    return out;
  }

  // ---- Client-detected hits (part D): own, told, oldWay, then flushPending at the frame's end ----

  /** The hits this client found in the snapshot just applied (in tick, then shell order): worked out, HP at once */
  own(hits: readonly OwnHit[]): void {
    const { store } = this.host;
    for (const o of hits) {
      const s = this.shellOf(o.shell), ship = store.get(o.target), owner = s ? store.get(s.owner) : undefined;
      const sh = s && owner ? gunShell(store.tuning, owner, s.gun) : null;
      if (!s || !ship || !sh) continue;
      const passes = this.passes.get(o.shell) ?? 0;
      const before = ship.hp.slice();
      const d = deriveShellHit({ ctx: store, ship, struck: o.part, kind: sh.kind, def: sh.def, grade: sh.grade, strength: sh.strength, passes });
      if (d.gone) this.passes.delete(o.shell); else this.passes.set(o.shell, passes + 1);
      this.stats.own++;
      this.pending.push({
        shell: o.shell, target: o.target, part: o.part, tick: o.tick, owner: s.owner, glancing: d.glancing, gone: d.gone, dealt: d.dealt,
        ignite: d.ignite, igniteTicks: sh.def.ignite?.ticks ?? 0, fx: d.fx, at: [Math.round(o.x * 10) / 10, Math.round(o.y * 10) / 10], own: true,
        undo: d.part >= 0 ? { part: d.part, hp: before[d.part], after: ship.hp[d.part] } : null, prev: passes,
      });
    }
  }

  /**
   * The server's records this frame (part D: what this client couldn't find, or would get wrong). One for a hit it
   * found too puts that one right (the number, a shield's share, the fire, the end); the rest are worked out as ever.
   */
  told(msg: ServerHitsMessage, snapTick: number): void {
    for (const r of unpackHits(msg.h)) {
      const mine = this.pending.find((d) => d.own && d.shell === r.shell && d.target === r.target);
      if (!mine) {
        const d = this.record(r, snapTick - r.ago, true);
        if (d) this.pending.push(d);
        else if (r.gone) this.lostGone.push(r.shell);
        continue;
      }
      this.stats.overridden++;
      mine.own = false;
      // (Its pass count, as the record has it: spent, or one more than before)
      if (r.gone !== mine.gone) { if (r.gone) this.passes.delete(r.shell); else this.passes.set(r.shell, mine.prev + 1); }
      mine.gone = r.gone;
      mine.glancing = r.glancing;
      if (r.shield && mine.undo) {
        // (a shield took some: its HP comes in the shipHps after, from what it was before)
        this.takeBack(r.target, mine.undo);
        mine.undo = null;
      }
      if (r.d10 !== undefined) mine.dealt = r.d10 / 10;
      if (r.ignite !== undefined) mine.ignite = r.ignite;
      const s = this.host.shell(r.shell) ?? this.dropped.get(r.shell);
      const owner = s ? this.host.store.get(s.owner) : undefined, sh = s && owner ? gunShell(this.host.store.tuning, owner, s.gun) : null;
      if (sh) mine.fx = hitEndFx(sh.kind, sh.def, r.gone);
    }
    this.settle();
  }

  /** A shell the server told the old way this frame (a projectileHit): a hit it found for it isn't one; its HP goes back */
  oldWay(shell: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const d = this.pending[i];
      if (!d.own || d.shell !== shell) continue;
      if (d.undo) this.takeBack(d.target, d.undo);
      // (its pass count back too)
      if (d.prev) this.passes.set(shell, d.prev); else this.passes.delete(shell);
      this.pending.splice(i, 1);
      this.stats.oldWay++;
    }
  }

  /**
   * Hits waiting for the frame's end (finding hits may have been switched off in this frame: netCaps comes after the
   * snapshot's records, so they're still handed out)
   */
  get hasPending(): boolean {
    return this.pending.length > 0 || this.lostGone.length > 0;
  }

  /** The frame's end: this frame's hits (found and told) as their messages, and the hits themselves (for the chain) */
  flushPending(): { out: HitsOutcome; done: HitDone[] } {
    const done = this.pending;
    this.pending = [];
    const out = this.messages(done);
    out.gone.push(...this.lostGone.splice(0));
    this.flush();
    return { out, done };
  }

  /**
   * A correction (hitFix): the hits this client missed worked out now as records (the number is the record's; one it
   * can't work out asks for its ship's HP), and the hits it had that the server didn't taken back. The server checks
   * the ships' HP soon after (hpCheck)
   */
  corrected(missed: readonly ShellHitRecord[], tick: number, wrong: readonly { target: number; undo: HitDone['undo'] }[]): HitsOutcome {
    const done: HitDone[] = [], lost: number[] = [];
    for (const r of missed) {
      const d = this.record(r, tick - r.ago, true);
      if (d) done.push(d); else if (r.gone) lost.push(r.shell);
    }
    const out = this.messages(done);
    out.gone.push(...lost);
    for (const w of wrong) {
      if (w.undo) { this.takeBack(w.target, w.undo); out.ships.add(w.target); }
    }
    this.flush();
    return out;
  }

  /** The server's checksum of a ship's HP as this client should have it: a mismatch asks for all of it again */
  check(msg: ServerHpCheckMessage): void {
    const ship = this.host.store.get(msg.id);
    if (!ship) return;
    this.stats.checks++;
    if (hpChecksum(ship.hp) !== msg.sum) { this.stats.mismatches++; this.resync.add(msg.id); }
    this.flush();
  }

  /**
   * A snapshot's removed list, before the shells go from the game state: kept for the hits message after it (records
   * can still name them), then their pass counts go (settle)
   */
  forget(ids: readonly number[]): void {
    this.settle();
    if (!ids.length) return;
    this.dropping = ids;
    for (const id of ids) {
      const s = this.host.shell(id);
      if (s) this.dropped.set(id, s);
    }
  }

  /** A new connection (a join): the server's count of each shell's passes starts afresh, so this one does too */
  reset(): void {
    this.passes.clear();
    this.dropped.clear();
    this.dropping = [];
    this.resync.clear();
    this.pending = [];
    this.lostGone = [];
    this.recent.clear();
  }

  /**
   * One record worked out (`hp`: into the ship store, as a record does; false: a correction's, messages only). Null:
   * it can't be (a shell or ship it doesn't have): their HP is asked for
   */
  private record(r: ShellHitRecord, tick: number, hp: boolean): HitDone | null {
    const { store } = this.host;
    this.stats.records++;
    const passes = this.passes.get(r.shell) ?? 0;
    if (r.gone) this.passes.delete(r.shell); else this.passes.set(r.shell, passes + 1);
    const s = this.shellOf(r.shell), ship = store.get(r.target), owner = s ? store.get(s.owner) : undefined;
    const sh = s && owner ? gunShell(store.tuning, owner, s.gun) : null;
    if (!s || !ship || !sh) { this.stats.missed++; if (hp) this.resync.add(r.target); return null; }
    const at = this.hitPoint(s, ship, r.target, r.part, tick);
    let dealt = 0, ignite: number, undo: HitDone['undo'] = null;
    if (r.shield || !hp) {
      // (a shield took some, or a correction: the HP comes after, in the shipHps)
      ignite = igniteRule(ship, r.part, sh.def);
    } else {
      const before = ship.hp.slice();
      const d = deriveShellHit({ ctx: store, ship, struck: r.part, kind: sh.kind, def: sh.def, grade: sh.grade, strength: sh.strength, passes });
      dealt = d.dealt;
      ignite = d.ignite;
      if (d.part >= 0) undo = { part: d.part, hp: before[d.part], after: ship.hp[d.part] };
    }
    if (r.d10 !== undefined) dealt = r.d10 / 10;
    if (r.ignite !== undefined) ignite = r.ignite;
    return {
      shell: r.shell, target: r.target, part: r.part, tick, owner: s.owner, glancing: r.glancing, gone: r.gone, dealt, ignite,
      igniteTicks: sh.def.ignite?.ticks ?? 0, fx: hitEndFx(sh.kind, sh.def, r.gone), at, own: false, undo, prev: passes,
    };
  }

  /** Hits as the messages the server would have sent: each one's impact, fire and end, then the damage summed */
  private messages(done: readonly HitDone[]): HitsOutcome {
    const out: HitsOutcome = { msgs: [], ships: new Set(), gone: [] };
    const sums = new Map<string, { target: number; source: number; glancing: boolean; amount: number }>();
    for (const d of done) {
      if (d.gone) out.gone.push(d.shell);
      if (d.undo) out.ships.add(d.target);
      out.msgs.push({ type: 'projectileHit', id: d.shell, x: d.at[0], y: d.at[1] });
      if (d.ignite >= 0 && d.igniteTicks) out.msgs.push({ type: 'ignite', bodyId: d.target, part: d.ignite, ticks: d.igniteTicks });
      if (d.fx) out.msgs.push({ type: 'detonation', kind: d.fx.kind, x: Math.round(d.at[0]), y: Math.round(d.at[1]), radius: d.fx.radius });
      const key = `${d.target},${d.owner},${d.glancing ? 1 : 0}`;
      const e = sums.get(key);
      if (e) e.amount += d.dealt; else sums.set(key, { target: d.target, source: d.owner, glancing: d.glancing, amount: d.dealt });
    }
    // The damage, summed and rounded as the server's flushDamage does
    for (const e of sums.values()) {
      const amount = Math.round(e.amount * 10) / 10;
      if (amount > 0) out.msgs.push({ type: 'damage', targetId: e.target, amount, sourceId: e.source, ...(e.glancing ? { glancing: true } : {}) });
    }
    return out;
  }

  /** A hit's HP taken back: what it took, given back (other hits on the part since keep theirs) */
  private takeBack(target: number, u: { part: number; hp: number; after: number }): void {
    const ship = this.host.store.get(target);
    if (ship) ship.hp[u.part] = hpWire(ship.hp[u.part] + (u.hp - u.after));
  }

  private settle(): void {
    for (const id of this.dropping) this.passes.delete(id);
    this.dropping = [];
    this.dropped.clear();
  }

  private flush(): void {
    if (!this.resync.size) return;
    this.stats.resyncs++;
    this.host.send({ type: 'hpResync', ids: [...this.resync] });
    this.resync.clear();
  }

  /**
   * Where the shell struck: its line on the hit's tick, as the server's collision step tests it (from where the shell
   * is at the end of that tick, moved as the server moves it, to one step on: SelfHits does the same), cast against
   * the struck part where the ship was when that step ran (a pilot's pose after its move that tick, anyone else's
   * from the tick before: they move after the collision step); if the line misses it (the pose is a little off: a
   * keyframed ship's path before the keyframe was a guess), the point of the line nearest the part's middle. To a
   * tenth, as the server's projectileHit.
   */
  private hitPoint(s: HitShell, ship: ShipState, id: number, part: number, tick: number): [number, number] {
    let ax = s.x, ay = s.y;
    const vx = s.vx, vy = s.vy;
    for (let k = s.spawnTick; k < tick && k < s.spawnTick + 1200; k++) { ax += vx; ay += vy; }
    const bx = ax + vx, by = ay + vy;
    const pose = this.host.pose(id, this.host.pilot(id) ? tick : tick - 1);
    let x = ax, y = ay;
    const geoms = this.host.store.geometry(ship);
    if (pose && geoms[part]) {
      const cs = this.host.store.tuning.cellSize, com = ship.derived.com;
      const px = pose.x, py = pose.y, pa = pose.angle;
      const [la, lb] = worldToLocalDir([ax - px, ay - py], pa), [lc, ld] = worldToLocalDir([bx - px, by - py], pa);
      const ok = (j: number) => j === part;
      // (a grazing hit from a line a hair off, an own shell's row rounded: the same cast a little thick)
      const h = castParts(geoms as PlacedGeom[], ok, la / cs + com[0], lb / cs + com[1], lc / cs + com[0], ld / cs + com[1])
        ?? castParts(geoms as PlacedGeom[], ok, la / cs + com[0], lb / cs + com[1], lc / cs + com[0], ld / cs + com[1], GRAZE / cs);
      if (h) { x = ax + (bx - ax) * h.t; y = ay + (by - ay) * h.t; }
      else {
        const [cx, cy] = shipPointToWorld(ship, { x: px, y: py, angle: pa }, geoms[part].centroid, cs);
        const dx = bx - ax, dy = by - ay, u = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy || 1)));
        x = ax + dx * u; y = ay + dy * u;
      }
    }
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }
}
