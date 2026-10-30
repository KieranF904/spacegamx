/**
 * The asset viewer's scene: the game's own ShipRenderer (hull build, ShipBatch, turrets, fixed barrels, wires,
 * frames, ThrusterFx flames and exhaust, headlights in the dark) over a stand-in for the game's Renderer and
 * GameState, lit by the game's Lighting, with the game's sky and bloom behind and over it. No server: the ships are
 * ShipStates made here, posed still.
 */

import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { EntityType, blueprintGeometry, type Blueprint, type PlacedGeom, type ShipState } from '@space-game/common';
import { Lighting, type Rgb } from '../rendering/lighting/Lighting';
import { Bloom } from '../rendering/Bloom';
import { SkyRenderer } from '../rendering/sky/SkyRenderer';
import { BIOME_KINDS, skyBiome } from '../rendering/sky/skyBiome';
import { ShipRenderer } from '../ships/ShipRenderer';
import type { ShipSource } from '../ships/ShipStore';
import type { ThrustCommand } from '../ships/ThrusterFx';
import type { InterpolatedEntity, GameState } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import factionsData from '../../../data/factions.json';
import { expandAsset, refLabel, type AssetRef } from './assets';
import { refBlueprint, viewerShip } from './builders';
import type { ViewerData } from './catalog';
import { DEFAULTS, lightWith, type LightPreset, type ViewerParams } from './params';

interface Light { ambient: Rgb; power: number; color: Rgb; elevation: number; dir: number; off?: boolean }
/** Presets: the light the game gives a sunlit system, the hangar's even light, a nebula's tinted gloom, the dark (headlights come on), none */
export const LIGHT_PRESETS: Record<LightPreset, Light> = {
  sun: { ambient: [0.25, 0.25, 0.27], power: 1, color: [0.95, 0.88, 0.74], elevation: 0.55, dir: 315 },
  hangar: { ambient: [0.42, 0.43, 0.46], power: 0.62, color: [0.93, 0.87, 0.75], elevation: 0.95, dir: 300 },
  nebula: { ambient: [0.3, 0.22, 0.36], power: 0.55, color: [0.72, 0.8, 1], elevation: 0.45, dir: 40 },
  dark: { ambient: [0.06, 0.06, 0.07], power: 0, color: [1, 1, 1], elevation: 0.5, dir: 0 },
  flat: { ambient: [1, 1, 1], power: 0, color: [1, 1, 1], elevation: 1, dir: 0, off: true },
};

const FACTION_IDS = Object.keys((factionsData as { factions: Record<string, unknown> }).factions);
const LABEL = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 13, fill: 0xb8c4d6, align: 'center' });
const FLAT_DARK = 0x05070b;

interface Item {
  id: number;
  ref: AssetRef;
  ship: ShipState;
  geoms: PlacedGeom[];
  entity: InterpolatedEntity;
  /** Its hull's extent about its centre of mass (world units, unturned) */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Which way its engines are driven (grid frame) */
  thrust: [number, number];
  label?: Text;
  grid?: Graphics;
}

/** What the scene was built from: a change here makes the ships again */
const buildKey = (p: ViewerParams) => [p.asset, p.facing, p.stub, p.tint, p.labels, p.cols].join('|');

export class ViewerScene {
  readonly app = new Application();
  private world = new Container();
  private shipLayer = new Container();
  private gridLayer = new Container();
  private labelLayer = new Container();
  private lighting = new Lighting(this.world);
  private sky!: SkyRenderer;
  private bloom!: Bloom;
  private ships!: ShipRenderer;
  private bodies = new Map<number, ShipState>();
  private state = { entities: new Map<number, InterpolatedEntity>(), playerId: -1 };
  private items: Item[] = [];
  private nextId = 1;
  private key = '';
  private skyKey = '';
  private p: ViewerParams = { ...DEFAULTS };
  /** The camera: centre (world units) and zoom as last drawn */
  readonly cam = { x: 0, y: 0, zoom: 1 };
  /** Export: PNG pixels per CSS pixel while a shot is taken (the hull's detail follows it) */
  private exportScale = 1;
  private size = { w: 1, h: 1 };
  /** Frames and time since the scene last changed (render waits for things to settle) */
  private since = { frames: 0, at: 0 };
  private running = false;
  /** Shown in the panel: what's on screen */
  info = '';

  constructor(private data: ViewerData, private host: HTMLElement) {}

  async init(): Promise<void> {
    const app = this.app;
    await app.init({ width: 4, height: 4, backgroundAlpha: 0, antialias: true, preference: 'webgl', autoStart: false, resolution: window.devicePixelRatio || 1, autoDensity: true, preserveDrawingBuffer: true, eventFeatures: { move: false, globalMove: false, click: false, wheel: false } });
    this.host.appendChild(app.canvas);
    this.sky = new SkyRenderer(app);
    this.bloom = new Bloom(app);
    app.stage.addChild(this.sky.container, this.world);
    this.bloom.addTo(app.stage);
    this.world.addChild(this.shipLayer, this.gridLayer, this.labelLayer);
    const source: ShipSource = {
      catalog: this.data.catalog, tuning: this.data.tuning, bodies: this.bodies,
      get: (id) => this.bodies.get(id),
      geometry: (ship) => this.items.find((i) => i.ship === ship)?.geoms ?? blueprintGeometry(this.data.catalog, ship.blueprint),
    };
    // (the parts of the game's Renderer that ShipRenderer reaches for)
    const scene = this;
    const renderer = {
      lighting: this.lighting,
      getShipLayer: () => this.shipLayer,
      hiddenEntityIds: new Set<number>(),
      shipRadius: new Map<number, number>(),
      inView: () => true,
      getZoom: () => scene.cam.zoom * scene.exportScale,
      get tagScale() { return 1; },
    };
    this.ships = new ShipRenderer(source, renderer as unknown as Renderer, this.state as unknown as GameState, (id) => this.command(id));
    for (const c of this.ships.glowLayers()) this.bloom.add(c);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.host);
    this.live(true);
  }

  /** Draw every frame (the page in a window), or not at all (the render daemon's page between renders: it costs nothing idle) */
  live(on: boolean): void {
    if (on === this.running) return;
    this.running = on;
    if (!on) return;
    const loop = () => { if (!this.running) return; this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  /** Take new settings (the ships are made again only when what they are changed) */
  set(p: ViewerParams): void {
    const prev = this.p;
    this.p = { ...p };
    if (prev.w !== p.w || prev.h !== p.h) this.resize();
    if (buildKey(p) !== this.key) this.build();
    this.since = { frames: 0, at: performance.now() };
  }

  get params(): ViewerParams {
    return this.p;
  }

  /** The canvas's size (CSS px) */
  get view(): { w: number; h: number } {
    return { ...this.size };
  }

  private resize(): void {
    const w = this.p.w ?? Math.max(16, this.host.clientWidth), h = this.p.h ?? Math.max(16, this.host.clientHeight);
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.app.renderer.resize(w, h);
    this.app.canvas.style.width = `${w}px`;
    this.app.canvas.style.height = `${h}px`;
    this.sky.resize();
    this.bloom.resize();
  }

  // ---- the ships

  private build(): void {
    this.key = buildKey(this.p);
    for (const it of this.items) { it.label?.destroy(); it.grid?.destroy(); }
    this.items = [];
    this.bodies.clear();
    this.state.entities.clear();
    const refs = expandAsset(this.p.asset, this.data.assets);
    const cs = this.data.tuning.cellSize;
    const tint = this.p.tint;
    const faction = tint?.startsWith('faction:') ? FACTION_IDS.indexOf(tint.slice(8)) : -1;
    const missing: string[] = [];
    for (const ref of refs) {
      let bp = refBlueprint(this.data.catalog, ref, this.data.ships, { facing: this.p.facing, stub: this.p.stub });
      if (!bp) { missing.push(`${ref.kind}:${ref.key}`); continue; }
      if (tint?.startsWith('#')) bp = { ...bp, paint: tint } as Blueprint;
      const id = this.nextId++;
      let ship: ShipState;
      try {
        ship = viewerShip(this.data.catalog, this.data.tuning, id, bp);
      } catch (e) {
        missing.push(`${ref.kind}:${ref.key} (${String(e)})`);
        continue;
      }
      const geoms = blueprintGeometry(this.data.catalog, ship.blueprint);
      const [cx, cy] = ship.derived.com;
      const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      geoms.forEach((g, i) => {
        if (!ship.derived.alive[i]) return;
        for (const [x, y] of g.polygon) {
          box.x0 = Math.min(box.x0, (x - cx) * cs); box.x1 = Math.max(box.x1, (x - cx) * cs);
          box.y0 = Math.min(box.y0, (y - cy) * cs); box.y1 = Math.max(box.y1, (y - cy) * cs);
        }
      });
      if (!Number.isFinite(box.x0)) Object.assign(box, { x0: -cs, y0: -cs, x1: cs, y1: cs });
      const entity = {
        id, type: EntityType.ShipBody, x: 0, y: 0, angle: 0, vx: 0, vy: 0, renderX: 0, renderY: 0, renderAngle: -Math.PI / 2,
        hp: 1, maxHp: 1, data: faction >= 0 ? [3, 0, 0, faction] : [1],
      } as InterpolatedEntity;
      // Engines driven the way most of them push (forward, for a ship)
      let fx = 0, fy = 0;
      for (const t of ship.derived.thrusters) { const f = Math.hypot(t.force[0], t.force[1]) || 1; fx += t.force[0] / f; fy += t.force[1] / f; }
      const fwd = ship.derived.thrusters.some((t) => t.force[1] < -1e-6);
      const thrust: [number, number] = fwd || !ship.derived.thrusters.length ? [0, -1] : [fx / (Math.hypot(fx, fy) || 1), fy / (Math.hypot(fx, fy) || 1)];
      const item: Item = { id, ref, ship, geoms, entity, box, thrust };
      if (this.p.labels && refs.length > 1) {
        item.label = new Text({ text: refLabel(ref, this.data.assets), style: LABEL, resolution: 4 });
        item.label.anchor.set(0.5, 0);
        this.labelLayer.addChild(item.label);
      }
      this.items.push(item);
      this.bodies.set(id, ship);
      this.state.entities.set(id, entity);
    }
    this.layout();
    this.drawGrids();
    this.info = `${this.items.length} shown${missing.length ? ` · not found: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}` : ''}`;
  }

  /** Sheets: a grid of cells as big as the biggest (in turn, by radius); one alone at the origin */
  private layout(): void {
    const n = this.items.length;
    if (!n) return;
    const cs = this.data.tuning.cellSize;
    // (cells as big as the biggest hull's box, each hull centred in its own; columns to suit the view's shape)
    const label = this.p.labels && n > 1 ? cs * 1.6 : 0;
    const cw = Math.max(...this.items.map((i) => i.box.x1 - i.box.x0)) + cs * 1.6;
    const ch = Math.max(...this.items.map((i) => i.box.y1 - i.box.y0)) + cs * 1.6 + label;
    const aspect = this.size.w / Math.max(1, this.size.h);
    const cols = this.p.cols ?? Math.max(1, Math.min(n, Math.round(Math.sqrt((n * aspect * ch) / cw))));
    const rows = Math.ceil(n / cols);
    this.items.forEach((it, k) => {
      const bx = (it.box.x0 + it.box.x1) / 2, by = (it.box.y0 + it.box.y1) / 2;
      const x = n === 1 ? 0 : ((k % cols) - (cols - 1) / 2) * cw - bx;
      const y = n === 1 ? 0 : (Math.floor(k / cols) - (rows - 1) / 2) * ch - by - label / 2;
      Object.assign(it.entity, { x, y, renderX: x, renderY: y });
    });
  }

  /** Where a label goes: under its hull as turned, a little clear of its barrels and bells */
  private labelY(it: Item): number {
    const a = (this.p.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), { x0, y0, x1, y1 } = it.box;
    return it.entity.y + Math.max(...[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => x * s + y * c)) + this.data.tuning.cellSize * 1.0;
  }

  /** The grid over each hull: its cells' lines, in its own frame */
  private drawGrids(): void {
    const cs = this.data.tuning.cellSize;
    for (const it of this.items) {
      const g = new Graphics();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const gm of it.geoms) {
        x0 = Math.min(x0, Math.floor(gm.bbox.minX)); y0 = Math.min(y0, Math.floor(gm.bbox.minY));
        x1 = Math.max(x1, Math.ceil(gm.bbox.maxX)); y1 = Math.max(y1, Math.ceil(gm.bbox.maxY));
      }
      if (!Number.isFinite(x0)) continue;
      x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
      const [cx, cy] = it.ship.derived.com;
      const X = (v: number) => (v - cx) * cs, Y = (v: number) => (v - cy) * cs;
      for (let x = x0; x <= x1; x++) g.moveTo(X(x), Y(y0)).lineTo(X(x), Y(y1));
      for (let y = y0; y <= y1; y++) g.moveTo(X(x0), Y(y)).lineTo(X(x1), Y(y));
      g.stroke({ color: 0x7fd4ff, width: 1, alpha: 0.28, pixelLine: true });
      // (the grid's origin, and the centre of mass)
      g.circle(X(0), Y(0), cs * 0.08).fill({ color: 0x7fd4ff, alpha: 0.7 });
      g.circle(0, 0, cs * 0.12).stroke({ color: 0xffd27f, width: 1, alpha: 0.9, pixelLine: true });
      it.grid = g;
      this.gridLayer.addChild(g);
    }
  }

  /** The content's extent at the current heading (world units) */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    const a = (this.p.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const cs = this.data.tuning.cellSize;
    for (const it of this.items) {
      // (room for barrels and bells round the hull, and behind it for the flames)
      let { x0, y0, x1, y1 } = it.box;
      x0 -= cs * 0.6; y0 -= cs * 0.6; x1 += cs * 0.6; y1 += cs * 0.6;
      if (this.p.flames > 0 && it.ship.derived.thrusters.length) {
        const plume = cs * (1.5 + 3.5 * this.p.flames) * (this.p.boost ? 1.7 : 1);
        const [tx, ty] = it.thrust;
        if (tx > 0.5) x0 -= plume; if (tx < -0.5) x1 += plume; if (ty > 0.5) y0 -= plume; if (ty < -0.5) y1 += plume;
      }
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
        const wx = it.entity.x + x * c - y * s, wy = it.entity.y + x * s + y * c;
        b.x0 = Math.min(b.x0, wx); b.x1 = Math.max(b.x1, wx); b.y0 = Math.min(b.y0, wy); b.y1 = Math.max(b.y1, wy);
      }
      if (it.label) b.y1 = Math.max(b.y1, this.labelY(it) + this.data.tuning.cellSize * 0.9);
    }
    if (!Number.isFinite(b.x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
    return b;
  }

  /** The zoom that fits it all (a margin round it) */
  fitZoom(): number {
    const b = this.bounds();
    const m = 1.18;
    return Math.max(0.01, Math.min(this.size.w / ((b.x1 - b.x0) * m || 1), this.size.h / ((b.y1 - b.y0) * m || 1)));
  }

  private command(id: number): ThrustCommand | null {
    const it = this.items.find((i) => i.id === id);
    const k = this.p.flames;
    return { dir: it ? [it.thrust[0] * k, it.thrust[1] * k] : [0, 0], turn: 0, boost: this.p.boost };
  }

  // ---- each frame

  private applyLight(): void {
    const p = this.p, L = LIGHT_PRESETS[p.light], lt = this.lighting;
    lt.enabled = !L.off;
    const lw = lightWith(L, p);
    lt.ambient = lw.ambient as Rgb;
    const dir = ((p.lightDir ?? L.dir) * Math.PI) / 180;
    // (far off, so it lights the whole view from one way, as a surface's sun does)
    Object.assign(lt.sun, {
      x: this.cam.x + Math.sin(dir) * 1e8, y: this.cam.y - Math.cos(dir) * 1e8, falloff: 1e9,
      power: p.lightPower ?? L.power, color: lw.color as Rgb, elevation: p.elevation ?? L.elevation,
    });
  }

  private applyBackground(): void {
    const p = this.p, bg = this.app.renderer.background;
    this.sky.container.visible = p.bg === 'starfield';
    bg.color = p.bg === 'dark' ? FLAT_DARK : 0x000000;
    bg.alpha = p.bg === 'transparent' ? 0 : 1;
    if (p.bg === 'starfield' && this.skyKey !== p.sky) {
      this.skyKey = p.sky;
      this.sky.setBiome(skyBiome(p.sky, (BIOME_KINDS as readonly string[]).includes(p.sky) ? { biome: p.sky } : {}));
    }
  }

  private lastT = 0;

  /** One frame: pose, light, draw */
  frame(): void {
    const now = performance.now();
    const dt = this.lastT ? Math.min(100, now - this.lastT) : 16;
    this.lastT = now;
    const p = this.p;
    this.cam.zoom = p.zoom === 'fit' ? this.fitZoom() : p.zoom;
    const b = this.bounds();
    this.cam.x = (b.x0 + b.x1) / 2 + p.x;
    this.cam.y = (b.y0 + b.y1) / 2 + p.y;
    const { w, h } = this.size, z = this.cam.zoom;
    this.world.scale.set(z);
    this.world.position.set(w / 2 - this.cam.x * z, h / 2 - this.cam.y * z);
    this.applyBackground();
    this.applyLight();
    this.bloom.enabled = p.bloom;
    this.ships.glowLayers()[1].visible = p.exhaust;
    const angle = (p.angle * Math.PI) / 180;
    for (const it of this.items) {
      const s = it.ship;
      it.entity.renderAngle = it.entity.angle = angle - Math.PI / 2;
      this.ships.setHeat(it.id, p.heat);
      // Damage: each part a seeded share of it (never quite gone: the structure stays as built)
      let seed = (p.seed * 2654435761 + it.id * 97) >>> 0;
      const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x6d2b79f5) >>> 0) / 4294967296);
      for (let i = 0; i < s.hp.length; i++) s.hp[i] = s.maxHp[i] * Math.max(0.02, 1 - p.damage * (0.35 + 0.65 * rnd()));
      // Turrets: at rest, or all aimed one way (as far round as each can turn)
      for (const wpn of s.derived.weapons) {
        if (!wpn.window) continue;
        if (p.aim === null) { s.aim[wpn.part] = 0; continue; }
        let off = (p.aim * Math.PI) / 180 - Math.PI / 2 - wpn.window.center;
        off = Math.atan2(Math.sin(off), Math.cos(off));
        s.aim[wpn.part] = Math.max(-wpn.window.half, Math.min(wpn.window.half, off));
      }
      if (it.grid) { it.grid.visible = p.grid; it.grid.position.set(it.entity.x, it.entity.y); it.grid.rotation = angle; }
      if (it.label) {
        it.label.position.set(it.entity.x, this.labelY(it));
        it.label.scale.set(1 / z);
      }
    }
    this.ships.update();
    if (p.bg === 'starfield') this.sky.update(dt, this.cam.x, this.cam.y, z, 0);
    this.lighting.frame({ x: this.cam.x, y: this.cam.y, r: Math.hypot(w, h) / 2 / z });
    this.bloom.render();
    this.app.render();
    this.since.frames++;
  }

  /** Every hull built (a boss's comes from the hull worker), faded in, engines spooled up */
  get settled(): boolean {
    const views = (this.ships as unknown as { views: Map<number, { hullKey: string; fade: number }> }).views;
    const built = this.items.every((i) => { const v = views.get(i.id); return v && v.hullKey !== '' && v.fade >= 1; });
    return built && this.since.frames >= 12 && performance.now() - this.since.at >= 700;
  }

  async whenSettled(timeoutMs = 30000): Promise<boolean> {
    const t0 = performance.now();
    while (!this.settled) {
      if (performance.now() - t0 > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  /** The view as a PNG data URL, `scale` PNG pixels to a CSS pixel */
  snapshot(scale = this.p.scale): string {
    const r = this.app.renderer, res = r.resolution;
    this.exportScale = scale;
    r.resize(this.size.w, this.size.h, scale);
    this.frame();
    const url = (this.app.canvas as HTMLCanvasElement).toDataURL('image/png');
    this.exportScale = 1;
    r.resize(this.size.w, this.size.h, res);
    this.app.canvas.style.width = `${this.size.w}px`;
    this.app.canvas.style.height = `${this.size.h}px`;
    this.frame();
    return url;
  }

  /** The world point under a canvas point */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.cam.x + (sx - this.size.w / 2) / this.cam.zoom, y: this.cam.y + (sy - this.size.h / 2) / this.cam.zoom };
  }
}
