import { Container, Mesh, MeshGeometry, Shader, GlProgram, State } from 'pixi.js';

const VERTEX_SHADER = `#version 300 es
  in vec2 aPosition;
  in vec2 aUV;

  out vec2 vUV;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;

  void main() {
    vUV = aUV;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `#version 300 es
  precision highp float;

  in vec2 vUV;
  out vec4 fragColor;

  uniform float uTime;
  uniform float uHue;
  uniform float uIntensity;
  uniform float uInnerRadius;
  uniform float uOuterRadius;
  uniform float uRayCount;
  uniform float uRayWidth;
  uniform float uRayVariation;
  uniform float uRaySpeed;
  uniform float uRayTurbulence;
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

  // 2D simplex noise; we sample it as 1D by fixing y lanes.
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  vec3 hsl2rgb(float h, float s, float l) {
    h = mod(h, 360.0) / 360.0;
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = l - c * 0.5;
    vec3 rgb;
    if (h < 1.0 / 6.0) rgb = vec3(c, x, 0.0);
    else if (h < 2.0 / 6.0) rgb = vec3(x, c, 0.0);
    else if (h < 3.0 / 6.0) rgb = vec3(0.0, c, x);
    else if (h < 4.0 / 6.0) rgb = vec3(0.0, x, c);
    else if (h < 5.0 / 6.0) rgb = vec3(x, 0.0, c);
    else rgb = vec3(c, 0.0, x);
    return rgb + m;
  }

  void main() {
    vec2 uv = (vUV - 0.5) * 2.0;
    float r = length(uv);
    float outer = max(0.02, uOuterRadius);
    float inner = clamp(uInnerRadius, 0.0, max(0.0, outer - 0.02));

    // Map normalized mesh radius [0..1] to corona multiplier space [0..outer].
    // This lets corona outer radius extend beyond 1.0 without clipping.
    float rMul = r * outer;
    if (rMul > outer) {
      fragColor = vec4(0.0);
      return;
    }

    // No sun core rendered in this effect
    if (rMul <= inner) {
      fragColor = vec4(0.0);
      return;
    }

    float a = atan(uv.y, uv.x);
    float ang01 = (a + 3.14159265) / 6.2831853;
    float theta = ang01 * 6.2831853;
    vec2 ring = vec2(cos(theta), sin(theta));
    float baseFreq = max(1.0, uRayCount);
    float t = uTime * (0.08 + uRaySpeed * 0.35);

    // Seamless wrapped 1D fields: sample simplex on a circular domain.
    // This guarantees start/end continuity at 0/360 degrees.
    float nShape = snoise(ring * baseFreq + vec2(t, 0.0) + vec2(3.7, 11.7));
    float nLen   = snoise(ring * (baseFreq * 0.83) + vec2(t * 0.7, 0.0) + vec2(37.1, 53.3));
    float nFine  = snoise(ring * (baseFreq * 1.9) + vec2(t * 1.2, 0.0) + vec2(91.9, 17.0));
    float nInt   = snoise(ring * (baseFreq * 1.35) + vec2(t * 1.05, 0.0) + vec2(12.4, 77.6));

    nShape = nShape * 0.5 + 0.5;
    nLen   = nLen   * 0.5 + 0.5;
    nFine  = nFine  * 0.5 + 0.5;
    nInt   = nInt   * 0.5 + 0.5;

    // Continuous angular field: points blend into each other naturally.
    float angularStrength = mix(0.35, 1.0, nShape);
    angularStrength *= mix(1.0 - 0.35 * uRayVariation, 1.0 + 0.35 * uRayVariation, nFine);

    // Extrusion length dictated by second animated 1D field.
    float localOuter = mix(inner + 0.05, outer, nLen);
    localOuter += (nFine - 0.5) * 0.15 * uRayTurbulence;
    localOuter = clamp(localOuter, inner + 0.05, outer);

    // Radial profile with pointed tip.
    float radialIn = smoothstep(inner, inner + 0.05 + uRayWidth * 0.3, rMul);
    float radialOut = 1.0 - smoothstep(localOuter - (0.06 + uRayWidth * 0.4), localOuter, rMul);
    float radialBand = radialIn * radialOut;

    float span = max(0.001, localOuter - inner);
    float rn = clamp((rMul - inner) / span, 0.0, 1.0);
    float pointTaper = pow(1.0 - rn, 1.6);

    // Mild non-rotational shimmer by stepping noise only.
    float shimmer = 0.92 + 0.16 * snoise(ring * (baseFreq * 2.7) + vec2(t * 1.8, 0.0) + vec2(141.3, 8.5));

    // Explicit intensity noise control (driven by "Intensity Noise" slider)
    float intensityNoise = mix(1.0 - 0.6 * uRayVariation, 1.0 + 0.6 * uRayVariation, nInt);

    float alpha = angularStrength * radialBand * pointTaper * shimmer * intensityNoise * uIntensity;
    alpha *= 0.65;

    // Color blend from base to tip with subtle hue modulation
    float hueShift = (nShape - 0.5) * 7.0 + (nFine - 0.5) * 4.0;
    vec3 hueMod = hsl2rgb(uHue + hueShift, 0.25, 0.55);
    vec3 rampColor = mix(uBaseColor, uTipColor, smoothstep(0.2, 1.0, rn));
    vec3 color = mix(rampColor, rampColor * hueMod * 1.15, 0.2);

    fragColor = vec4(color * alpha, alpha);
  }
`;

export class CoronaRaysRenderer {
  private container: Container;
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private time = 0;

  constructor() {
    this.container = new Container();
  }

  initialize(): void {
    const quadSize = 1.0;
    const positions = new Float32Array([
      -quadSize, -quadSize,
       quadSize, -quadSize,
       quadSize,  quadSize,
      -quadSize,  quadSize,
    ]);

    const uvs = new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]);

    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const geometry = new MeshGeometry({ positions, uvs, indices });

    const glProgram = new GlProgram({ vertex: VERTEX_SHADER, fragment: FRAGMENT_SHADER });

    this.shader = new Shader({
      glProgram,
      resources: {
        coronaUniforms: {
          uTime: { value: 0, type: 'f32' },
          uHue: { value: 40, type: 'f32' },
          uIntensity: { value: 0.7, type: 'f32' },
          uInnerRadius: { value: 0.45, type: 'f32' },
          uOuterRadius: { value: 0.9, type: 'f32' },
          uRayCount: { value: 10, type: 'f32' },
          uRayWidth: { value: 0.06, type: 'f32' },
          uRayVariation: { value: 0.35, type: 'f32' },
          uRaySpeed: { value: 0.35, type: 'f32' },
          uRayTurbulence: { value: 0.15, type: 'f32' },
          uBaseColor: { value: new Float32Array([1.0, 0.7, 0.4]), type: 'vec3<f32>' },
          uTipColor: { value: new Float32Array([1.0, 0.88, 0.7]), type: 'vec3<f32>' },
        },
      },
    });

    const state = State.for2d();
    state.blend = true;

    this.mesh = new Mesh({ geometry, shader: this.shader, state });
    this.container.addChild(this.mesh);
  }

  update(
    deltaMs: number,
    hue: number,
    worldRadius: number,
    opts: {
      intensity: number;
      innerRadiusMul: number;
      outerRadiusMul: number;
      rayCount: number;
      rayWidth: number;
      rayVariation: number;
      raySpeed: number;
      rayTurbulence: number;
      baseColor: [number, number, number];
      tipColor: [number, number, number];
    },
  ): void {
    this.time += deltaMs * 0.001;

    const safeOuter = Math.max(0.02, opts.outerRadiusMul);

    if (this.shader) {
      const u = (this.shader.resources.coronaUniforms as any).uniforms;
      u.uTime = this.time;
      u.uHue = hue;
      u.uIntensity = opts.intensity;
      u.uInnerRadius = opts.innerRadiusMul;
      u.uOuterRadius = safeOuter;
      u.uRayCount = opts.rayCount;
      u.uRayWidth = opts.rayWidth;
      u.uRayVariation = opts.rayVariation;
      u.uRaySpeed = opts.raySpeed;
      u.uRayTurbulence = opts.rayTurbulence;
      u.uBaseColor[0] = opts.baseColor[0];
      u.uBaseColor[1] = opts.baseColor[1];
      u.uBaseColor[2] = opts.baseColor[2];
      u.uTipColor[0] = opts.tipColor[0];
      u.uTipColor[1] = opts.tipColor[1];
      u.uTipColor[2] = opts.tipColor[2];
    }

    if (this.mesh) {
      this.mesh.scale.set(worldRadius * safeOuter, worldRadius * safeOuter);
    }
  }

  setPosition(x: number, y: number): void {
    this.container.position.set(x, y);
  }

  getContainer(): Container {
    return this.container;
  }

  destroy(): void {
    if (this.mesh) {
      this.mesh.destroy({ children: true, texture: false, textureSource: false });
      this.mesh = null;
    }
    this.shader = null;
    this.container.destroy({ children: true });
  }
}
