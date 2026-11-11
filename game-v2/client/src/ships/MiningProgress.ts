/**
 * Your mining progress: a thin ring round the rock you're working, filling towards your next drop, a brief flare of
 * it when the drop comes, fading out a little after you stop.
 *
 * WHEN a chunk drops is public, WHAT it holds secret (common econ/miningChunks.ts). The server works a rock by the
 * damage that lands (Mining.extract), each miner's work on it their own, and steps each unit worked through the rock's
 * public mining seed: the chunk's size and whether the unit is kept, so the unit the chunk drops at. The client does
 * the same here from its own hits as they land (your shells striking, your mining laser cutting, at its pulse's curve:
 * workedUnits, gunDps, gunPace, pulseCut), from the same seed (the rock's mineSeed, worked out with its composition),
 * so the ring fills to the server's drop and the drop lands on the hit that fills it. Nothing is sent for it: only on
 * entering a system are you told where you are on rocks you've part-worked there (asteroidSeed `mine`: enter).
 * What each drop holds (its ores, a gem, a bonus unit) stays on the server's secret dice; the ring never knows.
 *
 * Drawn in world space, its width in screen pixels, so it reads at any zoom.
 */

import { Container, Graphics } from 'pixi.js';
import {
  toolKeep, unitsPerDrop, workedUnits, gunDps, gunPace, keepOdds, workUnit, chunkDue, freshChunk, unpackChunks, UNIT_DROP,
  type MiningTable, type Composition, type ChunkState, type UnitRule,
} from '@space-game/common';
import { clearIfDrawn } from '../rendering/gfx';

/** Seconds the ring stays up after your last hit on the rock, and then takes to fade */
export const SHOW_FOR = 1.4, FADE = 0.7;
/** Seconds a drop's flare lasts */
const FLARE = 0.45;
const COLOR = 0xffe2a6, HOT = 0xffffff;

/** What the ring needs of a rock: its public mining seed and composition (the client's asteroid entity has both) */
export interface MineRock {
  seed: number;
  composition: Composition;
}

interface Work {
  /** The rock's seed this work is on (another rock come back under the same id starts over) */
  seed: number | undefined;
  /** Where you are in your chunks on it: the server's own stepping (common workUnit) */
  s: ChunkState;
  /** The last tool's keep chance on the rock (keepOdds), the rule it's for, and where this chunk drops by it */
  keep: number;
  rule: string;
  due: number;
  /** Without the rock's seed (none known): what a drop takes on average for the tool (unitsPerDrop) */
  per: number;
  /** Seconds: the last hit, the last drop (-1 none) */
  last: number;
  drop: number;
  /** Guns: your damage on the rock in about the last second (a leaking sum, as the server's), as of `t` */
  dps: number;
  t: number;
  /** The fill as drawn (eased towards the real one) */
  shown: number;
}

/** A rock as drawn: where, and its size */
export interface RockPose { renderX: number; renderY: number; data?: number[] }

export class MiningProgress {
  private rocks = new Map<number, Work>();
  /** (None without a layer: the tests, which only work it) */
  private g: Graphics | null = null;

  /** `rockOf`: a rock's seed and composition (none: the ring fills against the average) */
  constructor(layer: Container | null, private table: MiningTable, private now: () => number, private rockOf: (id: number) => MineRock | undefined = () => undefined) {
    if (!layer) return;
    const root = new Container();
    root.addChild((this.g = new Graphics()));
    layer.addChild(root);
  }

  private workOf(rock: number): Work {
    const seed = this.rockOf(rock)?.seed;
    let w = this.rocks.get(rock);
    if (!w || w.seed !== seed) this.rocks.set(rock, (w = { seed, s: freshChunk(), keep: 1, rule: '', due: 0, per: 1, last: -1e9, drop: -1, dps: 0, t: 0, shown: 0 }));
    return w;
  }

  /**
   * Entering a system: where you are on the rocks you've part-worked here (asteroidSeed/asteroidSpawn `mine`, packed:
   * packChunk). `fresh`: the system's whole word (every rock not in it is fresh for you)
   */
  enter(mine: readonly number[] | undefined, fresh: boolean): void {
    if (fresh) this.rocks.clear();
    for (const [rock, s] of unpackChunks(mine ?? [])) {
      const w = this.workOf(rock);
      w.s = s;
      w.rule = '';
      w.due = this.rockOf(rock) ? chunkDue(this.table, w.seed!, s, w.keep) : 0;
    }
  }

  /**
   * Units worked on `rock` by a tool of `rule` (its keep, the gun's rule if a gun, its hardness): stepped unit by unit
   * as the server does, a drop on the unit that drops it. Returns the fill, 0..1
   */
  private work(rock: number, units: number, rule: UnitRule): number {
    const w = this.workOf(rock), info = this.rockOf(rock), t = this.now();
    w.last = t;
    if (!info) {
      w.s.owed += units;
      w.per = unitsPerDrop(this.table, rule.keep);
      return this.progress(rock);
    }
    const c = info.composition;
    // (Guns crack soft rock only, anything else a hard enough tool: as the server's, no work on it)
    if (rule.gun ? c.hardness > 1 : rule.hardness < c.hardness) return this.progress(rock);
    const key = `${rule.keep}|${rule.gun ? 1 : 0}|${rule.hardness}`;
    if (key !== w.rule) { w.rule = key; w.keep = keepOdds(this.table, c, rule).keep; }
    w.s.owed += units;
    while (w.s.owed >= 1) {
      w.s.owed -= 1;
      if (workUnit(this.table, info.seed, w.s, w.keep) & UNIT_DROP) { w.drop = t; w.shown = 0; }
    }
    w.due = chunkDue(this.table, info.seed, w.s, w.keep);
    return this.progress(rock);
  }

  /**
   * Your shell of `damage` from a gun of `kind` struck rock `rock` of `tier` (the system's Mk): as the server works it,
   * past refDps a second on the rock only with the square root of it (a mining tool's shell, a charge, keeps all)
   */
  shell(rock: number, kind: string | undefined, damage: number, tier: number): number {
    const tools = this.table.tools as unknown as Record<string, { yield: number; hardness: number; mining?: boolean }>;
    const tool = (kind && tools[kind]) || tools.fixed, gun = tool.mining ? undefined : this.table.guns;
    const w = this.workOf(rock), t = this.now();
    let pace = 1;
    if (gun) {
      w.dps = gunDps(w.dps, t - w.t, damage);
      w.t = t;
      pace = gunPace(this.table, w.dps);
    }
    return this.work(rock, workedUnits(this.table, damage, tool.yield, pace), { keep: toolKeep(this.table, { mining: tool.mining }, tier).keep, gun, hardness: tool.hardness });
  }

  /**
   * Your mining laser of `grade` and `material` (its hardness: minerByMaterial, as the server's) cut rock `rock` of
   * `tier` at `dps` (its tuning's, times what it got and the beam's falloff) for `dt` seconds of its steady cut (the
   * ticks it cut, each by its pulse's curve: pulseCut)
   */
  laser(rock: number, dps: number, dt: number, grade: number, tier: number, material?: string): number {
    const k = toolKeep(this.table, { grade }, tier);
    if (k.keep <= 0) return 0;
    const hardness = (material !== undefined ? this.table.tools.minerByMaterial[material] : undefined) ?? this.table.tools.miner.hardness;
    return this.work(rock, workedUnits(this.table, dps * dt, this.table.tools.miner.yield, k.work), { keep: k.keep, gun: undefined, hardness });
  }

  /** Where you are on `rock`'s chunk (a copy; null: never worked here) */
  chunkOf(rock: number): ChunkState | null {
    const w = this.rocks.get(rock);
    return w ? { ...w.s } : null;
  }

  /** The fill towards the next drop on `rock`, 0..1 */
  progress(rock: number): number {
    const w = this.rocks.get(rock);
    if (!w) return 0;
    return Math.min(1, (w.s.worked + w.s.owed) / Math.max(1e-6, w.due || w.per));
  }

  /** How visible the ring on `rock` is now, 0..1 (up while you work it, fading after) */
  visibility(rock: number): number {
    const w = this.rocks.get(rock);
    if (!w) return 0;
    const idle = this.now() - Math.max(w.last, w.drop);
    return idle <= SHOW_FOR ? 1 : Math.max(0, 1 - (idle - SHOW_FOR) / FADE);
  }

  /** Once a frame: the rings, on the rocks as drawn (`rockAt`), `zoom` the camera's. A rock gone, its work goes too */
  update(dt: number, zoom: number, rockAt: (id: number) => RockPose | undefined): void {
    const g = this.g, t = this.now(), px = 1 / Math.max(0.05, zoom);
    if (!g) return;
    clearIfDrawn(g);
    for (const [id, w] of this.rocks) {
      const e = rockAt(id);
      if (!e) { this.rocks.delete(id); continue; }
      const vis = this.visibility(id);
      const fill = this.progress(id);
      // (Eased, so a hit's step reads as a fill; a drop snaps it back)
      w.shown = fill < w.shown ? fill : w.shown + (fill - w.shown) * Math.min(1, dt * 14);
      const flare = w.drop >= 0 && t - w.drop < FLARE ? 1 - (t - w.drop) / FLARE : 0;
      if (vis <= 0 && flare <= 0) continue;
      const size = e.data?.[0] ?? 30;
      const r = size + 7 + 5 * px, cx = e.renderX, cy = e.renderY, width = 2.4 * px;
      // The track, faint, and the fill from the top, clockwise
      g.circle(cx, cy, r).stroke({ color: COLOR, width, alpha: 0.16 * vis });
      if (w.shown > 0.005) {
        g.moveTo(cx, cy - r).arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + w.shown * Math.PI * 2).stroke({ color: COLOR, width: width * 1.25, alpha: 0.9 * vis, cap: 'round' });
      }
      // A drop: the whole ring flares bright and opens out a touch
      if (flare > 0) g.circle(cx, cy, r + (1 - flare) * 10 * px).stroke({ color: HOT, width: width * (1 + flare), alpha: 0.8 * flare });
    }
  }
}
