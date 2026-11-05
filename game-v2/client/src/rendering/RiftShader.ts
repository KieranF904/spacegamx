/**
 * Rift portal: a tear in space. A dark event horizon ringed by a flickering
 * photon ring, a two-tone accretion swirl winding into it, jagged cracks of
 * light splitting outwards from the tear, motes of light spiralling in, and a
 * faint halo. Its hue says where it goes. Fly into it to fast-travel (the
 * server moves you; this is the look).
 */

import { Container } from 'pixi.js';
import { createShaderQuad, ShaderQuad } from './shaderQuad';

/** Radius of the visible vortex, world units (the server's trigger radius is smaller) */
export const RIFT_VISUAL_RADIUS = 520;

const FRAGMENT = `
  void main() {
    vec2 p = (vUV - 0.5) * 2.0;           // -1..1 across the quad
    float r = length(p);
    if (r > 1.0) { fragColor = vec4(0.0); return; }
    float a = atan(p.y, p.x);
    float t = uTime;

    vec3 base = hsl2rgb(uHue, 0.85, 0.55);
    vec3 warm = hsl2rgb(uHue + 38.0, 0.9, 0.62);
    vec3 hot = hsl2rgb(uHue + 20.0, 0.6, 0.9);

    // The horizon breathes a little
    float throat = 0.16 + 0.008 * sin(t * 1.7);

    // Accretion swirl: logarithmic spiral arms, two tones, wound tighter inwards
    float swirl = a + 3.6 * log(r + 0.035) - t * 1.1;
    vec2 sp = vec2(cos(swirl), sin(swirl)) * (1.4 + r * 2.2);
    float arms = fbm(sp * 1.7 + vec2(0.0, t * 0.3));
    float lanes = pow(0.5 + 0.5 * sin(swirl * 3.0 + arms * 6.0), 4.0);
    float disc = smoothstep(0.78, 0.22, r) * smoothstep(throat - 0.01, throat + 0.12, r);
    vec3 col = mix(base, warm, smoothstep(0.2, 0.75, arms)) * (arms * 0.8 + lanes * 1.1) * disc;
    float alpha = disc * (0.3 + arms * 0.55 + lanes * 0.4);

    // Cracks of light splitting out from the tear: a few, uneven, jagged, slowly shifting
    // (noise is looked up on the circle, so there's no seam where the angle wraps)
    vec2 dir = vec2(cos(a), sin(a));
    float n = fbm(dir * 1.8 + vec2(r * 3.0 - t * 0.15, 0.0));
    float crack = pow(abs(sin(a * 3.0 + n * 7.0 + 0.5 * sin(t * 0.3))), 90.0);
    float which = smoothstep(0.42, 0.62, noise(dir * 2.3 + 11.0 + t * 0.03));
    float reach = 0.45 + 0.5 * noise(dir * 3.1 + 4.0);
    crack *= which * smoothstep(reach, throat + 0.05, r) * smoothstep(throat, throat + 0.05, r);
    col += hot * crack * 1.4;
    alpha = max(alpha, crack * 0.9);

    // Motes spiralling in
    float lane = mod(floor(swirl * 8.0 / 6.2832), 8.0);
    float along = fract(r * 5.0 + t * 0.55 + hash(vec2(lane, 3.0)) * 7.0);
    float mote = smoothstep(0.06, 0.0, abs(along - 0.5)) * step(0.62, hash(vec2(lane, floor(r * 5.0 + t * 0.55))));
    mote *= smoothstep(0.9, 0.3, r) * smoothstep(throat, throat + 0.1, r);
    col += hot * mote * 0.9;
    alpha = max(alpha, mote * 0.8);

    // The photon ring: a bright, flickering double rim at the horizon
    float flick = 0.85 + 0.15 * sin(a * 9.0 + t * 6.0) * sin(a * 4.0 - t * 3.3);
    float rim = exp(-pow((r - throat) / 0.018, 2.0)) * flick;
    float rim2 = exp(-pow((r - throat * 1.22) / 0.03, 2.0)) * 0.45;
    col += hot * rim * 2.0 + warm * rim2;
    alpha = max(alpha, max(rim, rim2));

    // Halo
    float halo = exp(-r * 2.6) * 0.5;
    col += base * halo * 0.7;
    alpha = max(alpha, halo * 0.45);

    // The horizon: black, hiding the stars behind it
    float well = smoothstep(throat, throat * 0.6, r);
    col = mix(col, vec3(0.0, 0.0, 0.01), well);
    alpha = max(alpha, well);

    float edge = smoothstep(1.0, 0.8, r);
    fragColor = vec4(col * edge, clamp(alpha, 0.0, 1.0) * edge);
  }
`;

export class RiftShader {
  readonly container = new Container();
  private quad: ShaderQuad;
  private time = Math.random() * 100;

  constructor(hue: number) {
    this.quad = createShaderQuad(FRAGMENT, {
      uTime: { value: 0, type: 'f32' },
      uHue: { value: hue, type: 'f32' },
    }, RIFT_VISUAL_RADIUS);
    this.container.addChild(this.quad.mesh);
  }

  update(delta: number): void {
    this.time += delta;
    this.quad.u.uniforms.uTime = this.time;
  }
}
