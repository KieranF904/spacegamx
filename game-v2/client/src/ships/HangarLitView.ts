/**
 * The hangar's ship as it looks in flight: a WebGL layer of the editor (over
 * its grid, under its marks), drawn by the same hull build, ShipBatch shader
 * and Lighting as in flight, under a star to the upper left. It follows the
 * editor's zoom and pan exactly; only built parts are in it (ghosts are the
 * editor's own faint outlines), and wrecked ones show their damage. It only
 * renders while the hangar is open.
 */

import { Application, Container } from 'pixi.js';
import type { Catalog, PlacedGeom, ShipState } from '@space-game/common';
import { Lighting } from '../rendering/lighting/Lighting';
import { ShipBatch } from '../rendering/lighting/ShipBatch';
import { buildHull } from './hullBuild';

const ID = 1;

export class HangarLitView {
  private app: Application | null = null;
  private ready = false;
  private open = false;
  private world = new Container();
  private lighting = new Lighting(this.world);
  private batch: ShipBatch;
  private ship: ShipState | null = null;
  /** Where the ship's centre of mass is (pixels, at a cell `cs`), and how far it reaches */
  private at = { x: 0, y: 0 };
  private radius = 1;
  /** The editor's view: pixels a cell, the grid point at the middle, the canvas's size */
  private view = { px: 40, cx: 0, cy: 0, w: 1, h: 1 };
  private host: HTMLElement;

  /** `before`: the editor's mark canvas (this layer goes under it) */
  constructor(private before: HTMLCanvasElement, private catalog: Catalog, private cs: number) {
    this.host = before.parentElement!;
    this.batch = new ShipBatch(this.lighting, cs);
    this.world.addChild(this.batch.container);
    // flatter than in flight (a high sun, more ambient), so the design reads evenly
    this.lighting.ambient = [0.42, 0.43, 0.46];
    Object.assign(this.lighting.sun, { x: -170000, y: -100000, falloff: 400000, power: 0.62, color: [0.93, 0.87, 0.75], elevation: 0.95 });
  }

  /**
   * The ship to show: its state (built from its built parts only) and their
   * placed geometry; `hp` each part's health (wrecked ones low), or none
   */
  show(ship: ShipState | null, geoms: PlacedGeom[], hp?: number[]): void {
    this.batch.remove(ID);
    this.ship = ship;
    if (!ship || !geoms.length || !ship.derived.alive.some(Boolean)) { this.ship = null; return; }
    if (hp) ship.hp = hp.map((f, i) => f * ship.maxHp[i]);
    const paint = ship.blueprint.paint ? parseInt(ship.blueprint.paint.slice(1), 16) : undefined;
    const build = buildHull(this.catalog, geoms, ship, this.cs, paint);
    this.radius = ship.derived.radius + this.cs;
    this.at = { x: ship.derived.com[0] * this.cs, y: ship.derived.com[1] * this.cs };
    this.batch.track(ID, this.at.x, this.at.y);
    this.batch.set(ID, build.hull, this.radius);
  }

  /** The editor's view this frame (pixels a cell, the grid point at the middle, its canvas's size in CSS pixels) */
  setView(px: number, cx: number, cy: number, w: number, h: number): void {
    Object.assign(this.view, { px, cx, cy, w, h });
    if (this.app && this.ready && (this.app.screen.width !== w || this.app.screen.height !== h) && w > 0 && h > 0) this.app.renderer.resize(w, h);
  }

  setOpen(open: boolean): void {
    this.open = open;
    // (closed, its hull's GPU geometry and damage texture go; set again as it opens)
    if (open) this.batch.restore(); else this.batch.release();
    if (open && !this.app) void this.start();
    if (this.app && this.ready) { if (open) this.app.ticker.start(); else this.app.ticker.stop(); }
  }

  private async start(): Promise<void> {
    const app = new Application();
    this.app = app;
    const { w, h } = this.view;
    await app.init({ width: Math.max(1, w), height: Math.max(1, h), backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: window.devicePixelRatio || 1, autoDensity: true, eventFeatures: { move: false, globalMove: false, click: false, wheel: false } });
    // (the page styles every canvas as the game's: this one fills the editor, under its marks, letting the mouse through)
    app.canvas.style.cssText = 'position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none;';
    this.host.insertBefore(app.canvas, this.before);
    app.stage.addChild(this.world);
    app.ticker.add(() => { this.frame(); app.render(); });
    this.ready = true;
    this.setView(this.view.px, this.view.cx, this.view.cy, this.view.w, this.view.h);
    this.setOpen(this.open);
  }

  private frame(): void {
    const { px, cx, cy, w, h } = this.view, k = px / this.cs;
    // grid point (x, y) sits at ((x - cx) px + w/2, (y - cy) px + h/2); the hull's pixels are at a cell `cs`
    this.world.scale.set(k);
    this.world.position.set(w / 2 - cx * px, h / 2 - cy * px);
    this.batch.begin();
    if (this.ship) {
      this.batch.place(ID, this.at.x, this.at.y, 0, 1, 0);
      this.batch.setDamage(ID, this.ship.hp, this.ship.maxHp, this.ship.detached);
    }
    this.batch.end(k);
    this.lighting.frame({ x: this.at.x, y: this.at.y, r: this.radius * 2 });
  }
}
