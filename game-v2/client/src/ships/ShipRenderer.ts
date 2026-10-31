/**
 * Draws modular ships and debris in flight: structure from a ShipSource (the
 * client's ShipStore), poses from the interpolated GameState entities.
 *
 * A hull is built once per design, set of parts still attached, colouring and
 * kind (shared by every ship like it: HULLS), at full health; damage and the
 * hit flash are data the hull shader reads (ShipBatch), so taking hits builds
 * nothing.
 */

import { Container, Graphics, GraphicsContext, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import { Lighting, LitMesh } from '../rendering/lighting/Lighting';
import { buildFrame } from './frameBuild';
import { LitGeometry } from '../rendering/lighting/LitGeometry';
import { buildSkeleton } from './skeletonBuild';
import { ShipBatch, ShipGeometry } from '../rendering/lighting/ShipBatch';
import { HullWorker } from './hullWorkerClient';
import { fromWire, type HullJob } from './hullWire';
import { buildHull, skeletonCovered, type HullBuild } from './hullBuild';
import { beam } from '../rendering/fxTextures';
import { EntityType, ShipState, SIDE_NORMAL, Side, facingEdges, isOpen, isWeaponFn, wireCells, cellKey, type Blueprint, dodgePhase, dodgeVec } from '@space-game/common';
import type { ShipSource } from './ShipStore';
import type { GameState } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import { functionColor, mix } from './shipColors';
import { ThrusterFx, ThrustCommand } from './ThrusterFx';
import { decorOf } from './partDecor';
import type { ClientFeatures } from './features/host';
import type { ShipDrawCtx } from './features/types';
import { turretHead, type GunShape } from './gunDecor';
import { cameraView } from '../rendering/cameraView';
import factionsData from '../../../data/factions.json';

/** Hostile factions' colours by index (snapshot data[3]) */
export const FACTION_COLORS = Object.values((factionsData as { factions: Record<string, { color: string }> }).factions).map((f) => parseInt(f.color.slice(1), 16));

interface BodyView {
  id: number;
  /** Over the hull: its turrets (the hull itself is a slot in a ShipBatch chunk) */
  container: Container;
  /** Headlights: 0 off … 1 on (they come on by themselves where it's dark), and their visible beam */
  lamps: number;
  beam?: Sprite;
  flames: Container;
  /** Turret heads, drawn once (when the structure changes) and turned each frame */
  guns: Container;
  turrets: Turret[];
  /** Fixed guns' barrels (under every hull, so recoil slides them in), remade with the hull; placed with the container */
  barrels: Container;
  /** A bespoke hull's frame (frameBuild.ts), under it, remade with it; placed with the container. Its glow: 0 cold .. 1 white-hot */
  frame?: { c: Container; cold?: LitMesh; hot?: LitMesh; art: LitMesh[]; shows?: { m: LitMesh; sk: number; cover: number }[] };
  heat?: number;
  /** Shots seen from it (a gun with twin barrels flashes from each in turn: barrelTip) */
  salvo?: number;
  fixed: Barrel[];
  /**
   * The structure last drawn: the ship (a new design is a new one, whose
   * rebuild count may match the old one's), its rebuild count, and the hull it
   * got (HULLS key); and the same for the turrets
   */
  ship: ShipState | null;
  rebuilds: number;
  hullKey: string;
  turretShip: ShipState | null;
  turretRebuilds: number;
  /** What the health bar shows now (it's redrawn only when that changes) */
  barKey?: string;
  /** A Burst Strafer's burst: its jets and the streak (drawDodge) */
  dodge?: Graphics;
  /** Named pilotless hulks (derelicts) get a label underneath */
  label?: Text;
  /** Its label is in the calm style (a passive hostile, unprovoked) */
  calmLabel?: boolean;
  /** Hostiles: a health bar under the label */
  bar?: Graphics;
  /** How brightly the hull flashes white from a hit (the hull shader adds it), fading fast */
  flashLevel: number;
  /** Fading in on arrival, out on leaving (0..1) */
  fade: number;
  /** When its hull was last built (ms) */
  builtAt?: number;
  /**
   * The ship the hull in its batch slot (and its barrels and frame) was built for, and the centre of mass it was built
   * about. While a new hull is built off the main thread the old one stays: shifted onto the ship's new centre (a part
   * lost), or not drawn at all if it was another ship's (a new design)
   */
  hullFor: ShipState | null;
  hullCom?: readonly number[];
  /**
   * Its power wires over the hull (in its frame: they turn with it): the dark
   * channel and the dim unpowered runs, and the lit ones (additive); what
   * they were drawn from (the ship, its rebuild, a hash of which segments are
   * lit) and when; how bright the lit ones are breathing. Every ship's are in
   * two shared layers under the turrets (one blend switch for all, not two a ship)
   */
  wires?: { g: Graphics; glow: Graphics; ship: ShipState | null; rebuilds: number; sig: number; at: number; breath: number };
  labelAlpha: number;
}

/** Seconds to fade a ship in as it arrives or out as it goes */
const FADE = 0.25;
/** Beyond the hull, how far off screen a ship still draws its engines, lamps and guns (their light reaches in) */
const OFFSCREEN_MARGIN = 600;

interface Turret {
  part: number;
  /** Its weapon's index in ship.derived.weapons (fixed while the structure is) */
  weapon: number;
  /** Its head, turned per frame: its metal (gunhouse and barrels, in their tones, tinted by light), its lit bits (lenses, coils) */
  barrel: Container;
  metal: Graphics;
  lit?: Graphics;
  /** Where it sits on the hull (relative to the centre of mass, in pixels) and the barrel's length */
  x0: number;
  y0: number;
  len: number;
  /** Its shapes (shared: GUN_LOOKS), and the dark cracks over the barrel, made once its part is hurt enough to show them */
  look: string;
  crack?: Graphics;
  /** The tints last given (only set again when they change) */
  tm: number;
  tl: number;
  /** Recoil (1 just fired, easing back to 0) and barrel heat (builds with sustained fire) */
  kick: number;
  heat: number;
}

interface Barrel {
  /** It (slid back on recoil): its metal, tinted by light, and its lit bits */
  g: Container;
  metal: Graphics;
  lit?: Graphics;
  /** Its part, its shapes (shared: GUN_LOOKS), and the dark cracks over it (made once the part is hurt enough to show them) */
  part: number;
  look: string;
  crack?: Graphics;
  tm: number;
  tl: number;
  /** Base position (the edge it pokes out of), outward normal, length */
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  len: number;
  kick: number;
  heat: number;
  debris: boolean;
}

/** How far a barrel slides back when it fires (fraction of its length), and how fast it returns and cools (per 60 Hz frame) */
const RECOIL = 0.28;
const RECOIL_RETURN = 1 / 9;
const HEAT_PER_SHOT = 0.22;
/** Guns' metal is drawn in its own tones; tinted by light, damage and heat (blocked turrets darker) */
const GUN_TINT = 0xffffff, GUN_BLOCKED = 0x8f8582;
/**
 * A gun's look, drawn once and shared by every gun like it (each ship's own Graphics over the same contexts): its metal
 * and, if it has any, its lit bits (each in its own colours), and the cracks over its outline. Counted out and back
 * (gunLook / dropGun); the last GUNS_IDLE_KEPT that no ship uses are kept, older ones destroyed.
 */
interface GunLook { metal: GraphicsContext; lit?: GraphicsContext; crack: GraphicsContext; uses: number }
const GUN_LOOKS = new Map<string, GunLook>();
const GUNS_IDLE = new Set<string>();
const GUNS_IDLE_KEPT = 128;
const destroyLook = (l: GunLook) => { l.metal.destroy(); l.lit?.destroy(); l.crack.destroy(); };
/** A gun's look by its key, made from its shapes and outline (scaled by k) the first time */
function gunLook(key: string, make: () => { shapes: readonly GunShape[]; outline: readonly number[][]; k: number }): GunLook {
  let look = GUN_LOOKS.get(key);
  if (!look) {
    const { shapes, outline, k } = make();
    const metal = new GraphicsContext();
    let lit: GraphicsContext | undefined;
    for (const s of shapes) {
      const g = s.glow ? (lit ??= new GraphicsContext()) : metal;
      g.poly(k === 1 ? s.pts : s.pts.map((v) => v * k)).fill({ color: s.color });
    }
    const crack = new GraphicsContext();
    for (const o of outline) crack.poly(k === 1 ? o : o.map((v) => v * k)).fill({ texture: crackTexture(), color: 0xffffff });
    GUN_LOOKS.set(key, (look = { metal, lit, crack, uses: 0 }));
  }
  look.uses++;
  GUNS_IDLE.delete(key);
  return look;
}
function dropGun(key: string): void {
  const look = GUN_LOOKS.get(key);
  if (!look || --look.uses > 0) return;
  GUNS_IDLE.add(key);
  for (const k of GUNS_IDLE) {
    if (GUNS_IDLE.size <= GUNS_IDLE_KEPT) break;
    GUNS_IDLE.delete(k);
    destroyLook(GUN_LOOKS.get(k)!);
    GUN_LOOKS.delete(k);
  }
}
/** Every gun look no ship is using, destroyed now */
function flushGuns(): void {
  for (const k of GUNS_IDLE) { destroyLook(GUN_LOOKS.get(k)!); GUN_LOOKS.delete(k); }
  GUNS_IDLE.clear();
}
/** A gun's Graphics over its shared look, in a container (cracks come later, if it's hurt) */
function gunGraphics(look: GunLook): { c: Container; metal: Graphics; lit?: Graphics } {
  const c = new Container(), metal = new Graphics(look.metal), lit = look.lit ? new Graphics(look.lit) : undefined;
  c.addChild(metal);
  if (lit) c.addChild(lit);
  return { c, metal, lit };
}
/** A gun's cracks, shown by how hurt its part is (`f` its health; made the first time they show) */
function showCracks(gun: { crack?: Graphics; look: string }, holder: Container, f: number): void {
  const a = crackShow(f);
  if (a <= 0) { if (gun.crack) gun.crack.visible = false; return; }
  if (!gun.crack) gun.crack = holder.addChild(new Graphics(GUN_LOOKS.get(gun.look)!.crack));
  gun.crack.alpha = a;
  gun.crack.visible = true;
}
/** A gun's Graphics and holder destroyed (its shared look kept for others), its look given back */
function disposeGun(gun: { metal: Graphics; lit?: Graphics; crack?: Graphics; look: string }, holder: Container): void {
  gun.metal.destroy(); gun.lit?.destroy(); gun.crack?.destroy();
  holder.destroy();
  dropGun(gun.look);
}
/** Each design's number (a fixed gun's look is keyed by its design, part and barrel; the hull worker keeps designs by
 * it): a design changed in place gets a new one (ShipRenderer.refresh) */
const DESIGN_NO = new WeakMap<Blueprint, number>();
let designs = 0;
const designNo = (bp: Blueprint) => { let n = DESIGN_NO.get(bp); if (n === undefined) DESIGN_NO.set(bp, (n = ++designs)); return n; };
/** The smallest a cell is on screen (px) for guns to be drawn */
const GUN_MIN_PX = 3;
const HEADLIGHT = 0xfff0d6;
/** Power wires: lit, live with nothing to run them, their channel; and the smallest a cell is on screen (px) for them to show */
const WIRE_LIT = 0x8fe3ff, WIRE_DIM = 0x3c5566, WIRE_DARK = 0x10141c;
const WIRE_MIN_PX = 5;
/** On NPC ships (hostiles, traffic), only from this close in */
const NPC_WIRE_MIN_PX = 9;
/** Headlights come on below this much ambient and sunlight */
const LAMPS_BELOW = 0.5;

/** Built hulls by design, then by which parts are attached, colouring and kind (the last few of each design: a boss's
 * hull is built again as each part breaks, and one is a lot of geometry) */
const HULLS = new WeakMap<Blueprint, Map<string, HullBuild>>();
const HULLS_KEPT = 6;
/** A big hull (a boss's) is built at most this often (ms: parts breaking together, one build) */
const BIG_HULL = 60, BUILD_EVERY = 200;
/**
 * A rigid design's (a boss's: Blueprint `rigid`) skeletons, built once and cut into what each part over them covers
 * (hullBuild skeletonCovered): by skeleton part, each piece with the part it's shown once gone (-1: always)
 */
const BONES = new WeakMap<Blueprint, { sk: number; cover: number; g: LitGeometry }[]>();
/** Built once and kept whatever comes off: its parts shown and hidden as they go (ShipBatch `dep`) */
const isRigid = (ship: ShipState) => !!ship.blueprint.rigid && ship.kind === 'ship';
/** Hulls asked of the hull worker (by design, then hull key), and designs it couldn't build (built here instead) */
const ASKED = new WeakMap<Blueprint, Set<string>>();
const BUILD_HERE = new WeakSet<Blueprint>();
/** The centre of mass each hull was built about (one built for parts since lost is drawn shifted onto the new centre) */
const BUILT_COM = new WeakMap<HullBuild, ShipState["derived"]["com"]>();

/** Dark branching cracks on clear (laid over guns' barrels as their part is hurt), made once */
let cracks: Texture | null = null;
function crackTexture(): Texture {
  if (cracks) return cracks;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  x.strokeStyle = 'rgba(0,0,0,0.9)';
  x.lineCap = 'round';
  const crack = (px: number, py: number, a: number, len: number, w: number, depth: number): void => {
    for (let i = 0; i < 8 && len > 2; i++) {
      const nx = px + Math.cos(a) * len, ny = py + Math.sin(a) * len;
      x.lineWidth = w;
      x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
      if (depth < 2 && rnd() < 0.35) crack(nx, ny, a + (rnd() < 0.5 ? 0.7 : -0.7), len * 0.7, w * 0.7, depth + 1);
      px = nx; py = ny; a += (rnd() - 0.5) * 0.9; len *= 0.85;
    }
  };
  for (let k = 0; k < 7; k++) crack(rnd() * 128, rnd() * 128, rnd() * Math.PI * 2, 10 + rnd() * 8, 1.6 + rnd(), 0);
  return (cracks = Texture.from(c));
}
/** How much of a gun's cracks show at this health (none until it's taken a little) */
const crackShow = (f: number) => Math.max(0, Math.min(1, (0.88 - f) / 0.6));
/** A colour darkened towards ember red as its part is hurt (as the hull shader does) */
const hurt = (c: number, f: number) => mix(0x3a0d08, c, 0.35 + 0.65 * Math.min(1, f));

/** A colour under light (per channel, up to 1.6) */
function shade(c: number, l: [number, number, number]): number {
  const f = (v: number, k: number) => Math.min(255, Math.round(v * k));
  return (f((c >> 16) & 255, l[0]) << 16) | (f((c >> 8) & 255, l[1]) << 8) | f(c & 255, l[2]);
}
const COOL = 1 / 130;

const LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 26, fill: 0xd9c9a3, letterSpacing: 2 });
/** Civilian traffic (snapshot data[0] = 2) */
const TRAFFIC_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 24, fill: 0x9fd8ff, letterSpacing: 2 });
/** Hostiles (data[0] = 3), and their elites */
const HOSTILE_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 24, fill: 0xff8a7a, letterSpacing: 2, fontWeight: '600' });
/** Hostiles that'll leave you be (a passive pack nobody's provoked: data[9] = 1) */
const CALM_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 24, fill: 0xb4bcc8, letterSpacing: 2 });
const ELITE_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 26, fill: 0xffc857, letterSpacing: 2, fontWeight: '700' });
/** Bosses (data[4] = 2): their health is the big bar at the top */
const BOSS_LABEL_STYLE = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 40, fill: 0xffcf7a, letterSpacing: 8, fontWeight: '800', dropShadow: { color: 0xff6a1a, blur: 12, distance: 0, alpha: 0.8 } });

export class ShipRenderer {
  private views = new Map<number, BodyView>();
  private layer: Container;
  private engines: ThrusterFx;
  private lastFrame = 0;
  private flamesLayer = new Container();
  /** Under the hulls (fixed barrels), the hulls in a few draws, then over them (flashes, turrets) */
  private underLayer = new Container();
  private hulls: ShipBatch;
  private overLayer = new Container();
  /** Ships gone from the world, fading out where they were last seen */
  private leaving: BodyView[] = [];

  constructor(
    private bridge: ShipSource,
    private renderer: Renderer,
    private state: GameState,
    /** The pilot's thrust command for a ship we fly (null: infer it from the ship's motion) */
    private thrustCommand: (id: number) => ThrustCommand | null,
    /** Ships not to draw (docked: inside their station) */
    private hidden: (id: number) => boolean = () => false,
    /** Part features' ship drawing (features/host.ts) */
    private features?: ClientFeatures,
  ) {
    this.layer = new Container();
    renderer.getShipLayer().addChild(this.layer);
    this.engines = new ThrusterFx(this.layer, bridge);
    // Every ship's flames in one layer under the hulls: one additive batch, not a blend switch per ship
    this.layer.addChild(this.flamesLayer);
    this.lighting = renderer.lighting;
    this.hulls = new ShipBatch(this.lighting, bridge.tuning.cellSize);
    this.layer.addChild(this.underLayer, this.hulls.container, this.overLayer);
    // Every ship's wires under every ship's turrets: the channels, then the lit runs (one additive run for them all)
    this.wireGlowLayer.blendMode = 'add';
    this.overLayer.addChild(this.wireLayer, this.wireGlowLayer);
    this.lighting.addSource(this.lights);
  }

  private wireLayer = new Container();
  /** The one ctx every feature draw gets (fields reset per ship: no allocation per frame) */
  private featureCtx = {} as ShipDrawCtx;
  private geometryOf = (ship: ShipState) => this.bridge.geometry(ship);
  private wireGlowLayer = new Container();
  private lights = (L: Lighting) => this.collectLights(L);
  private destroyed = false;

  /**
   * Everything it made let go: every ship's view (hull slots, guns, wires, frames, labels), the hull worker, its batch's
   * GPU geometry and textures, its light source, its layers, and the gun looks no one else is using
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [id, view] of this.views) { this.engines.forget(id); this.renderer.shipRadius.delete(id); this.dispose(view); }
    for (const view of this.leaving) this.dispose(view);
    this.views.clear();
    this.leaving.length = 0;
    this.builder.terminate();
    this.lighting.removeSource(this.lights);
    this.hulls.destroy();
    this.layer.destroy({ children: true });
    this.blown.clear();
    this.heats.clear();
    flushGuns();
  }

  private lighting: Lighting;
  private lvl: [number, number, number] = [1, 1, 1];

  /**
   * Ships' own lights: engines; and where it's dark, headlights (a beam ahead)
   * and a faint light over the hull so a ship can always see itself.
   */
  private collectLights(L: Lighting): void {
    this.engines.collectLights(L);
    for (const [eid, view] of this.views) {
      if (view.lamps <= 0.01) continue;
      const e = this.state.entities.get(eid), ship = this.bridge.bodies.get(eid);
      if (!e || !ship) continue;
      const fx = Math.cos(e.renderAngle), fy = Math.sin(e.renderAngle), r = ship.derived.radius;
      L.cone(e.renderX + fx * r * 0.9, e.renderY + fy * r * 0.9, fx, fy, HEADLIGHT, 1500 + r * 4, 1.5 * view.lamps, 0.4, 45);
      L.point(e.renderX, e.renderY, 0xd6e2ff, r * 2.4 + 60, 0.5 * view.lamps, r);
    }
  }

  /**
   * A shot left a gun at (x, y): the turret it came from (the one whose muzzle
   * is nearest) recoils and warms up.
   */
  kick(owner: number, x: number, y: number): void {
    const view = this.views.get(owner);
    if (!view || (!view.turrets.length && !view.fixed.length)) return;
    const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
    let best: { kick: number; heat: number; len: number } | null = null, bestD = Infinity;
    const near = (g: { kick: number; heat: number; len: number }, tx: number, ty: number) => {
      const d = Math.hypot(c.x + tx * cos - ty * sin - x, c.y + tx * sin + ty * cos - y);
      if (d < bestD) { bestD = d; best = g; }
    };
    for (const t of view.turrets) near(t, t.x0 + Math.cos(t.barrel.rotation) * t.len, t.y0 + Math.sin(t.barrel.rotation) * t.len);
    for (const b of view.fixed) near(b, b.x0 + b.nx * b.len, b.y0 + b.ny * b.len);
    const hit = best as { kick: number; heat: number; len: number } | null;
    if (!hit || bestD > hit.len + 40) return;
    hit.kick = 1;
    hit.heat = Math.min(1, hit.heat + HEAT_PER_SHOT);
  }

  /**
   * Where a shot leaving (x, y) along `angle` comes out of its gun as drawn:
   * the tip of the barrel it left by (a fixed gun's barrels poke out past the
   * facing edge where shells spawn; twin barrels take turns; a turret's barrel
   * ends where its shells do). Null if no barrel of the ship's fits.
   */
  barrelTip(owner: number, x: number, y: number, angle: number): { x: number; y: number } | null {
    const view = this.views.get(owner);
    if (!view || (!view.turrets.length && !view.fixed.length)) return null;
    const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
    const ax = Math.cos(angle), ay = Math.sin(angle);
    const world = (tx: number, ty: number) => [c.x + tx * cos - ty * sin, c.y + tx * sin + ty * cos];
    const fits: { d: number; tip: number[] }[] = [];
    for (const b of view.fixed) {
      if (b.debris) continue;
      // Pointing (about) the way the shot went, from the edge it spawned on
      const nx = b.nx * cos - b.ny * sin, ny = b.nx * sin + b.ny * cos;
      if (nx * ax + ny * ay < 0.94) continue;
      const [bx, by] = world(b.x0, b.y0);
      fits.push({ d: Math.hypot(bx - x, by - y), tip: [bx + nx * b.len, by + ny * b.len] });
    }
    for (const t of view.turrets) {
      const [tx, ty] = world(t.x0 + Math.cos(t.barrel.rotation) * t.len, t.y0 + Math.sin(t.barrel.rotation) * t.len);
      fits.push({ d: Math.hypot(tx - x, ty - y), tip: [tx, ty] });
    }
    if (!fits.length) return null;
    const best = Math.min(...fits.map((f) => f.d));
    if (best > this.bridge.tuning.cellSize * 1.6) return null;
    // Twin barrels the same way from the spawn point: each in turn
    const tied = fits.filter((f) => f.d <= best + 2);
    const pick = tied[(view.salvo = (view.salvo ?? 0) + 1) % tied.length];
    return { x: pick.tip[0], y: pick.tip[1] };
  }

  /** Headlights come on (fading in) where the ambient and the sun leave it dark; their beam shows faintly */
  private updateLamps(view: BodyView, ship: ShipState, e: { renderX: number; renderY: number; renderAngle: number }, dt: number): void {
    const env = this.lighting.envAt(e.renderX, e.renderY);
    const want = ship.kind === 'ship' && this.lighting.enabled && env < LAMPS_BELOW ? 1 : 0;
    view.lamps += (want - view.lamps) * Math.min(1, dt * 2.5);
    if (view.lamps < 0.02) { if (view.beam) view.beam.visible = false; return; }
    if (!view.beam) {
      view.beam = new Sprite(beam());
      view.beam.anchor.set(0, 0.5);
      view.beam.tint = HEADLIGHT;
      this.flamesLayer.addChild(view.beam);
    }
    const r = ship.derived.radius, len = 1500 + r * 4;
    const fx = Math.cos(e.renderAngle), fy = Math.sin(e.renderAngle);
    view.beam.visible = true;
    view.beam.position.set(e.renderX + fx * r * 0.9, e.renderY + fy * r * 0.9);
    view.beam.rotation = e.renderAngle;
    view.beam.scale.set(len / 256, (len * Math.tan(0.4) * 2) / 128);
    view.beam.alpha = 0.1 * view.lamps * Math.max(0.3, 1 - env / LAMPS_BELOW);
  }

  /** Build a ship's hull and turrets afresh next frame, not from the cache (leaving a station: whatever was changed there shows) */
  refresh(id: number): void {
    const ship = this.bridge.bodies.get(id);
    // (its design may have been changed in place: a new number, so its fixed guns' looks and the worker's copy are made
    // afresh, and an answer still on its way from the worker is dropped)
    if (ship) { HULLS.delete(ship.blueprint); ASKED.delete(ship.blueprint); DESIGN_NO.delete(ship.blueprint); }
    const view = this.views.get(id);
    if (view) { view.ship = null; view.turretShip = null; view.hullKey = ''; }
  }

  /**
   * A ship took damage: its hull flashes (harder for bigger hits; a big hull
   * far less: one shot doesn't light up a whole boss, and a stream of them
   * would leave it flickering white)
   */
  hit(id: number, amount: number): void {
    const view = this.views.get(id);
    if (!view) return;
    const r = view.ship?.derived.radius ?? 0, big = Math.min(1, Math.pow(160 / Math.max(160, r), 1.4));
    view.flashLevel = Math.max(view.flashLevel, Math.min(0.75, 0.3 + amount / 80) * big);
  }

  /** Engine flames and exhaust (for the bloom) */
  glowLayers(): Container[] {
    return [this.flamesLayer, this.engines.exhaustLayer];
  }

  update(): void {
    const cs = this.bridge.tuning.cellSize;
    const seen = new Set<number>();
    this.renderer.hiddenEntityIds = seen;
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.engines.beginFrame(dt);
    this.hulls.begin();
    // (Part features' once-a-frame setup: a Tow Beam's tethers are one graphics, cleared here and drawn afresh by each ship's draw)
    this.features?.beginFrame(this.layer);

    for (const [eid, ship] of this.bridge.bodies) {
      const entity = this.state.entities.get(eid);
      if (!entity) continue;
      seen.add(eid);
      let view = this.views.get(eid);
      if (!view) {
        view = { id: eid, container: new Container(), flames: new Container(), guns: new Container(), turrets: [], ship: null, turretShip: null, turretRebuilds: -1, rebuilds: -1, hullKey: '', flashLevel: 0,
          barrels: new Container(), fixed: [], lamps: 0, fade: 0, labelAlpha: 1, hullFor: null };
        view.container.addChild(view.guns);
        this.flamesLayer.addChild(view.flames);
        this.underLayer.addChild(view.barrels);
        this.overLayer.addChild(view.container);
        this.views.set(eid, view);
      }
      // Docked: inside the station, out of sight
      const away = this.hidden(eid);
      // Off screen, with room for its light to reach in: no hull, engine, lamp or gun work this frame (below). Each part's
      // visibility is set once a frame, as it'll be drawn: a change, even one undone, has Pixi rebuild the scene's draw list
      const shown = !away && (eid === this.state.playerId || this.renderer.inView(entity.renderX, entity.renderY, ship.derived.radius + OFFSCREEN_MARGIN));
      view.container.visible = view.flames.visible = shown;
      // (too small on screen to see a gun: see drawTurrets)
      view.barrels.visible = shown && cs * this.renderer.getZoom() >= GUN_MIN_PX;
      if (view.frame) view.frame.c.visible = !away;
      if (view.label) view.label.visible = shown;
      if (view.bar) view.bar.visible = shown;
      if (away) {
        view.lamps = 0;
        if (view.beam) view.beam.visible = false;
        if (view.wires) view.wires.g.visible = view.wires.glow.visible = false;
        continue;
      }
      const hostile = entity.type === EntityType.ShipBody && entity.data?.[0] === 3;
      // Hostiles wear their faction's colours; pilots their own paint
      const tint = hostile ? FACTION_COLORS[entity.data?.[3] ?? -1] : ship.blueprint.paint ? parseInt(ship.blueprint.paint.slice(1), 16) : undefined;
      this.renderer.shipRadius.set(eid, ship.derived.radius);
      this.hulls.track(eid, entity.renderX, entity.renderY);
      // A boss's hull is built off the main thread from the moment its body arrives, on screen or not: ready by the time it's seen
      if (isRigid(ship)) this.ask(ship, cs, tint);
      if (!shown) {
        if (view.beam) view.beam.visible = false;
        if (view.wires) view.wires.g.visible = view.wires.glow.visible = false;
        continue;
      }
      // (fading in only once its hull's there to show: built off the main thread, it may take a frame or two)
      if (view.hullFor === ship) view.fade = Math.min(1, view.fade + dt / FADE);
      view.container.alpha = view.barrels.alpha = view.flames.alpha = view.fade;
      // Its structure (which parts are attached) only changes when it's rebuilt; damage is data (below)
      const big = ship.blueprint.parts.length >= BIG_HULL;
      if ((ship !== view.ship || ship.rebuilds !== view.rebuilds) && !(big && ship === view.ship && now - (view.builtAt ?? 0) < BUILD_EVERY)) {
        const changed = ship !== view.ship;
        view.ship = ship;
        view.rebuilds = ship.rebuilds;
        const key = this.hullKey(ship, tint);
        if (changed || key !== view.hullKey) {
          // Built off the main thread, the hull it had drawing meanwhile (asked again next frame). Built here, now, only
          // for a new design replacing one already in view (the hangar's changes on the pilot's ship), so it never blinks out
          const now2 = changed && view.hullFor !== null && !isRigid(ship);
          if (this.drawHull(view, ship, cs, tint, key, now2)) { view.hullKey = key; view.builtAt = now; } else view.rebuilds = -1;
        }
      }
      this.hulls.setDamage(eid, ship.hp, ship.maxHp, ship.detached, ship.derived.alive);
      this.engines.draw(view.flames, ship, entity, this.thrustCommand(eid), dt, cs, tint);
      // Light on the ship (for its guns, which are tinted rather than lit per vertex)
      this.lighting.levelAt(entity.renderX, entity.renderY, this.lvl);
      this.drawTurrets(view, ship, cs, dt * 60);
      this.drawWires(view, ship, cs, now, entity.type === EntityType.ShipBody && (hostile || entity.data?.[0] === 2));
      this.updateLamps(view, ship, entity, dt);
      this.drawDodge(view, ship, entity.dodge, entity.dodgeDir, cs, now);
      if (this.features?.hasDrawers) {
        const fc = this.featureCtx;
        fc.eid = eid; fc.ship = ship; fc.entity = entity; fc.container = view.container; fc.cs = cs; fc.now = now; fc.shared = this.layer; fc.geometry = this.geometryOf;
        this.features.drawShip(fc);
      }
      // Quick: most of the flash gone in ~6 frames
      if (view.flashLevel > 0) view.flashLevel = Math.max(0, view.flashLevel * Math.pow(0.7, dt * 60) - 0.01 * dt * 60);
      view.container.x = entity.renderX;
      view.container.y = entity.renderY;
      if (entity.name && entity.type !== EntityType.Player) {
        if (!view.label) {
          const style = hostile ? (entity.data?.[4] === 2 ? BOSS_LABEL_STYLE : entity.data?.[4] === 1 ? ELITE_LABEL_STYLE : HOSTILE_LABEL_STYLE) : entity.data?.[0] === 2 ? TRAFFIC_LABEL_STYLE : LABEL_STYLE;
          // Rastered at 2× so it stays crisp zoomed in
          view.label = new Text({ text: entity.name, style, resolution: 2 });
          view.label.anchor.set(0.5, 0);
          view.labelAlpha = hostile ? 0.95 : 0.75;
          this.layer.addChild(view.label);
        }
        // Calm or provoked: grey until it means you harm
        const calm = hostile && entity.data?.[9] === 1 && entity.data?.[4] !== 2;
        if (hostile && (view.calmLabel ?? false) !== calm) {
          view.calmLabel = calm;
          view.label.style = calm ? CALM_LABEL_STYLE : entity.data?.[4] === 1 ? ELITE_LABEL_STYLE : HOSTILE_LABEL_STYLE;
        }
        // Counter-scaled when zoomed out, so it stays readable
        const k = this.renderer.tagScale;
        view.label.scale.set(k);
        view.label.alpha = view.labelAlpha * view.fade;
        // Below the ship on screen, upright however the camera's rolled (helm)
        const a = cameraView.angle, below = ship.derived.radius + 24, ux = -Math.sin(a), uy = Math.cos(a);
        view.label.x = entity.renderX + ux * below;
        view.label.y = entity.renderY + uy * below;
        view.label.rotation = a;
        if (hostile && entity.data?.[4] !== 2) {
          if (!view.bar) { view.bar = new Graphics(); this.layer.addChild(view.bar); }
          const f = Math.max(0, Math.min(1, (entity.data?.[5] ?? 100) / 100));
          const sh = (entity.data?.[1] ?? 0) / 100;
          const w = 120, x0 = -w / 2;
          view.bar.position.set(view.label.x + ux * 32 * k, view.label.y + uy * 32 * k);
          view.bar.rotation = a;
          view.bar.scale.set(k);
          view.bar.alpha = view.fade;
          const key = `${f}|${sh}`;
          if (key !== view.barKey) {
            view.barKey = key;
            view.bar.clear();
            view.bar.rect(x0 - 1, -1, w + 2, 8).fill({ color: 0x000000, alpha: 0.55 });
            view.bar.rect(x0, 0, w * f, 6).fill({ color: f > 0.5 ? 0xff6b5a : f > 0.25 ? 0xffa94d : 0xff3b3b });
            if (sh > 0) view.bar.rect(x0, -4, w * sh, 3).fill({ color: 0x7dd3fc });
          }
        }
      }
      // Grid forward is -y; the engine's angle 0 is +x
      view.container.rotation = entity.renderAngle + Math.PI / 2;
      view.flames.position.set(entity.renderX, entity.renderY);
      view.flames.rotation = view.container.rotation;
      this.placeHull(view);
    }

    for (const [eid, view] of this.views) {
      if (seen.has(eid)) continue;
      this.engines.forget(eid);
      this.renderer.shipRadius.delete(eid);
      this.views.delete(eid);
      // Fade out where it was last seen (from wherever it had faded in to); hidden ones just go
      if (view.container.visible && view.fade > 0) this.leaving.push(view);
      else this.dispose(view);
    }
    let w = 0;
    for (const view of this.leaving) {
      view.fade -= dt / FADE;
      if (view.fade <= 0) { this.dispose(view); continue; }
      view.container.alpha = view.barrels.alpha = view.flames.alpha = view.fade;
      if (view.wires) { view.wires.g.alpha = view.fade; view.wires.glow.alpha = view.wires.breath * view.fade; }
      this.placeHull(view);
      if (view.label) view.label.alpha = view.labelAlpha * view.fade;
      if (view.bar) view.bar.alpha = view.fade;
      if (view.beam) view.beam.visible = false;
      this.leaving[w++] = view;
    }
    this.leaving.length = w;
    this.hulls.end(this.renderer.getZoom());
  }

  /**
   * The hull's slot follows the container (and the barrels, frame and wires with it). A hull built for parts since
   * lost (its new one still being built) is shifted onto the ship's centre of mass as it is now; one built for another
   * ship (a new design on its way) isn't drawn.
   */
  private placeHull(view: BodyView): void {
    const c = view.container, ship = view.ship;
    if (view.wires) {
      view.wires.g.position.copyFrom(c.position); view.wires.g.rotation = c.rotation;
      view.wires.glow.position.copyFrom(c.position); view.wires.glow.rotation = c.rotation;
    }
    let x = c.x, y = c.y;
    const com = ship?.derived.com, at = view.hullCom;
    if (com && at && (com[0] !== at[0] || com[1] !== at[1])) {
      const cs = this.bridge.tuning.cellSize, dx = (at[0] - com[0]) * cs, dy = (at[1] - com[1]) * cs;
      const cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
      x += dx * cos - dy * sin; y += dx * sin + dy * cos;
    }
    const mine = view.hullFor === ship;
    view.barrels.position.set(x, y);
    view.barrels.rotation = c.rotation;
    // (no hull of its own yet: nothing of it drawn, not its guns nor its flames floating without it)
    if (!mine) {
      view.barrels.visible = view.guns.visible = view.flames.visible = false;
      if (view.wires) view.wires.g.visible = view.wires.glow.visible = false;
    }
    // (built whole: what shows is what's there)
    if (ship && mine && isRigid(ship)) {
      const alive = ship.derived.alive;
      const blown = this.blown.get(view.id);
      for (const s of view.frame?.shows ?? []) s.m.mesh.visible = alive[s.sk] && (s.cover < 0 || (!alive[s.cover] && !blown?.has(s.cover)));
      for (const b of view.fixed) b.g.visible = alive[b.part];
    }
    if (view.frame) {
      view.frame.c.position.set(x, y);
      view.frame.c.rotation = c.rotation;
      view.frame.c.alpha = view.fade;
      if (!mine) view.frame.c.visible = false;
      // (its heat eases in: the glow creeping out along the girders)
      const want = this.heats.get(view.id) ?? 0;
      view.heat = (view.heat ?? 0) + (want - (view.heat ?? 0)) * 0.03;
      if (view.frame.hot) view.frame.hot.mesh.alpha = view.heat * (0.75 + 0.25 * Math.sin(performance.now() / 260 + view.id));
    }
    if (mine) this.hulls.place(view.id, x, y, c.rotation, view.fade, view.flashLevel * view.fade);
  }

  private dispose(view: BodyView): void {
    view.label?.destroy();
    view.bar?.destroy();
    view.flames.destroy({ children: true });
    this.hulls.remove(view.id);
    view.beam?.destroy();
    this.clearBarrels(view);
    view.barrels.destroy();
    this.clearTurrets(view);
    if (view.wires) { view.wires.g.destroy(); view.wires.glow.destroy(); view.wires = undefined; }
    this.disposeFrame(view);
    view.container.destroy({ children: true });
    view.hullFor = null;
  }

  /** Its fixed guns' barrels destroyed (their looks given back) */
  private clearBarrels(view: BodyView): void {
    for (const b of view.fixed) disposeGun(b, b.g);
    view.fixed = [];
  }

  /** Its turrets destroyed (their looks given back) */
  private clearTurrets(view: BodyView): void {
    for (const t of view.turrets) disposeGun(t, t.barrel);
    view.turrets = [];
  }

  /** Which built hull a ship wears: the parts attached, its colouring and kind (its design is the HULLS map it's in) */
  private hullKey(ship: ShipState, tint?: number): string {
    return `${ship.kind}|${tint ?? ''}|${isRigid(ship) ? 'whole' : ship.derived.alive.map((a) => (a ? 1 : 0)).join('')}`;
  }

  /**
   * A hull asked of the hull worker (once per design, colouring and parts attached): a rigid design's whole, from the
   * moment its body arrives; any other for the parts it has now, about its centre of mass now. Kept as if built here
   * when it comes (unless its design's been changed since: refresh)
   */
  private builder = new HullWorker();
  private ask(ship: ShipState, cs: number, tint: number | undefined, key = this.hullKey(ship, tint)): void {
    const bp = ship.blueprint;
    if (BUILD_HERE.has(bp) || HULLS.get(bp)?.has(key)) return;
    let asked = ASKED.get(bp);
    if (!asked) ASKED.set(bp, (asked = new Set()));
    if (asked.has(key)) return;
    asked.add(key);
    const whole = isRigid(ship), design = designNo(bp);
    const com: [number, number] = [ship.derived.com[0], ship.derived.com[1]];
    const job: Omit<HullJob, 'id'> = whole
      ? { blueprint: bp, cs, tint, design, whole: true, kind: 'ship' }
      : { blueprint: bp, cs, tint, design, kind: ship.kind, alive: [...ship.derived.alive], com };
    this.builder.build(job, (d) => {
      if (this.destroyed || ASKED.get(bp) !== asked) return;
      asked.delete(key);
      if (!d) { BUILD_HERE.add(bp); return; }
      // (changed in place since it was asked: refresh)
      if (DESIGN_NO.get(bp) !== design) return;
      let byKey = HULLS.get(bp);
      if (!byKey) HULLS.set(bp, (byKey = new Map()));
      const build: HullBuild = { hull: { full: fromWire<ShipGeometry>(d.full), far: fromWire<ShipGeometry>(d.far) }, barrels: d.barrels };
      if (!whole) BUILT_COM.set(build, com);
      byKey.set(key, build);
      for (const k of byKey.keys()) { if (byKey.size <= HULLS_KEPT) break; byKey.delete(k); }
      if (whole && !BONES.has(bp)) BONES.set(bp, d.bones.map((b) => ({ sk: b.sk, cover: b.cover, g: fromWire<LitGeometry>(b.g) })));
    });
  }

  /**
   * Its hull drawn (false: still being built by the worker; what it had stays meanwhile). `here`: build it now, on the
   * main thread, if it isn't built already (a rigid design's is always the worker's while it's working)
   */
  private drawHull(view: BodyView, ship: ShipState, cs: number, tint: number | undefined, key: string, here = false): boolean {
    let byKey = HULLS.get(ship.blueprint);
    if (!byKey) HULLS.set(ship.blueprint, (byKey = new Map()));
    let build = byKey.get(key);
    const rigid = isRigid(ship), worker = this.builder.ok && !BUILD_HERE.has(ship.blueprint);
    if (!build && worker && (rigid || !here)) { this.ask(ship, cs, tint, key); return false; }
    if (build) { byKey.delete(key); byKey.set(key, build); }
    else {
      byKey.set(key, (build = buildHull(this.bridge.catalog, this.bridge.geometry(ship), ship, cs, tint, rigid)));
      if (!rigid) BUILT_COM.set(build, [ship.derived.com[0], ship.derived.com[1]]);
      for (const k of byKey.keys()) { if (byKey.size <= HULLS_KEPT) break; byKey.delete(k); }
    }
    // (a rigid design's is drawn where it is; any other about the centre it was built about, shifted onto the ship's: placeHull)
    const com = rigid ? ship.derived.com : BUILT_COM.get(build) ?? ship.derived.com;
    view.hullFor = ship;
    view.hullCom = rigid ? undefined : com;
    // Fixed guns' barrels: each ship its own (they recoil and glow) over the looks every ship like it shares
    this.clearBarrels(view);
    const debris = ship.kind === 'debris', design = designNo(ship.blueprint);
    const nth = new Map<number, number>();
    for (const b of build.barrels) {
      const k = nth.get(b.part) ?? 0;
      nth.set(b.part, k + 1);
      const look = `b|${design}|${b.part}|${k}|${cs}`;
      const { c: bg, metal, lit } = gunGraphics(gunLook(look, () => ({ shapes: b.parts ?? [{ pts: b.pts, color: 0x8e98a7 }], outline: b.outline ?? [b.pts], k: 1 })));
      bg.position.set(b.x0, b.y0);
      metal.tint = debris ? 0x555555 : GUN_TINT;
      view.barrels.addChild(bg);
      view.fixed.push({ g: bg, metal, lit, part: b.part, look, x0: b.x0, y0: b.y0, nx: b.nx, ny: b.ny, len: b.len, kick: 0, heat: 0, debris, tm: -1, tl: -1 });
    }
    this.hulls.set(view.id, build.hull, ship.derived.radius + cs);
    // Under the hull: its frame, if it has one, and its skeleton (a boss's: what's seen as its carapace comes off);
    // remade with it (its centre moves as parts come off; a broken skeleton goes)
    this.disposeFrame(view);
    const fp = debris ? undefined : ship.blueprint.parts.map((p) => this.bridge.catalog.pieces.get(p.piece)?.frame).find((f) => f);
    const bones = ship.blueprint.parts.map((p, i) => ({ sk: this.bridge.catalog.pieces.get(p.piece)?.skeleton, i })).filter((a) => a.sk && (rigid || ship.derived.alive[a.i]));
    if (!fp && !bones.length) return true;
    const c = new Container();
    const frame: NonNullable<BodyView['frame']> = { c, art: [] };
    // Its skeleton: lit geometry, as the hull is (skeletonBuild.ts); built whole, in pieces, each bared as what's over it goes
    if (bones.length && rigid) {
      let cut = BONES.get(ship.blueprint);
      if (!cut) {
        const catalog = this.bridge.catalog, geoms = this.bridge.geometry(ship);
        const over = (i: number) => { const pc = catalog.pieces.get(ship.blueprint.parts[i].piece); return !pc?.skeleton && !pc?.under; };
        cut = bones.flatMap(({ sk, i }) => {
          const g = new LitGeometry();
          buildSkeleton(g, sk!, ship.derived.com, cs);
          return [...skeletonCovered(g, geoms, ship.derived.com, cs, over)].map(([cover, piece]) => ({ sk: i, cover, g: piece }));
        });
        BONES.set(ship.blueprint, cut);
      }
      frame.shows = [];
      for (const { sk, cover, g } of cut) {
        const lm = new LitMesh(g.toGeometry());
        lm.radius = ship.derived.radius + cs;
        c.addChild(lm.mesh);
        this.lighting.add(lm);
        frame.art.push(lm);
        frame.shows.push({ m: lm, sk, cover });
      }
    } else if (bones.length) {
      const g = new LitGeometry();
      for (const { sk } of bones) buildSkeleton(g, sk!, com, cs);
      const lm = new LitMesh(g.toGeometry());
      lm.radius = ship.derived.radius + cs;
      c.addChild(lm.mesh);
      this.lighting.add(lm);
      frame.art.push(lm);
    }
    if (fp) {
      const { cold, hot } = buildFrame(fp, com, cs);
      const coldMesh = new LitMesh(cold.toGeometry()), hotMesh = new LitMesh(hot.toGeometry());
      coldMesh.radius = hotMesh.radius = ship.derived.radius;
      hotMesh.mesh.blendMode = 'add';
      hotMesh.mesh.alpha = view.heat ?? 0;
      c.addChild(coldMesh.mesh, hotMesh.mesh);
      this.lighting.add(coldMesh);
      this.lighting.add(hotMesh);
      frame.cold = coldMesh; frame.hot = hotMesh;
    }
    this.underLayer.addChildAt(c, 0);
    view.frame = frame;
    return true;
  }

  private disposeFrame(view: BodyView): void {
    if (!view.frame) return;
    // (each mesh's geometry its own, made with it: off the GPU with it)
    const gone = (lm: LitMesh) => { this.lighting.remove(lm); const g = lm.mesh.geometry; lm.destroy(); g?.destroy(true); };
    for (const lm of view.frame.art) gone(lm);
    if (view.frame.cold) gone(view.frame.cold);
    if (view.frame.hot) gone(view.frame.hot);
    view.frame.c.destroy({ children: true });
    view.frame = undefined;
  }

  /** A boss's skeleton pieces blown away (by the part each was under: bossBlow), before the skeleton itself goes */
  private blown = new Map<number, Set<number>>();
  blow(id: number, part: number): void {
    let b = this.blown.get(id);
    if (!b) this.blown.set(id, (b = new Set()));
    b.add(part);
  }

  /** How hot a ship's frame glows (a boss's later stage): eased towards (kept while its view comes and goes) */
  private heats = new Map<number, number>();
  setHeat(id: number, k: number): void {
    this.heats.set(id, Math.max(0, Math.min(1, k)));
  }

  /**
   * A ship's power wires over its hull (wires.ts), in its own frame: a dark
   * channel along every segment still on it, lit in the power colour where it's
   * live on a network with a generator, dim where it's live but unpowered; a cut
   * one shows only its stub on what's left. Remade only when the structure
   * changes and what's lit did too (a big ship's at most every BUILD_EVERY ms):
   * a boss built whole keeps its geometry until a part breaks, and then only a
   * hash over its segments is worked out. None on debris, nor while a cell is
   * too small on screen for a wire to show (an NPC's, `npc`, from a little
   * closer in). Drawn in the shared wire layers (one blend switch for every
   * ship's), placed with the ship each frame (placeHull).
   */
  private drawWires(view: BodyView, ship: ShipState, cs: number, now: number, npc = false): void {
    const d = ship.derived;
    const show = ship.kind === 'ship' && d.wires.length > 0 && cs * this.renderer.getZoom() >= (npc ? NPC_WIRE_MIN_PX : WIRE_MIN_PX);
    let w = view.wires;
    if (!show) { if (w) w.g.visible = w.glow.visible = false; return; }
    if (!w) {
      w = view.wires = { g: new Graphics(), glow: new Graphics(), ship: null, rebuilds: -1, sig: 0, at: 0, breath: 1 };
      w.glow.blendMode = 'add';
      this.wireLayer.addChild(w.g);
      this.wireGlowLayer.addChild(w.glow);
    }
    w.g.visible = w.glow.visible = true;
    if (ship !== w.ship || ship.rebuilds !== w.rebuilds) {
      const big = ship.blueprint.parts.length >= BIG_HULL;
      if (!(big && ship === w.ship && now - w.at < BUILD_EVERY)) {
        const networks = d.networks;
        // Which segments are lit (0 cut, 1 live unpowered, 2 lit), hashed
        let sig = d.wires.length;
        for (let s = 0; s < d.wires.length; s++) sig = (Math.imul(sig, 31) + (!d.wireLive[s] ? 0 : networks[d.wireNet[s]]?.powered ? 2 : 1)) | 0;
        if (ship !== w.ship || sig !== w.sig) this.layWires(w, ship, cs);
        w.ship = ship; w.rebuilds = ship.rebuilds; w.sig = sig; w.at = now;
      }
    }
    // The channel lit as the hull is; the lit runs breathe a little
    w.g.tint = shade(0xffffff, this.lvl);
    w.breath = 0.8 + 0.2 * Math.sin(now / 320 + view.id);
    // (faded in and out with the ship, as its container is)
    w.g.alpha = view.fade;
    w.glow.alpha = w.breath * view.fade;
  }

  private layWires(w: NonNullable<BodyView['wires']>, ship: ShipState, cs: number): void {
    const d = ship.derived, [cx, cy] = d.com;
    const cells = wireCells(this.bridge.catalog, ship.blueprint);
    const live = (x: number, y: number) => cells.get(cellKey(x, y))?.some((i) => d.alive[i]) ?? false;
    const X = (v: number) => (v + 0.5 - cx) * cs, Y = (v: number) => (v + 0.5 - cy) * cs;
    const g = w.g.clear(), glow = w.glow.clear();
    let dark = false, dim = false, lit = false;
    // The channel: whole where both ends are on the ship, a stub to the break where one is
    d.wires.forEach(([x0, y0, x1, y1], s) => {
      const a = live(x0, y0), b = live(x1, y1);
      if (!a && !b) return;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      if (a && b) g.moveTo(X(x0), Y(y0)).lineTo(X(x1), Y(y1));
      else if (a) g.moveTo(X(x0), Y(y0)).lineTo(X(mx), Y(my));
      else g.moveTo(X(x1), Y(y1)).lineTo(X(mx), Y(my));
      dark = true;
    });
    if (dark) g.stroke({ color: WIRE_DARK, width: cs * 0.15, alpha: 0.9, cap: 'round' });
    // Live but on a network with nothing to run it: a faint core
    d.wires.forEach(([x0, y0, x1, y1], s) => {
      if (!d.wireLive[s] || d.networks[d.wireNet[s]]?.powered) return;
      g.moveTo(X(x0), Y(y0)).lineTo(X(x1), Y(y1));
      dim = true;
    });
    if (dim) g.stroke({ color: WIRE_DIM, width: cs * 0.05, cap: 'round' });
    // Lit: a soft halo and a bright core (a stroke takes the path it ends, so it's traced for each)
    const trace = () => d.wires.forEach(([x0, y0, x1, y1], s) => {
      if (!d.wireLive[s] || !d.networks[d.wireNet[s]]?.powered) return;
      glow.moveTo(X(x0), Y(y0)).lineTo(X(x1), Y(y1));
      lit = true;
    });
    trace();
    if (lit) {
      glow.stroke({ color: WIRE_LIT, width: cs * 0.2, alpha: 0.16, cap: 'round' });
      trace();
      glow.stroke({ color: WIRE_LIT, width: cs * 0.055, alpha: 0.95, cap: 'round' });
    }
  }

  /**
   * Turret barrels at their current aim: bright when the shot is open, dim when
   * hull is in the way. Each barrel is drawn once, in white, and only turned
   * and tinted per frame.
   */
  // ---- Burst Strafer (common/src/ships/strafer.ts)
  /**
   * A Burst Strafer's burst: from each strafer firing (those pushing the dodge's way, each by how much of its push goes
   * that way), a hot pink-white jet out of its nozzle (long at first, shrinking as the burst runs out) with a flash at
   * the mouth, and speed streaks trailing off the hull away from the dodge. Redrawn every frame while it runs (a fifth
   * of a second); nothing otherwise.
   */
  private drawDodge(view: BodyView, ship: ShipState, counter: number | undefined, dir: number | undefined, cs: number, now: number): void {
    const s = ship.derived.strafe;
    const ph = s ? dodgePhase(counter, s) : null;
    if (!s || !ph || ph.phase !== 'burst' || !dir) {
      if (view.dodge?.visible) view.dodge.visible = false;
      return;
    }
    if (!view.dodge) { view.dodge = new Graphics(); view.container.addChild(view.dodge); }
    const g = view.dodge;
    g.visible = true;
    g.clear();
    const k = 1 - ph.progress, flicker = 0.85 + 0.15 * Math.sin(now / 23);
    const [cx, cy] = ship.derived.com;
    const geoms = this.bridge.geometry(ship);
    const [ux, uy] = dodgeVec(dir);
    for (const p of s.parts) {
      const geom = geoms[p.part], f = Math.hypot(p.push[0], p.push[1]);
      const share = f > 0 ? (p.push[0] * ux + p.push[1] * uy) / f : 0;
      if (!geom || share <= 0.05) continue;
      for (const nz of decorOf(geom).nozzles) {
        const bx = (nz.at[0] - cx) * cs, by = (nz.at[1] - cy) * cs;
        const hw = (nz.width / 2) * cs * (1.1 + 0.6 * k), len = cs * (1.4 + 4.2 * k) * flicker * (0.4 + 0.6 * share);
        const tip = [bx + nz.n[0] * len, by + nz.n[1] * len];
        const l = [bx + nz.t[0] * hw, by + nz.t[1] * hw], r = [bx - nz.t[0] * hw, by - nz.t[1] * hw];
        g.poly([l[0], l[1], tip[0], tip[1], r[0], r[1]]).fill({ color: 0xf472b6, alpha: 0.75 * (0.4 + 0.6 * k) });
        const core = [bx + nz.n[0] * len * 0.6, by + nz.n[1] * len * 0.6];
        g.poly([bx + nz.t[0] * hw * 0.45, by + nz.t[1] * hw * 0.45, core[0], core[1], bx - nz.t[0] * hw * 0.45, by - nz.t[1] * hw * 0.45]).fill({ color: 0xffffff, alpha: 0.85 * k });
        g.circle(bx, by, hw * (1.3 + 1.2 * k)).fill({ color: 0xfbcfe8, alpha: 0.65 * k });
      }
    }
    // Speed streaks: off the hull's trailing side (opposite the push), fading with the burst
    const R = ship.derived.radius, nx = -uy, ny = ux;
    for (let i = -1; i <= 1; i++) {
      const o = i * R * 0.45, a = R * 0.7, b = R * 0.9 + cs * (1.5 + 3 * k);
      g.moveTo(nx * o - ux * a, ny * o - uy * a).lineTo(nx * o - ux * b, ny * o - uy * b).stroke({ width: cs * 0.14, color: 0xf9a8d4, alpha: 0.6 * k });
    }
  }

  // ---- (end Burst Strafer)

  private drawTurrets(view: BodyView, ship: ShipState, cs: number, frames: number): void {
    // (too small on screen to see a gun: none drawn, nor turned)
    const near = cs * this.renderer.getZoom() >= GUN_MIN_PX;
    view.guns.visible = near;
    view.barrels.visible &&= near;
    // (turrets only change with the structure)
    if (ship !== view.turretShip || ship.rebuilds !== view.turretRebuilds) {
      view.turretShip = ship;
      view.turretRebuilds = ship.rebuilds;
      this.clearTurrets(view);
      const [cx, cy] = ship.derived.com;
      for (const [wi, w] of ship.derived.weapons.entries()) {
        if (!w.window) continue;
        // The turret's own head (gunDecor.ts): its gunhouse and barrels, by family and model; its mount is the hull's
        const fn = ship.blueprint.parts[w.part].fn;
        // (A bespoke turret may be drawn bigger than its part: its piece's `turret` size, in cells)
        const big = this.bridge.catalog.pieces.get(ship.blueprint.parts[w.part].piece)?.turret;
        const area = big ? big * big : this.bridge.geometry(ship)[w.part]?.area ?? 1;
        const len = big ? Math.max(w.window.barrel, big * 1.1) : w.window.barrel;
        // (drawn once for every turret like it, on any ship: its look shared)
        const look = `t|${fn}|${len}|${area}|${cs}`;
        const { c: barrel, metal, lit } = gunGraphics(gunLook(look, () => ({ ...turretHead(fn, len, area), k: cs })));
        const x0 = (w.window.pivot[0] - cx) * cs, y0 = (w.window.pivot[1] - cy) * cs;
        barrel.position.set(x0, y0);
        view.guns.addChild(barrel);
        view.turrets.push({ part: w.part, weapon: wi, barrel, metal, lit, look, x0, y0, len: w.window.barrel * cs, kick: 0, heat: 0, tm: -1, tl: -1 });
      }
    }
    for (const t of near ? view.turrets : []) {
      const w = ship.derived.weapons[t.weapon];
      if (!w?.window) continue;
      const open = ship.kind === 'ship' && isOpen(w.window, ship.aim[t.part]);
      const r = w.window.center + ship.aim[t.part];
      t.barrel.rotation = r;
      // Recoil: straight back on firing, easing home
      const back = t.kick > 0 ? RECOIL * t.len * t.kick * t.kick : 0;
      t.barrel.position.set(t.x0 - Math.cos(r) * back, t.y0 - Math.sin(r) * back);
      // Lit like the hull, darker while its shot is blocked; a hot barrel glows towards amber-white whatever the light
      const tf = ship.hp[t.part] / (ship.maxHp[t.part] || 1);
      const hot = Math.min(1, t.heat * 0.85 + t.kick * 0.3);
      // (set only when it changes: a tint set marks the Graphics for re-batching)
      const tm = mix(hurt(shade(open ? GUN_TINT : GUN_BLOCKED, this.lvl), tf), 0xffd9a0, hot);
      if (tm !== t.tm) t.metal.tint = t.tm = tm;
      if (t.lit) { const tl = mix(hurt(open ? 0xffffff : 0x9a9a9a, tf), 0xffd9a0, hot); if (tl !== t.tl) t.lit.tint = t.tl = tl; }
      showCracks(t, t.barrel, tf);
      t.kick = Math.max(0, t.kick - frames * RECOIL_RETURN);
      t.heat = Math.max(0, t.heat - frames * COOL);
    }
    for (const b of view.fixed) {
      const bf = ship.hp[b.part] / (ship.maxHp[b.part] || 1);
      const hot = Math.min(1, b.heat * 0.85 + b.kick * 0.3);
      const tm = b.debris ? shade(0x555555, this.lvl) : mix(hurt(shade(GUN_TINT, this.lvl), bf), 0xffd9a0, hot);
      if (tm !== b.tm) b.metal.tint = b.tm = tm;
      if (b.lit) { const tl = b.debris ? 0x333333 : mix(hurt(0xffffff, bf), 0xffd9a0, hot); if (tl !== b.tl) b.lit.tint = b.tl = tl; }
      showCracks(b, b.g, bf);
      if (b.kick <= 0 && b.heat <= 0) continue;
      // Fixed guns slide back into the hull, and glow hot
      const back = RECOIL * 1.4 * b.len * b.kick * b.kick;
      b.g.position.set(b.x0 - b.nx * back, b.y0 - b.ny * back);
      b.kick = Math.max(0, b.kick - frames * RECOIL_RETURN);
      b.heat = Math.max(0, b.heat - frames * COOL);
      // Home and cool: settle exactly
      if (b.kick <= 0 && b.heat <= 0) b.g.position.set(b.x0, b.y0);
    }
  }
}
