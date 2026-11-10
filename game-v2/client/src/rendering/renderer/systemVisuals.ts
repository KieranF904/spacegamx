/**
 * @contract client.render.system-visuals
 * owns:       a system's look as the renderer holds it (SystemVisuals), built from the server's systemInfo, and the light it casts (ambient and sun)
 * needs:      common ServerSystemInfoMessage and StarSystemData, Lighting, SurfaceRenderer, SkyBiome
 * invariants: until systemInfo arrives a system draws with DEFAULT_SYSTEM_VISUALS, which a systemInfo naming no hue or radius also builds — client/src/rendering/renderer/rendererModules.test.ts
 * extend:     a new systemInfo visual field is one more line in visualsFromInfo() and one on SystemVisuals
 */

import type { ServerSystemInfoMessage, StarSystemData } from '@space-game/common';
import type { CentralType } from '../CentralBodyShaders';
import type { Lighting } from '../lighting/Lighting';
import type { SurfaceRenderer } from '../surface/SurfaceRenderer';
import { SUN_DIR } from '../surface/SurfaceRenderer';
import type { SkyBiome } from '../sky/skyBiome';

/** A surface's daylight (night dims it) */
export interface Day { ambient: [number, number, number]; power: number; sun: [number, number, number] }

// System-specific visual configuration
// Populated from server 'systemInfo' messages (data-driven via systems.json),
// with a Sol-like fallback for systems without data.
export interface SystemVisuals {
  starHue: number;          // Base hue for the central star (0-360)
  starRadius: number;       // Size of central star
  specialStarChance?: number;      // Chance for special colored stars
  specialStarHue?: number;         // Hue for special stars
  hasNebula?: boolean;
  /** Hazards here ('darkness' dims the ambient light) */
  hazards?: string[];
  nebulaHue?: number;
  sunStyle?: string;
  sunStyleParams?: Record<string, number>;
  coronaStyle?: string;
  coronaStyleParams?: Record<string, number>;
  /** Central body type 'none' (e.g. the proto empty scene): no sun or glow */
  noCentralBody?: boolean;
  /** Black holes and pulsars get their own shaders instead of the sun */
  centralType?: CentralType;
  centralRadius?: number;
  centralHue?: number;
  /** Detail-star mode: full fBM/warp/plasma control (like sandbox detail_sun) */
  detailStar?: boolean;
  detailParams?: Record<string, number>;
  detailColors?: Record<string, string>;
  /** Starfield shader config (sandbox-style GPU starfield) */
  starfield?: {
    starBrightness?: number;
    twinkleSpeed?: number;
    twinkleAmount?: number;
    hueShift?: number;
    density?: number;
    starSize?: number;
    parallaxStrength?: number;
    baseCell?: number;
    lodBlendWidth?: number;
  };
}

// Fallback visuals used until the server sends systemInfo
export const DEFAULT_SYSTEM_VISUALS: SystemVisuals = {
  starHue: 40,
  starRadius: 1000,
  sunStyle: 'granular',
  coronaStyle: 'plasmaStreams',
};

/**
 * A system's visuals from a server systemInfo message
 * (called when entering a system, or on join).
 */
export function visualsFromInfo(msg: ServerSystemInfoMessage): SystemVisuals {
  const visuals: SystemVisuals = {
    starHue: msg.centralBody.hue ?? 40,
    starRadius: msg.centralBody.radius ?? 1000,
    sunStyle: msg.centralBody.sunStyle,
    sunStyleParams: msg.centralBody.sunStyleParams,
    coronaStyle: msg.centralBody.coronaStyle,
    coronaStyleParams: msg.centralBody.coronaStyleParams,
    specialStarChance: msg.visuals.specialStarChance,
    specialStarHue: msg.visuals.specialStarHue,
    hasNebula: msg.visuals.hasNebula,
    hazards: msg.hazards,
    nebulaHue: msg.visuals.nebulaHue,
    starfield: {
      hueShift: msg.visuals.starHueShift,
    },
  };

  // Detail-star mode: full fBM/warp/plasma control
  const cb = msg.centralBody as any;
  visuals.noCentralBody = cb.type === 'none';
  if (cb.type === 'black_hole' || cb.type === 'pulsar' || cb.type === 'brown_dwarf') {
    visuals.centralType = cb.type;
    visuals.centralRadius = cb.radius ?? 1000;
    visuals.centralHue = cb.type === 'black_hole' ? (cb.diskHue ?? 30) : cb.type === 'brown_dwarf' ? (cb.hue ?? 14) : (cb.beamHue ?? 190);
  }
  if (cb.detailStar) {
    visuals.detailStar = true;
    visuals.detailParams = cb.detailParams ?? {};
    visuals.detailColors = cb.detailColors ?? {};
  }
  return visuals;
}

/** Convert HSL to hex color (matching original game's color system) */
export function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}

export function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const hex = hslToHex(h, s * 100, l * 100);
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/**
 * A system's light: its ambient (from its sky, dimmer in dark systems, or
 * set in its data) and its central body's (a sun's warm light, a black
 * hole's disc glow, a pulsar's cold one).
 */
export function lightSystem(lighting: Lighting, surface: SurfaceRenderer, sys: StarSystemData | undefined, v: SystemVisuals, biome: SkyBiome, setDay: (d: Day) => void): void {
  // A planet's surface: daylight, from the same way the ground is shaded
  const day = sys?.surface ? surface.light() : null;
  if (day) {
    const tl = Math.max(...day.tint) || 1;
    // Underground: no sun, a little dim light, most of it the glow of the cracks in the floor coming up
    if (!day.sun) {
      lighting.ambient = [0, 1, 2].map((i) => day.ambient * (0.45 + 0.55 * (day.tint[i] / tl))) as [number, number, number];
      lighting.sun.power = 0;
      lighting.ground = day.ground;
      setDay({ ambient: [...lighting.ambient] as [number, number, number], power: 0, sun: [1, 1, 1] });
      return;
    }
    const lava = sys?.surface?.kind === 'lava';
    // (a lava world's sky is its own haze: the light takes much more of its colour, and the sun comes through it warm)
    lighting.ambient = [0, 1, 2].map((i) => day.ambient * ((lava ? 0.55 : 0.8) + (lava ? 0.45 : 0.2) * (day.tint[i] / tl))) as [number, number, number];
    Object.assign(lighting.sun, { x: -SUN_DIR[0] * 1e8, y: -SUN_DIR[1] * 1e8, falloff: 1e9, power: 0.8, color: lava ? [1, 0.82, 0.66] : [1, 0.96, 0.88], elevation: 0.85 });
    lighting.ground = day.ground;
    setDay({ ambient: [...lighting.ambient] as [number, number, number], power: 0.8, sun: [...lighting.sun.color] as [number, number, number] });
    return;
  }
  lighting.ground = [0, 0, 0];
  const AMBIENT: Record<string, number> = { band: 0.3, cluster: 0.32, emission: 0.28, ember: 0.22, remnant: 0.22, void: 0.06, abyss: 0.07 };
  let level = typeof sys?.visuals?.ambient === 'number' ? sys.visuals.ambient : AMBIENT[biome.kind] ?? 0.25;
  if (v.hazards?.includes('darkness')) level *= 0.6;
  // Tinted a little by the sky's own colour
  const tint = biome.nebula.strength > 0.05 ? biome.nebula.b : biome.band.edge;
  const tl = Math.max(tint[0], tint[1], tint[2]) || 1;
  lighting.ambient = [0, 1, 2].map((i) => level * (0.75 + 0.25 * (tint[i] / tl))) as [number, number, number];
  const sun = lighting.sun;
  sun.x = 0; sun.y = 0;
  if (v.noCentralBody) sun.power = 0;
  else if (v.centralType === 'black_hole') {
    Object.assign(sun, { power: 1.1, falloff: (v.centralRadius ?? 1000) * 10, color: hslRgb(v.centralHue ?? 30, 0.85, 0.62), elevation: 0.55 });
  } else if (v.centralType === 'pulsar') {
    Object.assign(sun, { power: 0.9, falloff: 25000, color: hslRgb(v.centralHue ?? 190, 0.6, 0.78), elevation: 0.7 });
  } else if (v.centralType === 'brown_dwarf') {
    // Dim and red: the planets and rocks catch a low ember light
    Object.assign(sun, { power: 0.75, falloff: 30000 + (v.centralRadius ?? 0), color: hslRgb(v.centralHue ?? 14, 0.75, 0.6), elevation: 0.45 });
  } else {
    const r = v.detailStar ? v.detailParams?.radius ?? v.starRadius : v.starRadius;
    Object.assign(sun, { power: 1.0, falloff: 39000 + r, color: hslRgb(v.starHue, 0.55, 0.84), elevation: 0.55 });
  }
}
