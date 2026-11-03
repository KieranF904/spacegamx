/**
 * Guns' moving hardware, per family and model: a turret's head (its gunhouse
 * and barrels, turned as one) and a fixed gun's barrels (which recoil out of
 * the facing edge). Shapes are in the gun's own frame (u out along the
 * barrel, v across; grid units), each a pre-shaded metal tone or an accent,
 * drawn once in their colours and tinted per frame (light, damage, heat).
 * Cylinders are shaded across their axis (dark flanks, lit spine) so they
 * read round however the turret turns.
 *
 *   cannon      Pip a light gun on a dome; Hammer a thick short barrel with a
 *               slotted muzzle brake; Twinlink two linked barrels; Longbarrel
 *               a slim barrel with cooling rings; Bastion a massive armoured
 *               house, fume extractor and brake
 *   autocannon  rotary clusters (3 or 6 barrels in clamps); Stinger a vented shroud
 *   flak        quad barrels with flash hiders, fed from drums
 *   mortar      stubby wide tubes, the bore seen as a dark mouth
 *   laser       a lens on a finned tube; Cutter a wide aperture; Searchlight a dish
 *   pulse       a coil stack round its core
 *   missile     a pod with a grid of tube mouths
 *   railgun     twin rails, a glowing slot between; Coilgun banded; Spear heavy
 *   emp         a spike, or a dish round one
 *   arc         a tesla coil: wound toroid, prongs
 *   torpedo     fat tubes
 *   lance       a heavy emitter: an armoured shroud slotted over its glowing core, a
 *               faceted spar through focusing collars, a crystal between two prongs
 *   legendary   their own (honeycomb pod, ice spikes, petals, crystal, rings, orb)
 *
 * Pure (no DOM): the hull worker builds fixed barrels with it.
 */

import { SHIP_FUNCTIONS } from './shipFunctionData';
import shipModels from '../../../data/ships/models.json';
import { hexToNum } from './shipColors';

/** `glow`: lit by itself (lenses, coils, tips), not by the light it's in */
export interface GunShape { pts: number[]; color: number; glow?: boolean }
/** A gun's moving hardware: shapes (back to front), its silhouette (for cracks) */
export interface GunParts { shapes: GunShape[]; outline: number[][] }

// Metal tones (pre-tint): bore, dark flank, body, lit, spine
const BORE = 0x11151d, DK = 0x434b58, MT = 0x7a8494, LT = 0xaab4c2, HI = 0xdde3ec;
const WARM = 0xb45309;
/** Barrels drawn fatter than true scale, so they read at game zoom (a cell is ~24 px) */
const FAT = 1.5;

/** Each weapon function's family, model, accent and glow */
interface GunId { family: string; model: string; accent: number; glow?: number }
const LEGACY = (shipModels as unknown as { legacy: Record<string, string> }).legacy;
/** Functions with neither a family nor a legacy one: by their decor */
const BY_DECOR: Record<string, string> = { cannon: 'cannon', flak: 'flak', laser: 'laser', railgun: 'railgun', lance: 'lance', missile: 'missile', emp: 'emp', exotic: 'exotic' };
const IDS = new Map<string, GunId>(SHIP_FUNCTIONS.filter((f) => f.weapon).map((f) => [f.id, {
  family: f.family ?? LEGACY[f.id] ?? BY_DECOR[f.decor ?? ''] ?? 'cannon',
  model: f.model ? f.id : '',
  accent: f.color ? hexToNum(f.color) : 0xe05a4a,
  glow: f.glow ? hexToNum(f.glow) : undefined,
}]));
export const gunId = (fn: string): GunId => IDS.get(fn) ?? { family: 'cannon', model: '', accent: 0xe05a4a };

/** Mix two colours */
const mix = (a: number, b: number, t: number) => {
  const c = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (c(16) << 16) | (c(8) << 8) | c(0);
};

/**
 * A gun being drawn: `k` its scale (√cells), `m` where its muzzle is (u),
 * `b0` where its barrels start (inside the gunhouse, or under the hull's edge)
 */
class Gun {
  shapes: GunShape[] = [];
  outline: number[][] = [];
  readonly b0: number;
  readonly paint: number;
  readonly lens: number;
  constructor(readonly k: number, readonly m: number, readonly turret: boolean, readonly id: GunId) {
    this.b0 = turret ? 0 : -0.12;
    // (the family colour, toned to sit on metal)
    this.paint = mix(id.accent, MT, 0.25);
    this.lens = id.glow ?? 0xff5a4a;
  }
  /** (`glow`: drawn with the lit bits, over the metal: anything in the lens colour, or set) */
  add(pts: number[], color: number, sil = false, glow = color === this.lens): number[] {
    this.shapes.push(glow ? { pts, color, glow } : { pts, color });
    if (sil) this.outline.push(pts);
    return pts;
  }
  box(u0: number, u1: number, v0: number, v1: number, color: number, sil = false) { return this.add([u0, v0, u1, v0, u1, v1, u0, v1], color, sil); }
  /** A chamfered plate (corners cut by c) */
  plate(u0: number, u1: number, v0: number, v1: number, c: number, color: number, sil = false) {
    return this.add([u0 + c, v0, u1 - c, v0, u1, v0 + c, u1, v1 - c, u1 - c, v1, u0 + c, v1, u0, v1 - c, u0, v0 + c], color, sil);
  }
  ngon(u: number, v: number, r: number, sides: number, color: number, sil = false, squash = 1, turn = 0.5) {
    const pts: number[] = [];
    for (let i = 0; i < sides; i++) { const a = ((i + turn) / sides) * Math.PI * 2; pts.push(u + Math.cos(a) * r * squash, v + Math.sin(a) * r); }
    return this.add(pts, color, sil);
  }
  /** A cylinder along u: dark flanks, a body, a lit spine */
  cyl(u0: number, u1: number, v: number, w: number, sil = true, body = MT) {
    w *= FAT;
    this.box(u0, u1, v - w, v + w, DK, sil);
    this.box(u0, u1, v - w * 0.64, v + w * 0.64, body);
    this.box(u0, u1, v - w * 0.22, v + w * 0.18, HI);
  }
  /** A tapered tube (w0 at u0 to w1 at u1), shaded the same */
  taper(u0: number, u1: number, v: number, w0: number, w1: number, sil = true) {
    w0 *= FAT; w1 *= FAT;
    const q = (s: number, c: number, o = false) => this.add([u0, v - w0 * s, u1, v - w1 * s, u1, v + w1 * s, u0, v + w0 * s], c, o);
    q(1, DK, sil); q(0.64, MT); q(0.2, HI);
  }
  /** A band round a barrel (collar, ring, clamp) */
  band(u: number, v: number, w: number, t: number, color = LT) {
    w *= FAT;
    this.box(u - t / 2, u + t / 2, v - w, v + w, DK, true);
    this.box(u - t / 2, u + t / 2, v - w * 0.7, v + w * 0.7, color);
  }
  /** A domed gunhouse: rim, body, cap (turrets only) */
  dome(r: number, sides = 10, u = 0) {
    if (!this.turret) return;
    this.ngon(u, 0, r, sides, DK, true);
    this.ngon(u, 0, r * 0.8, sides, MT);
    this.ngon(u - r * 0.06, 0, r * 0.45, sides, LT);
  }
  /** A box gunhouse (turrets only): chamfered, with its paint stripe across the back */
  house(u0: number, u1: number, hw: number, c = 0.06) {
    if (!this.turret) return;
    const k = this.k;
    this.plate(u0, u1, -hw, hw, c * k, DK, true);
    this.plate(u0 + 0.03 * k, u1 - 0.03 * k, -hw + 0.03 * k, hw - 0.03 * k, c * k * 0.7, MT);
    this.box(u0 + 0.05 * k, u0 + 0.1 * k, -hw * 0.75, hw * 0.75, this.paint);
  }
  /** A muzzle brake: a block with ports */
  brake(u0: number, u1: number, w: number) {
    w *= FAT;
    this.box(u0, u1, -w, w, DK, true);
    this.box(u0 + (u1 - u0) * 0.1, u1 - (u1 - u0) * 0.1, -w * 0.78, w * 0.78, LT);
    for (const f of [0.3, 0.68]) this.box(u0 + (u1 - u0) * (f - 0.1), u0 + (u1 - u0) * (f + 0.1), -w * 0.92, w * 0.92, BORE);
  }
  /** A tube's open mouth seen from the side (a dark ellipse in a lit rim) */
  mouth(u: number, v: number, w: number) {
    w *= FAT;
    this.ngon(u, v, w, 8, LT, false, 0.42, 0);
    this.ngon(u, v, w * 0.78, 8, BORE, false, 0.34, 0);
  }
  /** A tube mouth seen from above (a pod's launch tubes) */
  tube(u: number, v: number, r: number, rim = WARM) {
    this.ngon(u, v, r * 1.15, 8, LT);
    this.ngon(u, v, r, 8, rim);
    this.ngon(u, v, r * 0.68, 8, BORE);
  }
  /** Something lit (lens, coil, tip) */
  glow(pts: number[]) { this.add(pts, this.lens); }
}

type Design = (g: Gun) => void;

/** Rotary cluster: n barrels across ±spread, clamps along */
function rotary(g: Gun, n: number, spread: number, w: number, clamps: number[], hr: number) {
  const { k, m, b0 } = g;
  g.dome(hr * k, 10);
  if (g.turret) g.box(-hr * k * 0.9, -hr * k * 0.35, hr * k * 0.55, hr * k * 1.05, g.paint, true);
  const s = spread * k;
  for (let i = 0; i < n; i++) g.cyl(b0, m, n === 1 ? 0 : -s + (2 * s * i) / (n - 1), w * k);
  for (const c of clamps) g.band(b0 + (m - b0) * c, 0, s + w * k * 1.6, 0.05 * k);
  g.band(m - 0.03 * k, 0, s + w * k * 1.4, 0.05 * k, MT);
}

/** Quad flak: two pairs, flash hiders, drums */
function quad(g: Gun, spread: number, w: number, drums: number) {
  const { k, m, b0 } = g;
  g.dome(0.25 * k, 10);
  if (g.turret) for (let d = 0; d < drums; d++) {
    const v = drums === 1 ? 0 : (d ? 1 : -1) * 0.2 * k;
    g.ngon(-0.2 * k, v, 0.12 * k, 8, DK, true);
    g.ngon(-0.2 * k, v, 0.09 * k, 8, g.paint);
    g.ngon(-0.2 * k, v, 0.035 * k, 6, WARM);
  }
  for (const v of [-spread, -spread * 0.36, spread * 0.36, spread]) {
    g.cyl(b0, m, v * k, w * k);
    g.box(m - 0.09 * k, m, v * k - w * k * 1.9, v * k + w * k * 1.9, DK, true);
  }
  g.band(b0 + (m - b0) * 0.42, 0, spread * k + w * k * 1.8, 0.06 * k);
}

/** A crescent dish, open forward, centred at u (radius r) */
function dish(g: Gun, u: number, r: number) {
  const out: number[] = [], inn: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = -1.15 + (2.3 * i) / 8;
    out.push(u - Math.cos(a) * r * 0.45, Math.sin(a) * r);
    inn.unshift(u - Math.cos(a) * r * 0.2 + r * 0.06, Math.sin(a) * r * 0.86);
  }
  g.add([...out, ...inn], DK, true);
  const mid: number[] = [], mi: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = -1.05 + (2.1 * i) / 8;
    mid.push(u - Math.cos(a) * r * 0.36, Math.sin(a) * r * 0.9);
    mi.unshift(u - Math.cos(a) * r * 0.22 + r * 0.04, Math.sin(a) * r * 0.8);
  }
  g.add([...mid, ...mi], LT);
}

const DESIGNS: Record<string, Design> = {
  // ---- cannon
  cannon_pip: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.25 * k, 10);
    g.cyl(b0, m, 0, 0.065 * k);
    g.band(g.turret ? 0.25 * k : 0.05 * k, 0, 0.085 * k, 0.07 * k);
    g.band(m - 0.035 * k, 0, 0.09 * k, 0.07 * k);
  },
  cannon_hammer: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.3 * k, 0.24 * k, 0.28 * k, 0.1);
    if (g.turret) for (const s of [-1, 1]) g.box(-0.18 * k, 0.12 * k, s * 0.2 * k - 0.04 * k, s * 0.2 * k + 0.04 * k, LT);
    g.cyl(b0, m - 0.16 * k, 0, 0.12 * k);
    g.cyl(b0, b0 + (m - b0) * 0.42, 0, 0.15 * k, true, LT);
    g.brake(m - 0.18 * k, m, 0.17 * k);
  },
  cannon_twinlink: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.24 * k, 0.2 * k, 0.3 * k, 0.12);
    for (const v of [-0.13, 0.13]) {
      g.cyl(b0, m, v * k, 0.06 * k);
      g.band(m - 0.035 * k, v * k, 0.08 * k, 0.06 * k);
    }
    // The link: a yoke across both
    const u = b0 + (m - b0) * 0.62;
    g.box(u - 0.04 * k, u + 0.04 * k, -0.2 * k, 0.2 * k, DK, true);
    g.box(u - 0.025 * k, u + 0.025 * k, -0.18 * k, 0.18 * k, g.paint);
  },
  cannon_longbarrel: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.22 * k, 10);
    if (g.turret) g.box(-0.3 * k, -0.16 * k, -0.07 * k, 0.07 * k, LT, true);
    g.taper(b0, m, 0, 0.07 * k, 0.05 * k);
    for (const f of [0.3, 0.45, 0.6, 0.75]) g.band(b0 + (m - b0) * f, 0, 0.085 * k, 0.04 * k);
    g.band(m - 0.03 * k, 0, 0.07 * k, 0.06 * k, MT);
  },
  cannon_bastion: (g) => {
    const { k, m, b0 } = g;
    if (g.turret) {
      g.ngon(0, 0, 0.36 * k, 8, DK, true);
      g.ngon(0, 0, 0.31 * k, 8, MT);
      // Sloped armour over the front, bolted
      g.add([0.08 * k, -0.27 * k, 0.3 * k, -0.15 * k, 0.3 * k, 0.15 * k, 0.08 * k, 0.27 * k], LT);
      for (const s of [-1, 1]) g.ngon(-0.16 * k, s * 0.2 * k, 0.03 * k, 6, DK);
      g.box(-0.3 * k, -0.24 * k, -0.18 * k, 0.18 * k, g.paint);
    }
    g.cyl(b0, m - 0.2 * k, 0, 0.11 * k);
    g.cyl(b0 + (m - b0) * 0.5, b0 + (m - b0) * 0.66, 0, 0.15 * k, true, LT);
    g.brake(m - 0.22 * k, m, 0.2 * k);
  },
  // ---- autocannon: rotary
  autocannon_rattler: (g) => rotary(g, 3, 0.085, 0.03, [0.55, 0.85], 0.24),
  autocannon_chainsaw: (g) => {
    rotary(g, 4, 0.14, 0.032, [0.35, 0.65, 0.9], 0.27);
    // Its belt feed, from a box on the side
    if (g.turret) g.box(-0.08 * g.k, 0.12 * g.k, -0.34 * g.k, -0.22 * g.k, LT, true);
  },
  autocannon_stinger: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.23 * k, 10);
    g.cyl(b0, m, 0, 0.035 * k);
    // A vented shroud over most of it
    const s1 = b0 + (m - b0) * 0.82;
    g.cyl(g.turret ? 0.12 * k : b0, s1, 0, 0.08 * k);
    for (let i = 0; i < 4; i++) {
      const u = (g.turret ? 0.2 * k : 0.05 * k) + ((s1 - (g.turret ? 0.2 * k : 0.05 * k)) * (i + 0.5)) / 4;
      for (const s of [-1, 1]) g.box(u - 0.025 * k, u + 0.025 * k, s * 0.045 * k - 0.018 * k, s * 0.045 * k + 0.018 * k, BORE);
    }
  },
  // ---- flak: quad
  flak_burst: (g) => quad(g, 0.19, 0.032, 1),
  flak_cloudmaker: (g) => quad(g, 0.23, 0.036, 2),
  // ---- mortar: stubby wide tubes
  mortar_lobber: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.27 * k, 10);
    const u0 = g.turret ? 0.05 * k : b0;
    g.taper(u0, m - 0.04 * k, 0, 0.13 * k, 0.16 * k);
    g.band(u0 + (m - u0) * 0.35, 0, 0.17 * k, 0.05 * k);
    g.mouth(m - 0.04 * k, 0, 0.17 * k);
  },
  mortar_quake: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.3 * k, 0.16 * k, 0.3 * k, 0.12);
    const u0 = g.turret ? 0.02 * k : b0;
    // Recoil springs either side of one great bore
    for (const s of [-1, 1]) g.cyl(u0, u0 + (m - u0) * 0.7, s * 0.25 * k, 0.035 * k, true, LT);
    g.taper(u0, m - 0.05 * k, 0, 0.17 * k, 0.21 * k);
    g.band(u0 + (m - u0) * 0.3, 0, 0.22 * k, 0.06 * k);
    g.mouth(m - 0.05 * k, 0, 0.22 * k);
  },
  // ---- laser: a lens
  laser_glint: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.23 * k, 10);
    if (g.turret) g.ngon(0, 0, 0.06 * k, 6, g.lens);
    g.cyl(b0, m - 0.16 * k, 0, 0.055 * k);
    for (const f of [0.3, 0.5]) {
      const u = b0 + (m - b0) * f;
      g.box(u - 0.035 * k, u + 0.035 * k, -0.11 * k, 0.11 * k, DK, true);
    }
    g.add([m - 0.17 * k, -0.06 * k, m, -0.11 * k, m, 0.11 * k, m - 0.17 * k, 0.06 * k], DK, true);
    g.glow([m - 0.05 * k, -0.08 * k, m, -0.09 * k, m, 0.09 * k, m - 0.05 * k, 0.08 * k]);
  },
  laser_cutter: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.26 * k, 0.16 * k, 0.27 * k, 0.1);
    const u0 = g.turret ? 0.1 * k : b0, u1 = m - 0.14 * k;
    g.cyl(u0, u1, 0, 0.15 * k);
    for (let i = 0; i < 3; i++) { const u = u0 + ((u1 - u0) * (i + 0.6)) / 3.4; g.box(u - 0.02 * k, u + 0.02 * k, -0.17 * k, 0.17 * k, DK); }
    // A wide aperture, lit right across
    g.add([u1, -0.14 * k, m, -0.23 * k, m, 0.23 * k, u1, 0.14 * k], DK, true);
    g.glow([m - 0.05 * k, -0.2 * k, m, -0.21 * k, m, 0.21 * k, m - 0.05 * k, 0.2 * k]);
  },
  laser_searchlight: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.2 * k, 10);
    const d = m - 0.2 * k;
    g.cyl(b0, d, 0, 0.045 * k);
    dish(g, d, 0.3 * k);
    // The feed at its focus, on a strut
    g.box(d, m - 0.04 * k, -0.015 * k, 0.015 * k, LT);
    g.ngon(m - 0.04 * k, 0, 0.05 * k, 6, g.lens);
  },
  // ---- pulse: coil stack
  pulse_strobe: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.23 * k, 10);
    g.cyl(b0, m, 0, 0.045 * k);
    const u0 = g.turret ? 0.26 * k : 0.02 * k;
    for (let i = 0; i < 3; i++) {
      const u = u0 + ((m - 0.08 * k - u0) * i) / 2;
      g.box(u - 0.035 * k, u + 0.035 * k, -0.1 * k, 0.1 * k, DK, true);
      g.glow([u - 0.018 * k, -0.085 * k, u + 0.018 * k, -0.085 * k, u + 0.018 * k, 0.085 * k, u - 0.018 * k, 0.085 * k]);
    }
  },
  pulse_overpulse: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.26 * k, 0.18 * k, 0.28 * k, 0.12);
    for (const v of [-0.08, 0.08]) g.cyl(b0, m, v * k, 0.04 * k);
    const u0 = g.turret ? 0.24 * k : 0.02 * k;
    for (let i = 0; i < 5; i++) {
      const u = u0 + ((m - 0.06 * k - u0) * i) / 4;
      g.box(u - 0.03 * k, u + 0.03 * k, -0.17 * k, 0.17 * k, DK, true);
      g.glow([u - 0.014 * k, -0.15 * k, u + 0.014 * k, -0.15 * k, u + 0.014 * k, 0.15 * k, u - 0.014 * k, 0.15 * k]);
    }
  },
  // ---- missile: a pod with tubes
  missile_dart: (g) => pod(g, 2, 2, 0.2, 0.22),
  missile_swarm: (g) => pod(g, 3, 3, 0.27, 0.26),
  missile_hammerhead: (g) => {
    const { k, m } = g;
    if (!g.turret) { g.box(-0.12, 0.18 * k, -0.32 * k, -0.26 * k, LT, true); g.box(-0.12, 0.18 * k, 0.26 * k, 0.32 * k, LT, true); return; }
    g.plate(-0.3 * k, Math.min(m, 0.34 * k), -0.32 * k, 0.32 * k, 0.08 * k, DK, true);
    g.plate(-0.27 * k, Math.min(m, 0.34 * k) - 0.03 * k, -0.29 * k, 0.29 * k, 0.06 * k, MT);
    for (const v of [-0.14, 0.14]) {
      g.tube(0.02 * k, v * k, 0.12 * k);
      // The warhead's nose in its tube
      g.ngon(0.02 * k, v * k, 0.045 * k, 6, LT);
    }
    g.box(-0.27 * k, -0.2 * k, -0.25 * k, 0.25 * k, g.paint);
  },
  // ---- railgun: twin rails
  railgun_needle: (g) => rails(g, 0.09, 0.042, [], 0.22),
  railgun_coilgun: (g) => rails(g, 0.095, 0.042, [0.3, 0.48, 0.66, 0.84], 0.24),
  // Rail Driver: a short shrouded rifle, one housing over the rails, side vents behind a lit slot
  railgun_rail_driver: (g) => {
    rails(g, 0.075, 0.038, [], 0.26);
    const k = g.k, { b0, m } = g;
    g.box(b0, b0 + (m - b0) * 0.62, -0.13 * k, 0.13 * k, DK, true);
    g.box(b0 + 0.02 * k, b0 + (m - b0) * 0.6, -0.1 * k, 0.1 * k, LT);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) {
      const x = b0 + (m - b0) * (0.12 + i * 0.15);
      g.box(x, x + 0.045 * k, s * 0.1 * k, s * 0.135 * k, DK);
    }
  },
  railgun_spear: (g) => {
    rails(g, 0.13, 0.06, [0.5], 0.3);
    // Capacitor banks on the house's flanks
    const k = g.k;
    if (g.turret) for (const s of [-1, 1]) { g.box(-0.24 * k, 0.1 * k, s * 0.3 * k - 0.05 * k, s * 0.3 * k + 0.05 * k, DK, true); g.box(-0.2 * k, 0.06 * k, s * 0.3 * k - 0.025 * k, s * 0.3 * k + 0.025 * k, g.lens); }
  },
  // ---- emp: spike, dish
  emp_hush: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.22 * k, 10);
    if (g.turret) { g.ngon(0, 0, 0.13 * k, 10, LT); g.ngon(0, 0, 0.09 * k, 10, g.lens); }
    g.cyl(b0, m - 0.22 * k, 0, 0.045 * k);
    g.add([m - 0.22 * k, -0.06 * k, m - 0.04 * k, -0.015 * k, m - 0.04 * k, 0.015 * k, m - 0.22 * k, 0.06 * k], LT, true);
    g.band(m - 0.22 * k, 0, 0.08 * k, 0.04 * k);
    g.ngon(m - 0.04 * k, 0, 0.045 * k, 6, g.lens);
  },
  emp_blackout: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.28 * k, 12);
    const d = b0 + (m - b0) * 0.45;
    g.cyl(b0, d, 0, 0.06 * k);
    dish(g, d, 0.36 * k);
    g.add([d, -0.05 * k, m - 0.05 * k, -0.015 * k, m - 0.05 * k, 0.015 * k, d, 0.05 * k], LT, true);
    for (const f of [0.35, 0.65]) g.band(d + (m - d) * f, 0, 0.05 * k, 0.03 * k, g.lens);
    g.ngon(m - 0.05 * k, 0, 0.06 * k, 6, g.lens);
  },
  // ---- arc: tesla coil
  arc_spark: (g) => coil(g, 0.2, [0]),
  arc_tesla: (g) => coil(g, 0.27, [0, -0.45, 0.45]),
  // ---- torpedo: fat tubes
  torpedo_eel: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.26 * k, 0.12 * k, 0.24 * k, 0.1);
    g.cyl(b0, m, 0, 0.13 * k);
    g.band(b0 + (m - b0) * 0.5, 0, 0.15 * k, 0.05 * k);
    g.band(m - 0.04 * k, 0, 0.15 * k, 0.07 * k, MT);
    g.mouth(m, 0, 0.12 * k);
  },
  torpedo_leviathan: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.3 * k, 0.14 * k, 0.34 * k, 0.12);
    for (const v of [-0.2, 0.2]) {
      g.cyl(b0, m, v * k, 0.11 * k);
      g.band(m - 0.04 * k, v * k, 0.125 * k, 0.07 * k, MT);
      g.mouth(m, v * k, 0.1 * k);
    }
    const u = b0 + (m - b0) * 0.5;
    g.box(u - 0.05 * k, u + 0.05 * k, -0.31 * k, 0.31 * k, DK, true);
    g.box(u - 0.03 * k, u + 0.03 * k, -0.29 * k, 0.29 * k, g.paint);
  },
  // ---- lance: the super-tier beam, a heavy emitter
  lance_lance: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.3 * k, 0.12 * k, 0.27 * k, 0.12);
    const u0 = g.turret ? 0.04 * k : b0, L = m - u0;
    // An armoured shroud over the back half: tapered, chamfered at the front, its paint band at the back
    const s1 = u0 + L * 0.5, sw = 0.19 * k;
    g.add([u0, -sw, s1 - 0.04 * k, -sw * 0.92, s1 + 0.05 * k, -sw * 0.62, s1 + 0.05 * k, sw * 0.62, s1 - 0.04 * k, sw * 0.92, u0, sw], DK, true);
    g.add([u0, -sw * 0.8, s1 - 0.05 * k, -sw * 0.74, s1 + 0.02 * k, -sw * 0.5, s1 + 0.02 * k, 0, u0, 0], LT);
    g.add([u0, 0, s1 + 0.02 * k, 0, s1 + 0.02 * k, sw * 0.5, s1 - 0.05 * k, sw * 0.74, u0, sw * 0.8], MT);
    g.box(u0 + L * 0.04, u0 + L * 0.09, -sw * 0.86, sw * 0.86, g.paint);
    // Slots across it, the charged core glowing through each
    for (const f of [0.17, 0.27, 0.37]) {
      const u = u0 + L * f;
      g.box(u - 0.024 * k, u + 0.024 * k, -sw * 0.66, sw * 0.66, BORE);
      g.add([u - 0.012 * k, -sw * 0.5, u + 0.012 * k, -sw * 0.5, u + 0.012 * k, sw * 0.5, u - 0.012 * k, sw * 0.5], g.lens, false, true);
    }
    // The spar: a faceted prism, one face lit, one in shade, out to the head
    const a = s1, b = m - 0.17 * k, pw = 0.085 * k;
    g.add([a, -pw, b, -pw * 0.8, b + 0.04 * k, 0, b, pw * 0.8, a, pw], DK, true);
    g.add([a, -pw * 0.75, b - 0.01 * k, -pw * 0.6, b + 0.02 * k, 0, a, 0], LT);
    g.add([a, 0, b + 0.02 * k, 0, b - 0.01 * k, pw * 0.6, a, pw * 0.75], MT);
    // Its core: a lit channel the whole length
    g.add([u0 + L * 0.12, -0.02 * k, b + 0.03 * k, -0.012 * k, b + 0.03 * k, 0.012 * k, u0 + L * 0.12, 0.02 * k], g.lens, false, true);
    // Focusing collars on the spar, smaller towards the head
    for (const [f, w] of [[0.18, 0.105], [0.55, 0.09]] as const) {
      const u = a + (b - a) * f;
      g.box(u - 0.028 * k, u + 0.028 * k, -w * k, w * k, DK, true);
      g.box(u - 0.016 * k, u + 0.016 * k, -w * k * 0.82, w * k * 0.82, LT);
    }
    // The head: two prongs swept forward and in, lit at their tips, a crystal between them
    for (const s of [-1, 1]) {
      g.add([b - 0.13 * k, s * 0.05 * k, b - 0.02 * k, s * 0.17 * k, m + 0.03 * k, s * 0.1 * k, m + 0.03 * k, s * 0.07 * k, b + 0.02 * k, s * 0.1 * k, b - 0.08 * k, s * 0.035 * k], DK, true);
      g.add([b - 0.1 * k, s * 0.055 * k, b - 0.02 * k, s * 0.145 * k, m + 0.01 * k, s * 0.09 * k, b + 0.02 * k, s * 0.085 * k], s < 0 ? LT : MT);
      g.ngon(m + 0.02 * k, s * 0.085 * k, 0.022 * k, 6, g.lens);
    }
    g.add([b - 0.02 * k, 0, b + 0.07 * k, -0.045 * k, m + 0.02 * k, 0, b + 0.07 * k, 0.045 * k], g.lens, false, true);
    g.add([b + 0.03 * k, 0, b + 0.07 * k, -0.02 * k, m - 0.01 * k, 0, b + 0.07 * k, 0.02 * k], 0xf5ecff, false, true);
  },
  // ---- legendaries
  hive: (g) => {
    const { k, m } = g;
    if (!g.turret) { g.box(-0.12, 0.14 * k, -0.3 * k, 0.3 * k, DK, true); return; }
    g.ngon(0.02 * k, 0, 0.34 * k, 6, DK, true, 1, 0);
    g.ngon(0.02 * k, 0, 0.3 * k, 6, MT, false, 1, 0);
    for (const [u, v] of [[0, 0], [0.15, 0.09], [0.15, -0.09], [-0.15, 0.09], [-0.15, -0.09], [0, 0.18], [0, -0.18]]) {
      g.ngon(u * k + 0.02 * k, v * k, 0.075 * k, 6, mix(g.lens, MT, 0.25), false, 1, 0);
      g.ngon(u * k + 0.02 * k, v * k, 0.05 * k, 6, BORE, false, 1, 0);
    }
    void m;
  },
  frostbite: (g) => {
    DESIGNS.laser_glint(g);
    const { k, m } = g;
    // Ice spikes round the emitter
    for (const s of [-1, 1]) g.add([m - 0.22 * k, s * 0.06 * k, m - 0.02 * k, s * 0.17 * k, m - 0.12 * k, s * 0.05 * k], g.lens, true);
  },
  cinder_bloom: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.25 * k, 10);
    g.cyl(b0, m - 0.12 * k, 0, 0.05 * k);
    // Petals open round a glowing heart
    for (let i = 0; i < 5; i++) {
      const a = -1.1 + (2.2 * i) / 4, c = Math.cos(a), s = Math.sin(a);
      const u = m - 0.12 * k;
      g.add([u, 0, u + c * 0.16 * k - s * 0.05 * k, s * 0.16 * k + c * 0.05 * k, u + c * 0.2 * k, s * 0.2 * k, u + c * 0.16 * k + s * 0.05 * k, s * 0.16 * k - c * 0.05 * k], i % 2 ? LT : g.paint, true);
    }
    g.ngon(m - 0.1 * k, 0, 0.06 * k, 7, g.lens);
  },
  prism: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.24 * k, 10);
    g.cyl(b0, m - 0.24 * k, 0, 0.05 * k);
    // A crystal held in a claw
    g.add([m - 0.26 * k, 0, m - 0.12 * k, -0.11 * k, m, 0, m - 0.12 * k, 0.11 * k], g.lens, true);
    g.add([m - 0.22 * k, 0, m - 0.12 * k, -0.07 * k, m - 0.05 * k, 0], HI);
    for (const s of [-1, 1]) g.box(m - 0.3 * k, m - 0.16 * k, s * 0.1 * k - 0.02 * k, s * 0.1 * k + 0.02 * k, LT, true);
  },
  phase: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.24 * k, 0.12 * k, 0.24 * k, 0.12);
    g.cyl(b0, m, 0, 0.05 * k);
    for (const f of [0.45, 0.8]) {
      const u = b0 + (m - b0) * f;
      g.ngon(u, 0, 0.16 * k, 10, DK, true, 0.3, 0);
      g.ngon(u, 0, 0.13 * k, 10, g.lens, false, 0.22, 0);
    }
  },
  singularity: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.25 * k, 10);
    g.cyl(b0, m - 0.16 * k, 0, 0.045 * k);
    // An orb held in a ring
    g.ngon(m - 0.12 * k, 0, 0.15 * k, 12, DK, true);
    g.ngon(m - 0.12 * k, 0, 0.12 * k, 12, g.lens);
    g.ngon(m - 0.12 * k, 0, 0.07 * k, 10, BORE);
    // (its dark heart goes over the lit ring)
    g.shapes[g.shapes.length - 1].glow = true;
  },
  exotic: (g) => {
    const { k, m, b0 } = g;
    g.dome(0.24 * k, 10);
    g.cyl(b0, m - 0.08 * k, 0, 0.1 * k);
    g.ngon(m - 0.08 * k, 0, 0.11 * k, 8, g.lens);
  },
  /** The demolition launcher: a stubby launch rail */
  demolition: (g) => {
    const { k, m, b0 } = g;
    g.house(-0.22 * k, 0.12 * k, 0.22 * k, 0.1);
    g.box(b0, m, -0.1 * k, 0.1 * k, DK, true);
    g.box(b0, m - 0.04 * k, -0.06 * k, 0.06 * k, g.paint);
    g.ngon(m - 0.08 * k, 0, 0.05 * k, 6, WARM);
  },
};

/** Pod: cols × rows tube mouths on a box (turrets); a fixed launcher shows only its rails (the bay is the hull's) */
function pod(g: Gun, cols: number, rows: number, hw: number, hl: number) {
  const { k, m } = g;
  if (!g.turret) {
    for (const s of [-1, 1]) g.box(-0.12, 0.14 * k, s * (hw + 0.02) * k - 0.025 * k, s * (hw + 0.02) * k + 0.025 * k, LT, true);
    return;
  }
  const u1 = Math.min(m, hl * k);
  g.plate(-hl * k, u1, -hw * k, hw * k, 0.05 * k, DK, true);
  g.plate(-hl * k + 0.03 * k, u1 - 0.03 * k, -hw * k + 0.03 * k, hw * k - 0.03 * k, 0.04 * k, MT);
  const pu = (hl * k + u1 - 0.08 * k) / cols, pv = (2 * hw * k - 0.08 * k) / rows, r = Math.min(pu, pv) * 0.36;
  for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) g.tube(-hl * k + 0.04 * k + pu * (a + 0.5), -hw * k + 0.04 * k + pv * (b + 0.5), r);
  // Side rails
  for (const s of [-1, 1]) g.box(-hl * k * 0.7, u1 * 0.8, s * hw * k - 0.02 * k, s * hw * k + 0.02 * k, LT);
}

/** Twin rails, a lit slot between, coil bands (fractions along) */
function rails(g: Gun, o: number, w: number, coils: number[], hr: number) {
  const { k, m, b0 } = g;
  g.house(-hr * k, hr * k * 0.5, hr * k, 0.1);
  g.glow([b0, -o * k * 0.4, m - 0.04 * k, -o * k * 0.25, m - 0.04 * k, o * k * 0.25, b0, o * k * 0.4]);
  for (const s of [-1, 1]) {
    g.box(b0, m, s * o * k - w * k, s * o * k + w * k, DK, true);
    g.box(b0, m, s * o * k - w * k * 0.5, s * o * k + w * k * 0.4, LT);
  }
  for (const f of coils) g.band(b0 + (m - b0) * f, 0, (o + w * 2) * k, 0.045 * k, g.lens === 0xff5a4a ? LT : mix(LT, g.lens, 0.6));
}

/** A tesla coil: wound toroid, prongs at these angles, lit tips */
function coil(g: Gun, r: number, prongs: number[]) {
  const { k, m } = g;
  const c = g.turret ? 0 : -0.12;
  if (g.turret) {
    g.ngon(c, 0, r * k, 12, DK, true);
    g.ngon(c, 0, r * k * 0.86, 12, LT);
    g.ngon(c, 0, r * k * 0.7, 12, DK);
    g.ngon(c, 0, r * k * 0.56, 12, MT);
    g.ngon(c, 0, r * k * 0.3, 8, g.lens);
  }
  for (const a of prongs) {
    const ca = Math.cos(a), sa = Math.sin(a), from = g.turret ? r * k * 0.9 : -0.1, to = a ? m * 0.82 : m - 0.05 * k;
    const w = 0.025 * k;
    g.add([c + ca * from + sa * w, sa * from - ca * w, c + ca * to, sa * to, c + ca * from - sa * w, sa * from + ca * w], LT, true);
    g.ngon(c + ca * to, sa * to, 0.045 * k, 6, g.lens);
  }
}

/** A family's base look (legacy parts, and models without their own) */
const FAMILY: Record<string, string> = {
  cannon: 'cannon_pip', autocannon: 'autocannon_rattler', flak: 'flak_burst', mortar: 'mortar_lobber', laser: 'laser_glint',
  pulse: 'pulse_strobe', missile: 'missile_dart', railgun: 'railgun_needle', emp: 'emp_hush', arc: 'arc_spark',
  torpedo: 'torpedo_eel', lance: 'lance_lance',
  // (Support weapons, common/src/ships/features/support/support.ts: the Repair Beam an emitter in its own green, point defence a quick little autocannon)
  repair: 'laser_glint', point_defence: 'autocannon_rattler',
};
const designOf = (id: GunId): Design => DESIGNS[id.model] ?? DESIGNS[id.family] ?? DESIGNS[FAMILY[id.family] ?? 'cannon_pip'];

/** How far a fixed gun's barrels reach past its edge (×√cells), by model or family */
const REACH: Record<string, number> = {
  cannon_pip: 0.5, cannon_hammer: 0.48, cannon_twinlink: 0.55, cannon_longbarrel: 0.95, cannon_bastion: 0.62,
  autocannon_rattler: 0.5, autocannon_chainsaw: 0.6, autocannon_stinger: 0.66, flak_burst: 0.42, flak_cloudmaker: 0.52,
  mortar_lobber: 0.32, mortar_quake: 0.38, laser_glint: 0.45, laser_cutter: 0.38, laser_searchlight: 0.5,
  pulse_strobe: 0.5, pulse_overpulse: 0.6, missile_dart: 0.18, missile_swarm: 0.18, missile_hammerhead: 0.2,
  railgun_needle: 0.95, railgun_rail_driver: 0.8, railgun_coilgun: 0.85, railgun_spear: 1, emp_hush: 0.42, emp_blackout: 0.5,
  arc_spark: 0.38, arc_tesla: 0.42, torpedo_eel: 0.55, torpedo_leviathan: 0.6, lance_lance: 0.95,
  hive: 0.16, frostbite: 0.5, cinder_bloom: 0.45, prism: 0.5, phase: 0.55, singularity: 0.45, exotic: 0.42, demolition: 0.3,
};
const reachOf = (id: GunId) => REACH[id.model] ?? REACH[id.family] ?? REACH[FAMILY[id.family] ?? ''] ?? 0.5;

/** Turret heads made, by function, length and size (the same few over and over: every ship like another has its guns) */
const HEADS = new Map<string, GunParts>();
const HEADS_KEPT = 512;

/**
 * A turret's head: gunhouse and barrels about its pivot, the muzzle `len` out (cells; `size` its cells). Made once for
 * each (fn, len, size) and shared: read it, don't change it.
 */
export function turretHead(fn: string, len: number, size: number): GunParts {
  const key = `${fn}|${len}|${size}`;
  let head = HEADS.get(key);
  if (head) return head;
  const id = gunId(fn);
  const g = new Gun(Math.sqrt(Math.max(1, size)), len, true, id);
  designOf(id)(g);
  head = { shapes: g.shapes, outline: g.outline };
  if (HEADS.size >= HEADS_KEPT) HEADS.delete(HEADS.keys().next().value!);
  HEADS.set(key, head);
  return head;
}

/** How far a fixed gun's barrels reach past its edge (cells; `size` its cells): where its beam is drawn from */
export function fixedReach(fn: string, size: number): number {
  return reachOf(gunId(fn)) * Math.sqrt(Math.max(1, size));
}

/** A fixed gun's barrels, out of its edge (u 0), and how far they reach (cells) */
export function fixedGun(fn: string, size: number): GunParts & { len: number } {
  const id = gunId(fn);
  const k = Math.sqrt(Math.max(1, size)), len = reachOf(id) * k;
  const g = new Gun(k, len, false, id);
  designOf(id)(g);
  return { shapes: g.shapes, outline: g.outline, len };
}

/** Which fixed housing a family sits in (partDecor) */
export type Housing = 'casemate' | 'well' | 'emitter' | 'spinal' | 'bay' | 'socket';
const HOUSING: Record<string, Housing> = {
  cannon: 'casemate', autocannon: 'casemate', flak: 'casemate', mortar: 'well', torpedo: 'bay',
  laser: 'emitter', pulse: 'emitter', frostbite: 'emitter', prism: 'emitter', phase: 'emitter', cinder_bloom: 'emitter', singularity: 'emitter', exotic: 'emitter',
  railgun: 'spinal', lance: 'spinal', missile: 'bay', hive: 'bay', demolition: 'bay', emp: 'socket', arc: 'socket',
  repair: 'emitter', point_defence: 'casemate',
};
export const housingOf = (fn: string): Housing => HOUSING[gunId(fn).family] ?? 'casemate';

/** Which turret ring-mount a family sits on (partDecor): its base's shape */
export type TurretBase = 'ring' | 'round' | 'lugged' | 'tub' | 'stalk' | 'braced';
const TURRET_BASE: Record<string, TurretBase> = {
  cannon: 'ring', missile: 'ring', torpedo: 'ring', railgun: 'ring', lance: 'ring', demolition: 'ring',
  autocannon: 'round', flak: 'lugged', hive: 'lugged', mortar: 'tub',
  laser: 'stalk', pulse: 'stalk', frostbite: 'stalk', cinder_bloom: 'stalk', prism: 'stalk', phase: 'stalk', singularity: 'stalk', exotic: 'stalk',
  emp: 'braced', arc: 'braced',
  repair: 'stalk', point_defence: 'round',
};
export const turretBaseOf = (fn: string): TurretBase => TURRET_BASE[gunId(fn).family] ?? 'ring';
