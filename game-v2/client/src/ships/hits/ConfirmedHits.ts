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
 */
import {
  CAPS, unpackHits, gunShell, deriveShellHit, igniteRule, hitEndFx, hpChecksum, castParts, worldToLocalDir, shipPointToWorld,
  type ClientMessage, type ServerMessage, type ServerHitsMessage, type ServerHpCheckMessage, type ShipState, type HitCtx, type PlacedGeom,
} from '@space-game/common';

/** A shell as the client has it: who fired it, from which gun (a fire event's packing), and its straight line */
export interface HitShell { owner: number; gun: number; spawnTick: number; x: number; y: number; vx: number; vy: number }

export interface ConfirmedHitsHost {
  /** The ships (ShipStore): the rules read their blueprints and geometry, and the hits change their HP */
  readonly store: HitCtx & { get(id: number): ShipState | undefined };
  /** A shell it has (a projectile row, or a fire event's), null if none or not from a gun */
  shell(id: number): HitShell | null;
  /** Where a ship was at a tick (its replica, else where it is), null if unknown */
  pose(id: number, tick: number): { x: number; y: number; angle: number } | null;
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

export class ConfirmedHits {
  /** Ships each shell has passed through (records that didn't end it), as the server counts them for this client */
  private passes = new Map<number, number>();
  /** Ships whose HP it should be sent again (hpResync), gathered while handling a message */
  private resync = new Set<number>();
  /** Counters (tests, the console) */
  readonly stats = { records: 0, missed: 0, checks: 0, mismatches: 0, resyncs: 0 };

  constructor(private host: ConfirmedHitsHost) {}

  /** One hits message, `snapTick` the tick of the snapshot just applied (a record's hit tick counts back from it) */
  expand(msg: ServerHitsMessage, snapTick: number): HitsOutcome {
    const { store } = this.host;
    const out: HitsOutcome = { msgs: [], ships: new Set(), gone: [] };
    const sums = new Map<string, { target: number; source: number; glancing: boolean; amount: number }>();
    for (const r of unpackHits(msg.h)) {
      this.stats.records++;
      const passes = this.passes.get(r.shell) ?? 0;
      if (r.gone) { this.passes.delete(r.shell); out.gone.push(r.shell); } else this.passes.set(r.shell, passes + 1);
      const s = this.host.shell(r.shell), ship = store.get(r.target), owner = s ? store.get(s.owner) : undefined;
      const sh = s && owner ? gunShell(store.tuning, owner, s.gun) : null;
      if (!s || !ship || !sh) { this.stats.missed++; this.resync.add(r.target); continue; }
      const tick = snapTick - r.ago;
      const at = this.hitPoint(s, ship, r.target, r.part, tick);
      out.msgs.push({ type: 'projectileHit', id: r.shell, x: at[0], y: at[1] });
      let dealt: number, ignite: number;
      if (r.shield) {
        // (a shield took some: the HP comes after, in the shipHps)
        dealt = 0;
        ignite = igniteRule(ship, r.part, sh.def);
      } else {
        const d = deriveShellHit({ ctx: store, ship, struck: r.part, kind: sh.kind, def: sh.def, grade: sh.grade, strength: sh.strength, passes });
        dealt = d.dealt;
        ignite = d.ignite;
        if (d.part >= 0) out.ships.add(r.target);
      }
      if (r.d10 !== undefined) dealt = r.d10 / 10;
      if (r.ignite !== undefined) ignite = r.ignite;
      if (ignite >= 0 && sh.def.ignite) out.msgs.push({ type: 'ignite', bodyId: r.target, part: ignite, ticks: sh.def.ignite.ticks });
      const fx = hitEndFx(sh.kind, sh.def, r.gone);
      if (fx) out.msgs.push({ type: 'detonation', kind: fx.kind, x: Math.round(at[0]), y: Math.round(at[1]), radius: fx.radius });
      const key = `${r.target},${s.owner},${r.glancing ? 1 : 0}`;
      const e = sums.get(key);
      if (e) e.amount += dealt; else sums.set(key, { target: r.target, source: s.owner, glancing: r.glancing, amount: dealt });
    }
    // The damage, summed and rounded as the server's flushDamage does
    for (const e of sums.values()) {
      const amount = Math.round(e.amount * 10) / 10;
      if (amount > 0) out.msgs.push({ type: 'damage', targetId: e.target, amount, sourceId: e.source, ...(e.glancing ? { glancing: true } : {}) });
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

  /** Shells removed (a snapshot's list): their pass counts go */
  forget(ids: readonly number[]): void {
    if (!this.passes.size) return;
    for (const id of ids) this.passes.delete(id);
  }

  private flush(): void {
    if (!this.resync.size) return;
    this.stats.resyncs++;
    this.host.send({ type: 'hpResync', ids: [...this.resync] });
    this.resync.clear();
  }

  /**
   * Where the shell struck: its line from the tick before the hit to the tick after, cast against the struck part
   * where the ship was at the hit's tick; if the line misses it (the pose is a little off), the point of the line
   * nearest the part's middle. To a tenth, as the server's projectileHit.
   */
  private hitPoint(s: HitShell, ship: ShipState, id: number, part: number, tick: number): [number, number] {
    const t0 = tick - 1 - s.spawnTick, t1 = tick + 1 - s.spawnTick;
    const ax = s.x + s.vx * t0, ay = s.y + s.vy * t0, bx = s.x + s.vx * t1, by = s.y + s.vy * t1;
    const pose = this.host.pose(id, tick);
    let x = (ax + bx) / 2, y = (ay + by) / 2;
    const geoms = this.host.store.geometry(ship);
    if (pose && geoms[part]) {
      const cs = this.host.store.tuning.cellSize, com = ship.derived.com;
      const [la, lb] = worldToLocalDir([ax - pose.x, ay - pose.y], pose.angle), [lc, ld] = worldToLocalDir([bx - pose.x, by - pose.y], pose.angle);
      const h = castParts(geoms as PlacedGeom[], (j) => j === part, la / cs + com[0], lb / cs + com[1], lc / cs + com[0], ld / cs + com[1]);
      if (h) { x = ax + (bx - ax) * h.t; y = ay + (by - ay) * h.t; }
      else {
        const [cx, cy] = shipPointToWorld(ship, pose, geoms[part].centroid, cs);
        const dx = bx - ax, dy = by - ay, u = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy || 1)));
        x = ax + dx * u; y = ay + dy * u;
      }
    }
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }
}

/**
 * The caps this client announces in its join: confirmed hits when `?hits=1` (remembered; `?hits=0` turns it off),
 * else what was remembered, else on in a dev build. The server takes them only where it allows (the dev server).
 */
export function clientCaps(): number {
  let on: boolean | null = null;
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('hits');
    if (q === '0' || q === '1') { on = q === '1'; globalThis.localStorage?.setItem('sg.hits', q); }
    else {
      const v = globalThis.localStorage?.getItem('sg.hits');
      if (v === '0' || v === '1') on = v === '1';
    }
  } catch { /* no storage: the default */ }
  if (on === null) on = !!(import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  return on ? CAPS.HITS : 0;
}
