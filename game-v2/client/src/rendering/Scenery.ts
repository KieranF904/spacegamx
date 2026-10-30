/**
 * Scenery besides planets: comets (an icy nucleus, a glowing coma, and ion and
 * dust tails streaming away from the star, longer the closer it gets) and
 * built structures such as a solar collector ring around the star and the
 * broken Halden ring at Ashfall, and the stillstones ("lodestones" in the
 * code), huge grey bodies whose fields charge a jump drive
 * (common/src/ships/jumpFields.ts).
 *
 * Halden work has one look wherever it turns up (HALDEN): dark slate, angular
 * notched slabs, and a thin inlay of greyseam with a faint cold shimmer. All of
 * it is drawn once; only the lights that blink are redrawn.
 */

import { clearIfDrawn } from './gfx';
import { Container, Graphics, Text, TextStyle, type Texture, type UniformGroup } from 'pixi.js';
import {
  CometData, StructureData, LodestoneData, cometPosition, lodestonePosition, lodestoneLabel, lodestoneSize, lodestoneLive, lodestoneFieldRadius,
  jumpTuning, type ShipTuning,
} from '@space-game/common';
import { Lighting, LitMesh } from './lighting/Lighting';
import { keepUpright } from './cameraView';
import { STONE, STILLSTONE_REACH, stillstoneGlowColor, stillstoneShards, stillstoneSpin } from './StillstoneMesh';
import { stillstoneDisc, stillstoneShader } from './StillstoneShader';
import { stillstoneMapData } from './procedural';
import shipTuning from '../../../data/ships/tuning.json';
import { createShaderQuad, ShaderQuad } from './shaderQuad';

const JUMP = jumpTuning(shipTuning as unknown as ShipTuning);
/** The Halden's visual language: slate faces, a darker edge, a greyseam inlay (cold), and scorch where it faced a fire */
const HALDEN = { face: 0x2e333c, faceLight: 0x383e48, edge: 0x56606c, inlay: 0xa9cfd8, scorch: 0x7a3418 };

const TAIL_FRAGMENT = `
  void main() {
    // x: 0 at the nucleus .. 1 at the tip; y: -1..1 across
    float x = vUV.x;
    float y = (vUV.y - 0.5) * 2.0;
    float width = 0.08 + x * uSpread;
    float core = exp(-pow(y / width, 2.0));
    float streaks = 0.65 + 0.35 * noise(vec2(x * 6.0 - uTime * 0.6, y * 9.0 + uSeed));
    float fade = pow(1.0 - x, 1.6) * smoothstep(0.0, 0.03, x);
    vec3 col = hsl2rgb(uHue, 0.75, 0.72);
    float a = core * streaks * fade * uStrength;
    fragColor = vec4(col * a, a * 0.85);
  }
`;

const COMA_FRAGMENT = `
  void main() {
    vec2 p = (vUV - 0.5) * 2.0;
    float r = length(p);
    float glow = exp(-r * 5.0) * 0.9 + exp(-r * 14.0);
    vec3 col = mix(hsl2rgb(uHue, 0.6, 0.75), vec3(1.0), exp(-r * 18.0));
    float a = glow * uStrength * smoothstep(1.0, 0.7, r);
    fragColor = vec4(col * a, a);
  }
`;

const LABEL = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 48, fill: 0xbfe6ff, letterSpacing: 5 });

class CometView {
  readonly container = new Container();
  private ion: ShaderQuad;
  private dust: ShaderQuad;
  private coma: ShaderQuad;
  private nucleus = new Graphics();
  private label: Text;
  private time = Math.random() * 50;

  constructor(readonly data: CometData) {
    const hue = data.hue ?? 195;
    const tail = (h: number, spread: number) => createShaderQuad(TAIL_FRAGMENT, {
      uTime: { value: 0, type: 'f32' }, uHue: { value: h, type: 'f32' }, uSpread: { value: spread, type: 'f32' },
      uStrength: { value: 1, type: 'f32' }, uSeed: { value: Math.random() * 10, type: 'f32' },
    }, 0.5);
    this.dust = tail(42, 0.55);
    this.ion = tail(hue, 0.18);
    this.coma = createShaderQuad(COMA_FRAGMENT, { uHue: { value: hue, type: 'f32' }, uStrength: { value: 1, type: 'f32' } }, 0.5);
    for (const q of [this.dust, this.ion, this.coma]) q.mesh.blendMode = 'add';
    const n = data.nucleus;
    this.nucleus.circle(0, 0, n).fill({ color: 0x9aa4b0 });
    this.nucleus.circle(-n * 0.3, -n * 0.25, n * 0.45).fill({ color: 0xc8d2dc, alpha: 0.8 });
    this.label = new Text({ text: data.name.toUpperCase(), style: LABEL });
    this.label.anchor.set(0.5, 0);
    this.label.alpha = 0.6;
    this.label.y = this.data.nucleus * 6 + 200;
    this.container.addChild(this.dust.mesh, this.ion.mesh, this.coma.mesh, this.nucleus, this.label);
  }

  update(dt: number, tick: number): { x: number; y: number } {
    this.time += dt;
    const { x, y } = cometPosition(this.data, tick);
    this.container.x = x;
    this.container.y = y;
    const r = Math.hypot(x, y) || 1;
    // Away from the star; the tails grow as it nears perihelion
    const away = Math.atan2(y, x);
    const heat = Math.min(1, 9000 / r);
    const len = 1500 + 16000 * heat * heat;
    const place = (q: ShaderQuad, angle: number, length: number, width: number, strength: number) => {
      q.mesh.rotation = angle;
      q.mesh.scale.set(length, width);
      q.mesh.x = Math.cos(angle) * length * 0.5;
      q.mesh.y = Math.sin(angle) * length * 0.5;
      q.u.uniforms.uStrength = strength;
      q.u.uniforms.uTime = this.time;
    };
    // The dust tail lags behind the orbit, so it curves off a little to one side
    place(this.ion, away, len, len * 0.22, 0.4 + 0.6 * heat);
    place(this.dust, away + 0.22, len * 0.7, len * 0.4, 0.25 + 0.5 * heat);
    const coma = this.data.nucleus * (5 + 10 * heat);
    this.coma.mesh.scale.set(coma * 2, coma * 2);
    this.coma.u.uniforms.uStrength = 0.5 + 0.5 * heat;
    keepUpright(this.label);
    return { x, y };
  }
}

/**
 * A ring of solar collectors round the star: two rails joined by a lattice,
 * a collector blade on a strut every segment facing the star (each a grid of
 * cells in a gold frame), a collector hub every tenth with radiator fins and a
 * beacon, and beacons blinking along the outer rail. Sized from its radius, so
 * it reads at the scale of the star it circles.
 */
/** The Helios Array's lights are redrawn at most this often (they blink and sweep slowly) */
const GLINT_HZ = 30;

class SolarRingView {
  readonly container = new Container();
  private ring = new Graphics();
  private glints = new Graphics();
  private time = 0;
  private label: Text;

  constructor(readonly data: StructureData) {
    const R = data.radius, n = data.segments, arc = data.oldArc;
    const seg = (Math.PI * 2 * R) / n;
    const railGap = 260, bladeIn = R - railGap - 140, bladeDepth = Math.min(700, seg * 0.45), bladeHalf = seg * 0.42;
    const g = this.ring;
    // Rails
    for (const rr of [R - railGap, R + railGap]) {
      g.circle(0, 0, rr).stroke({ color: 0x5d6878, width: 46, alpha: 0.95 });
      g.circle(0, 0, rr).stroke({ color: 0xb8c4d4, width: 10, alpha: 0.9 });
    }
    const P = (r: number, a: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
    // Lattice between the rails
    for (let i = 0; i < n * 2; i++) {
      const a0 = (i / (n * 2)) * Math.PI * 2, a1 = ((i + 1) / (n * 2)) * Math.PI * 2;
      const [x0, y0] = P(i % 2 ? R + railGap : R - railGap, a0), [x1, y1] = P(i % 2 ? R - railGap : R + railGap, a1);
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ color: 0x7d899a, width: 12 });
    }
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a), tx = -s, ty = c;
      if (i % 10 === 0) {
        // A collector hub: a hexagon astride the rails, radiators fanned outward
        const [hx, hy] = P(R, a);
        const hex: number[] = [];
        for (let k = 0; k < 6; k++) { const b = a + (k / 6) * Math.PI * 2 + Math.PI / 6; hex.push(hx + Math.cos(b) * 420, hy + Math.sin(b) * 420); }
        for (const side of [-1, 1]) {
          const fx = hx + c * 300 + tx * side * 260, fy = hy + s * 300 + ty * side * 260;
          g.poly([fx - tx * 90, fy - ty * 90, fx + tx * 90, fy + ty * 90, fx + tx * 70 + c * 900, fy + ty * 70 + s * 900, fx - tx * 70 + c * 900, fy - ty * 70 + s * 900])
            .fill({ color: 0xd8dce3 }).stroke({ color: 0x8e98a6, width: 8 });
        }
        g.poly(hex).fill({ color: 0x8f9bab }).stroke({ color: 0x4d5766, width: 14 });
        g.circle(hx, hy, 210).fill({ color: 0x3a4250 }).stroke({ color: 0xd9b45a, width: 10 });
        g.circle(hx, hy, 90).fill({ color: 0x252b36 });
        continue;
      }
      // The oldest arc is Halden work: the same shape (the colony copied it), not the same make
      const old = !!arc && (i - arc.from + n) % n < arc.count;
      // Strut in to the blade
      const [sx0, sy0] = P(R - railGap, a), [sx1, sy1] = P(bladeIn, a);
      g.moveTo(sx0, sy0).lineTo(sx1, sy1).stroke({ color: old ? HALDEN.edge : 0x8b97a8, width: 22 });
      // The blade: across the strut, facing the star, cells in a grid
      const mid = bladeIn - bladeDepth / 2;
      const px = c * mid, py = s * mid, hd = bladeDepth / 2;
      if (old) {
        // Notched corners and a greyseam inlay down the middle, in place of the cells
        const nb = bladeHalf * 0.12, nd = hd * 0.25;
        g.poly([
          px + tx * (bladeHalf - nb) - c * hd, py + ty * (bladeHalf - nb) - s * hd,
          px - tx * (bladeHalf - nb) - c * hd, py - ty * (bladeHalf - nb) - s * hd,
          px - tx * bladeHalf - c * (hd - nd), py - ty * bladeHalf - s * (hd - nd),
          px - tx * bladeHalf + c * hd, py - ty * bladeHalf + s * hd,
          px + tx * bladeHalf + c * hd, py + ty * bladeHalf + s * hd,
          px + tx * bladeHalf - c * (hd - nd), py + ty * bladeHalf - s * (hd - nd),
        ]).fill({ color: i % 2 ? HALDEN.face : HALDEN.faceLight }).stroke({ color: HALDEN.edge, width: 14 });
        g.moveTo(px - tx * bladeHalf * 0.8, py - ty * bladeHalf * 0.8)
          .lineTo(px - c * hd * 0.35, py - s * hd * 0.35)
          .lineTo(px + tx * bladeHalf * 0.8, py + ty * bladeHalf * 0.8)
          .stroke({ color: HALDEN.inlay, width: 7, alpha: 0.5 });
        const [bx, by] = P(R + railGap + 40, a);
        g.circle(bx, by, 34).fill({ color: 0x9aa6b6 });
        continue;
      }
      g.poly([
        px + tx * bladeHalf - c * hd, py + ty * bladeHalf - s * hd,
        px - tx * bladeHalf - c * hd, py - ty * bladeHalf - s * hd,
        px - tx * bladeHalf + c * hd, py - ty * bladeHalf + s * hd,
        px + tx * bladeHalf + c * hd, py + ty * bladeHalf + s * hd,
      ]).fill({ color: 0x1c3a63 }).stroke({ color: 0xd9b45a, width: 14 });
      for (let k = -3; k <= 3; k++) {
        const ox = px + tx * bladeHalf * (k / 4), oy = py + ty * bladeHalf * (k / 4);
        g.moveTo(ox - c * hd * 0.94, oy - s * hd * 0.94).lineTo(ox + c * hd * 0.94, oy + s * hd * 0.94).stroke({ color: 0x4f78a8, width: 6 });
      }
      g.moveTo(px - tx * bladeHalf * 0.96, py - ty * bladeHalf * 0.96).lineTo(px + tx * bladeHalf * 0.96, py + ty * bladeHalf * 0.96).stroke({ color: 0x4f78a8, width: 6 });
      // Beacon housing on the outer rail
      const [bx, by] = P(R + railGap + 40, a);
      g.circle(bx, by, 34).fill({ color: 0x9aa6b6 });
    }
    // The beacons as they are most of the time (dim): drawn once with the ring; only the lit ones are drawn each frame
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const br = i % 10 === 0 ? R : R + 300;
      g.circle(Math.cos(a) * br, Math.sin(a) * br, 18).fill({ color: i % 10 === 0 ? 0xffd890 : i % 2 ? 0xff5050 : 0x50ff80, alpha: 0.35 });
    }
    this.glints.blendMode = 'add';
    this.label = new Text({ text: data.name.toUpperCase(), style: LABEL });
    this.label.anchor.set(0.5, 0);
    this.label.alpha = 0.5;
    this.label.scale.set(Math.min(6, Math.max(1, R / 6000)));
    this.label.y = R + railGap + 400;
    this.container.addChild(this.ring, this.glints, this.label);
  }

  /** Seconds since the lights were last drawn (they're redrawn at most GLINT_HZ times a second) */
  private glintWait = 0;

  update(dt: number): void {
    this.time += dt;
    this.ring.rotation += dt * 0.0015;
    keepUpright(this.label);
    this.glints.rotation = this.ring.rotation;
    this.glintWait += dt;
    if (this.glintWait < 1 / GLINT_HZ) return;
    this.glintWait = 0;
    // A sweep of light running round the blades, and the beacons blinking (the dim ones are part of the ring)
    const g = this.glints;
    clearIfDrawn(g);
    const R = this.data.radius, n = this.data.segments;
    const seg = (Math.PI * 2 * R) / n, bladeMid = R - 260 - 140 - Math.min(700, seg * 0.45) / 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const sweep = Math.max(0, Math.cos(a * 2 - this.time * 0.25)) ** 16;
      if (sweep > 0.02 && i % 10) g.circle(Math.cos(a) * bladeMid, Math.sin(a) * bladeMid, 380 * sweep + 60).fill({ color: 0xfff1c0, alpha: 0.4 * sweep });
      if (((this.time * 0.8 + i * 0.37) % 1) >= 0.12) continue;
      const br = i % 10 === 0 ? R : R + 300;
      g.circle(Math.cos(a) * br, Math.sin(a) * br, i % 10 === 0 ? 120 : 46).fill({ color: i % 10 === 0 ? 0xffd890 : i % 2 ? 0xff5050 : 0x50ff80, alpha: 1 });
    }
  }
}

/**
 * A broken Halden ring round the star: `segments` slots of slate slabs, a third
 * of them gone, the rest cracked, some knocked out of true, with a greyseam
 * inlay along each and their inner faces scorched where they faced the star.
 * Drawn once; it only turns.
 */
class RuinRingView {
  readonly container = new Container();
  private ring = new Graphics();
  private label: Text;

  constructor(readonly data: StructureData) {
    const R = data.radius, n = Math.max(6, data.segments);
    let seed = 11;
    for (const ch of data.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const g = this.ring;
    const slot = (Math.PI * 2) / n, depth = Math.max(500, R * 0.028);
    const arcPts = (r: number, a0: number, a1: number, m: number, out: number[]) => {
      for (let k = 0; k <= m; k++) { const b = a0 + ((a1 - a0) * k) / m; out.push(Math.cos(b) * r, Math.sin(b) * r); }
    };
    for (let i = 0; i < n; i++) {
      const roll = rnd();
      const a = i * slot + (rnd() - 0.5) * slot * 0.1;
      if (roll < 0.3) {
        // Gone: a few fragments where it was
        for (let k = 0; k < 3; k++) {
          const b = a + (rnd() - 0.5) * slot * 0.8, r = R + (rnd() - 0.5) * depth * 4, f = depth * (0.15 + rnd() * 0.25);
          const pts: number[] = [];
          for (let q = 0; q < 5; q++) { const t = (q / 5) * Math.PI * 2 + rnd() * 0.6; pts.push(Math.cos(b) * r + Math.cos(t) * f, Math.sin(b) * r + Math.sin(t) * f); }
          g.poly(pts).fill({ color: HALDEN.face }).stroke({ color: HALDEN.edge, width: 10 });
        }
        continue;
      }
      // Knocked out of true: pushed in or out, and turned a little about its middle
      const drift = roll > 0.82 ? (rnd() - 0.5) * depth * 5 : 0;
      const tilt = roll > 0.82 ? (rnd() - 0.5) * 0.05 : 0;
      const w = slot * (0.62 + rnd() * 0.18), a0 = a - w / 2 + tilt, a1 = a + w / 2 - tilt;
      const r0 = R - depth / 2 + drift, r1 = R + depth / 2 + drift, notch = w * 0.06;
      // The slab: notched at both ends (the Halden never squared a corner)
      const pts: number[] = [];
      arcPts(r1, a0 + notch, a1 - notch, 10, pts);
      pts.push(Math.cos(a1) * (r0 + depth * 0.35), Math.sin(a1) * (r0 + depth * 0.35));
      arcPts(r0, a1 - notch * 0.4, a0 + notch * 0.4, 10, pts);
      pts.push(Math.cos(a0) * (r0 + depth * 0.35), Math.sin(a0) * (r0 + depth * 0.35));
      g.poly(pts).fill({ color: i % 2 ? HALDEN.face : HALDEN.faceLight }).stroke({ color: HALDEN.edge, width: 16 });
      // Its inner face, scorched by whatever it once held to the star
      const sc: number[] = [];
      arcPts(r0, a0 + notch, a1 - notch, 10, sc);
      g.poly(sc).stroke({ color: HALDEN.scorch, width: depth * 0.12, alpha: 0.7 });
      // The greyseam inlay: a line down its length, broken where the slab cracked
      const crack = rnd() < 0.5 ? a0 + w * (0.3 + rnd() * 0.4) : null;
      const inlay = (b0: number, b1: number) => {
        const p: number[] = [];
        arcPts(R + drift, b0, b1, 8, p);
        g.poly(p, false).stroke({ color: HALDEN.inlay, width: Math.max(10, depth * 0.05), alpha: 0.45 });
      };
      if (crack === null) inlay(a0 + notch * 2, a1 - notch * 2);
      else {
        inlay(a0 + notch * 2, crack - 0.004);
        inlay(crack + 0.004, a1 - notch * 2);
        g.moveTo(Math.cos(crack) * r0, Math.sin(crack) * r0).lineTo(Math.cos(crack + 0.006) * r1, Math.sin(crack + 0.006) * r1)
          .stroke({ color: 0x1c1f25, width: depth * 0.06 });
      }
    }
    this.label = new Text({ text: data.name.toUpperCase(), style: LABEL });
    this.label.anchor.set(0.5, 0);
    this.label.alpha = 0.45;
    this.label.scale.set(Math.min(6, Math.max(1, R / 6000)));
    this.label.y = R + depth * 2 + 300;
    this.container.addChild(this.ring, this.label);
  }

  update(dt: number): void {
    this.ring.rotation += dt * 0.0006;
    keepUpright(this.label);
  }
}

/**
 * A stillstone: its surface map (stillstoneMap.ts, built in a worker the first
 * time it's seen) drawn by StillstoneShader.ts, so its carving and grit take
 * the sun and every nearby light, and its grooves glow of their own, brightest
 * on the night side (away from the star), brightening and pulsing while your
 * drive charges in its field (`glow`, 0..1). A shattered one is lit polygons
 * (StillstoneMesh.ts). It turns slowly, never slowing, from the clock. Only a
 * live one marks its field. A frame only turns it and sets its glow.
 */
class LodestoneView {
  readonly container = new Container();
  /** The field's edge and haze (under the stone; live ones only) */
  private field = new Graphics();
  /** The stone (it turns) */
  private body = new Container();
  private lit: LitMesh;
  /** Its own uniforms and textures, once its map is built (shattered stones have none) */
  private stone: { glow: UniformGroup; textures: Texture[] } | null = null;
  private label: Text;
  private time = 0;
  private glow = 0;
  private gone = false;
  private readonly spin: { phase: number; rate: number };
  private readonly R: number;
  private readonly live: boolean;

  constructor(readonly data: LodestoneData, private lighting: Lighting | null) {
    const R = (this.R = lodestoneSize(data, JUMP));
    this.live = lodestoneLive(data);
    const state = data.state ?? 'active';
    this.spin = stillstoneSpin(data, R);
    if (state === 'shattered') {
      this.lit = new LitMesh(stillstoneShards(data, R).toGeometry());
    } else {
      // Drawn once its map is ready (a moment after it's first seen)
      this.lit = new LitMesh(stillstoneDisc(R));
      this.lit.mesh.visible = false;
      void stillstoneMapData(data).then((maps) => {
        if (this.gone) return;
        const litUniforms = (this.lit.shader.resources as Record<string, unknown>).litUniforms;
        const { shader, glow, textures } = stillstoneShader(maps, litUniforms, stillstoneGlowColor(data));
        (glow.uniforms.uGlow as Float32Array)[3] = state === 'dead' ? 0 : 1;
        this.stone = { glow, textures };
        this.lit.mesh.shader = shader;
        this.lit.mesh.visible = true;
      });
    }
    this.lit.radius = R * 1.3;
    lighting?.add(this.lit);
    this.body.addChild(this.lit.mesh);

    // The field's edge and haze: drawn once (full bright), turned and dimmed in update
    if (this.live) {
      const F = lodestoneFieldRadius(data, JUMP), segs = 96, step = state === 'scarred' ? 3 : 2;
      for (let i = 0; i < segs; i += step) {
        const a0 = (i / segs) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / segs;
        this.field.moveTo(Math.cos(a0) * F, Math.sin(a0) * F).arc(0, 0, F, a0, a1).stroke({ color: STONE.field, width: 14, alpha: 0.37 });
      }
      this.field.circle(0, 0, F).fill({ color: STONE.field, alpha: 0.045 });
      this.field.blendMode = 'add';
    }
    this.label = new Text({ text: lodestoneLabel(data, JUMP).toUpperCase(), style: LABEL });
    this.label.anchor.set(0.5, 0);
    this.label.alpha = 0.5;
    this.label.scale.set(Math.max(0.6, R / 2600));
    this.label.y = (this.live ? lodestoneFieldRadius(data, JUMP) : R * 1.1) + 120;
    this.container.addChild(this.field, this.body, this.label);
  }

  /** How far from its centre it shows (for culling) */
  get reach(): number {
    return Math.max(this.live ? lodestoneFieldRadius(this.data, JUMP) : 0, this.R * STILLSTONE_REACH) + 300;
  }

  update(dt: number, tick: number, glow: number): void {
    this.time += dt;
    const p = lodestonePosition(this.data, tick);
    this.container.x = p.x;
    this.container.y = p.y;
    // Its turn comes from the clock, so everyone sees it at the same angle
    const rot = this.spin.phase + this.spin.rate * (tick / 60);
    this.body.rotation = rot;
    keepUpright(this.label);
    this.glow += (glow - this.glow) * Math.min(1, dt * 3);
    if (this.live) {
      this.field.rotation = -this.time * 0.02;
      this.field.alpha = (0.12 + 0.25 * this.glow) / 0.37;
    }
    if (!this.stone) return;
    // The night side (away from the system centre), in the stone's own turning frame; the drive's charge; the clock
    const g = this.stone.glow.uniforms.uGlow as Float32Array;
    g[0] = Math.atan2(p.y, p.x) - rot; g[1] = this.glow; g[2] = this.time;
  }

  destroy(): void {
    this.gone = true;
    this.lighting?.remove(this.lit);
    this.container.destroy({ children: true });
    for (const t of this.stone?.textures ?? []) t.destroy(true);
  }
}

export class SceneryRenderer {
  readonly container = new Container();
  private comets: CometView[] = [];
  private rings: (SolarRingView | RuinRingView)[] = [];
  private lodestones: LodestoneView[] = [];
  /** What lights the stillstones (Renderer sets it; without it they show their plain colours) */
  lighting: Lighting | null = null;

  set(comets: CometData[], structures: StructureData[], lodestones: LodestoneData[] = []): void {
    for (const v of [...this.comets, ...this.rings]) v.container.destroy({ children: true });
    for (const v of this.lodestones) v.destroy();
    this.container.removeChildren();
    this.rings = structures.flatMap<SolarRingView | RuinRingView>((s) => (s.kind === 'solar_ring' ? [new SolarRingView(s)] : s.kind === 'ruin_ring' ? [new RuinRingView(s)] : []));
    this.comets = comets.map((c) => new CometView(c));
    this.lodestones = lodestones.map((l) => new LodestoneView(l, this.lighting));
    for (const v of [...this.rings, ...this.lodestones, ...this.comets]) this.container.addChild(v.container);
  }

  /** `glow`: how brightly a stillstone's veins pulse for your drive (0..1: ShipClient.lodestoneGlow) */
  update(dt: number, tick: number, view: { x0: number; y0: number; x1: number; y1: number }, glow?: (id: string) => number): void {
    for (const l of this.lodestones) {
      const p = lodestonePosition(l.data, tick), m = l.reach;
      l.container.visible = p.x + m > view.x0 && p.x - m < view.x1 && p.y + m > view.y0 && p.y - m < view.y1;
      if (l.container.visible) l.update(dt, tick, glow?.(l.data.id) ?? 0);
    }
    for (const r of this.rings) {
      const R = r.data.radius * 1.08 + 1400;
      r.container.visible = R > view.x0 && -R < view.x1 && R > view.y0 && -R < view.y1;
      if (r.container.visible) r.update(dt);
    }
    for (const c of this.comets) {
      c.update(dt, tick);
      const m = 20000;
      const { x, y } = c.container;
      c.container.visible = x + m > view.x0 && x - m < view.x1 && y + m > view.y0 && y - m < view.y1;
    }
  }
}
