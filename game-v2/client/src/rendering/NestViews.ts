/**
 * Hostile nests (systems.json `nests`): the structures a faction's packs
 * launch from, each orbiting the system centre, a planet or a moon
 * (common world/nests.ts), drawn by kind: a Redtooth dig (a rig over a
 * cracked boulder, a Halden cache glowing in the cut), a Scrapborn heap (junk
 * round a lump of greyseam), a pirate den (a hollowed rock with a hab and a
 * docking arm), a Frost Brood roost (ice shards), a scavenger sift (a frame
 * holding crystal), a Cinder shrine (a hull welded into a furnace), a knot
 * of debris that echoes condense from, or a Helios drone dock (a cradle off
 * the Array).
 *
 * Each is one lit mesh (nests/buildNest.ts) in the asteroids' materials
 * (nests/nestShader.ts), lit by the Lighting as the rocks round it are, plus
 * soft glow sprites for its lamps and at most one real light of its own.
 * Built once; a frame only moves and turns it, and breathes its lamps.
 */

import { Container, Shader, Sprite, Text, TextStyle } from 'pixi.js';
import { NEST_RADIUS, nestPosition, type NestData, type PlanetData } from '@space-game/common';
import factionsData from '../../../data/factions.json';
import { Lighting, LitMesh } from './lighting/Lighting';
import { keepUpright } from './cameraView';
import { rockAtlas } from './rocks/RockMaterials';
import { buildNest, type NestGlow, type NestLight } from './nests/buildNest';
import { flatAtlas, glowTexture, nestProgram, nestUniforms } from './nests/nestShader';

/** Each faction's colour (its nests' lamps) */
const FACTION_COLOR: Record<string, number> = Object.fromEntries(
  Object.entries((factionsData as { factions: Record<string, { color: string }> }).factions).map(([id, f]) => [id, parseInt(f.color.slice(1), 16)]),
);
/** A nest's colour on the maps: its faction's */
export const nestColor = (faction: string): number => FACTION_COLOR[faction] ?? 0xff5a4a;
const LABEL = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 48, fill: 0xffd2c8, letterSpacing: 5 });

/** Fire: a quick uneven waver */
const flick = (t: number) => 0.82 + 0.1 * Math.sin(t * 9.1) + 0.08 * Math.sin(t * 23.7 + 1.3);

class NestView {
  readonly container = new Container();
  readonly lit: LitMesh;
  private glowLayer = new Container();
  private glowSprites: { s: Sprite; g: NestGlow }[] = [];
  private time = Math.random() * 20;
  private readonly spin: number;
  readonly light: NestLight | null;

  constructor(readonly data: NestData, private planets: PlanetData[] | undefined) {
    const built = buildNest(data, nestColor(data.faction));
    this.light = built.light;
    this.lit = new LitMesh(built.geo.build());
    this.lit.radius = NEST_RADIUS * 1.3;
    const shader = new Shader({
      glProgram: nestProgram(),
      resources: { litUniforms: (this.lit.shader.resources as Record<string, unknown>).litUniforms, nestUniforms, uDetail: (rockAtlas() ?? flatAtlas()).source },
    });
    this.lit.mesh.shader = shader;
    const tex = glowTexture();
    for (const g of built.glows) {
      const s = new Sprite(tex);
      s.anchor.set(0.5);
      s.position.set(g.x, g.y);
      s.width = s.height = g.r * 2;
      s.tint = g.color;
      s.alpha = g.a;
      s.blendMode = 'add';
      this.glowLayer.addChild(s);
      this.glowSprites.push({ s, g });
    }
    // Heaps and knots tumble; built things barely turn
    let h = 0;
    for (const ch of data.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const k = data.kind;
    this.spin = k === 'knot' || k === 'scrap' || k === 'sift' || k === 'roost' ? 0.03 + ((h % 1000) / 1000) * 0.03 : 0.006;
    const label = new Text({ text: data.name.toUpperCase(), style: LABEL });
    label.anchor.set(0.5, 0);
    label.alpha = 0.5;
    label.scale.set(0.6);
    label.y = NEST_RADIUS + 200;
    // (mesh, glows, label: the label stays the third child)
    this.container.addChild(this.lit.mesh, this.glowLayer, label);
    this.container.scale.set(data.scale ?? 1);
    this.lit.radius *= data.scale ?? 1;
  }

  position(tick: number): { x: number; y: number } {
    return nestPosition(this.data, this.planets, tick);
  }

  get rotation(): number {
    return this.lit.mesh.rotation;
  }

  update(dt: number, at: { x: number; y: number }): void {
    this.time += dt;
    this.container.x = at.x;
    this.container.y = at.y;
    this.lit.mesh.rotation = this.glowLayer.rotation = this.time * this.spin;
    keepUpright(this.container.children[2]);
    const pulse = 0.7 + 0.3 * Math.sin(this.time * 1.7), fire = flick(this.time);
    for (const { s, g } of this.glowSprites) s.alpha = g.a * (g.flicker ? fire : g.pulse ? pulse : 1);
    const sh = this.lit.mesh.shader as Shader;
    const atlas = rockAtlas();
    if (atlas && sh.resources.uDetail !== atlas.source) sh.resources.uDetail = atlas.source;
  }

  /** Its own light, in the world (it turns with the nest) */
  addLight(L: Lighting): void {
    const l = this.light;
    if (!l || !this.container.visible) return;
    const r = this.lit.mesh.rotation, k = this.data.scale ?? 1, c = Math.cos(r) * k, s = Math.sin(r) * k;
    const power = l.power * (l.flicker ? flick(this.time) : 1);
    L.point(this.container.x + l.x * c - l.y * s, this.container.y + l.x * s + l.y * c, l.color, l.r * k, power, l.h);
  }

  destroy(lighting: Lighting | null): void {
    lighting?.remove(this.lit);
    this.container.destroy({ children: true });
  }
}

export class NestRenderer {
  readonly container = new Container();
  private views: NestView[] = [];
  private clock = 0;
  private _lighting: Lighting | null = null;
  private readonly source = (L: Lighting) => { for (const v of this.views) v.addLight(L); };

  /** The world's lighting: nests are lit by it and add their lights to it */
  get lighting(): Lighting | null { return this._lighting; }
  set lighting(l: Lighting | null) {
    if (l === this._lighting) return;
    if (this._lighting) { this._lighting.removeSource(this.source); for (const v of this.views) this._lighting.remove(v.lit); }
    this._lighting = l;
    if (l) { l.addSource(this.source); for (const v of this.views) l.add(v.lit); }
  }

  set(nests: NestData[], planets: PlanetData[] | undefined): void {
    for (const v of this.views) v.destroy(this._lighting);
    this.views = nests.map((n) => new NestView(n, planets));
    for (const v of this.views) {
      this.container.addChild(v.container);
      this._lighting?.add(v.lit);
    }
  }

  update(dt: number, tick: number, view: { x0: number; y0: number; x1: number; y1: number }): void {
    this.clock += dt;
    // How big the world is on screen (the camera's zoom: the scales above this layer)
    let zoom = 1;
    for (let n: Container | null = this.container; n; n = n.parent) zoom *= n.scale.x;
    const u = nestUniforms.uniforms as { uZoom: number; uTime: number };
    u.uZoom = zoom;
    u.uTime = this.clock;
    const M = NEST_RADIUS * 3;
    for (const n of this.views) {
      const p = n.position(tick), m = M * (n.data.scale ?? 1);
      n.container.visible = p.x + m > view.x0 && p.x - m < view.x1 && p.y + m > view.y0 && p.y - m < view.y1;
      if (n.container.visible) n.update(dt, p);
    }
  }
}
