/**
 * SunRenderer - GPU-accelerated sun rendering with custom shaders
 * 
 * Uses PixiJS v8 mesh shaders for smooth, performant sun visuals
 * Features: flowfield noise, solar flares, corona, limb darkening
 */

import { Container, Mesh, MeshGeometry, Shader, GlProgram, State } from 'pixi.js';

// Vertex shader - creates a quad and passes UV coordinates
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

// Fragment shader - all the sun magic happens here
const FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  
  in vec2 vUV;
  out vec4 fragColor;
  
  uniform float uTime;
  uniform float uHue;
  uniform float uRadius;
  uniform float uNoiseScale;
  uniform float uCoronaSize;
  uniform float uCoronaIntensity;
  uniform float uLOD; // 0.0 = far/simple, 1.0+ = close/detailed (can go higher)
  uniform float uSunStyle;
  uniform float uCoronaStyle;
  uniform vec4 uSunParamsA;
  uniform vec2 uSunParamsB;
  uniform vec4 uCoronaParamsA;
  uniform vec2 uCoronaParamsB;
  // Custom colors for voronoi style
  uniform vec3 uDarkColor;   // Cell interior (darkest)
  uniform vec3 uMidColor;    // Cell mid-tone
  uniform vec3 uBrightColor; // Cell bright gradient
  uniform vec3 uEdgeColor;   // Cell wall/edge color
  // Extended warp params: x=warpScale, y=warpDetail, z=turbulenceMix
  uniform vec3 uWarpParams;
  // Extra fBM controls: x=noiseScale, y=animSpeed, z=contrast
  uniform vec3 uFbmParams;
  // Plasma overlay: x=intensity, y=scale, z=speed
  uniform vec3 uPlasmaParams;
  // Edge styling: x=brightness, y=thickness, z=sharpness
  uniform vec3 uEdgeStyle;
  // More edge: x=limbDarkening, y=glowIntensity, z=glowSize
  uniform vec3 uEdgeGlow;
  // Plasma color
  uniform vec3 uPlasmaColor;
  // Center light: x=intensity, y=radius, z=falloff
  uniform vec3 uCenterLight;
  // Inside adjust: x=innerDarkening, y=whiteBalance, z=saturation
  uniform vec3 uInsideAdjust;
  // Center light color
  uniform vec3 uCenterColor;
  
  // ============================================
  // Simplex noise (optimized)
  // ============================================
  
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
  
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
    m = m * m * m * m;
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
  
  // ============================================
  // Continuous LOD Fractal Noise
  // Smoothly adds detail as you zoom in
  // ============================================
  
  // Domain warping - distorts coordinates for organic flow
  vec2 domainWarp(vec2 p, float time, float strength) {
    float n1 = snoise(p * 0.5 + time * 0.02);
    float n2 = snoise(p * 0.5 + vec2(5.2, 1.3) + time * 0.015);
    return p + vec2(n1, n2) * strength;
  }
  
  // Continuous FBM with smooth LOD transitions
  // Each octave fades in/out smoothly based on LOD
  float fbmContinuous(vec2 p, float lod, float time) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    float maxAmp = 0.0;
    
    // Base octaves (always present)
    int baseOctaves = 2;
    // Additional octaves based on LOD (each 0.5 LOD adds an octave)
    float totalOctaves = float(baseOctaves) + lod * 8.0;
    
    for (int i = 0; i < 12; i++) {
      float octaveIndex = float(i);
      
      // Smooth fade for this octave based on LOD
      float octaveFade = clamp(totalOctaves - octaveIndex, 0.0, 1.0);
      if (octaveFade <= 0.0) break;
      
      // Add time variation per octave for animation
      vec2 offset = vec2(
        sin(time * 0.01 * (1.0 + octaveIndex * 0.1)),
        cos(time * 0.008 * (1.0 + octaveIndex * 0.1))
      ) * 0.5;
      
      val += amp * snoise(p * freq + offset) * octaveFade;
      maxAmp += amp * octaveFade;
      
      freq *= 2.0;
      amp *= 0.5;
    }
    
    return val / max(maxAmp, 0.001); // Normalize
  }
  
  // Multi-layer domain-warped fractal
  // Creates turbulent, flowing patterns with infinite detail
  float turbulentFractal(vec2 p, float lod, float time) {
    // Layer 1: Large-scale flow
    vec2 p1 = domainWarp(p * 1.0, time, 0.3);
    float layer1 = fbmContinuous(p1, lod * 0.5, time);
    
    // Layer 2: Medium turbulence (fades in at LOD 0.3+)
    float layer2Fade = smoothstep(0.2, 0.5, lod);
    vec2 p2 = domainWarp(p * 2.0 + layer1 * 0.3, time * 1.2, 0.25);
    float layer2 = fbmContinuous(p2, lod * 0.7, time * 1.1) * layer2Fade;
    
    // Layer 3: Fine detail (fades in at LOD 0.6+)
    float layer3Fade = smoothstep(0.5, 0.8, lod);
    vec2 p3 = domainWarp(p * 4.0 + layer2 * 0.2, time * 1.5, 0.2);
    float layer3 = fbmContinuous(p3, lod, time * 1.2) * layer3Fade * 0.5;
    
    // Layer 4: Ultra-fine detail (fades in at LOD 1.0+)
    float layer4Fade = smoothstep(0.9, 1.5, lod);
    vec2 p4 = p * 8.0 + layer3 * 0.15;
    float layer4 = fbmContinuous(p4, lod, time * 1.3) * layer4Fade * 0.25;
    
    return layer1 * 0.5 + layer2 * 0.3 + layer3 + layer4;
  }
  
  // Cellular/granulation pattern with LOD
  // Fixed scale - detail layers fade in rather than scaling
  float granulation(vec2 p, float lod, float time) {
    float baseScale = 12.0; // Fixed base scale
    vec2 gp = p * baseScale;
    
    // Animate cell centers
    gp += vec2(snoise(p * 2.0 + time * 0.02), snoise(p * 2.0 + vec2(100.0) + time * 0.015)) * 0.3;
    
    // Base cell pattern (always visible)
    float n = snoise(gp);
    float cells = smoothstep(-0.2, 0.4, n) * 0.8;
    
    // Medium detail layer (fades in at LOD 0.3+)
    float med = snoise(gp * 2.0 + 50.0);
    float medFade = smoothstep(0.2, 0.5, lod);
    cells += smoothstep(-0.1, 0.3, med) * 0.15 * medFade;
    
    // Fine detail layer (fades in at LOD 0.6+)
    float fineFade = smoothstep(0.5, 0.9, lod);
    float fine = snoise(gp * 4.0 + time * 0.03) * 0.12 * fineFade;
    cells += fine;
    
    // Ultra-fine detail (fades in at LOD 1.0+)
    float ultraFade = smoothstep(0.9, 1.4, lod);
    float ultra = snoise(gp * 8.0 + time * 0.04) * 0.08 * ultraFade;
    cells += ultra;
    
    return cells;
  }
  
  // ============================================
  // Brownian Motion / Fractional Brownian Motion
  // Creates intricate, organic branching patterns
  // ============================================
  
  // Hash function for pseudo-random values
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  
  // 2D hash for Voronoi cell centers
  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  
  // Smooth value noise
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // Smoothstep
    
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  
  // Brownian bridge - creates organic branching paths
  vec2 brownianWalk(vec2 p, float time, int steps) {
    vec2 pos = p;
    float scale = 1.0;
    for (int i = 0; i < steps; i++) {
      float t = time * 0.1 + float(i) * 0.5;
      float angle = valueNoise(pos * scale + t) * 6.28318;
      pos += vec2(cos(angle), sin(angle)) * 0.15 / scale;
      scale *= 1.5;
    }
    return pos;
  }
  
  // Fractional Brownian Motion with domain warping
  // Creates intricate, self-similar patterns
  float fbmBrownian(vec2 p, float complexity, float time) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    float maxAmp = 0.0;
    
    // Domain warp the input
    vec2 warp = vec2(
      snoise(p * 0.5 + time * 0.02),
      snoise(p * 0.5 + vec2(50.0) + time * 0.015)
    );
    p += warp * 0.4;
    
    int octaves = int(complexity);
    for (int i = 0; i < 12; i++) {
      if (i >= octaves) break;
      
      // Add rotational variety per octave
      float angle = float(i) * 0.5 + time * 0.01;
      mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
      vec2 rp = rot * p * frequency;
      
      // Use simplex noise with time offset per octave
      float n = snoise(rp + time * (0.01 + float(i) * 0.005));
      value += n * amplitude;
      maxAmp += amplitude;
      
      frequency *= 2.0;
      amplitude *= 0.5;
    }
    
    return value / maxAmp;
  }
  
  // Branching Brownian tree pattern
  // Creates lightning/vein-like structures
  float brownianBranches(vec2 p, float complexity, float time, float branching) {
    float pattern = 0.0;
    
    // Multiple layers of branching patterns at different scales
    for (int layer = 0; layer < 4; layer++) {
      float scale = pow(2.0, float(layer));
      float layerTime = time * (0.03 + float(layer) * 0.01);
      
      // Domain warp for organic flow
      vec2 warp = vec2(
        fbmBrownian(p * scale * 0.3, 4.0, layerTime),
        fbmBrownian(p * scale * 0.3 + vec2(100.0), 4.0, layerTime + 10.0)
      );
      vec2 wp = p * scale + warp * (0.3 + branching * 0.4);
      
      // Create ridge pattern (like valleys/veins)
      float ridge = fbmBrownian(wp, complexity * 0.7, layerTime);
      ridge = 1.0 - abs(ridge);
      ridge = pow(ridge, 2.0 + branching * 3.0);
      
      // Weight by layer (smaller scales = less influence)
      float weight = 1.0 / pow(1.5, float(layer));
      pattern += ridge * weight;
    }
    
    return pattern;
  }
  
  // Intricate Brownian plasma surface
  // Combines multiple techniques for complex, animated pattern
  float brownianPlasma(vec2 p, float complexity, float drift, float branching, float time, float lod) {
    // Base turbulent flow
    float turbulent = fbmBrownian(p * 2.0, complexity, time * drift);
    
    // Branching veins overlay
    float branches = brownianBranches(p, complexity * 0.6, time * drift * 0.7, branching);
    
    // Cellular pattern for texture
    float cells = 0.0;
    vec2 cellP = p * 8.0;
    cellP += turbulent * 0.5; // Distort cells with turbulence
    
    // Voronoi-like cells
    vec2 cellI = floor(cellP);
    vec2 cellF = fract(cellP);
    float minDist = 1.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 cellCenter = neighbor + hash(cellI + neighbor) * 0.5;
        cellCenter += vec2(
          sin(time * 0.05 + hash(cellI + neighbor) * 6.28),
          cos(time * 0.04 + hash(cellI + neighbor + 50.0) * 6.28)
        ) * 0.15;
        float d = length(cellF - cellCenter);
        minDist = min(minDist, d);
      }
    }
    cells = smoothstep(0.0, 0.5, minDist);
    
    // Combine layers
    float result = turbulent * 0.4 + branches * 0.4 + cells * 0.2;
    
    // Add fine detail based on LOD
    float fineDetail = fbmBrownian(p * 6.0 + turbulent * 0.3, complexity * 0.5, time * drift * 1.5);
    float fineFade = smoothstep(0.3, 0.8, lod);
    result += fineDetail * 0.15 * fineFade;
    
    return result;
  }
  
  // ============================================
  // Flowfield distortion
  // ============================================
  
  vec2 flowField(vec2 p, float time, float lod) {
    float eps = 0.01;
    float strength = 0.15 + lod * 0.1; // More flow detail when zoomed in
    float n1 = snoise(p + vec2(eps, 0.0) + time * 0.02);
    float n2 = snoise(p - vec2(eps, 0.0) + time * 0.02);
    float n3 = snoise(p + vec2(0.0, eps) + time * 0.02);
    float n4 = snoise(p - vec2(0.0, eps) + time * 0.02);
    return vec2((n3 - n4), -(n1 - n2)) / (2.0 * eps) * strength;
  }
  
  // ============================================
  // HSL to RGB
  // ============================================
  
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
  
  // ============================================
  // Plasma corona rim effect
  // Creates colorful, energetic plasma edge
  // ============================================
  
  vec3 plasmaColor(float t, float hue, float time) {
    // Multi-colored plasma with energy bands
    float h1 = hue;
    float h2 = mod(hue + 30.0, 360.0);  // Shift toward orange
    float h3 = mod(hue - 20.0 + 360.0, 360.0);  // Shift toward red
    float h4 = mod(hue + 60.0, 360.0);  // Shift toward yellow
    
    // Oscillate between colors based on position and time
    float wave = sin(t * 12.0 + time * 0.8) * 0.5 + 0.5;
    float wave2 = sin(t * 8.0 - time * 0.6 + 1.5) * 0.5 + 0.5;
    
    vec3 c1 = hsl2rgb(h1, 0.95, 0.7);
    vec3 c2 = hsl2rgb(h2, 1.0, 0.8);
    vec3 c3 = hsl2rgb(h3, 0.9, 0.6);
    vec3 c4 = hsl2rgb(h4, 1.0, 0.9);
    
    vec3 color = mix(c1, c2, wave);
    color = mix(color, c3, wave2 * 0.4);
    color = mix(color, c4, pow(wave * wave2, 2.0) * 0.5);
    
    return color;
  }
  
  // ============================================
  // Main rendering
  // ============================================
  
  void main() {
    vec2 uv = (vUV - 0.5) * 2.0;
    float dist = length(uv);
    
    float sunRadius = uRadius;
    float lod = uLOD;
    float baseHue = uHue;
    float coolHue = mod(baseHue + 15.0, 360.0);
    float warmHue = mod(baseHue - 10.0 + 360.0, 360.0);
    float hotHue = mod(baseHue - 25.0 + 360.0, 360.0);

    float sunCoreRadius = uSunParamsA.x;
    float sunFlowSpeed = uSunParamsA.y;
    float sunFlowScale = uSunParamsA.z;
    float sunTurbulence = uSunParamsA.w;
    float sunRimIntensity = uSunParamsB.x;
    float sunHeatBias = uSunParamsB.y;

    float coronaRadius = uCoronaParamsA.x;
    float coronaP1 = uCoronaParamsA.y;
    float coronaP2 = uCoronaParamsA.z;
    float coronaP3 = uCoronaParamsA.w;
    float coronaP4 = uCoronaParamsB.x;
    float coronaP5 = uCoronaParamsB.y;
    
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    
    // Normalized angle for corona effects
    float angle = atan(uv.y, uv.x);
    float normAngle = angle / 6.28318 + 0.5;
    
    // ========== Outer atmospheric glow (far corona) ==========
    // Start inside the sun for smooth overlap
    float glowStart = sunRadius * 0.7;
    float glowEnd = sunRadius * uCoronaSize * coronaRadius;
    
    if (dist > glowStart && dist < glowEnd) {
      float t = (dist - glowStart) / (glowEnd - glowStart);
      float glowAlpha = uCoronaIntensity * 0.4 * pow(1.0 - t, 3.0);
      vec3 glowColor = hsl2rgb(baseHue, 0.6, 0.7);
      color = glowColor;
      alpha = glowAlpha;
    }
    
    // ========== Plasma corona rim (the colorful edge) ==========
    // Start well inside the sun for large overlap
    float coronaInner = sunRadius * 0.6;
    float coronaOuter = sunRadius * (1.25 + 0.25 * coronaRadius);
    
    if (dist > coronaInner && dist < coronaOuter) {
      float t = (dist - coronaInner) / (coronaOuter - coronaInner);
      
      if (uCoronaStyle < 0.5) {
        // Soft glow corona
        vec2 coronaUV = uv * 3.0 * coronaP2;
        float coronaNoise = turbulentFractal(coronaUV, lod * 0.8, uTime);
        float streakNoise = snoise(vec2(normAngle * 40.0, uTime * 0.1));
        float streaks = pow(abs(streakNoise), 1.5) * 0.35;
        float tendrilNoise = snoise(vec2(normAngle * 20.0 + uTime * 0.05, dist * 8.0));
        float tendrils = smoothstep(0.2, 0.8, tendrilNoise) * (1.0 - t);
        
        float coronaIntensity = (1.0 - pow(t, 0.7)) * (0.7 + coronaNoise * coronaP3 + streaks + tendrils * 0.3);
        coronaIntensity *= uCoronaIntensity * coronaP5;
        
        vec3 plasmaCol = plasmaColor(normAngle + coronaNoise * 0.2, baseHue, uTime);
        float pulse = sin(uTime * coronaP4 + normAngle * 10.0) * 0.5 + 0.5;
        plasmaCol = mix(plasmaCol, vec3(1.0, 0.98, 0.9), pulse * 0.2);
        
        float coronaAlpha = coronaIntensity * (1.0 - pow(t, coronaP1));
        coronaAlpha = clamp(coronaAlpha, 0.0, 0.95);
        
        color = mix(color, plasmaCol, coronaAlpha);
        alpha = max(alpha, coronaAlpha);
      } else {
        // Plasma stream corona
        float streamCount = max(2.0, coronaP1);
        float streamWidth = coronaP2;
        float streamSpeed = coronaP3;
        float streamTurb = coronaP4;
        
        float streamPhase = normAngle * streamCount * 6.28318 + uTime * streamSpeed;
        float streamMask = pow(max(0.0, sin(streamPhase)), 3.0 + streamWidth * 8.0);
        float streamNoise = snoise(vec2(normAngle * streamCount, dist * 6.0 + uTime * 0.2));
        streamMask *= smoothstep(0.2, 0.8, streamNoise * 0.5 + 0.5 + streamTurb * 0.2);
        
        float streamIntensity = (1.0 - t) * streamMask * uCoronaIntensity * coronaP5;
        vec3 streamColor = plasmaColor(normAngle + streamNoise * 0.2, baseHue, uTime);
        streamColor = mix(streamColor, vec3(1.0, 0.98, 0.9), pow(1.0 - t, 2.0) * 0.4);
        
        color = mix(color, streamColor, streamIntensity);
        alpha = max(alpha, streamIntensity);
      }
    }
    
    // ========== Solar prominences / flares ==========
    // Start inside sun for overlap
    if (dist > sunRadius * 0.7 && dist < sunRadius * 1.6) {
      float flare1 = pow(max(0.0, sin(angle * 7.0 + uTime * 0.3 + 0.5)), 4.0);
      float flare2 = pow(max(0.0, sin(angle * 5.0 - uTime * 0.2 + 2.1)), 5.0);
      float flare3 = pow(max(0.0, sin(angle * 11.0 + uTime * 0.4 + 4.2)), 6.0);
      float flares = flare1 * 0.5 + flare2 * 0.3 + flare3 * 0.2;
      
      float flareExtent = sunRadius * (1.0 + flares * 0.55);
      if (dist < flareExtent && dist > sunRadius * 0.8) {
        float flareT = (dist - sunRadius * 0.8) / (flareExtent - sunRadius * 0.8);
        float flareAlpha = flares * 0.5 * pow(1.0 - flareT, 2.5);
        vec3 flareColor = plasmaColor(angle / 6.28318, warmHue, uTime * 1.5);
        flareColor = mix(flareColor, vec3(1.0, 0.95, 0.8), pow(1.0 - flareT, 3.0) * 0.5);
        color = mix(color, flareColor, flareAlpha);
        alpha = max(alpha, flareAlpha);
      }
    }
    
    // ========== Sun body with continuous fractal detail ==========
    if (dist < sunRadius) {
      float sunT = dist / sunRadius;
      
      // 3D Spherical shading
      vec2 sphereUV = uv / sunRadius;
      float z = sqrt(max(0.0, 1.0 - dot(sphereUV, sphereUV)));
      vec3 normal = normalize(vec3(sphereUV, z));
      
      vec3 lightDir = normalize(vec3(-0.15, 0.2, 1.0));
      float NdotL = max(0.0, dot(normal, lightDir));
      float diffuse = mix(0.7, 1.0, NdotL);
      
      vec3 viewDir = vec3(0.0, 0.0, 1.0);
      vec3 halfVec = normalize(lightDir + viewDir);
      float NdotH = max(0.0, dot(normal, halfVec));
      float specular = pow(NdotH, 32.0) * 0.4;
      
      float fresnel = pow(1.0 - z, 3.0) * 0.3;
      
      // Flowfield distorted UVs with LOD
      vec2 flowUV = uv * 3.0 * uNoiseScale * sunFlowScale;
      vec2 flow = flowField(flowUV, uTime * (0.5 + sunFlowSpeed), lod);
      vec2 distortedUV = flowUV + flow;
      
      // ===== STYLE-BASED FRACTAL SURFACE =====
      float surface = 0.0;
      float swirls = 0.0;
      float largePattern = snoise(uv * 1.2 * uNoiseScale + uTime * 0.008) * 0.5;
      
      if (uSunStyle < 0.5) {
        // Style 0: Turbulent flow with rolling cells
        float surfaceDetail = turbulentFractal(distortedUV, lod, uTime * (0.8 + sunFlowSpeed));
        float cells = granulation(uv * uNoiseScale, lod, uTime);
        surface = surfaceDetail * (0.25 + sunTurbulence * 0.35) + cells * 0.12;
        float swirlNoise = snoise(distortedUV * 2.5 - uTime * 0.006);
        swirls = smoothstep(0.3, 0.6, swirlNoise) * (0.1 + sunTurbulence * 0.2);
      } else if (uSunStyle < 1.5) {
        // Style 1: Granular faculae + sparkle
        float grainScale = sunFlowScale;
        float grainContrast = sunTurbulence;
        float sparkleRate = sunFlowSpeed;
        float cells = granulation(uv * uNoiseScale * grainScale, lod, uTime);
        surface = cells * (0.2 + grainContrast * 0.3);
        float sparkleNoise = snoise(uv * 6.0 * grainScale + uTime * (0.2 + sparkleRate));
        swirls = smoothstep(0.65, 0.9, sparkleNoise) * (0.05 + sparkleRate * 0.12);
      } else {
        // Style 2: FRACTAL BROWNIAN MOTION (fBM) + PLASMA OVERLAY
        // Params: octaves (flowSpeed), lacunarity (flowScale), gain (turbulence), warpAmt (heatBias)
        
        float octaveCount = max(1.0, floor(sunFlowSpeed)); // 1-8 octaves
        float lacunarity = max(1.5, sunFlowScale);         // frequency multiplier per octave
        float gain = clamp(sunTurbulence, 0.1, 0.9);       // amplitude multiplier per octave
        float warpAmt = sunHeatBias;                       // domain warping amount
        
        // Extra params from uniforms
        float noiseScale = uFbmParams.x;
        float animSpeed = uFbmParams.y;
        float contrast = uFbmParams.z;
        
        float time = uTime * animSpeed;
        
        // Edge styling params
        float edgeBrightness = uEdgeStyle.x;
        float edgeThickness = uEdgeStyle.y;
        float edgeSharpness = uEdgeStyle.z;
        float limbDarkening = uEdgeGlow.x;
        float glowIntensity = uEdgeGlow.y;
        float glowSize = uEdgeGlow.z;
        
        // ============================================
        // SPHERE DISTORTION - Maps flat UV to spherical coordinates
        // This makes the noise wrap around the sphere properly
        // ============================================
        vec2 normalizedUV = uv / sunRadius; // -1 to 1 range within sun
        float r = length(normalizedUV);
        
        // Calculate spherical coordinates
        // z is the depth on a unit sphere: z = sqrt(1 - x² - y²)
        // Use asin to get latitude-like distortion toward edges
        float sphereZ = sqrt(max(0.0, 1.0 - r * r));
        
        // Spherical projection: map to longitude/latitude
        // This compresses the UV toward edges, simulating a sphere surface
        float theta = atan(normalizedUV.y, normalizedUV.x);  // Longitude: -π to π
        float phi = asin(clamp(r, 0.0, 1.0));                // Latitude: 0 at center to π/2 at edge
        
        // Convert back to UV with spherical distortion
        // The phi/r ratio causes compression toward edges (sphere bulge)
        float sphereDistortAmount = 1.0; // Full sphere distortion
        float distortFactor = mix(1.0, (phi / max(r, 0.001)) * 0.6366, sphereDistortAmount); // 0.6366 = 2/π
        
        vec2 sphereUV = normalizedUV * distortFactor * sunRadius;
        
        // Add subtle animated rotation for a slowly spinning sun
        float spinSpeed = 0.015;
        float spin = uTime * spinSpeed;
        mat2 spinMat = mat2(cos(spin), -sin(spin), sin(spin), cos(spin));
        sphereUV = spinMat * sphereUV;
        
        // Domain warping
        float warpScale = uWarpParams.x;
        vec2 warpedUV = sphereUV * noiseScale * 3.0;
        vec2 warp = vec2(
          snoise(warpedUV * warpScale + time * 0.3),
          snoise(warpedUV * warpScale + vec2(43.0, 17.0) + time * 0.25)
        ) * warpAmt * 0.5;
        
        vec2 fbmUV = sphereUV * noiseScale * 4.0 + warp;
        
        // Classic fBM loop
        float fbmValue = 0.0;
        float amplitude = 0.5;
        float frequency = 1.0;
        float maxAmp = 0.0;
        
        for (int i = 0; i < 8; i++) {
          if (float(i) >= octaveCount) break;
          float n = snoise(fbmUV * frequency + time * (0.1 + float(i) * 0.05));
          fbmValue += amplitude * n;
          maxAmp += amplitude;
          frequency *= lacunarity;
          amplitude *= gain;
        }
        
        fbmValue = (fbmValue / maxAmp) * 0.5 + 0.5;
        
        // Turbulence variant
        float turbMix = uWarpParams.z;
        if (turbMix > 0.01) {
          float turbulence = 0.0;
          amplitude = 0.5;
          frequency = 1.0;
          float turbMaxAmp = 0.0;
          
          for (int i = 0; i < 8; i++) {
            if (float(i) >= octaveCount) break;
            float n = abs(snoise(fbmUV * frequency * 1.5 + time * 0.2 + vec2(100.0)));
            turbulence += amplitude * n;
            turbMaxAmp += amplitude;
            frequency *= lacunarity;
            amplitude *= gain;
          }
          turbulence = turbulence / turbMaxAmp;
          fbmValue = mix(fbmValue, turbulence, turbMix);
        }
        
        // Apply contrast
        fbmValue = (fbmValue - 0.5) * contrast + 0.5;
        fbmValue = clamp(fbmValue, 0.0, 1.0);
        
        // Base color gradient: dark -> mid -> bright
        vec3 baseColor;
        if (fbmValue < 0.5) {
          baseColor = mix(uDarkColor, uMidColor, fbmValue * 2.0);
        } else {
          baseColor = mix(uMidColor, uBrightColor, (fbmValue - 0.5) * 2.0);
        }
        
        // Highlight
        float highlight = smoothstep(0.7, 1.0, fbmValue);
        vec3 cellColor = mix(baseColor, uEdgeColor, highlight * 0.6);
        
        // ============================================
        // PLASMA OVERLAY - sine wave interference pattern
        // ============================================
        float plasmaIntensity = uPlasmaParams.x;
        float plasmaScale = uPlasmaParams.y;
        float plasmaSpeed = uPlasmaParams.z;
        
        if (plasmaIntensity > 0.01) {
          float pt = uTime * plasmaSpeed;
          vec2 pUV = sphereUV * plasmaScale;
          
          // Multiple sine waves creating plasma effect
          float plasma = 0.0;
          plasma += sin(pUV.x * 10.0 + pt);
          plasma += sin(pUV.y * 10.0 + pt * 0.7);
          plasma += sin((pUV.x + pUV.y) * 7.0 + pt * 1.3);
          plasma += sin(length(pUV - 0.5) * 12.0 - pt * 0.8);
          plasma += sin(atan(pUV.y - 0.5, pUV.x - 0.5) * 5.0 + pt * 0.5);
          plasma = plasma / 5.0; // Normalize to -1 to 1
          plasma = plasma * 0.5 + 0.5; // Normalize to 0-1
          
          // Swirling plasma tendrils
          float angle = atan(uv.y - 0.5, uv.x - 0.5);
          float tendril = sin(angle * 8.0 + pt * 2.0 + length(uv - 0.5) * 15.0);
          tendril = smoothstep(0.3, 0.9, tendril);
          
          // Edge-focused plasma (stronger near the edge)
          float edgeDist = dist / sunRadius;
          float edgeFocus = smoothstep(0.5, 1.0, edgeDist);
          
          // Combine plasma effects
          float plasmaFinal = mix(plasma, tendril, 0.4);
          plasmaFinal *= edgeFocus * plasmaIntensity;
          
          // Apply plasma color
          vec3 plasmaCol = uPlasmaColor * plasmaFinal;
          cellColor = cellColor + plasmaCol;
        }
        
        // ============================================
        // CENTER CONTRAST - darks get darker, brights get highlighted toward center
        // ============================================
        float centerDarken = uCenterLight.x;    // How much to darken darks toward center
        float centerHighlight = uCenterLight.y; // How much to highlight brights toward center
        float centerFalloff = uCenterLight.z;   // Falloff curve
        
        if (centerDarken > 0.01 || centerHighlight > 0.01) {
          float sunT_center = dist / sunRadius;
          // Falloff: 1.0 at center, 0.0 at edge
          float centerMask = 1.0 - pow(sunT_center, centerFalloff);
          
          // Get luminance of current color
          float luma = dot(cellColor, vec3(0.299, 0.587, 0.114));
          
          // Dark areas (low luminance) get darker toward center
          float darkFactor = 1.0 - smoothstep(0.0, 0.5, luma); // 1.0 for dark, 0.0 for bright
          float darkenAmount = darkFactor * centerDarken * centerMask;
          cellColor *= (1.0 - darkenAmount * 0.7);
          
          // Bright areas (high luminance) get highlighted toward center
          float brightFactor = smoothstep(0.4, 0.8, luma); // 0.0 for dark, 1.0 for bright
          float highlightAmount = brightFactor * centerHighlight * centerMask;
          vec3 highlightColor = mix(cellColor, uCenterColor, highlightAmount * 0.5);
          cellColor = cellColor + highlightColor * highlightAmount * 0.3;
        }
        
        // ============================================
        // INSIDE ADJUSTMENTS
        // ============================================
        float innerDarkening = uInsideAdjust.x;
        float whiteBalance = uInsideAdjust.y;
        float satAdjust = uInsideAdjust.z;
        
        // Inner darkening (darken the center, opposite of limb darkening)
        float sunT_inner = dist / sunRadius;
        float innerFactor = mix(1.0, sunT_inner, innerDarkening);
        cellColor *= innerFactor;
        
        // White balance (shift towards warm/cool)
        cellColor.r *= 1.0 + whiteBalance * 0.3;
        cellColor.b *= 1.0 - whiteBalance * 0.3;
        
        // Saturation adjustment
        float luma = dot(cellColor, vec3(0.299, 0.587, 0.114));
        cellColor = mix(vec3(luma), cellColor, satAdjust);
        
        // ============================================
        // EDGE STYLING
        // ============================================
        float sunT = dist / sunRadius;
        
        // Limb darkening (darken towards edges based on z)
        float limbFactor = mix(1.0, pow(z, 0.5), limbDarkening);
        cellColor *= limbFactor;
        
        // Edge glow (bright rim) - only inside the sun
        float glowStart = 1.0 - glowSize;
        float edgeGlowVal = smoothstep(glowStart, 0.98, sunT) * glowIntensity;
        vec3 glowColor = mix(uBrightColor, uEdgeColor, 0.5);
        cellColor = mix(cellColor, glowColor * edgeBrightness, edgeGlowVal);
        
        // Bright edge highlight (inside the sun)
        float brightEdgeStart = 1.0 - edgeThickness;
        float brightEdge = smoothstep(brightEdgeStart, 0.97, sunT);
        cellColor = mix(cellColor, uEdgeColor * edgeBrightness, brightEdge * 0.6 * edgeSharpness);
        
        // Clean alpha edge - fade ends strictly at sunRadius
        // Use noise for organic edge but ensure it stays inside sunRadius
        float edgeNoise = snoise(uv * 30.0 + uTime * 0.5) * 0.01;
        float edgeFadeStart = sunRadius * (1.0 - edgeThickness);
        float edgeFadeEnd = sunRadius * 0.995; // Stop slightly inside to leave gap for corona
        float edgeFade = 1.0 - smoothstep(edgeFadeStart + edgeNoise * sunRadius, edgeFadeEnd, dist);
        
        color = cellColor;
        alpha = edgeFade;
      }
      
      // For styles 0 and 1, continue with standard color processing
      if (uSunStyle < 1.5) {
        float limbFactor = pow(z, 0.4);
        float heat = clamp(sunHeatBias, 0.0, 1.0);
        float hue = mix(coolHue, warmHue, pow(sunT, mix(1.6, 0.9, heat)));
        float sat = mix(0.55, 0.9, sunT);
        float lit = mix(0.98, 0.58, pow(sunT, mix(1.1, 0.8, heat)));
        
        lit *= diffuse * limbFactor;
        lit += surface + swirls * 0.5 + largePattern * 0.03;
        lit += specular + fresnel * 0.5;
        lit = clamp(lit, 0.15, 1.0);
        
        vec3 sunColor = hsl2rgb(hue, sat, lit);
        
        // Specular hotspot
        sunColor = mix(sunColor, vec3(1.0, 1.0, 0.95), specular * 0.8);
        
        // Plasma edge
        float edgeT = smoothstep(0.88, 0.99, sunT);
        float edgeNoise = turbulentFractal(uv * 5.0 * uNoiseScale, lod, uTime * 1.2);
        vec3 rimPlasma = plasmaColor(normAngle + edgeNoise * 0.15, baseHue, uTime);
        rimPlasma = mix(rimPlasma, vec3(1.0, 0.98, 0.85), 0.3);
        sunColor = mix(sunColor, rimPlasma, edgeT * (0.4 + sunRimIntensity * 0.6));
        
        // Thin edge
        float thinEdge = smoothstep(0.96, 0.995, sunT);
        sunColor = mix(sunColor, vec3(1.0, 0.98, 0.92), thinEdge * 0.5);
        
        color = sunColor;
        alpha = 1.0;
        float edgeSoft = 1.0 - smoothstep(sunRadius * 0.998, sunRadius * 1.002, dist);
        alpha *= edgeSoft;
        
        // Center glow
        float coreRadius = clamp(sunCoreRadius, 0.2, 0.95);
        if (dist < sunRadius * coreRadius) {
          float centerT = dist / (sunRadius * coreRadius);
          float centerGlow = pow(1.0 - centerT, 2.5) * 0.45;
          color = mix(color, vec3(1.0, 1.0, 0.98), centerGlow);
        }
      }
    }
    
    // ========== CORONA ==========    // Use premultiplied alpha for proper blending
    fragColor = vec4(color * alpha, alpha);
  }
`;

export class SunRenderer {
  private container: Container;
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private time: number = 0;
  private hue: number = 40; // Default yellow-orange
  private radius: number = 0.35; // UV space radius (0-1)
  
  constructor() {
    this.container = new Container();
  }
  
  /**
   * Initialize the sun mesh and shader
   * Must be called after PixiJS renderer is initialized
   */
  initialize(): void {
    // Create geometry - a simple quad covering -1 to 1
    const quadSize = 2.0;
    const positions = new Float32Array([
      -quadSize, -quadSize,  // bottom-left
       quadSize, -quadSize,  // bottom-right
       quadSize,  quadSize,  // top-right
      -quadSize,  quadSize,  // top-left
    ]);
    
    const uvs = new Float32Array([
      0, 0,  // bottom-left
      1, 0,  // bottom-right
      1, 1,  // top-right
      0, 1,  // top-left
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
        sunUniforms: {
          uTime: { value: 0, type: 'f32' },
          uHue: { value: this.hue, type: 'f32' },
          uRadius: { value: this.radius, type: 'f32' },
          uNoiseScale: { value: 1.0, type: 'f32' },
          uCoronaSize: { value: 2.2, type: 'f32' },
          uCoronaIntensity: { value: 0.7, type: 'f32' },
          uLOD: { value: 1.0, type: 'f32' },
          uSunStyle: { value: 0, type: 'f32' },
          uCoronaStyle: { value: 0, type: 'f32' },
          uSunParamsA: { value: new Float32Array(4), type: 'vec4<f32>' },
          uSunParamsB: { value: new Float32Array(2), type: 'vec2<f32>' },
          uCoronaParamsA: { value: new Float32Array(4), type: 'vec4<f32>' },
          uCoronaParamsB: { value: new Float32Array(2), type: 'vec2<f32>' },
          uDarkColor: { value: new Float32Array([0.1, 0.02, 0.0]), type: 'vec3<f32>' },
          uMidColor: { value: new Float32Array([0.4, 0.07, 0.0]), type: 'vec3<f32>' },
          uBrightColor: { value: new Float32Array([1.0, 0.4, 0.0]), type: 'vec3<f32>' },
          uEdgeColor: { value: new Float32Array([1.0, 0.67, 0.2]), type: 'vec3<f32>' },
          uWarpParams: { value: new Float32Array([0.3, 0.5, 0.3]), type: 'vec3<f32>' },
          uFbmParams: { value: new Float32Array([4.0, 0.15, 1.0]), type: 'vec3<f32>' },
          uPlasmaParams: { value: new Float32Array([0.3, 3.0, 1.0]), type: 'vec3<f32>' },
          uEdgeStyle: { value: new Float32Array([1.0, 0.03, 0.5]), type: 'vec3<f32>' },
          uEdgeGlow: { value: new Float32Array([0.5, 0.4, 0.1]), type: 'vec3<f32>' },
          uPlasmaColor: { value: new Float32Array([1.0, 0.6, 0.2]), type: 'vec3<f32>' },
          uCenterLight: { value: new Float32Array([0.0, 0.3, 2.0]), type: 'vec3<f32>' },
          uInsideAdjust: { value: new Float32Array([0.0, 0.0, 1.0]), type: 'vec3<f32>' },
          uCenterColor: { value: new Float32Array([1.0, 0.9, 0.7]), type: 'vec3<f32>' },
        },
      },
    });
    
    // Create state with blending enabled
    const state = State.for2d();
    state.blend = true;
    
    this.mesh = new Mesh({
      geometry,
      shader: this.shader,
      state,
    });
    
    this.container.addChild(this.mesh);
  }
  
  // Additional configurable properties
  private noiseScale: number = 1.0;
  private coronaSize: number = 2.2;
  private coronaIntensity: number = 0.7;
  private animationSpeed: number = 1.0;
  private lod: number = 1.0; // Level of detail: 0 = far/simple, 1 = close/detailed
  private sunStyle: number = 0;
  private coronaStyle: number = 0;
  private sunParams: number[] = [0.6, 0.5, 1.2, 0.35, 0.8, 0.55];
  private coronaParams: number[] = [1.1, 1.6, 1.0, 0.25, 0.3, 0.9];
  private sunParamsA = new Float32Array(4);
  private sunParamsB = new Float32Array(2);
  private coronaParamsA = new Float32Array(4);
  private coronaParamsB = new Float32Array(2);

  private syncParamArrays(): void {
    this.sunParamsA.set(this.sunParams.slice(0, 4));
    this.sunParamsB.set(this.sunParams.slice(4, 6));
    this.coronaParamsA.set(this.coronaParams.slice(0, 4));
    this.coronaParamsB.set(this.coronaParams.slice(4, 6));
  }
  
  /**
   * Update the sun shader uniforms
   */
  update(delta: number, hue: number, worldRadius: number, screenSize: { width: number; height: number }): void {
    this.time += delta * this.animationSpeed; // delta is already in seconds from sandbox
    this.hue = hue;
    this.syncParamArrays();
    
    if (this.shader) {
      // Access uniforms through the group
      const group = this.shader.resources.sunUniforms as any;
      group.uniforms.uTime = this.time;
      group.uniforms.uHue = hue;
      group.uniforms.uRadius = this.radius;
      group.uniforms.uNoiseScale = this.noiseScale;
      group.uniforms.uCoronaSize = this.coronaSize;
      group.uniforms.uCoronaIntensity = this.coronaIntensity;
      group.uniforms.uLOD = this.lod;
      group.uniforms.uSunStyle = this.sunStyle;
      group.uniforms.uCoronaStyle = this.coronaStyle;
      group.uniforms.uSunParamsA = this.sunParamsA;
      group.uniforms.uSunParamsB = this.sunParamsB;
      group.uniforms.uCoronaParamsA = this.coronaParamsA;
      group.uniforms.uCoronaParamsB = this.coronaParamsB;
      // Custom colors for style 2
      group.uniforms.uDarkColor = new Float32Array(this.darkColor);
      group.uniforms.uMidColor = new Float32Array(this.midColor);
      group.uniforms.uBrightColor = new Float32Array(this.brightColor);
      group.uniforms.uEdgeColor = new Float32Array(this.edgeColor);
      // Warp params
      group.uniforms.uWarpParams = new Float32Array(this.warpParams);
      // fBM params
      group.uniforms.uFbmParams = new Float32Array(this.fbmParams);
      // Plasma overlay
      group.uniforms.uPlasmaParams = new Float32Array(this.plasmaParams);
      group.uniforms.uPlasmaColor = new Float32Array(this.plasmaColor);
      // Edge styling
      group.uniforms.uEdgeStyle = new Float32Array(this.edgeStyle);
      group.uniforms.uEdgeGlow = new Float32Array(this.edgeGlow);
      // Center light
      group.uniforms.uCenterLight = new Float32Array(this.centerLight);
      group.uniforms.uCenterColor = new Float32Array(this.centerColor);
      // Inside adjustments
      group.uniforms.uInsideAdjust = new Float32Array(this.insideAdjust);
    }
    
    if (this.mesh) {
      // Scale mesh to match world radius
      // The mesh is 2x2 in local space, and we want it to be worldRadius * 5 to include corona
      const scale = worldRadius * 2.5;
      this.mesh.scale.set(scale, scale);
    }
  }
  
  /**
   * Set the sun's visual radius (in UV space, 0-1)
   */
  setRadius(radius: number): void {
    this.radius = radius;
  }
  
  /**
   * Set the noise scale for surface detail
   */
  setNoiseScale(scale: number): void {
    this.noiseScale = scale;
  }
  
  /**
   * Set the corona size multiplier
   */
  setCoronaSize(size: number): void {
    this.coronaSize = size;
  }
  
  /**
   * Set the corona intensity
   */
  setCoronaIntensity(intensity: number): void {
    this.coronaIntensity = intensity;
  }
  
  /**
   * Set the animation speed multiplier
   */
  setAnimationSpeed(speed: number): void {
    this.animationSpeed = speed;
  }

  /**
   * Set sun surface style and parameters
   */
  setSunStyle(styleIndex: number, params: number[]): void {
    this.sunStyle = styleIndex;
    this.sunParams = params.slice(0, 6);
    this.syncParamArrays();
  }

  /**
   * Set corona style and parameters
   */
  setCoronaStyle(styleIndex: number, params: number[]): void {
    this.coronaStyle = styleIndex;
    this.coronaParams = params.slice(0, 6);
    this.syncParamArrays();
  }
  
  /**
   * Set custom colors for voronoi style (style 2)
   */
  setCustomColors(
    darkColor: [number, number, number], 
    midColor: [number, number, number],
    brightColor: [number, number, number],
    edgeColor: [number, number, number]
  ): void {
    this.darkColor = darkColor;
    this.midColor = midColor;
    this.brightColor = brightColor;
    this.edgeColor = edgeColor;
  }
  
  /**
   * Set warp parameters for irregular cell walls
   */
  setWarpParams(warpScale: number, warpDetail: number, turbulenceMix: number): void {
    this.warpParams = [warpScale, warpDetail, turbulenceMix];
  }
  
  /**
   * Set fBM parameters
   */
  setFbmParams(noiseScale: number, animSpeed: number, contrast: number): void {
    this.fbmParams = [noiseScale, animSpeed, contrast];
  }
  
  /**
   * Set plasma overlay parameters
   */
  setPlasmaParams(intensity: number, scale: number, speed: number): void {
    this.plasmaParams = [intensity, scale, speed];
  }
  
  /**
   * Set plasma color
   */
  setPlasmaColor(color: [number, number, number]): void {
    this.plasmaColor = color;
  }
  
  /**
   * Set edge styling parameters
   */
  setEdgeStyle(brightness: number, thickness: number, sharpness: number): void {
    this.edgeStyle = [brightness, thickness, sharpness];
  }
  
  /**
   * Set edge glow parameters
   */
  setEdgeGlow(limbDarkening: number, glowIntensity: number, glowSize: number): void {
    this.edgeGlow = [limbDarkening, glowIntensity, glowSize];
  }
  
  /**
   * Set center light parameters
   */
  setCenterLight(intensity: number, radius: number, falloff: number): void {
    this.centerLight = [intensity, radius, falloff];
  }
  
  /**
   * Set center light color
   */
  setCenterColor(color: [number, number, number]): void {
    this.centerColor = color;
  }
  
  /**
   * Set inside adjustment parameters
   */
  setInsideAdjust(innerDarkening: number, whiteBalance: number, saturation: number): void {
    this.insideAdjust = [innerDarkening, whiteBalance, saturation];
  }
  
  private darkColor: [number, number, number] = [0.1, 0.02, 0.0];
  private midColor: [number, number, number] = [0.4, 0.07, 0.0];
  private brightColor: [number, number, number] = [1.0, 0.4, 0.0];
  private edgeColor: [number, number, number] = [1.0, 0.67, 0.2];
  private warpParams: [number, number, number] = [0.3, 0.5, 0.3];
  private fbmParams: [number, number, number] = [4.0, 0.15, 1.0];
  private plasmaParams: [number, number, number] = [0.3, 3.0, 1.0];
  private plasmaColor: [number, number, number] = [1.0, 0.6, 0.2];
  private edgeStyle: [number, number, number] = [1.0, 0.03, 0.5];
  private edgeGlow: [number, number, number] = [0.5, 0.4, 0.1];
  private centerLight: [number, number, number] = [0.0, 0.3, 2.0];
  private centerColor: [number, number, number] = [1.0, 0.9, 0.7];
  private insideAdjust: [number, number, number] = [0.0, 0.0, 1.0];
  
  /**
   * Set the level of detail (0 = far/simple, 1 = close/detailed)
   * This affects shader complexity based on zoom level
   */
  setLOD(lod: number): void {
    this.lod = Math.max(0, Math.min(1, lod));
  }
  
  /**
   * Set position in world space
   */
  setPosition(x: number, y: number): void {
    this.container.position.set(x, y);
  }
  
  /**
   * Get the container to add to scene
   */
  getContainer(): Container {
    return this.container;
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    this.mesh?.destroy();
    this.shader = null;
  }
}