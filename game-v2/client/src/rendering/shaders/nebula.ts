// Codementor-inspired procedural nebula shader for sandbox use.
// Tuned defaults are baked in; runtime controls are intentionally minimal.

export const nebulaVert = `#version 300 es
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

export const nebulaFrag = `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 fragColor;

uniform float uTime;
uniform float uSeed;
uniform float uShapeScale;
uniform float uIntensity;
uniform float uAnimSpeed;
uniform float uLod;
uniform float uParallax;
uniform vec2 uCamera;
uniform float uNebulaRadius;

float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float a = fract(sin(dot(i + vec2(0.0, 0.0), vec2(127.1, 311.7))) * 43758.5453123);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453123);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453123);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453123);

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.55;
    float f = 1.0;
    for (int i = 0; i < 6; i++) {
        v += a * noise(p * f);
        f *= 1.85;
        a *= 0.55;
    }
    return v;
}

vec3 rotateHue(vec3 col, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    mat3 m = mat3(
        0.299 + 0.701*c + 0.168*s, 0.587 - 0.587*c + 0.330*s, 0.114 - 0.114*c - 0.497*s,
        0.299 - 0.299*c - 0.328*s, 0.587 + 0.413*c + 0.035*s, 0.114 - 0.114*c + 0.292*s,
        0.299 - 0.300*c + 1.250*s, 0.587 - 0.588*c - 1.050*s, 0.114 + 0.886*c - 0.203*s
    );
    return clamp(m * col, 0.0, 2.0);
}

void main() {
    // Tuned defaults from prototype export
    const float DENSITY = 0.97;
    const float CONTRAST = 2.28;
    const float WARP = 0.63;
    const float FLOW_SPEED = 0.01;
    const float NOISE_DETAIL = 2.0;
    const float SUBTLE_COLOR_VAR = 3.05;
    const float COLOR_STREAKS = 0.95;
    const float STREAK_WIDTH = 1.68;
    const float STREAK_COLOR_BIAS = -0.6;
    const float OUTER_FALLOFF = 3.35;
    const float HUE_SHIFT = -12.0;
    const float GRAIN = 0.03;

    vec2 uv = vUV;
    float lod = clamp(uLod, 0.0, 1.0);
    float t = uTime * FLOW_SPEED * max(0.0, uAnimSpeed);

    float aspect = 1.0;
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * max(0.2, uShapeScale);
    float safeRadius = max(1.0, uNebulaRadius);
    vec2 parallaxOffset = (uCamera / safeRadius) * uParallax;
    p += parallaxOffset;
    p += vec2(uSeed * 0.00037, uSeed * 0.00071);

    vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - vec2(0.0, t * 0.8)));
    vec2 w = p + (q - 0.5) * WARP;

    // Keep base pattern stable across LOD; only modulate fine-detail contribution.
    float base = fbm(w * (0.9 + NOISE_DETAIL * 0.8));
    float detail = fbm(w * 2.5 + vec2(7.1, -3.4));
    float microDetail = fbm(w * 4.6 + vec2(-11.7, 6.9));
    float ridge = 1.0 - abs(2.0 * detail - 1.0);

    float nebula = mix(base, ridge, 0.32) * DENSITY;
    nebula += (microDetail - 0.5) * 0.28 * lod;
    nebula = pow(max(0.0, nebula), CONTRAST);

    float radial = 1.0 - length((uv - 0.5) * vec2(1.15, 1.0));
    radial = smoothstep(0.0, 1.0, radial);

    vec3 deep = vec3(0.03, 0.06, 0.14);
    vec3 mid = vec3(0.20, 0.10, 0.33);
    vec3 hot = vec3(0.75, 0.42, 0.86);

    float cVarA = fbm(w * 0.55 + vec2(2.4, -1.1));
    float cVarB = fbm(w * 0.95 + vec2(-4.2, 3.7));
    float cVarC = fbm(w * 1.65 + vec2(8.3, -6.6));
    float cVar = (cVarA * 0.7 + cVarB * 0.3) - 0.5;
    float cVar2 = (cVarC - 0.5);

    vec3 varTint = vec3(
      cVar * 0.28 + cVar2 * 0.14,
      cVar * -0.12 + cVar2 * 0.08,
      cVar * 0.34 - cVar2 * 0.10
    ) * SUBTLE_COLOR_VAR;
    deep += varTint * 0.85;
    mid += varTint * 1.15;
    hot += varTint * 1.45;

    vec3 gas = mix(deep, mid, smoothstep(0.08, 0.55, nebula));
    gas = mix(gas, hot, smoothstep(0.45, 1.0, nebula));

    float segA = fbm(w * (1.05 / STREAK_WIDTH) + vec2(t * 0.10, -t * 0.06));
    float segB = fbm(w * (2.20 / STREAK_WIDTH) + vec2(-3.7, 5.1) + vec2(t * 0.04, t * 0.03));
    float segField = mix(segA, segB, 0.42);
    float densityMask = smoothstep(0.14, 0.82, nebula);
    float segmentMask = smoothstep(0.56, 0.87, segField);
    segmentMask *= (0.55 + 0.45 * smoothstep(0.35, 0.90, cVarA));
    segmentMask *= densityMask;

    float streakPicker = fbm(w * 0.72 + vec2(-6.2, 4.3));
    float streakPicker2 = fbm(w * 1.41 + vec2(9.7, -2.1));
    float picker = clamp(streakPicker * 0.65 + streakPicker2 * 0.35, 0.0, 1.0);
    float bias = clamp(STREAK_COLOR_BIAS * 0.5 + 0.5, 0.0, 1.0);

    vec3 coolA = vec3(0.05, 0.82, 0.98);
    vec3 coolB = vec3(0.50, 0.34, 1.00);
    vec3 warmA = vec3(1.00, 0.62, 0.16);
    vec3 warmB = vec3(0.98, 0.22, 0.72);

    float coolWarm = smoothstep(0.25, 0.75, mix(picker, bias, 0.35));
    float intra = fract(picker * 3.17 + segB * 0.61);
    vec3 coolColor = mix(coolA, coolB, smoothstep(0.2, 0.8, intra));
    vec3 warmColor = mix(warmA, warmB, smoothstep(0.2, 0.8, 1.0 - intra));
    vec3 biasColor = mix(coolColor, warmColor, coolWarm);

    float lum = dot(biasColor, vec3(0.299, 0.587, 0.114));
    biasColor = mix(vec3(lum), biasColor, 1.35);
    biasColor = clamp(biasColor, 0.0, 1.25);

    float streakStrength = clamp(segmentMask * COLOR_STREAKS * 1.15 * mix(0.35, 1.0, lod), 0.0, 1.0);
    vec3 biasedGas = mix(gas, mix(gas, biasColor, 0.72), streakStrength);
    gas = mix(gas, biasedGas, densityMask);

    float hueBand = smoothstep(0.18, 0.72, nebula) * (0.6 + 0.4 * (cVarA + cVarB) * 0.5);
    gas += vec3(0.08, -0.02, 0.11) * hueBand * SUBTLE_COLOR_VAR * mix(0.45, 1.0, lod);
    gas = rotateHue(gas, HUE_SHIFT * 0.0174532925);

    float edgeDist = length((uv - 0.5) * vec2(1.15, 1.0));
    float edgeMask = clamp(1.0 - edgeDist, 0.0, 1.0);
    edgeMask = pow(edgeMask, 0.4 + OUTER_FALLOFF * 0.9);

    vec3 col = gas;
    float g = (noise(uv * 600.0 + uTime * 0.7) - 0.5) * GRAIN * mix(0.2, 1.0, lod);
    col += g;
    col *= edgeMask * max(0.0, uIntensity);

    col = pow(max(col, 0.0), vec3(0.9));

    float nebulaAlpha = clamp(nebula * edgeMask * max(0.0, uIntensity), 0.0, 1.0);
    float alpha = nebulaAlpha;
    fragColor = vec4(col * alpha, alpha);
}
`;
