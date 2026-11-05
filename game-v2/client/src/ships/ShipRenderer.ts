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
import { EntityType, ShipState, SIDE_NORMAL, Side, currentStage, facingEdges, isOpen, isWeaponFn, STATUS_SLOWED, type Blueprint, type WeaponInfo } from '@space-game/common';
import type { ShipSource } from './ShipStore';
import type { GameState, InterpolatedEntity } from '../state/GameState';
import type { Renderer } from '../rendering/Renderer';
import { functionColor, mix } from './shipColors';
import { ThrusterFx, ThrustCommand } from './ThrusterFx';
import { PartFx } from './PartFx';
import { decorOf } from './partDecor';
import type { ClientFeatures } from './features/host';
import type { ShipDrawCtx } from './features/types';
import { turretHead, type GunShape } from './gunDecor';
import { animOf, lightsLit, reloadShare, type GunAnimSpec } from './gunAnim';
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
  /** Named pilotless hulks (derelicts) get a label underneath */
  label?: Text;
  /** Its label is in the calm style (a passive hostile, unprovoked) */
  calmLabel?: boolean;
  /** Hostiles: a health bar under the label */
  bar?: Graphics;
  /** The pilot's own bank members glowing by their bank's charge (drawBankGlow), and what it last showed */
  bankGlow?: { g: Graphics; sig: number; ship: ShipState | null; rebuilds: number };
  /** How brightly the hull flashes white from a hit (the hull shader adds it), fading fast */
  flashLevel: number;
  /** Fading in on arrival, out on leaving (0..1) */
  fade: number;
  /** How much of it is drawn this frame: its fade, less what it's a ghost from far off (ghostOf: the focus grid) */
  vis?: number;
  /** When its hull was last built (ms) */
  builtAt?: number;
  /**
   * The ship the hull in its batch slot (and its barrels and frame) was built for, and the centre of mass it was built
   * about. While a new hull is built off the main thread the old one stays: shifted onto the ship's new centre (a part
   * lost), or not drawn at all if it was another ship's (a new design)
   */
  hullFor: ShipState | null;
  hullCom?: readonly number[];
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
  /** Its state-driven decor (gunAnim.ts), the Graphics it draws on and what that last showed, and a frame count for its vents */
  anim?: GunAnimSpec;
  deco?: Graphics;
  decoKey?: number;
  phase?: number;
  ventT?: number;
  reloading?: boolean;
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
  /** Where it points now: its gimbal's turn (radians, off its normal; ship.aim) and that turn's normal */
  rot: number;
  rx: number;
  ry: number;
  kick: number;
  heat: number;
  debris: boolean;
  /** Its state-driven decor (gunAnim.ts), the Graphics it draws on and what that last showed, and a frame count for its vents */
  anim?: GunAnimSpec;
  deco?: Graphics;
  decoKey?: number;
  phase?: number;
  ventT?: number;
  reloading?: boolean;
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
function disposeGun(gun: { metal: Graphics; lit?: Graphics; crack?: Graphics; deco?: Graphics; look: string }, holder: Container): void {
  gun.metal.destroy(); gun.lit?.destroy(); gun.crack?.destroy(); gun.deco?.destroy();
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
/** Where another pilot's status row keeps its weapon statuses (features.wire.json status "statuses") */
const STATUS_SLOT = 7;
const HEADLIGHT = 0xfff0d6;
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
  private partFx = new PartFx();
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
    this.lighting.addSource(this.lights);
  }

  /** Is this ship slowed by a Frostbite's beam: you from your pilot row's ticks, other pilots from their status bits (weaponry.ts STATUS_SLOWED) */
  private slowed(eid: number, e: InterpolatedEntity): boolean {
    if (eid === this.state.playerId) return (e.slowUntil ?? 0) > this.state.serverTick;
    return ((e.status?.[STATUS_SLOT] ?? 0) & STATUS_SLOWED) !== 0;
  }

  /** Is this ship EMP'd (Hush): your row carries the ticks left in data[5], everyone else's a flag in data[2] */
  private empd(e: InterpolatedEntity): boolean {
    return ((e.type === EntityType.Player ? e.data?.[5] : e.data?.[2]) ?? 0) > 0;
  }

  /** The one ctx every feature draw gets (fields reset per ship: no allocation per frame) */
  private featureCtx = {} as ShipDrawCtx;
  private geometryOf = (ship: ShipState) => this.bridge.geometry(ship);
  private lights = (L: Lighting) => this.collectLights(L);
  private destroyed = false;

  /**
   * Everything it made let go: every ship's view (hull slots, guns, frames, labels), the hull worker, its batch's
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
  kick(owner: number, x: number, y: number, power = 1): void {
    const view = this.views.get(owner);
    if (!view || (!view.turrets.length && !view.fixed.length)) return;
    const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
    let best: { kick: number; heat: number; len: number } | null = null, bestD = Infinity;
    const near = (g: { kick: number; heat: number; len: number }, tx: number, ty: number) => {
      const d = Math.hypot(c.x + tx * cos - ty * sin - x, c.y + tx * sin + ty * cos - y);
      if (d < bestD) { bestD = d; best = g; }
    };
    for (const t of view.turrets) near(t, t.x0 + Math.cos(t.barrel.rotation) * t.len, t.y0 + Math.sin(t.barrel.rotation) * t.len);
    for (const b of view.fixed) near(b, b.x0 + b.rx * b.len, b.y0 + b.ry * b.len);
    const hit = best as { kick: number; heat: number; len: number } | null;
    if (!hit || bestD > hit.len + 40) return;
    hit.kick = Math.min(1.4, power);
    hit.heat = Math.min(1, hit.heat + HEAT_PER_SHOT);
  }

  /**
   * How far the spin of the gun a shot left (x, y) from has got (0..1): your own gun's spin, another ship's how hard it is
   * being fired (its barrel heat). 0 if no gun fits.
   */
  spinAt(owner: number, x: number, y: number): number {
    const view = this.views.get(owner);
    if (!view || (!view.turrets.length && !view.fixed.length)) return 0;
    const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation);
    let best: Turret | Barrel | null = null, bestD = Infinity;
    for (const t of view.turrets) {
      const d = Math.hypot(c.x + t.x0 * cos - t.y0 * sin - x, c.y + t.x0 * sin + t.y0 * cos - y);
      if (d < bestD) { bestD = d; best = t; }
    }
    for (const b of view.fixed) {
      const d = Math.hypot(c.x + b.x0 * cos - b.y0 * sin - x, c.y + b.x0 * sin + b.y0 * cos - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return 0;
    const ship = view.ship;
    if (owner === this.state.playerId && ship) return Math.max(0, Math.min(1, ship.spin[best.part] ?? 0));
    return Math.min(1, best.heat * 1.1);
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
      // Pointing (about) the way the shot went, from the edge it spawned on (turned on its gimbal)
      const nx = b.rx * cos - b.ry * sin, ny = b.rx * sin + b.ry * cos;
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

  /**
   * How much of a ghost this ship is drawn as (0 none, 1 all: its hull goes, the ghost layer's marker stands in): the focus
   * grid draws ships from 18 km out as ghosts (CAPS.FOCUS: ShipClient sets it, common network/cells.ts ghostWeight)
   */
  ghostOf: (eid: number) => number = () => 0;

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
        // Back before it had faded out (its entity gone a moment and sent again, an id that came straight back): the
        // fading view is taken up again. A second view beside it would lose its hull when the old one finished fading,
        // the batch slot being the ship's id (hull gone for good, its guns and flames still drawn)
        view = this.takeBack(eid) ?? this.newView(eid);
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
        continue;
      }
      // (fading in only once its hull's there to show: built off the main thread, it may take a frame or two)
      if (view.hullFor === ship) view.fade = Math.min(1, view.fade + dt / FADE);
      view.vis = view.fade * (1 - this.ghostOf(eid));
      view.container.alpha = view.barrels.alpha = view.flames.alpha = view.vis;
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
      this.engines.draw(view.flames, ship, entity, this.thrustCommand(eid), dt, cs, tint, this.slowed(eid, entity) ? 1 : 0, this.empd(entity));
      // Light on the ship (for its guns, which are tinted rather than lit per vertex)
      this.lighting.levelAt(entity.renderX, entity.renderY, this.lvl);
      this.drawTurrets(view, ship, cs, dt * 60);
      this.drawBankGlow(view, ship, cs, eid === this.state.playerId);
      this.partFx.draw(view.container, view.guns, ship, this.bridge.geometry(ship), cs, now, eid === this.state.playerId ? this.state.charge : null);
      this.updateLamps(view, ship, entity, dt);
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
        view.label.alpha = view.labelAlpha * view.vis;
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
          view.bar.alpha = view.vis;
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
      // (a ghost already, dropped from the focus far off: it doesn't come back solid to fade out)
      view.vis = Math.min(view.vis ?? view.fade, view.fade);
      view.container.alpha = view.barrels.alpha = view.flames.alpha = view.vis;
      this.placeHull(view);
      if (view.label) view.label.alpha = view.labelAlpha * view.vis;
      if (view.bar) view.bar.alpha = view.vis;
      if (view.beam) view.beam.visible = false;
      this.leaving[w++] = view;
    }
    this.leaving.length = w;
    this.hulls.end(this.renderer.getZoom());
  }

  /**
   * The hull's slot follows the container (and the barrels and frame with it). A hull built for parts since
   * lost (its new one still being built) is shifted onto the ship's centre of mass as it is now; one built for another
   * ship (a new design on its way) isn't drawn.
   */
  private placeHull(view: BodyView): void {
    const c = view.container, ship = view.ship;
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
      view.frame.c.alpha = view.vis ?? view.fade;
      if (!mine) view.frame.c.visible = false;
      // (its heat eases in: the glow creeping out along the girders)
      const want = this.heats.get(view.id) ?? 0;
      view.heat = (view.heat ?? 0) + (want - (view.heat ?? 0)) * 0.03;
      if (view.frame.hot) view.frame.hot.mesh.alpha = view.heat * (0.75 + 0.25 * Math.sin(performance.now() / 260 + view.id));
    }
    const vis = view.vis ?? view.fade;
    if (mine) this.hulls.place(view.id, x, y, c.rotation, vis, view.flashLevel * vis);
  }

  /** A ship's view, empty (its hull, guns and flames come as it's drawn) */
  private newView(eid: number): BodyView {
    const view: BodyView = { id: eid, container: new Container(), flames: new Container(), guns: new Container(), turrets: [], ship: null, turretShip: null, turretRebuilds: -1, rebuilds: -1, hullKey: '', flashLevel: 0,
      barrels: new Container(), fixed: [], lamps: 0, fade: 0, labelAlpha: 1, hullFor: null };
    view.container.addChild(view.guns);
    this.flamesLayer.addChild(view.flames);
    this.underLayer.addChild(view.barrels);
    this.overLayer.addChild(view.container);
    return view;
  }

  /** A view of this ship still fading out, taken off the leaving list (it fades back in from where it had got to) */
  private takeBack(eid: number): BodyView | undefined {
    const i = this.leaving.findIndex((v) => v.id === eid);
    return i < 0 ? undefined : this.leaving.splice(i, 1)[0];
  }

  private dispose(view: BodyView): void {
    view.label?.destroy();
    view.bar?.destroy();
    view.flames.destroy({ children: true });
    // (The batch slot is the ship's id: not taken from another view of it that's live now)
    const live = this.views.get(view.id);
    if (!live || live === view) this.hulls.remove(view.id);
    view.beam?.destroy();
    this.clearBarrels(view);
    view.barrels.destroy();
    this.clearTurrets(view);
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
      view.fixed.push({ g: bg, metal, lit, part: b.part, look, x0: b.x0, y0: b.y0, nx: b.nx, ny: b.ny, len: b.len, rot: 0, rx: b.nx, ry: b.ny, kick: 0, heat: 0, debris, tm: -1, tl: -1, anim: debris ? undefined : animOf(ship.blueprint.parts[b.part].fn) });
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

  /**
   * Where a boss's laid-open pieces are drawn now (world): of `byStage` (bosses.json `exposed`), the list for the stage
   * it's fighting, standing pieces only (its window's effect rides them: BossFx)
   */
  exposedAt(id: number, byStage: readonly (readonly string[])[]): { x: number; y: number }[] {
    const ship = this.bridge.bodies.get(id), view = this.views.get(id);
    if (!ship || !view || !byStage.length) return [];
    const st = currentStage(this.bridge.catalog, ship) || byStage.length;
    const names = byStage[Math.max(0, Math.min(byStage.length - 1, st - 1))];
    const geo = this.bridge.geometry(ship), [cx, cy] = ship.derived.com, cs = this.bridge.tuning.cellSize;
    const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation), out: { x: number; y: number }[] = [];
    ship.blueprint.parts.forEach((p, i) => {
      if (!ship.derived.alive[i] || !names.includes(p.piece) || !geo[i]) return;
      const lx = (geo[i].centroid[0] - cx) * cs, ly = (geo[i].centroid[1] - cy) * cs;
      out.push({ x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos });
    });
    return out;
  }

  /** How hot a ship's frame glows (a boss's later stage): eased towards (kept while its view comes and goes) */
  private heats = new Map<number, number>();
  setHeat(id: number, k: number): void {
    this.heats.set(id, Math.max(0, Math.min(1, k)));
  }

  /**
   * The pilot's own Capacitor and Drive Cell members glow with their bank's charge (rework 2026-11 section 2.4): amber and
   * blue, brightest full, dark drained. Redrawn only when a bank's charge moves a step
   */
  private drawBankGlow(view: BodyView, ship: ShipState, cs: number, own: boolean): void {
    const L = own && ship.kind === 'ship' ? ship.derived.power : undefined;
    let b = view.bankGlow;
    if (!L || !L.banks.length) { if (b) b.g.visible = false; return; }
    if (!b) {
      const g = new Graphics();
      g.blendMode = 'add';
      b = view.bankGlow = { g, sig: -1, ship: null, rebuilds: -1 };
      view.container.addChildAt(g, Math.max(0, view.container.getChildIndex(view.guns)));
    }
    b.g.visible = true;
    const charge = this.state.charge.b;
    let sig = 1;
    for (let k = 0; k < L.banks.length; k++) sig = (Math.imul(sig, 31) + Math.round((charge[k] ?? 100) / 5)) | 0;
    if (sig === b.sig && ship === b.ship && ship.rebuilds === b.rebuilds) return;
    b.sig = sig; b.ship = ship; b.rebuilds = ship.rebuilds;
    const geoms = this.bridge.geometry(ship), [cx, cy] = ship.derived.com, g = b.g.clear();
    for (let k = 0; k < L.banks.length; k++) {
      const B = L.banks[k], pct = Math.max(0, Math.min(100, charge[k] ?? 100)) / 100, color = B.kind === 'drive' ? 0x3b82f6 : 0xf59e0b;
      for (const i of B.parts) {
        const poly = geoms[i]?.polygon;
        if (!poly || !ship.derived.alive[i]) continue;
        poly.forEach(([x, y], j) => (j ? g.lineTo((x - cx) * cs, (y - cy) * cs) : g.moveTo((x - cx) * cs, (y - cy) * cs)));
        g.closePath().fill({ color, alpha: 0.05 + 0.5 * pct });
      }
    }
  }

  private weaponOfPart(ship: ShipState, part: number): WeaponInfo | undefined {
    for (let i = 0; i < ship.derived.weapons.length; i++) if (ship.derived.weapons[i].part === part) return ship.derived.weapons[i];
    return undefined;
  }

  /**
   * One gun's state-driven decor (gunAnim.ts): the reload glow (returned: 0..1 of the way to its red), vents and
   * ejects off the housing, a spinning cluster, rail lights. `dx, dy` is the barrel's direction in the container `c`
   * (a turret's turns with it: 1, 0), `len` its length. Your own guns read the ship's gun state; other ships' guns
   * keep the resting look (a spin follows how hard they are being fired).
   */
  private animate(view: BodyView, ship: ShipState, gun: Turret | Barrel, w: WeaponInfo | undefined, c: Container, x0: number, y0: number,
    dx: number, dy: number, len: number, frames: number): number {
    const a = gun.anim!, p = gun.part, mine = view.id === this.state.playerId;
    const reload = w?.fire.reload ?? 0, left = mine ? ship.reload[p] ?? 0 : 0;
    const share = reloadShare(left, reload);
    if (left > 0) {
      // The housing in the world (a turret's barrel turns with it)
      const ang = 'barrel' in gun ? gun.barrel.rotation : gun.g.rotation, ca = Math.cos(ang), sa = Math.sin(ang);
      const cr = view.container.rotation, cc = Math.cos(cr), cs = Math.sin(cr);
      const bx = (dx * ca - dy * sa), by = (dx * sa + dy * ca);
      const lx = x0 + bx * len * 0.5, ly = y0 + by * len * 0.5;
      const fa = cr + Math.atan2(by, bx);
      gun.ventT = (gun.ventT ?? 0) + frames;
      if (a.vent && gun.ventT >= a.vent.every) {
        gun.ventT = 0;
        this.renderer.ventPuff(view.container.x + lx * cc - ly * cs, view.container.y + lx * cs + ly * cc, fa, a.vent.kind, a.vent.color);
      }
      if (!gun.reloading && a.eject !== undefined) {
        // The spent clip falls out sideways
        const ex = view.container.x + x0 * cc - y0 * cs, ey = view.container.y + x0 * cs + y0 * cc;
        this.renderer.ventPuff(ex, ey, fa + Math.PI / 2, 'spark', a.eject);
        this.renderer.ventPuff(ex, ey, fa - Math.PI / 2, 'spark', a.eject);
      }
    }
    gun.reloading = left > 0;
    if (a.lights || a.spin) {
      if (!gun.deco) {
        gun.deco = new Graphics();
        gun.deco.blendMode = 'add';
        c.addChild(gun.deco);
      }
      const d = gun.deco;
      // Along the barrel's line (a turret's frame turns with its head: dx, dy = 1, 0; a fixed gun's is the ship's, from its base)
      const px = -dy, py = dx;
      if (a.lights) {
        const n = a.lights.n, lit = lightsLit(n, mine ? ship.rounds[p] ?? n : n, left, reload);
        // (redrawn only when what it shows changes: sixths of a light)
        const key = Math.round(lit * 6) + (left > 0 ? 1000 : 0);
        if (key !== gun.decoKey) {
          gun.decoKey = key;
          d.clear();
          const r = Math.max(1.3, len * 0.028);
          for (let i = 0; i < n; i++) {
            const u = len * (0.3 + 0.55 * (i / (n - 1)));
            const k = Math.max(0, Math.min(1, lit - i));
            d.circle(dx * u, dy * u, r * 1.9).fill({ color: a.lights.color, alpha: 0.12 + 0.2 * k });
            d.circle(dx * u, dy * u, r).fill({ color: k > 0.5 ? 0xe8fbff : a.lights.color, alpha: 0.12 + 0.88 * k });
          }
        }
      }
      if (a.spin) {
        // The cluster turns with the gun's spin; another ship's follows how hard it is fired
        const spin = mine ? ship.spin[p] ?? 0 : Math.min(1, gun.heat * 1.1);
        if (spin > 0.02 || gun.decoKey) {
          gun.phase = ((gun.phase ?? 0) + frames * (0.15 + 1.1 * spin)) % (Math.PI * 2);
          gun.decoKey = spin > 0.02 ? 1 : 0;
          d.clear();
          if (spin > 0.02) {
            const R = Math.max(2, len * 0.06);
            for (let i = 0; i < 3; i++) {
              const v = R * Math.sin(gun.phase + (i * Math.PI * 2) / 3), ox = px * v, oy = py * v;
              d.moveTo(dx * len * 0.35 + ox, dy * len * 0.35 + oy).lineTo(dx * len * 0.95 + ox, dy * len * 0.95 + oy);
              d.stroke({ color: 0xffd9a0, width: Math.max(1, len * 0.014), alpha: 0.18 + 0.5 * spin });
            }
          }
        }
      }
    }
    return a.reloadGlow !== undefined ? share * 0.7 : 0;
  }

  /**
   * Turret barrels at their current aim: bright when the shot is open, dim when
   * hull is in the way. Each barrel is drawn once, in white, and only turned
   * and tinted per frame.
   */
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
        view.turrets.push({ part: w.part, weapon: wi, barrel, metal, lit, look, x0, y0, len: w.window.barrel * cs, kick: 0, heat: 0, tm: -1, tl: -1, anim: animOf(fn) });
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
      // (a gun reloading glows red; gunAnim.ts)
      const rg = t.anim ? this.animate(view, ship, t, w, t.barrel, t.x0, t.y0, 1, 0, t.len, frames) : 0;
      let tm = mix(hurt(shade(open ? GUN_TINT : GUN_BLOCKED, this.lvl), tf), 0xffd9a0, hot);
      if (rg > 0) tm = mix(tm, t.anim!.reloadGlow!, rg);
      if (tm !== t.tm) t.metal.tint = t.tm = tm;
      if (t.lit) { let tl = mix(hurt(open ? 0xffffff : 0x9a9a9a, tf), 0xffd9a0, hot); if (rg > 0) tl = mix(tl, t.anim!.reloadGlow!, rg); if (tl !== t.tl) t.lit.tint = t.tl = tl; }
      showCracks(t, t.barrel, tf);
      t.kick = Math.max(0, t.kick - frames * RECOIL_RETURN);
      t.heat = Math.max(0, t.heat - frames * COOL);
    }
    for (const b of view.fixed) {
      // Turned on its gimbal as far as it aims (common/src/ships/turret.ts stepFixedGunAim: your own as predicted, another
      // pilot's from their cursor, a pilotless ship's from its last shot: ShipClient.stepTurretVisuals / preSnapshot)
      const rot = b.debris ? 0 : ship.aim[b.part] ?? 0;
      if (rot !== b.rot) {
        b.rot = rot;
        const c = Math.cos(rot), s = Math.sin(rot);
        b.rx = b.nx * c - b.ny * s; b.ry = b.nx * s + b.ny * c;
        b.g.rotation = rot;
        if (b.kick <= 0 && b.heat <= 0) b.g.position.set(b.x0, b.y0);
      }
      const bf = ship.hp[b.part] / (ship.maxHp[b.part] || 1);
      const hot = Math.min(1, b.heat * 0.85 + b.kick * 0.3);
      const rg = b.anim ? this.animate(view, ship, b, this.weaponOfPart(ship, b.part), b.g, b.x0, b.y0, b.nx, b.ny, b.len, frames) : 0;
      let tm = b.debris ? shade(0x555555, this.lvl) : mix(hurt(shade(GUN_TINT, this.lvl), bf), 0xffd9a0, hot);
      if (rg > 0) tm = mix(tm, b.anim!.reloadGlow!, rg);
      if (tm !== b.tm) b.metal.tint = b.tm = tm;
      if (b.lit) { let tl = b.debris ? 0x333333 : mix(hurt(0xffffff, bf), 0xffd9a0, hot); if (rg > 0) tl = mix(tl, b.anim!.reloadGlow!, rg); if (tl !== b.tl) b.lit.tint = b.tl = tl; }
      showCracks(b, b.g, bf);
      if (b.kick <= 0 && b.heat <= 0) continue;
      // Fixed guns slide back into the hull, and glow hot
      const back = RECOIL * 1.4 * b.len * b.kick * b.kick;
      b.g.position.set(b.x0 - b.rx * back, b.y0 - b.ry * back);
      b.kick = Math.max(0, b.kick - frames * RECOIL_RETURN);
      b.heat = Math.max(0, b.heat - frames * COOL);
      // Home and cool: settle exactly
      if (b.kick <= 0 && b.heat <= 0) b.g.position.set(b.x0, b.y0);
    }
  }
}
