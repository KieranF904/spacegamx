/**
 * Space station visuals: one of several designs (stationDesigns.ts), seeded by
 * station id so each looks a little different but always the same, its
 * blinking nav lights and chase lights, the docking ring (in range of it, the
 * HUD offers H to dock), and on armed stations the defence turrets, which
 * sweep while idle, swing onto what they're shooting, and kick as they fire.
 *
 * Its look (stations/): shown at once with today's lighting, then, once its
 * bake comes back from the worker (heights, shadows, facing, light spill,
 * panel mapping: stationBake.ts) and the hull atlas is built, drawn with its
 * materials (StationMaterials.ts), taking the same lights. The halo and the
 * nav, chase and weld lights are soft sprites.
 */

import { Container, Geometry, Graphics, Shader, Sprite, Text, TextStyle, Texture, UniformGroup } from 'pixi.js';
import { STATION_DESIGNS, stationInteractRadius, STATION_WEAPONS } from '@space-game/common';
import { Lighting, LitMesh } from './lighting/Lighting';
import { buildStation, NavTip, StationLayout, turretLook } from './stationDesigns';
import { stationBakeData } from './procedural';
import type { StationGeometry } from './stations/StationGeometry';
import { applyStationLook } from './stations/stationLook';
import type { BakeInput, BakeOutput, BakedPiece, BakePiece, StationDome } from './stations/stationBake';
import { stationAtlas, stationProgram, stationSprites, stationUniforms } from './stations/StationMaterials';
import { keepUpright } from './cameraView';

const ACCENTS = [0x5fd4c4, 0xffb547, 0x9f8cff, 0x7dd3fc, 0xf472b6, 0x86efac];
const MOUNT = 0x5a6370;
const MOUNT_EDGE = 0x353c46;

/** Turret turn rates (radians a second): onto a target, and idling */
const TRACK = 4.5;
const SWEEP = 0.6;
/** How long a turret keeps on its target after its last shot (seconds) */
const HOLD = 1.6;

function rng(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Turret {
  x: number; y: number;
  rest: number;
  angle: number;
  phase: number;
  pivot: Container;
  lit: LitMesh;
  target: number;
  /** Seconds since it last fired */
  since: number;
}

export interface StationShot { x: number; y: number; weapon: string; color: number }

/** Bakes, by station (a station seen again, say back in its system, isn't baked again) */
const bakes = new Map<string, Promise<BakeOutput | null>>();

/** A piece's lit geometry as bake input */
function bakePiece(g: StationGeometry, x: number, y: number, rotor: boolean, domes: StationDome[]): BakePiece {
  return { pos: new Float32Array(g.pos), nrm: new Float32Array(g.nrm), col: new Float32Array(g.col), idx: new Uint32Array(g.idx), shapes: g.shapes, x, y, rotor, domes };
}

/** A baked piece as a mesh's geometry */
function bakedGeometry(p: BakedPiece): Geometry {
  return new Geometry({
    attributes: {
      aPosition: { buffer: p.pos, format: 'float32x2' }, aNormal: { buffer: p.nrm, format: 'float32x3' },
      aColor: { buffer: p.col, format: 'float32x4' }, aExpo: { buffer: p.expo, format: 'float32x3' },
      aMat: { buffer: p.mat, format: 'float32x4' }, aUV: { buffer: p.uv, format: 'float32x2' }, aWin: { buffer: p.win, format: 'float32x2' },
      aShadow: { buffer: p.shadow, format: 'float32x3' }, aBend: { buffer: p.bend, format: 'float32x3' }, aSpill: { buffer: p.spill, format: 'float32x3' },
    },
    indexBuffer: new Uint32Array(p.count).map((_, i) => i),
  });
}

/** A nav light's sprites: a broad glow, a white core, a coloured dot (a welder: a spark and a dot) */
interface NavSprites { glow: Sprite | null; core: Sprite | null; dot: Sprite; star: Sprite | null }

export class StationView {
  readonly container = new Container();
  readonly weapon: string;
  private spinner = new Container();
  private meshes: LitMesh[] = [];
  private lights = new Container();
  private navSprites: NavSprites[] = [];
  private chaseSprites: Sprite[] = [];
  /** The look's own uniforms (shared by its pieces), once it has its look */
  private look: UniformGroup | null = null;
  private disposed = false;
  private designName: string;
  private dockZone = new Graphics();
  private label: Text;
  private time = 0;
  private layout: StationLayout;
  private navTips: NavTip[];
  private accent: number;
  private turrets: Turret[] = [];
  private muzzle = 0;
  private shotColor = 0xffffff;
  private radius: number;
  /** Its look (index into STATION_DESIGNS): how far out its docking ring sits */
  private design: number;

  /**
   * @param design index into STATION_DESIGNS
   * @param turrets how many defence turrets it has (0: unarmed)
   * @param weapon index into STATION_WEAPONS
   */
  constructor(stationId: number, radius: number, name: string | undefined, private lighting: Lighting, design = 0, turrets = 0, weapon = 0) {
    const r = rng(stationId + 1);
    const R = radius;
    this.radius = R;
    this.design = design;
    this.accent = ACCENTS[stationId % ACCENTS.length];
    this.weapon = STATION_WEAPONS[weapon] ?? 'laser';
    const designName = this.designName = STATION_DESIGNS[design] ?? 'ring';
    const L = this.layout = buildStation(designName, R, r, this.accent, turrets);
    const domes = applyStationLook(designName, L, R);
    this.navTips = L.navTips;

    // Faint light spill around the hull: one soft sprite
    const halo = new Sprite(stationSprites().halo);
    halo.anchor.set(0.5);
    halo.width = halo.height = R * 4.4;
    halo.tint = this.accent;
    halo.alpha = 0.11;
    halo.blendMode = 'add';

    // Turret mounts are part of the body; the heads turn on them
    const T = Math.max(26, Math.min(50, R * 0.18));
    const look = turretLook(this.weapon, T);
    this.muzzle = look.muzzle;
    this.shotColor = look.color;
    const mounts = L.hardpoints.slice(0, Math.max(0, turrets));
    for (const h of mounts) {
      L.body.disc(h.x, h.y, look.mountRadius, MOUNT, { bevel: T * 0.18, edge: MOUNT_EDGE }, 10);
      L.body.disc(h.x, h.y, look.mountRadius * 0.55, MOUNT_EDGE, { bevel: T * 0.06 }, 10);
    }

    // (the look's additions may reach a little past the design's own reach)
    for (let v = 0; v < L.body.vertexCount; v++) L.reach = Math.max(L.reach, Math.hypot(L.body.pos[v * 2], L.body.pos[v * 2 + 1]));
    const body = new LitMesh(L.body.toGeometry());
    body.radius = L.reach;
    this.meshes.push(body);
    if (L.spin.vertexCount) {
      const spin = new LitMesh(L.spin.toGeometry());
      spin.radius = L.spinRadius;
      this.spinner.position.set(L.spinAt.x, L.spinAt.y);
      this.spinner.addChild(spin.mesh);
      this.meshes.push(spin);
    }

    const heads = new Container();
    const headGeometry = mounts.length ? look.head.toGeometry() : null;
    mounts.forEach((h) => {
      const lit = new LitMesh(headGeometry!);
      lit.radius = this.muzzle;
      const pivot = new Container();
      pivot.position.set(h.x, h.y);
      pivot.addChild(lit.mesh);
      heads.addChild(pivot);
      this.meshes.push(lit);
      const phase = r() * Math.PI * 2;
      this.turrets.push({ x: h.x, y: h.y, rest: h.rest, angle: h.rest, phase, pivot, lit, target: -1, since: Infinity });
    });
    for (const m of this.meshes) lighting.add(m);

    this.makeLightSprites(designName === 'shipyard');
    this.dockZone.visible = false;

    this.label = new Text({
      text: name ?? 'Station',
      style: new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 30, fill: 0xcfd8e6, letterSpacing: 2 }),
    });
    this.label.anchor.set(0.5, 0);
    this.label.y = L.reach;
    this.label.alpha = 0.8;

    this.container.addChild(halo, this.dockZone, body.mesh, this.spinner, heads, this.lights, this.label);

    // The look: baked off the main thread (once per station), then the materials take over
    const tileW = R * 0.22;
    const key = `${designName}|${stationId}|${R}|${turrets}|${this.weapon}`;
    let bake = bakes.get(key);
    if (!bake) {
      const pieces: BakePiece[] = [bakePiece(L.body as StationGeometry, 0, 0, false, domes.body)];
      if (L.spin.vertexCount) pieces.push(bakePiece(L.spin as StationGeometry, L.spinAt.x, L.spinAt.y, true, domes.spin));
      for (const h of mounts) pieces.push(bakePiece(look.head as StationGeometry, h.x, h.y, true, []));
      const input: BakeInput = {
        design: designName, R, tileW, pieces, navTips: L.navTips, chase: L.chase, chaseColor: L.chaseColor ?? this.accent,
        guns: L.hardpoints.slice(0, 4).map((h) => [h.x, h.y]),
      };
      bakes.set(key, (bake = stationBakeData(input)));
    }
    void Promise.all([bake, stationAtlas()]).then(([out, atlas]) => { if (out) this.takeLook(out, atlas, tileW); });
  }

  /** How far it's drawn from its centre (world units, its name under it too): what culling keeps on screen */
  get reach(): number {
    return this.layout.reach + 60;
  }

  /** Has defence turrets */
  get armed(): boolean {
    return this.turrets.length > 0;
  }

  /**
   * @param dt seconds since last frame
   * @param playerDist distance from the local player's ship to the station centre
   * @param here the station's position in the world
   * @param where an entity's position in the world (what the turrets are on)
   */
  update(dt: number, playerDist: number, here?: { x: number; y: number }, where?: (id: number) => { x: number; y: number } | null): void {
    this.time += dt;
    this.spinner.rotation += this.layout.spinRate * dt;
    // (Its name upright under it, however the view and the entity are turned)
    keepUpright(this.label, this.container.parent?.rotation ?? 0);
    if (this.look) { const p = this.look.uniforms.uParams as Float32Array; p[0] = this.time % 1000; p[1] = this.pulse; }
    this.aimTurrets(dt, here, where);

    // The lights blink in steps: update only when one changes
    const chase = this.layout.chase.length ? Math.floor(this.time * 6) % this.layout.chase.length : 0;
    let key = chase;
    this.navTips.forEach((n, i) => { if (((this.time * 0.9 + n.phase) % 1) < 0.18) key += (i + 1) * 1000; });
    if (key !== this.lightsKey) {
      this.lightsKey = key;
      this.drawLights(chase);
    }

    // Docking ring: fades in as you approach, solid with a prompt once you're in range
    const R = stationInteractRadius(this.radius, this.design);
    const near = playerDist < R * 2.5;
    this.dockZone.visible = near;
    if (!near) return;
    const inRange = playerDist < R;
    // Drawn once per look (in range or not); turning and fading are just transforms
    if (inRange !== this.zoneInRange) {
      this.zoneInRange = inRange;
      const z = this.dockZone.clear();
      const dashes = 48;
      for (let k = 0; k < dashes; k++) {
        const a0 = (k / dashes) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2 / dashes) * (inRange ? 0.9 : 0.5);
        z.moveTo(Math.cos(a0) * R, Math.sin(a0) * R).arc(0, 0, R, a0, a1).stroke({ color: 0x7dd3fc, width: inRange ? 6 : 4 });
      }
      if (inRange) z.circle(0, 0, R).fill({ color: 0x7dd3fc, alpha: 0.04 / 0.75 });
    }
    this.dockZone.rotation = this.time * 0.15;
    this.dockZone.alpha = inRange ? 0.75 : Math.max(0, 1 - (playerDist - R) / (R * 1.5)) * 0.4;
  }

  /**
   * A turret fired at a point (the station at `sx, sy`): it snaps onto it and
   * kicks. Returns where the shot leaves the barrel, in the world.
   */
  fire(turret: number, target: number, sx: number, sy: number, tx: number, ty: number): StationShot {
    const t = this.turrets[turret % Math.max(1, this.turrets.length)];
    if (!t) {
      // Unarmed (or an old server): from the hull's edge
      const a = Math.atan2(ty - sy, tx - sx), r = this.radius * 0.9;
      return { x: sx + Math.cos(a) * r, y: sy + Math.sin(a) * r, weapon: this.weapon, color: this.shotColor };
    }
    const a = Math.atan2(ty - sy - t.y, tx - sx - t.x);
    t.angle = a;
    t.target = target;
    t.since = 0;
    t.pivot.rotation = a;
    return { x: sx + t.x + Math.cos(a) * this.muzzle, y: sy + t.y + Math.sin(a) * this.muzzle, weapon: this.weapon, color: this.shotColor };
  }

  /** The station's own lights: its lamps (the refinery's furnace pulsing), the nav lights as they blink, muzzle flashes (world position given) */
  collectLights(L: Lighting, x: number, y: number, rotation: number): void {
    const c = Math.cos(rotation), s = Math.sin(rotation);
    const at = (px: number, py: number): [number, number] => [x + px * c - py * s, y + px * s + py * c];
    const furnace = this.designName === 'refinery' ? 1 + 0.25 * this.pulse : 1;
    this.layout.lamps.forEach((l, i) => L.point(...at(l.x, l.y), l.color, l.radius, l.power * (i === 0 ? furnace : 1), l.height));
    for (const n of this.navTips) {
      if (((this.time * 0.9 + n.phase) % 1) >= 0.18) continue;
      L.point(...at(n.x, n.y), n.color, this.radius * 1.1, 0.9, this.radius * 0.3);
    }
    for (const t of this.turrets) {
      if (t.since > 0.12) continue;
      const k = 1 - t.since / 0.12;
      L.point(...at(t.x + Math.cos(t.angle) * this.muzzle, t.y + Math.sin(t.angle) * this.muzzle), this.shotColor, this.radius * 1.6, 1.4 * k, 60);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const m of this.meshes) this.lighting.remove(m);
    // (its geometry is its own: the meshes don't free it as they go)
    for (const g of new Set(this.meshes.map((m) => m.mesh.geometry))) g.destroy();
  }

  private lightsKey = -1;
  private zoneInRange: boolean | null = null;

  /** The baked look in place of today's: each piece's new geometry, drawn with the materials, keeping its lights */
  private takeLook(out: BakeOutput, atlas: Texture, tileW: number): void {
    if (this.disposed || out.pieces.length !== this.meshes.length) return;
    const look = this.look = new UniformGroup(stationUniforms(this.designName, this.radius, tileW));
    const old = new Set(this.meshes.map((m) => m.mesh.geometry));
    this.meshes.forEach((lm, i) => {
      lm.mesh.geometry = bakedGeometry(out.pieces[i]);
      lm.mesh.shader = new Shader({
        glProgram: stationProgram(),
        resources: { litUniforms: (lm.shader.resources as Record<string, unknown>).litUniforms, stationUniforms: look, uDetail: atlas.source },
      });
    });
    for (const g of old) g.destroy();
  }

  /** The glow pulse (the refinery's furnace and glowing parts), 0.4..1 */
  private get pulse(): number {
    return 0.7 + 0.3 * Math.sin(this.time * 1.3);
  }

  /** On a target while it's firing, otherwise sweeping slowly about its rest; the barrel kicks back as it fires */
  private aimTurrets(dt: number, here?: { x: number; y: number }, where?: (id: number) => { x: number; y: number } | null): void {
    for (const t of this.turrets) {
      t.since += dt;
      let want = t.rest + Math.sin(this.time * 0.25 + t.phase) * 0.9;
      let rate = SWEEP;
      if (t.since < HOLD && t.target >= 0 && here && where) {
        const p = where(t.target);
        if (p) { want = Math.atan2(p.y - here.y - t.y, p.x - here.x - t.x); rate = TRACK; }
      }
      let d = want - t.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      t.angle += Math.max(-rate * dt, Math.min(rate * dt, d));
      t.pivot.rotation = t.angle;
      const kick = Math.max(0, 1 - t.since / 0.18);
      t.lit.mesh.x = -kick * kick * this.muzzle * 0.18;
    }
  }

  /** The nav lights, the shipyard's welders and the chase lights, as soft sprites (drawLights sets which are on) */
  private makeLightSprites(welds: boolean): void {
    const sp = stationSprites(), R = this.radius;
    const add = (t: Texture, x: number, y: number, size: number, tint: number, alpha: number, rotation = 0): Sprite => {
      const s = new Sprite(t);
      s.anchor.set(0.5);
      s.position.set(x, y);
      s.width = s.height = size;
      s.tint = tint;
      s.alpha = alpha;
      s.rotation = rotation;
      s.blendMode = 'add';
      this.lights.addChild(s);
      return s;
    };
    this.navTips.forEach((n, i) => {
      if (welds && i < 4) {
        this.navSprites.push({ glow: null, core: null, star: add(sp.star, n.x, n.y, R * 0.32, n.color, 0.85, i * 0.4), dot: add(sp.glow, n.x, n.y, R * 0.12, 0xffffff, 0.9) });
        return;
      }
      const glow = add(sp.glow, n.x, n.y, R * 0.75, n.color, 0.55);
      const core = add(sp.glow, n.x, n.y, R * 0.16, 0xffffff, 0.9);
      this.navSprites.push({ glow, core, dot: add(sp.glow, n.x, n.y, R * 0.2, n.color, 1), star: null });
    });
    const color = this.layout.chaseColor ?? this.accent;
    for (const p of this.layout.chase) this.chaseSprites.push(add(sp.glow, p.x, p.y, R * 0.11, color, 0.45));
  }

  // (Blinks by alpha, not visibility: a change of `visible` has Pixi rebuild the scene's draw list; additive at no alpha is nothing)
  private drawLights(chase: number): void {
    const R = this.radius;
    this.navTips.forEach((n, i) => {
      const on = ((this.time * 0.9 + n.phase) % 1) < 0.18, s = this.navSprites[i];
      if (!s) return;
      if (s.star) {
        // A welder: a spark while it's on, a dim glow between
        s.star.alpha = on ? 0.85 : 0;
        s.dot.tint = on ? 0xffffff : n.color;
        s.dot.alpha = on ? 0.9 : 0.5;
        return;
      }
      s.glow!.alpha = on ? 0.55 : 0;
      s.core!.alpha = on ? 0.9 : 0;
      s.dot.width = s.dot.height = R * (on ? 0.2 : 0.12);
      s.dot.alpha = on ? 1 : 0.5;
    });
    const pts = this.chaseSprites;
    const other = (chase + Math.floor(pts.length / 2)) % Math.max(1, pts.length);
    pts.forEach((s, i) => {
      const lit = i === chase || i === other;
      s.width = s.height = R * (lit ? 0.22 : 0.11);
      s.alpha = lit ? 1 : 0.45;
    });
  }
}
