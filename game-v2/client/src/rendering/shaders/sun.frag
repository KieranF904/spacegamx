// Sun shader with flowfield noise patterns and smooth gradients
// Fragment shader

precision mediump float;

varying vec2 vUV;

uniform float uTime;
uniform float uHue;           // Base hue (0-360)
uniform float uRadius;        // Sun radius in UV space (0-1)
uniform vec2 uResolution;     // For aspect ratio correction

// ============================================
// Simplex noise functions
// ============================================

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
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

// Fractal brownian motion for more complex noise
float fbm(vec2 p, int octaves) {
    float value = 0.0;
    float amplitude = 0.5;
    float frequency = 1.0;
    for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        value += amplitude * snoise(p * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

// ============================================
// Flowfield distortion
// ============================================

vec2 flowField(vec2 p, float time) {
    // Curl noise for divergence-free flow
    float eps = 0.01;
    float n1 = snoise(p + vec2(eps, 0.0) + time * 0.02);
    float n2 = snoise(p - vec2(eps, 0.0) + time * 0.02);
    float n3 = snoise(p + vec2(0.0, eps) + time * 0.02);
    float n4 = snoise(p - vec2(0.0, eps) + time * 0.02);
    
    // Curl = (dN/dy, -dN/dx)
    return vec2((n3 - n4) / (2.0 * eps), -(n1 - n2) / (2.0 * eps)) * 0.15;
}

// ============================================
// HSL to RGB conversion
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
// Main
// ============================================

void main() {
    // Center UV coordinates (-1 to 1)
    vec2 uv = (vUV - 0.5) * 2.0;
    
    // Aspect ratio correction
    float aspect = uResolution.x / uResolution.y;
    uv.x *= aspect;
    
    float dist = length(uv);
    float sunRadius = uRadius;
    
    // Calculate hue variations
    float baseHue = uHue;
    float warmHue = mod(baseHue + 20.0, 360.0);
    float hotHue = mod(baseHue + 40.0, 360.0);
    
    // ========== Outer glow (corona) ==========
    float glowStart = sunRadius * 0.95;
    float glowEnd = sunRadius * 2.5;
    
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    
    if (dist > glowStart && dist < glowEnd) {
        float glowT = (dist - glowStart) / (glowEnd - glowStart);
        // Exponential falloff
        float glowAlpha = 0.4 * pow(1.0 - glowT, 2.5);
        
        // Color shifts from bright to warm to hot
        float hue = mix(baseHue, hotHue, glowT);
        float sat = 0.8;
        float lit = mix(0.7, 0.4, glowT);
        
        color = hsl2rgb(hue, sat, lit);
        alpha = glowAlpha;
    }
    
    // ========== Sun body ==========
    if (dist < sunRadius) {
        float sunT = dist / sunRadius;
        
        // Apply flowfield distortion to UVs for surface texture
        vec2 flowUV = uv * 3.0;
        vec2 flow = flowField(flowUV, uTime);
        vec2 distortedUV = flowUV + flow;
        
        // Multi-octave noise for surface detail
        float surfaceNoise = fbm(distortedUV + uTime * 0.01, 4);
        
        // Slow-moving large-scale patterns
        float largePattern = snoise(uv * 1.5 + uTime * 0.008) * 0.5;
        
        // Sunspots (darker regions)
        float spotNoise = snoise(distortedUV * 2.0 - uTime * 0.005);
        float spots = smoothstep(0.3, 0.5, spotNoise) * 0.15;
        
        // Bright granulation
        float granulation = (surfaceNoise * 0.5 + 0.5) * 0.1;
        
        // Base gradient (bright center to darker edge - limb darkening)
        float limbDarkening = 1.0 - pow(sunT, 1.5) * 0.3;
        
        // Hue shifts from center to edge
        float hue = mix(baseHue, hotHue, sunT * sunT);
        float sat = mix(0.7, 1.0, sunT);
        float lit = mix(0.98, 0.55, pow(sunT, 0.8));
        
        // Apply surface effects
        lit = lit * limbDarkening;
        lit = lit + granulation - spots + largePattern * 0.05;
        lit = clamp(lit, 0.3, 1.0);
        
        color = hsl2rgb(hue, sat, lit);
        alpha = 1.0;
        
        // Soft edge
        float edgeSoftness = smoothstep(sunRadius, sunRadius * 0.95, dist);
        alpha *= edgeSoftness;
    }
    
    // ========== Bright center glow ==========
    if (dist < sunRadius * 0.5) {
        float centerT = dist / (sunRadius * 0.5);
        float centerGlow = pow(1.0 - centerT, 2.0) * 0.4;
        color = mix(color, vec3(1.0, 1.0, 0.98), centerGlow);
    }
    
    // ========== Edge ring (photosphere) ==========
    float ringDist = abs(dist - sunRadius);
    if (ringDist < sunRadius * 0.03) {
        float ringT = 1.0 - ringDist / (sunRadius * 0.03);
        float pulse = 0.4 + 0.2 * sin(uTime * 2.0);
        vec3 ringColor = hsl2rgb(baseHue, 1.0, 0.85);
        color = mix(color, ringColor, ringT * pulse * 0.5);
        alpha = max(alpha, ringT * pulse * 0.6);
    }
    
    gl_FragColor = vec4(color, alpha);
}
