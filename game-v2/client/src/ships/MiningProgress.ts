/**
 * Your mining progress: a thin ring round the rock you're working, filling towards your next drop, a brief flare of
 * it when the drop comes, fading out a little after you stop. Nothing is sent for it.
 *
 * The server works a rock by the damage that lands (Mining.extract: damage × the tool's yield × its work ÷
 * damagePerUnit), and a chunk is due every chunkUnits worked, waiting for the next kept unit when none was kept. The
 * client sees its own hits land (your shells striking, your mining laser cutting), so it works out the same rock units
 * here and fills the ring by them against what a drop takes on average for your tool (unitsPerDrop). It can't know the
 * server's rolls (the chunk's size and every keep are on the server's secret dice: payoutDice.ts), so a drop comes a
 * little before or after the ring fills; when it's full it holds, breathing, until the drop. A drop is a chunk of ore
 * appearing near where you've just been striking (as MiningStrikeFx.pod tells it), or, as a chunk thrown at you is
 * often caught before its pod is drawn, ore you mined coming into your hold: the ring flares and starts over.
 *
 * Drawn in world space, its width in screen pixels, so it reads at any zoom.
 */

import { Container, Graphics } from 'pixi.js';
import { toolKeep, unitsPerDrop, type MiningTable } from '@space-game/common';
import { clearIfDrawn } from '../rendering/gfx';
import { POD_NEAR, POD_WITHIN } from '../rendering/weapons/MiningStrikeFx';

/** Seconds the ring stays up after your last hit on the rock, and then takes to fade */
export const SHOW_FOR = 1.4, FADE = 0.7;
/** A chunk picked up this soon after you last worked a rock (seconds) is its drop; its pod seen this soon before, the same one */
const DROP_WITHIN = 2.5;
/** Seconds a drop's flare lasts */
const FLARE = 0.45;
/** Work on a rock is forgotten this long after your last hit (the server keeps it: this only bounds the map) */
const FORGET = 90;
const COLOR = 0xffe2a6, HOT = 0xffffff;

interface Work {
  /** Rock units worked since the last drop, and what a drop takes on average for the tool last used */
  units: number;
  per: number;
  /** Seconds: the last hit, the last drop (-1 none) */
  last: number;
  drop: number;
  /** The last hit's point (a drop near it is this rock's) */
  x: number;
  y: number;
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

  private workOf(rock: number, x: number, y: number): Work {
    let w = this.rocks.get(rock);
    if (!w) this.rocks.set(rock, (w = { units: 0, per: 1, last: 0, drop: -1, x, y, dps: 0, t: 0, shown: 0 }));
    w.x = x; w.y = y;
    return w;
  }

  /** Units worked on `rock` (by a tool keeping `keep`), struck at (x, y). Returns the fill, 0..1 */
  work(rock: number, units: number, keep: number, x: number, y: number): number {
    const w = this.workOf(rock, x, y);
    w.units += units;
    w.per = unitsPerDrop(this.table, keep);
    w.last = this.now();
    return this.progress(rock);
  }

  /**
   * Your shell of `damage` from a gun of `kind` struck soft rock `rock` of `tier` (the system's Mk) at (x, y): as the
   * server works it, past refDps a second on the rock only with the square root of it
   */
  shell(rock: number, kind: string | undefined, damage: number, tier: number, x: number, y: number): number {
    const tools = this.table.tools as unknown as Record<string, { yield: number }>;
    const tool = (kind && tools[kind]) || tools.fixed, gun = this.table.guns;
    const w = this.workOf(rock, x, y), t = this.now(), dt = t - w.t;
    w.dps = (dt >= 1 ? 0 : w.dps * (1 - dt)) + damage;
    w.t = t;
    const work = gun && w.dps > gun.refDps ? Math.sqrt(gun.refDps / w.dps) : 1;
    return this.work(rock, (damage * tool.yield * work) / this.table.damagePerUnit, toolKeep(this.table, {}, tier).keep, x, y);
  }

  /**
   * Your mining laser of `grade` cut rock `rock` of `tier` for `dt` seconds at `dps` (its tuning's, times what it got
   * and the beam's falloff): over a pulse the server's cut averages that
   */
  laser(rock: number, dps: number, dt: number, grade: number, tier: number, x: number, y: number): number {
    const k = toolKeep(this.table, { grade }, tier);
    if (k.keep <= 0) return 0;
    return this.work(rock, (dps * dt * this.table.tools.miner.yield * k.work) / this.table.damagePerUnit, k.keep, x, y);
  }

  /** A chunk of ore appeared at (x, y): if it's near where you've just been working a rock, that's your drop. True if it was */
  dropAt(x: number, y: number): boolean {
    const t = this.now();
    let best: Work | null = null, bd = POD_NEAR;
    for (const w of this.rocks.values()) {
      if (t - w.last > POD_WITHIN) continue;
      const d = Math.hypot(w.x - x, w.y - y);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) return false;
    best.units = 0;
    best.drop = t;
    return true;
  }

  /**
   * Ore you broke off came into your hold (a 'gained' message from 'mined': a chunk thrown at you is often picked up
   * before its pod is ever drawn here): that's a drop from the rock you've worked most lately, unless its pod was
   * already seen. True if it counted
   */
  dropped(): boolean {
    const t = this.now();
    let best: Work | null = null;
    for (const w of this.rocks.values()) if (t - w.last <= DROP_WITHIN && (!best || w.last > best.last)) best = w;
    if (!best || t - best.drop < DROP_WITHIN) return false;
    best.units = 0;
    best.drop = t;
    return true;
  }

  /** The fill towards the next drop on `rock`, 0..1 */
  progress(rock: number): number {
    const w = this.rocks.get(rock);
    return w ? Math.min(1, w.units / Math.max(1e-6, w.per)) : 0;
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
