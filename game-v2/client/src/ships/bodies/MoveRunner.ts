/**
 * Bodies' moves worked out on this client's tick-aligned layer (decision-inputs stage 4, CAPS.MOVES; common
 * bodies/moves). For every body it runs (BodyRunner), each snapshot, the ticks of its window once over, after the
 * bodies were stepped again (what they read of other ships is final only then), in the server's order (MoveTrack):
 *
 *   staged bosses  from their MOVE, HARASS (at this client's ship), PERSONAL (at this client's ship), WINDOW, HOLD and
 *                  CAP decisions: their telegraphs, beams, glows, strikes' looks, launch flashes and straight shells
 *   custom enemies from the move their order carries
 *
 * A move under way when it began running the body is sat out (the server sends that one the old way, BodyNet.derives).
 * What it gives: messages (drawn as if the server had sent them: `take`), shells (as projectile rows with ids of this
 * client's own, flown straight, gone at the end of their life or at the rock they meet) and those shells' removals.
 * Their hits are the server's, told the old way (projectileHit, damage): a told hit at a point takes the nearest of
 * these shells there with it (`struck`).
 */
import {
  BODY_KINDS, CUSTOM_DESIGNS, CUSTOM_TRAIL, DECISION, EntityType, MOVES_HOLD, STAGED_MOVES, WANT, WEAPON_KIND_TYPE, AI_ORDER, CO,
  StagedTrack, CustomTrack, aheadOf, partState, blueprintGrade, customGroups, customMoves, gunDef, groupsGone, launchShot, localToWorldDir, moveShotSeed, rayTerrain, shipPointToWorld, uncap,
  datan2, dhypot,
  type CustomAct, type CustomStats, type DesignMoves, type EntityState, type FlightBody, type MoveHost, type MovePose, type MoveShot,
  type ServerMessage, type ShipReplicaSet, type ShipState, type ShipTuning, type Terrain, type Catalog, type PlacedGeom, type MoveOrigin,
} from '@space-game/common';
import type { BodyRunner } from './BodyRunner';

/** This client's own ids for the shells it makes (well clear of the server's entity ids) */
const LOCAL_ID0 = 0x40000000;
/** A told hit takes the nearest shell of these within this of its point */
const STRUCK_NEAR = 160;

export interface MoveRunnerHost {
  reps: ShipReplicaSet;
  bodies: BodyRunner;
  store: { get(id: number): ShipState | undefined; geometry(ship: ShipState): PlacedGeom[]; readonly catalog: Catalog };
  tuning: ShipTuning;
  terrain(): Terrain | null | undefined;
  /** factions.json custom.designs (the custom enemies' numbers) */
  custom?: { designs: Record<string, CustomStats> };
  /**
   * A fork (the PT timeline's moves, client predict/kinds/movesKind.ts): its bodies' runs begin at this tick at the
   * earliest (a move under way then is sat out, as on a SYNC), so it can be made afresh from a recent tick and stepped
   * ahead of the snapshots
   */
  from?: number;
  /** A fork of these bodies only */
  only?: (id: number) => boolean;
  /** How a fork reads other ships (predict/aheadReads.ts: past the snapshots, never stepping them ahead on the layer) */
  read?: { now(id: number, t: number): FlightBody | null };
}

/** A look its moves gave, with the tick and body it's of */
export interface TimedMoveMsg { tick: number; owner: number; msg: ServerMessage }

interface Run {
  since: number;
  through: number;
  staged?: StagedTrack;
  custom?: CustomTrack;
  /** (a staged boss) its parts' states (PART_STATE) as its PART decisions left them */
  parts?: Uint8Array;
  /** Its host's tick and shells this tick */
  host: MoveHost & { t: number; n: number; owner: number };
}

interface LocalShell { id: number; until: number; x: number; y: number; vx: number; vy: number; at: number }

const NOBODY: MovePose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 };
const asPose = (b: FlightBody | null | undefined): MovePose | null => (b ? { x: b.x, y: b.y, angle: b.angle, vx: b.vx, vy: b.vy } : null);

export class MoveRunner {
  private readonly runs = new Map<number, Run>();
  private readonly shells = new Map<number, LocalShell>();
  private nextId = LOCAL_ID0;
  private msgs: ServerMessage[] = [];
  private timed: TimedMoveMsg[] = [];
  private rows: EntityState[] = [];
  private gone: number[] = [];
  private customs: Record<string, DesignMoves>;
  readonly stats = { msgs: 0, shells: 0, struck: 0, moves: 0, sat: 0 };

  constructor(private readonly host: MoveRunnerHost) {
    // (a custom move's pick is the commander's: never made here)
    this.customs = customMoves(() => Infinity);
  }

  /** A connection afresh: nothing runs, its shells go */
  reset(): void {
    this.runs.clear();
    this.timed = [];
    for (const id of this.shells.keys()) this.gone.push(id);
    this.shells.clear();
  }

  /**
   * A snapshot's window, after its bodies were stepped again: every body it runs worked through to `tick`. Returns the
   * shells it made (projectile rows) and those whose time is up (removals) for the snapshot
   */
  advance(tick: number, self: number): { rows: EntityState[]; removed: number[] } {
    const bodies = this.host.bodies;
    for (const id of [...this.runs.keys()]) if (!bodies.view(id)) this.runs.delete(id);
    const from = this.host.from ?? -Infinity, only = this.host.only;
    for (const id of bodies.ids()) {
      if (only && !only(id)) continue;
      const v = bodies.view(id)!;
      // (a fork's runs begin at its start at the earliest)
      const since = Math.max(v.syncTick, from);
      let run = this.runs.get(id);
      if (!run || run.since !== since) {
        const s = v.state(since);
        if (!s) continue;
        const made = this.makeRun(id, s.kind, since);
        if (!made) continue;
        this.runs.set(id, (run = made));
      }
      for (let t = Math.max(run.through + 1, run.since + 1); t <= tick; t++) {
        const s = v.state(t);
        if (!s?.on) break;
        run.host.t = t;
        run.host.n = 0;
        if (run.staged) this.stepStaged(run, id, t, s.target, s.stage, v.state(t - 1)?.side ?? s.side, s.homeX, s.homeY, s.hold ?? MOVES_HOLD.RUN, v.at(t), self);
        else if (run.custom && s.target >= 0) this.stepCustom(run, id, t, s.target, s.want, s.gone);
      }
      run.through = Math.max(run.through, tick);
    }
    for (const [id, sh] of this.shells) if (tick >= sh.until) { this.shells.delete(id); this.gone.push(id); }
    const out = { rows: this.rows, removed: this.gone };
    this.rows = [];
    this.gone = [];
    return out;
  }

  /** The messages its moves gave since the last take, to be handled as the server's would have been */
  take(): ServerMessage[] {
    const m = this.msgs;
    this.msgs = [];
    this.timed = [];
    return m;
  }

  /** take, each with its tick and body (the PT timeline's moves compare and time them: predict/kinds/movesKind.ts) */
  takeTimed(): TimedMoveMsg[] {
    const m = this.timed;
    this.msgs = [];
    this.timed = [];
    return m;
  }

  /** A hit told at a point (projectileHit of a shell it doesn't know): the nearest of its shells there goes */
  struck(x: number, y: number, tick: number): void {
    let best = -1, bd = STRUCK_NEAR;
    for (const [id, s] of this.shells) {
      const k = tick - s.at, d = dhypot(s.x + s.vx * k - x, s.y + s.vy * k - y);
      if (d < bd) { bd = d; best = id; }
    }
    if (best < 0) return;
    this.shells.delete(best);
    this.gone.push(best);
    this.stats.struck++;
  }

  /** Is this one of its own shells */
  owns(id: number): boolean {
    return this.shells.has(id);
  }

  /** The tick one of its shells is gone at (its life's end, or the rock it meets) */
  until(id: number): number | undefined {
    return this.shells.get(id)?.until;
  }

  private makeRun(id: number, kind: number, since: number): Run | null {
    const k = BODY_KINDS[kind];
    if (!k) return null;
    const host = this.moveHost(id);
    // (the enemy AI's pilot: a custom enemy's moves, by the design its order carries)
    if (k.brain === 'ai') return { since, through: since, host, custom: new CustomTrack(since) };
    const sm = STAGED_MOVES[k.brain], ship = this.host.store.get(id);
    if (!sm || !k.flight || !ship) return null;
    const moves = sm.make(host, id, k.flight);
    // (its parts as it has them now; PART decisions from here)
    const parts = Uint8Array.from({ length: ship.blueprint.parts.length }, (_, i) => partState(this.host.store.catalog, ship, i));
    const run: Run = { since, through: since, host, parts, staged: new StagedTrack(moves, host, sm.personalNames, sm.personalTicks) };
    host.part = (i) => run.parts![i] ?? 0;
    return run;
  }

  private stepStaged(run: Run, id: number, t: number, target: number, stage: number, side: 1 | -1, hx: number, hy: number, hold: number, ds: readonly (readonly number[])[], self: number): void {
    const tr = run.staged!, m = tr.moves;
    m.target = target; m.stage = stage; m.side = side; m.homeX = hx; m.homeY = hy; m.want = [WANT.FLY];
    // (its parts as they were on the tick: PART decisions, part damage being the server's)
    for (const d of ds) if (d[0] === DECISION.PART && run.parts) run.parts[d[1] ?? -1] = d[2] ?? 0;
    if (ds.some((d) => d[0] === DECISION.MOVE)) this.stats.moves++;
    for (const msg of tr.tick(t, ds, self, id, hold)) this.msg(msg, t, id);
  }

  private stepCustom(run: Run, id: number, t: number, target: number, w: readonly number[], goneNow: number | undefined): void {
    const design = CustomTrack.designOf(w);
    const stats = design ? this.host.custom?.designs[design] : undefined;
    if (!design || !stats) return;
    run.custom!.tick(t, w, this.customs[design], this.customAct(run, id, t, target, design, stats, goneNow ?? w[CO.GONE] ?? 0));
  }

  private msg(m: ServerMessage, tick: number, owner: number): void {
    this.msgs.push(m);
    this.timed.push({ tick, owner, msg: m });
    this.stats.msgs++;
  }

  /** Its moves' host on this client: reads off the tick layer, what it draws kept for `take`, its shells as rows */
  private moveHost(owner: number): MoveHost & { t: number; n: number; owner: number } {
    const self = this, reps = this.host.reps, store = this.host.store;
    const h = {
      t: 0, n: 0, owner,
      tick: () => h.t,
      // (its own pose before its own step this tick; another ship's as the server's step read it)
      me: () => asPose(reps.at(owner, h.t - 1)?.body) ?? NOBODY,
      pose: (id: number) => asPose(self.host.read ? self.host.read.now(id, h.t) : reps.preAt(id, h.t)),
      ship: () => store.get(owner)!,
      get catalog() { return store.catalog; },
      geometry: (s: ShipState) => store.geometry(s),
      cellSize: this.host.tuning.cellSize,
      terrain: () => self.host.terrain(),
      fx: (msg: ServerMessage) => self.msg(msg, h.t, owner),
      shoot: (s: MoveShot) => self.shoot(owner, h.t, h.n++, s, h.me()),
      cap: (_x: number, _y: number, angles: number[]) => {
        const r = self.runs.get(owner)?.staged;
        return r ? uncap(angles, r.capNow()) : angles;
      },
      mobs: true,
      origin: { t: 0, who: -1 } as MoveOrigin,
    };
    return h;
  }

  /** A move's straight shell, as the server's Weapons.spawn made it (its seed: moveShotSeed), drawn as a row of its own */
  private shoot(owner: number, t: number, n: number, s: MoveShot, me: MovePose): void {
    const ship = this.host.store.get(owner);
    if (!ship) return;
    const tuning = this.host.tuning, grade = blueprintGrade(this.host.store.catalog, ship.blueprint);
    const def = gunDef(tuning, s.kind, { grade });
    const shot = launchShot(def, s.kind, { speedScale: s.speed ?? 1, sizeScale: 1, turret: false }, s.angle, me.vx, me.vy, t, `${moveShotSeed(owner, t, n)}:0`);
    // (gone at its life's end, or where it meets rock)
    let life = shot.life;
    const terrain = this.host.terrain();
    if (terrain) life = Math.ceil(life * rayTerrain(terrain, s.x, s.y, s.x + shot.vx * life, s.y + shot.vy * life));
    const id = this.nextId++;
    if (this.nextId > LOCAL_ID0 + 0x3fffffff) this.nextId = LOCAL_ID0;
    this.shells.set(id, { id, until: t + life, x: s.x, y: s.y, vx: shot.vx, vy: shot.vy, at: t });
    this.rows.push({
      id, type: EntityType.Projectile, vx: shot.vx, vy: shot.vy,
      // (no position: spawn + velocity × age; no gun: its hits are the server's)
      data: [WEAPON_KIND_TYPE[s.kind] ?? 1, grade, (owner * 137) % 360, t, s.x, s.y, owner, shot.size, 0, 0, -1],
    } as EntityState);
    this.stats.shells++;
  }

  /** A custom enemy's moves' reads on this client (its target's trail from its replica's last few ticks) */
  private customAct(run: Run, eid: number, t: number, target: number, design: string, stats: CustomStats, goneBits: number): CustomAct {
    const reps = this.host.reps, store = this.host.store, h = run.host, self = this;
    const ship = store.get(eid);
    const groups = customGroups(design);
    // (its pieces gone as the server's moves read them on the tick: GONE decisions, else its order's)
    const gone = () => goneBits;
    const bit = (g: string) => { const i = groups.indexOf(g); return i < 0 ? 0 : 1 << i; };
    const pre = (id: number, k: number) => (this.host.read ? this.host.read.now(id, k) : reps.preAt(id, k));
    const me = () => h.me(), tp = () => asPose(pre(target, t)) ?? NOBODY;
    return {
      // (its damage scale is its grade's: only the server's damage reads it)
      eid, now: t, target, design, stats, dmg: 1, st: run.custom!.st,
      d: dhypot(tp().x - me().x, tp().y - me().y),
      has: (g) => { const b = bit(g); return b !== 0 && !(gone() & b); },
      at: (g, evenGone) => {
        const b = bit(g);
        if (!ship || !b || (!evenGone && gone() & b)) return null;
        return groupAt(store, this.host.tuning.cellSize, me(), ship, groups.indexOf(g));
      },
      me, tpose: tp,
      ahead: (ticks) => {
        // (its trail: its velocity the ticks it was fought, oldest first, as the server noted it)
        const tr: number[] = [];
        for (let k = t - CUSTOM_TRAIL + 1; k <= t; k++) { const p = pre(target, k); if (p) tr.push(p.vx, p.vy); }
        return aheadOf(tp(), tr, Math.max(0, Math.round(ticks)));
      },
      fx: (msg) => self.msg(msg, t, eid),
      shoot: (s) => self.shoot(eid, t, h.n++, s, me()),
      rng: () => 0,
      mobs: true,
    };
  }
}

/** A piece in the world: the first of its parts with a mount (where it fires from), else its first part's middle (as the server's) */
function groupAt(store: { geometry(s: ShipState): PlacedGeom[] }, cellSize: number, pose: MovePose, ship: ShipState, group: number): { x: number; y: number; dir: number } | null {
  const geoms = store.geometry(ship);
  let first = -1;
  for (let i = 0; i < ship.blueprint.parts.length; i++) {
    if (ship.blueprint.parts[i].group !== group) continue;
    if (first < 0) first = i;
    const m = geoms[i]?.mount;
    if (m) {
      const [x, y] = shipPointToWorld(ship, pose, m.at, cellSize), [dx, dy] = localToWorldDir(m.dir, pose.angle);
      return { x, y, dir: datan2(dy, dx) };
    }
  }
  if (first < 0) return null;
  const [x, y] = shipPointToWorld(ship, pose, geoms[first].centroid, cellSize), [dx, dy] = localToWorldDir([0, -1], pose.angle);
  return { x, y, dir: datan2(dy, dx) };
}
