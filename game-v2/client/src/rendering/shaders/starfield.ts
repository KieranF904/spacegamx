// Starfield shader for fullscreen quad rendering
// Procedural star generation in the fragment shader — no data texture needed
// Parallax layers, LOD crossfade, twinkle, HSL color, inverse-square glow

// Vertex shader (PixiJS v8 / GLSL 300 ES)
export const starfieldVert = `#version 300 es
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

// Fragment shader — procedural starfield with simplex noise clustering
export const starfieldFrag = `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 fragColor;

uniform float uTime;
uniform float uZoom;
uniform vec2  uCamera;
uniform vec2  uResolution;
uniform float uStarBrightness;
uniform float uTwinkleSpeed;
uniform float uTwinkleAmount;
uniform float uHueShift;
uniform float uDensity;          // star spawn probability multiplier
uniform float uStarSize;         // star size multiplier
uniform float uParallaxStrength; // parallax intensity
uniform float uBaseCell;         // LOD base cell size
uniform float uLodBlendWidth;    // LOD crossfade width (0.3=sharp, 1.0=wide)

// =============================================
// Hash helpers
// =============================================
float hash(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p.yx + 19.19);
    return fract(p.x * p.y);
}
vec2 hash2(vec2 p) {
    return vec2(hash(p), hash(p + 127.1));
}

// =============================================
// Simplex noise 2D  (for star clustering)
// =============================================
vec3 mod289v3(vec3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289v2(vec2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute(vec3 x)  { return mod289v3(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289v2(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m * m * m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x = a0.x * x0.x  + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);          // range ~ -1..1
}

// =============================================
// Realistic star color from "temperature"
// Maps a 0..1 value to cool blue → white → warm yellow/orange
// =============================================
vec3 starColor(float temp, float hueShift) {
    vec3 cool   = vec3(1.0, 0.7, 0.4);
    vec3 warm   = vec3(1.0, 0.92, 0.8);
    vec3 white  = vec3(0.95, 0.95, 1.0);
    vec3 blue   = vec3(0.7, 0.8, 1.0);

    vec3 col;
    if (temp < 0.25)      col = mix(cool, warm, temp / 0.25);
    else if (temp < 0.55) col = mix(warm, white, (temp - 0.25) / 0.3);
    else                  col = mix(white, blue, (temp - 0.55) / 0.45);

    float angle = hueShift * 0.01745;
    float cs = cos(angle), sn = sin(angle);
    vec2 rg = vec2(col.r - 0.5, col.g - 0.5);
    col.rg = vec2(rg.x*cs - rg.y*sn, rg.x*sn + rg.y*cs) + 0.5;
    return clamp(col, 0.0, 1.0);
}

// =============================================
// Cheap density function using hash (NOT noise)
// Produces organic-ish clustering without trig/permute cost.
// Evaluated once per cell, not per fragment.
// =============================================
float cellDensity(vec2 cellId, float layerSeed) {
    // Large-scale pattern from hashing at multiple scales
    float h1 = hash(cellId * 0.037 + layerSeed);
    float h2 = hash(cellId * 0.011 + layerSeed + 99.0);
    // Combine for smooth-ish variation
    float d = h1 * 0.6 + h2 * 0.4;
    return smoothstep(0.2, 0.75, d);   // 0..1 density
}

// =============================================
// Star layer  (optimized: 1 star/cell, cheap density)
// =============================================
vec3 starLayer(vec2 worldPos, float cellSize, float depth, float layerSeed, float layerAlpha) {
    if (layerAlpha <= 0.001) return vec3(0.0);

    // Parallax
    vec2 pPos = worldPos + uCamera * depth * uParallaxStrength;
    vec2 cell = floor(pPos / cellSize);
    vec3 col = vec3(0.0);

    // 3×3 neighborhood — 1 star per cell max
    for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
            vec2 c = cell + vec2(float(dx), float(dy));
            vec2 seed = c + layerSeed;

            // Cheap density check — skip empty cells fast
            float density = cellDensity(c, layerSeed);
            float spawnProb = (density * 0.7 + 0.15) * uDensity;
            if (hash(seed * 0.131) > spawnProb) continue;

            // Star position
            vec2 starPos = (c + hash2(seed * 0.719)) * cellSize;
            float d = length(pPos - starPos) / cellSize;

            // Early out — if fragment is far from this star, skip
            if (d > 0.04) continue;

            // Star properties
            float temp = hash(seed * 0.317);
            temp = temp * temp * 0.7 + temp * 0.3;

            float rawSize = hash(seed * 0.937);
            float size = (0.003 + 0.006 * rawSize * rawSize) * uStarSize;

            float phase = hash(seed * 0.811) * 6.2832;
            float baseBright = 0.5 + 0.5 * hash(seed * 0.631);
            baseBright *= 0.7 + density * 0.4;

            // Twinkle
            float tw = 1.0 - uTwinkleAmount
                     + uTwinkleAmount * (0.5 + 0.5 * sin(uTime * uTwinkleSpeed + phase));

            // Tight glow
            float core = smoothstep(size * 0.5, 0.0, d);
            float halo = smoothstep(size * 2.0, 0.0, d) * 0.3;
            float brightness = (core + halo) * tw * baseBright * uStarBrightness * layerAlpha;

            col += starColor(temp, uHueShift) * brightness;
        }
    }
    return col;
}

// =============================================
// Main  (3 simultaneous LOD layers with smooth crossfade)
// =============================================
void main() {
    vec2 screenPos = (vUV - 0.5) * uResolution;
    vec2 worldPos  = screenPos / uZoom + uCamera;

    vec3 col = vec3(0.0);

    float logZoom  = -log2(uZoom);
    float layerF   = logZoom + 2.5;
    float base     = floor(layerF);
    float f        = fract(layerF);

    // 3 layers always visible:
    //   i=0  (coarsest, fading OUT as zoom increases)
    //   i=1  (middle, always solid)
    //   i=2  (finest, fading IN as zoom increases)
    for (int i = 0; i < 3; i++) {
        float li = base + float(i) - 1.0;

        float alpha;
        if (i == 0) {
            // Fading out: full at f=0, gone by f=blendWidth
            alpha = 1.0 - smoothstep(0.0, uLodBlendWidth, f);
        } else if (i == 2) {
            // Fading in: appears at f=(1-blendWidth), full at f=1
            alpha = smoothstep(1.0 - uLodBlendWidth, 1.0, f);
        } else {
            // Middle layer: always fully visible
            alpha = 1.0;
        }

        float cellSz = uBaseCell * pow(2.0, li);
        float depth  = 0.05 + float(i) * 0.25;
        float seed   = li * 137.0;

        col += starLayer(worldPos, cellSz, depth, seed, alpha);
    }

    col += vec3(0.008, 0.009, 0.014);
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
