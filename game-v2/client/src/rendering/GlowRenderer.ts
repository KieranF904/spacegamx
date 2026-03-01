/**
 * GlowRenderer - GPU-accelerated ambient glow rendering
 * 
 * Creates the large area lighting effect emanating from the sun
 * Uses a simple radial gradient shader with noise for variation
 */

import { Container, Mesh, MeshGeometry, Shader, GlProgram, State } from 'pixi.js';
import { debugConfig } from '../ui/DebugUI';

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
  uniform float uInnerRadius;
  uniform float uIntensity;
  uniform vec3 uInnerColor;
  uniform vec3 uOuterColor;
  uniform vec2 uParallax;  // Camera-based parallax offset
  uniform float uLOD;      // Level of detail: 0 = simple, 1 = detailed
  
  // Simple noise for subtle variation
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  
  // Multi-octave noise for smoother variation
  float fbm(vec2 p) {
    float val = 0.0;
    float amp = 0.5;
    // LOD-based octave count: 2-4 octaves based on zoom
    int maxOctaves = 2 + int(uLOD * 2.0);
    for (int i = 0; i < 4; i++) {
      if (i >= maxOctaves) break;
      val += amp * noise(p);
      p *= 2.0;
      amp *= 0.5;
    }
    return val;
  }
  
  // HSL to RGB conversion
  vec3 hsl2rgb(float h, float s, float l) {
    h = mod(h, 360.0) / 360.0;
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = l - c / 2.0;
    vec3 rgb;
    if (h < 1.0/6.0) rgb = vec3(c, x, 0.0);
    else if (h < 2.0/6.0) rgb = vec3(x, c, 0.0);
    else if (h < 3.0/6.0) rgb = vec3(0.0, c, x);
    else if (h < 4.0/6.0) rgb = vec3(0.0, x, c);
    else if (h < 5.0/6.0) rgb = vec3(x, 0.0, c);
    else rgb = vec3(c, 0.0, x);
    return rgb + m;
  }
  
  void main() {
    vec2 uv = (vUV - 0.5) * 2.0;
    
    // Apply parallax offset
    vec2 farParallaxUV = uv + uParallax * 0.1;
    vec2 midParallaxUV = uv + uParallax * 0.4;
    vec2 nearParallaxUV = uv + uParallax * 0.8;
    
    float dist = length(uv);
    
    // Skip pixels outside the glow area or inside the sun
    if (dist > 1.0 || dist < uInnerRadius) {
      fragColor = vec4(0.0);
      return;
    }
    
    // Calculate falloff from inner radius to outer edge
    float t = (dist - uInnerRadius) / (1.0 - uInnerRadius);
    
    // Smooth exponential falloff for natural light decay
    float falloff = pow(1.0 - t, 3.0);
    
    // === Organic radial waves with variance ===
    
    // Add noise to distort the radial distance - breaks perfect symmetry
    float distortAmount = 0.08;
    float farDistort = noise(farParallaxUV * 3.0 + uTime * 0.02) * distortAmount;
    float midDistort = noise(midParallaxUV * 4.0 - uTime * 0.03) * distortAmount;
    float nearDistort = noise(nearParallaxUV * 5.0 + uTime * 0.025) * distortAmount;
    
    // Distorted radial distances for organic feel
    float farDist = length(farParallaxUV) + farDistort;
    float midDist = length(midParallaxUV) + midDistort;
    float nearDist = length(nearParallaxUV) + nearDistort;
    
    // Gentle concentric ripples - lower frequencies, smoother
    float wave1 = sin(farDist * 12.0 - uTime * 0.3) * 0.5 + 0.5;
    float wave2 = sin(midDist * 18.0 + uTime * 0.2) * 0.5 + 0.5;
    float wave3 = sin(nearDist * 25.0 - uTime * 0.4) * 0.5 + 0.5;
    
    // Very smooth transitions
    wave1 = smoothstep(0.2, 0.8, wave1);
    wave2 = smoothstep(0.25, 0.75, wave2);
    wave3 = smoothstep(0.3, 0.7, wave3);
    
    // Fade waves toward edges
    float waveFade = pow(1.0 - t, 2.0);
    
    // Combine layers - very subtle modulation
    float waves = (wave1 * 0.4 + wave2 * 0.35 + wave3 * 0.25) * waveFade;
    
    // Very subtle application to falloff
    falloff *= 0.92 + waves * 0.16;
    
    // Very slight color variation
    float hueShift = (wave1 - 0.5) * 3.0;
    
    // Color ramp controlled by UI color pickers + subtle hue variation
    float hue = uHue + hueShift;
    vec3 hueTint = hsl2rgb(hue, 0.25, 0.55);
    vec3 ramp = mix(uInnerColor, uOuterColor, clamp(t, 0.0, 1.0));
    vec3 color = mix(ramp, ramp * hueTint * 1.1, 0.18);
    
    // Alpha with smooth edges
    float alpha = falloff * uIntensity;
    alpha *= smoothstep(1.0, 0.85, dist);  // Smooth outer edge
    alpha *= smoothstep(uInnerRadius, uInnerRadius + 0.08, dist);  // Smooth inner edge
    
    // Use premultiplied alpha for proper blending
    fragColor = vec4(color * alpha, alpha);
  }
`;

export class GlowRenderer {
  private container: Container;
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private time: number = 0;
  
  constructor() {
    this.container = new Container();
  }
  
  initialize(): void {
    // Large quad for the glow area
    const quadSize = 2.0;
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
    
    const geometry = new MeshGeometry({
      positions,
      uvs,
      indices,
    });
    
    // Create GL program
    const glProgram = new GlProgram({
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
    });
    
    // Create shader with inline uniform definitions (PixiJS v8 style)
    this.shader = new Shader({
      glProgram,
      resources: {
        glowUniforms: {
          uTime: { value: 0, type: 'f32' },
          uHue: { value: 40, type: 'f32' },
          uInnerRadius: { value: 0.15, type: 'f32' },
          uIntensity: { value: 0.6, type: 'f32' },
          uInnerColor: { value: new Float32Array([1.0, 0.75, 0.4]), type: 'vec3<f32>' },
          uOuterColor: { value: new Float32Array([1.0, 0.6, 0.4]), type: 'vec3<f32>' },
          uParallax: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uLOD: { value: 1.0, type: 'f32' },
        },
      },
    });
    
    // Create state with additive-like blending for glow effect
    const state = State.for2d();
    state.blend = true;
    
    this.mesh = new Mesh({
      geometry,
      shader: this.shader,
      state,
    });
    
    // Glow should be behind the sun
    this.container.addChild(this.mesh);
  }
  
  private lod: number = 1.0;
  
  update(
    delta: number,
    hue: number,
    sunRadius: number,
    glowRadius: number,
    cameraX: number = 0,
    cameraY: number = 0,
    intensity: number = 0.6,
    glowSize: number = 0.1,
    innerColor: [number, number, number] = [1.0, 0.75, 0.4],
    outerColor: [number, number, number] = [1.0, 0.6, 0.4],
  ): void {
    this.time += delta * 0.016;
    
    if (this.shader) {
      // Access uniforms through the group
      const group = this.shader.resources.glowUniforms as any;
      group.uniforms.uTime = this.time;
      group.uniforms.uHue = hue;
      const innerMul = 1.0 + Math.max(0, glowSize) * 2.0;
      group.uniforms.uInnerRadius = Math.min(0.95, (sunRadius * innerMul) / Math.max(1, glowRadius));
      group.uniforms.uIntensity = intensity;
      group.uniforms.uLOD = this.lod;
      group.uniforms.uInnerColor[0] = innerColor[0];
      group.uniforms.uInnerColor[1] = innerColor[1];
      group.uniforms.uInnerColor[2] = innerColor[2];
      group.uniforms.uOuterColor[0] = outerColor[0];
      group.uniforms.uOuterColor[1] = outerColor[1];
      group.uniforms.uOuterColor[2] = outerColor[2];
      // Parallax scale from debug config (adjustable via F3 debug panel)
      const parallaxScale = debugConfig.parallaxScale;
      group.uniforms.uParallax[0] = -cameraX * parallaxScale;
      group.uniforms.uParallax[1] = -cameraY * parallaxScale;
    }
    
    if (this.mesh) {
      // Scale to cover the glow area in world coordinates
      this.mesh.scale.set(glowRadius, glowRadius);
    }
  }
  
  setPosition(x: number, y: number): void {
    this.container.position.set(x, y);
  }
  
  setLOD(lod: number): void {
    this.lod = Math.max(0, Math.min(1, lod));
  }
  
  getContainer(): Container {
    return this.container;
  }
  
  destroy(): void {
    this.mesh?.destroy();
    this.shader = null;
  }
}
