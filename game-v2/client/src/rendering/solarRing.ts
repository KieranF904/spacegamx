/**
 * The Helios Array (a `solar_ring` structure): a megastructure of collector arrays round the star, drawn as ONE mesh
 * with one small shader, built once when the system loads. A frame only turns it and sets a few uniforms.
 *
 * Each of its `segments` (outward from the star):
 * - an inner rim, a bright sunlit edge tying the arrays together;
 * - six collector modules (two columns either side of a spoke, three rows), photovoltaic cells in the shared solar-cell
 *   look (solarCells.ts: the stations' and the Helios Drone's), each in a thin frame, its own small tilt (sheen);
 * - a spoke up the middle carrying a gold power conduit, a dim amber lamp at its tip;
 * - a Warren truss between two chords (the main ring), a beacon on the outer chord blinking red or green.
 * Every tenth segment is a hub instead: an octagonal service module astride the truss with a gold docking ring and a
 * slow amber beacon, a mast inward, and two ribbed radiators outward (away from the star), warm at the root.
 * `oldArc` segments are Halden work: slate slabs with notched corners and a greyseam inlay where the cells would be.
 *
 * The light: the star is the ring's centre, so in the ring's own (turning) frame the sun is always radially inward,
 * and how much each surface faces it never changes; it's baked into the vertices (`shade`). The shader only takes
 * the system's ambient and the sun's colour at this radius (from Lighting), the clock (lamps, a slow sweep of sheen
 * round the arrays) and the cell tile. No Graphics are redrawn, ever. It turns by the server clock (solarRingGeometry.ts),
 * so the system map (ui/mapStructures.ts) draws its hubs and Halden arc where they are.
 */

import { BufferImageSource, Container, Geometry, GlProgram, Mesh, Shader, State, Text, TextStyle, Texture, UniformGroup } from 'pixi.js';
import type { StructureData } from '@space-game/common';
import { SOLAR, solarCellTexel } from './solarCells';
import { keepUpright } from './cameraView';
import type { Lighting } from './lighting/Lighting';
import { CELL_TILE, RING_KIND, solarRingAngle, solarRingGeometry } from './solarRingGeometry';

const VERTEX = `#version 300 es
in vec2 aPosition;
in vec2 aUV;
in vec3 aColor;
in vec4 aMat;
out vec2 vUV;
out vec3 vColor;
out vec4 vMat;
out vec2 vDir2;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  vUV = aUV; vColor = aColor; vMat = aMat;
  // (twice its angle round the ring, as a direction: interpolates smoothly where atan would wrap)
  vec2 d = normalize(aPosition);
  vDir2 = vec2(d.x * d.x - d.y * d.y, 2.0 * d.x * d.y);
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vColor;
in vec4 vMat;
in vec2 vDir2;
out vec4 fragColor;
uniform sampler2D uCells;
// x: clock (s); y: world units per cell tile; zw: the sheen sweep's direction (doubled angle)
uniform vec4 uRing;
uniform vec3 uAmb;
uniform vec3 uSunC;
void main() {
  int kind = int(vMat.x + 0.5);
  // (sampled for every pixel, outside the branches: ANGLE flattens them anyway)
  vec4 cellTex = texture(uCells, vUV / uRing.y);
  vec3 light = min(uAmb + uSunC * vMat.y, vec3(1.6));
  float t = uRing.x;
  if (kind == ${RING_KIND.metal}) {
    fragColor = vec4(vColor * light, 1.0);
  } else if (kind == ${RING_KIND.cells}) {
    // Solar cells (solarCells.ts): navy-violet cells sunk between silver bus lines and frame, a navy floor, a blue-white
    // anti-reflective sheen (each module's own tilt, and a slow sweep round the ring) with a thin-film shift
    float h = cellTex.r * 4.0 - 2.0, e = cellTex.g;
    float lum = dot(light, vec3(0.33));
    vec3 cell = ${SOLAR.cell} * min(light, vec3(1.2)) * 0.62 * (1.0 + 0.3 * clamp(h, -1.0, 1.0)) + ${SOLAR.floor};
    vec3 bus = ${SOLAR.bus} * (min(lum, 1.2) * 0.6 + 0.06);
    float sweep = pow(max(dot(vDir2, uRing.zw), 0.0), 24.0);
    vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vMat.w * 1.3 + vec3(0.0, 0.33, 0.67)));
    vec3 sheen = mix(${SOLAR.sheen}, irid, 0.3) * dot(uSunC, vec3(0.33)) * (0.04 + 0.22 * vMat.w * vMat.w * vMat.w + 0.3 * sweep);
    fragColor = vec4(mix(cell, bus, e) + sheen * (1.0 - 0.6 * e), 1.0);
  } else if (kind == ${RING_KIND.radiator}) {
    // Ribbed radiator panels, warm where they leave the hub
    float rib = 0.88 + 0.12 * smoothstep(0.3, 0.9, abs(fract(vUV.x / 23.0) * 2.0 - 1.0));
    vec3 heat = vec3(1.0, 0.42, 0.12) * 0.22 * exp(-vUV.y / 200.0) * (0.85 + 0.15 * sin(t * 0.9));
    fragColor = vec4(vColor * light * rib + heat, 1.0);
  } else if (kind == ${RING_KIND.inlay}) {
    // Greyseam: a faint cold shimmer of its own
    float s = 0.5 + 0.22 * sin(t * 0.8 + vMat.z + vUV.x * 0.012);
    fragColor = vec4(vColor * s + vColor * light * 0.25, 1.0);
  } else {
    // Lamps: steady, a short blink (as the old beacons: 12% of each 1.25 s), or a slow pulse
    float mode = vMat.w;
    float on = mode < 0.5 ? 0.55 + 0.1 * sin(t * 0.7 + vMat.z) : mode < 1.5 ? (fract(t * 0.8 + vMat.z) < 0.12 ? 1.0 : 0.16) : 0.55 + 0.45 * sin(t * 1.6 + vMat.z);
    float r = length(vUV);
    if (kind == ${RING_KIND.lamp}) {
      float a = smoothstep(1.0, 0.8, r);
      fragColor = vec4(mix(vColor, vec3(1.0), 0.45) * (0.35 + 0.9 * on) * a, a);
    } else {
      // (added: alpha 0)
      float g = exp(-r * r * 7.0) * (1.0 - smoothstep(0.85, 1.0, r));
      fragColor = vec4(vColor * g * on * 0.55, 0.0);
    }
  }
}
`;

let program: GlProgram | null = null;
/** The ring's program (gameShaders compiles it ahead) */
export function solarRingProgram(): GlProgram {
  return (program ??= new GlProgram({ vertex: VERTEX, fragment: FRAGMENT, name: 'solar-ring' }));
}

let cells: Texture | null = null;
/** One tile of cells (solarCellTexel): r its relief (height/4 + 0.5), g its silver; mipmapped, repeating */
export function solarCellTexture(): Texture {
  if (cells) return cells;
  const N = 256, data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const { v, e } = solarCellTexel(i, j), o = (j * N + i) * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, v / 4 + 0.5)) * 255);
    data[o + 1] = Math.round(e * 255);
    data[o + 3] = 255;
  }
  return (cells = new Texture({ source: new BufferImageSource({
    resource: data, width: N, height: N, alphaMode: 'no-premultiply-alpha', addressMode: 'repeat', scaleMode: 'linear', mipmapFilter: 'linear', autoGenerateMipmaps: true,
  }) }));
}

const LABEL = new TextStyle({ fontFamily: 'Segoe UI, sans-serif', fontSize: 48, fill: 0xbfe6ff, letterSpacing: 5 });

export class SolarRingView {
  readonly container = new Container();
  private mesh: Mesh<Geometry, Shader>;
  private uniforms: UniformGroup;
  private time = 0;
  private label: Text;

  constructor(readonly data: StructureData, private lighting: Lighting | null = null) {
    const g = solarRingGeometry(data);
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: g.positions, format: 'float32x2' },
        aUV: { buffer: g.uvs, format: 'float32x2' },
        aColor: { buffer: g.colors, format: 'float32x3' },
        aMat: { buffer: g.mats, format: 'float32x4' },
      },
      indexBuffer: g.indices,
    });
    this.uniforms = new UniformGroup({
      uRing: { value: new Float32Array([0, CELL_TILE, 1, 0]), type: 'vec4<f32>' },
      uAmb: { value: new Float32Array([0.16, 0.16, 0.2]), type: 'vec3<f32>' },
      uSunC: { value: new Float32Array([1.1, 1.0, 0.86]), type: 'vec3<f32>' },
    });
    const tex = solarCellTexture();
    const shader = new Shader({ glProgram: solarRingProgram(), resources: { ringUniforms: this.uniforms, uCells: tex.source } });
    const state = State.for2d();
    state.blend = true;
    this.mesh = new Mesh<Geometry, Shader>({ geometry, shader, state });
    this.label = new Text({ text: data.name.toUpperCase(), style: LABEL });
    this.label.anchor.set(0.5, 0);
    this.label.alpha = 0.5;
    this.label.scale.set(Math.min(6, Math.max(1, data.radius / 6000)));
    this.label.y = data.radius + 1700;
    this.container.addChild(this.mesh, this.label);
  }

  /** `tick`: the server tick (it turns by the clock, so the map shows its hubs where they are) */
  update(dt: number, tick: number): void {
    this.time += dt;
    this.mesh.rotation = solarRingAngle(tick);
    keepUpright(this.label);
    const u = this.uniforms.uniforms as { uRing: Float32Array; uAmb: Float32Array; uSunC: Float32Array };
    // The sheen's sweep goes round twice a turn of its own (as the old glints did), slowly
    const sweep = this.time * 0.25;
    u.uRing[0] = this.time; u.uRing[2] = Math.cos(sweep); u.uRing[3] = Math.sin(sweep);
    // The system's ambient and the sun's light at this radius (Lighting off: plain colours)
    const L = this.lighting;
    if (L) {
      const on = L.enabled, s = L.sun, R = this.data.radius;
      const k = on ? (s.power / (1 + (R * R) / (s.falloff * s.falloff))) : 0;
      for (let c = 0; c < 3; c++) {
        u.uAmb[c] = on ? Math.max(0.1, L.ambient[c]) : 1;
        u.uSunC[c] = s.color[c] * Math.min(1.25, k);
      }
    }
  }
}
