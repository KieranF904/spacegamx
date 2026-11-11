/**
 * Your mining progress: a thin ring round the rock you're working, filling towards your next drop, a brief flare of
 * it when the drop comes, fading out a little after you stop.
 *
 * The server works a rock by the damage that lands (Mining.extract), each miner's work on it their own, and throws a
 * chunk at the unit it's due: the first at or past the chunk's size with something kept. The size and the keeps are
 * on the server's secret dice (payoutDice.ts), so when a chunk starts (your first hit on a rock, each drop) the server
 * tells you where it's due and how far in you are (a mineChunk message, a few bytes a chunk, nothing a hit). Between
 * those the client fills the ring from its own hits as they land (your shells striking, your mining laser cutting, at
 * its pulse's curve) by the server's one rule (common econ/mining.ts workedUnits, gunDps, gunPace), and snaps to the
 * server's count with each message. The drop comes as the ring fills; full a moment early (a hit seen here before the
 * server has it), it holds, breathing, until the server's drop arrives: the ring flares and starts over from it.
 * Before the first word on a rock it fills against what a drop takes on average for your tool (unitsPerDrop).
 *
 * Drawn in world space, its width in screen pixels, so it reads at any zoom.
 */

import { Container, Graphics } from 'pixi.js';
import { toolKeep, unitsPerDrop, workedUnits, gunDps, gunPace, type MiningTable } from '@space-game/common';
import { clearIfDrawn } from '../rendering/gfx';

/** Seconds the ring stays up after your last hit on the rock, and then takes to fade */
export const SHOW_FOR = 1.4, FADE = 0.7;
/** Seconds a drop's flare lasts */
const FLARE = 0.45;
/** Work on a rock is forgotten this long after your last hit (the server keeps it: this only bounds the map) */
const FORGET = 90;
const COLOR = 0xffe2a6, HOT = 0xffffff;

interface Work {
  /** Rock units worked into this chunk (the server's count at its last word, and your hits since) */
  units: number;
  /** Where the chunk's drop falls, in rock units (the server's word; 0: none yet), and the average for your tool till then */
  due: number;
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

  constructor(layer: Container | null, private table: MiningTable, private now: () => number) {
    if (!layer) return;
    const root = new Container();
    root.addChild((this.g = new Graphics()));
    layer.addChild(root);
  }

  private workOf(rock: number): Work {
    let w = this.rocks.get(rock);
    if (!w) this.rocks.set(rock, (w = { units: 0, due: 0, per: 1, last: this.now(), drop: -1, dps: 0, t: 0, shown: 0 }));
    return w;
  }

  /** Units worked on `rock` (by a tool keeping `keep`). Returns the fill, 0..1 */
  work(rock: number, units: number, keep: number): number {
    const w = this.workOf(rock);
    w.units += units;
    w.per = unitsPerDrop(this.table, keep);
    w.last = this.now();
    return this.progress(rock);
  }

  /**
   * Your shell of `damage` from a gun of `kind` struck soft rock `rock` of `tier` (the system's Mk): as the server
   * works it, past refDps a second on the rock only with the square root of it
   */
  shell(rock: number, kind: string | undefined, damage: number, tier: number): number {
    const tools = this.table.tools as unknown as Record<string, { yield: number }>;
    const tool = (kind && tools[kind]) || tools.fixed;
    const w = this.workOf(rock), t = this.now();
    w.dps = gunDps(w.dps, t - w.t, damage);
    w.t = t;
    return this.work(rock, workedUnits(this.table, damage, tool.yield, gunPace(this.table, w.dps)), toolKeep(this.table, {}, tier).keep);
  }

  /**
   * Your mining laser of `grade` cut rock `rock` of `tier` at `dps` (its tuning's, times what it got and the beam's
   * falloff) for `dt` seconds of its steady cut (the ticks it cut, each by its pulse's curve: pulseCut)
   */
  laser(rock: number, dps: number, dt: number, grade: number, tier: number): number {
    const k = toolKeep(this.table, { grade }, tier);
    if (k.keep <= 0) return 0;
    return this.work(rock, workedUnits(this.table, dps * dt, this.table.tools.miner.yield, k.work), k.keep);
  }

  /**
   * The server's word on your chunk on `rock` (a mineChunk message): its drop falls at `due` rock units, `at` are
   * worked; `drop`: one was just thrown (the ring flares and starts over from there)
   */
  chunk(rock: number, due: number, at: number, drop: boolean): void {
    const w = this.workOf(rock);
    w.due = due;
    w.units = at;
    if (drop) { w.drop = this.now(); w.shown = 0; }
  }

  /** The fill towards the next drop on `rock`, 0..1 */
  progress(rock: number): number {
    const w = this.rocks.get(rock);
    return w ? Math.min(1, w.units / Math.max(1e-6, w.due || w.per)) : 0;
  }

  /** How visible the ring on `rock` is now, 0..1 (up while you work it, fading after) */
  visibility(rock: number): number {
    const w = this.rocks.get(rock);
    if (!w) return 0;
    const idle = this.now() - Math.max(w.last, w.drop);
    return idle <= SHOW_FOR ? 1 : Math.max(0, 1 - (idle - SHOW_FOR) / FADE);
  }

  /** Once a frame: the rings, on the rocks as drawn (`rockAt`), `zoom` the camera's */
  update(dt: number, zoom: number, rockAt: (id: number) => RockPose | undefined): void {
    const g = this.g, t = this.now(), px = 1 / Math.max(0.05, zoom);
    if (!g) return;
    clearIfDrawn(g);
    for (const [id, w] of this.rocks) {
      const e = rockAt(id);
      if (!e || t - w.last > FORGET) { this.rocks.delete(id); continue; }
      const vis = this.visibility(id);
      const fill = this.progress(id);
      // (Eased, so a hit's step reads as a fill; a drop snaps it back)
      w.shown = fill < w.shown ? fill : w.shown + (fill - w.shown) * Math.min(1, dt * 14);
      const flare = w.drop >= 0 && t - w.drop < FLARE ? 1 - (t - w.drop) / FLARE : 0;
      if (vis <= 0 && flare <= 0) continue;
      const size = e.data?.[0] ?? 30;
      const r = size + 7 + 5 * px, cx = e.renderX, cy = e.renderY, width = 2.4 * px;
      // The track, faint, and the fill from the top, clockwise; full, it breathes while the drop is rolled
      g.circle(cx, cy, r).stroke({ color: COLOR, width, alpha: 0.16 * vis });
      if (w.shown > 0.005) {
        const full = w.shown >= 0.999, breathe = full ? 0.75 + 0.25 * Math.sin(t * 7) : 1;
        g.moveTo(cx, cy - r).arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + w.shown * Math.PI * 2).stroke({ color: COLOR, width: width * 1.25, alpha: 0.9 * vis * breathe, cap: 'round' });
      }
      // A drop: the whole ring flares bright and opens out a touch
      if (flare > 0) g.circle(cx, cy, r + (1 - flare) * 10 * px).stroke({ color: HOT, width: width * (1 + flare), alpha: 0.8 * flare });
    }
  }
}
