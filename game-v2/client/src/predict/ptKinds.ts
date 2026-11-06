/**
 * The PT timeline's kinds: every kind of thing the client steps ahead of the confirmed tick to the own predicted tick,
 * so what you see is at the same moment as your own ship and shells (prediction mode C3 game-wide, track C).
 *
 * This is the registry's contract (one module, so the core track's PT/ST layer can adopt it as it is). A kind:
 *
 *   advance(to)   steps ahead from its confirmed state to the PT head `to` (the own predicted tick), once a tick,
 *                 recording what it stepped by tick (a state hash per thing per tick, or the outputs it gave)
 *   confirm(c)    the confirmed tick moved on to c: what it recorded at c (or in (last c, c]) against ST, the state the
 *                 snapshots make final there; a miss re-steps that thing once, from ST(c) to the head, and the drawn
 *                 pose eases from the old PT to the new (PtEase)
 *   pose(id, t)   where a thing it steps is drawn at tick t (PT, with what's left of an ease), if it steps it
 *   drawTick(id)  the tick a thing it steps (and what it fires) is drawn at this frame, if it steps it
 *
 * PtKinds runs them in `order` each frame: every kind's confirm first (lowest order first), then every kind's advance.
 * Order is "derived from" order: a kind reads only kinds with a lower order, so what it reads is already re-stepped
 * (ships 0, bodies 10, homing shells and mobs 20, bodies' moves (boss attacks, their shells) 30, shells 40).
 *
 * Kinds never touch the tick-accurate layer's truth (hits found, checks, the own ship's step): drawing only, as the
 * prediction modes are (state/drawMode.ts). A kind's stats are the overlay's rows (dev/simOverlay/predictSource.ts).
 */

export interface PoseXY { x: number; y: number; angle: number }

export interface PtKindStats {
  /** Ticks advanced (each steps every thing the kind holds) */
  ticks: number;
  /** Thing-ticks stepped advancing (not re-steps) */
  steps: number;
  /** ST checks made, and how many matched what PT had recorded */
  checks: number;
  matches: number;
  misses: number;
  /** Things re-stepped, and thing-ticks re-stepped */
  restepThings: number;
  restepTicks: number;
  /** Confirms that re-stepped anything */
  resteps: number;
  /** Re-steps that moved a drawn thing, and how far in all (world units) */
  corrections: number;
  correctionDist: number;
  /** Outputs (shells, looks) PT showed ahead, and those ST showed that PT hadn't (shown late, by how many ticks in all) */
  ahead: number;
  late: number;
  lateTicks: number;
  /** Outputs PT showed that ST never had (taken back) */
  wrong: number;
  restepMs: number;
  advanceMs: number;
}

export function noPtStats(): PtKindStats {
  return { ticks: 0, steps: 0, checks: 0, matches: 0, misses: 0, restepThings: 0, restepTicks: 0, resteps: 0, corrections: 0, correctionDist: 0, ahead: 0, late: 0, lateTicks: 0, wrong: 0, restepMs: 0, advanceMs: 0 };
}

export interface PtKind {
  /** Its overlay name ('ships', 'bodies', 'guides', 'moves', 'shells') */
  readonly name: string;
  /** Lower runs first (see the module comment) */
  readonly order: number;
  readonly stats: PtKindStats;
  /** The confirmed tick moved on to c (called every frame; a kind ignores c it has checked) */
  confirm(c: number): void;
  /** Step ahead to the PT head `to` */
  advance(to: number): void;
  /** Start again (a mode switch, a reconnect): nothing held */
  reset(): void;
  /** Does it step this thing (its draw tick is PT's) */
  has?(id: number): boolean;
  /** Where a thing it steps is drawn at tick t; null: not one of its own */
  pose?(id: number, t: number): PoseXY | null;
  /** A pose placed elsewhere at its draw tick (the replica layer's), with what's left of its ease added */
  eased?(id: number, p: PoseXY): PoseXY;
}

/** The registry: the kinds the client steps on the PT timeline */
export class PtKinds {
  private list: PtKind[] = [];

  add(k: PtKind): this {
    this.list = [...this.list.filter((o) => o.name !== k.name), k].sort((a, b) => a.order - b.order);
    return this;
  }

  remove(name: string): void {
    this.list = this.list.filter((k) => k.name !== name);
  }

  get(name: string): PtKind | undefined {
    return this.list.find((k) => k.name === name);
  }

  all(): readonly PtKind[] {
    return this.list;
  }

  /** A frame: what's newly confirmed checked (re-stepped once on a miss), then every kind stepped on to the head */
  frame(confirmed: number, predicted: number): void {
    for (const k of this.list) k.confirm(confirmed);
    for (const k of this.list) k.advance(predicted);
  }

  reset(): void {
    for (const k of this.list) k.reset();
  }

  /** Is this thing on the PT timeline (any kind steps it) */
  has(id: number): boolean {
    for (const k of this.list) if (k.has?.(id)) return true;
    return false;
  }

  /** A pose placed elsewhere at its draw tick, eased by the first kind that steps it (if that kind eases) */
  eased(id: number, p: PoseXY): PoseXY {
    for (const k of this.list) if (k.has?.(id)) return k.eased ? k.eased(id, p) : p;
    return p;
  }

  /** Where it's drawn at tick t, by the first kind that steps it */
  pose(id: number, t: number): PoseXY | null {
    for (const k of this.list) {
      if (!k.has?.(id)) continue;
      const p = k.pose?.(id, t);
      if (p) return p;
    }
    return null;
  }
}

const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
export const wrapAngle = (d: number) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

/**
 * The eased draw: after a re-step moved a thing's PT from `was` to `now`, it is drawn at the new PT plus an offset that
 * fades over lerpMs (what's left of an earlier ease carries on into the next). As PtStLayer's, for every other kind
 */
export class PtEase {
  private readonly offsets = new Map<number, { dx: number; dy: number; da: number; at: number }>();

  constructor(public lerpMs = 150, private readonly now: () => number = () => performance.now()) {}

  /** A re-step moved it: returns how far (0: it didn't move) */
  moved(id: number, was: PoseXY, to: PoseXY): number {
    const dx = was.x - to.x, dy = was.y - to.y, da = wrapAngle(was.angle - to.angle);
    if (!dx && !dy && !da) return 0;
    const now = this.now(), o = this.offsets.get(id), w = o ? this.weight(o.at, now) : 0;
    this.offsets.set(id, { dx: dx + (o ? o.dx * w : 0), dy: dy + (o ? o.dy * w : 0), da: da + (o ? o.da * w : 0), at: now });
    return Math.hypot(dx, dy);
  }

  /** The pose `p` with what's left of its ease added (in place) */
  apply(id: number, p: PoseXY): PoseXY {
    const o = this.offsets.get(id);
    if (!o) return p;
    const w = this.weight(o.at, this.now());
    if (w <= 0) { this.offsets.delete(id); return p; }
    p.x += o.dx * w; p.y += o.dy * w; p.angle += o.da * w;
    return p;
  }

  drop(id: number): void { this.offsets.delete(id); }
  clear(): void { this.offsets.clear(); }

  private weight(at: number, now: number): number {
    return 1 - smoothstep((now - at) / Math.max(1, this.lerpMs));
  }
}

/** FNV-1a over a list of numbers (outputs' hashes: a tick's shells and looks) */
export function hashNums(h: number, xs: readonly number[]): number {
  for (const x of xs) {
    const v = Number.isInteger(x) ? x | 0 : Math.round(x * 1024) | 0;
    h ^= v & 0xff; h = Math.imul(h, 16777619);
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 16777619);
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 16777619);
    h ^= v >>> 24; h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** FNV-1a over a string (a look's key) */
export function hashStr(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const FNV0 = 2166136261;
