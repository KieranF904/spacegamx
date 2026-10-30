/**
 * Sun and sky prototype lab (sunlab.html, dev server only): the game's sun, sky and central bodies against the
 * prototypes (src/rendering/proto), live, with GPU timings when the browser exposes timer queries. It draws the
 * same layers as the native harness (scripts/sun-sky-proto/layers.ts and skyLayers.ts) with a small WebGL2 runner.
 */

import sunText from '../src/rendering/SunRenderer.ts?raw';
import glowText from '../src/rendering/GlowRenderer.ts?raw';
import raysText from '../src/rendering/CoronaRaysRenderer.ts?raw';
import centralText from '../src/rendering/CentralBodyShaders.ts?raw';
import quadText from '../src/rendering/shaderQuad.ts?raw';
import { GLSL_COMMON } from '../src/rendering/shaderQuad';
import { skyNoiseTexture } from '../src/rendering/sky/noiseTexture';
import { bakeSimplex, noise3Data, NOISE3_SIZE, sunNoiseData, SUN_NOISE_SIZE } from '../src/rendering/proto/protoNoise';
import { EXACT_SIZE, EXACT_UNITS } from '../src/rendering/proto/sunProto';
import systemsJson from '../../data/systems.json';
import { centralLayers, sourcesFrom, sunPrograms, sunVariantLayers, type CentralBody, type Layer, type View } from '../../scripts/sun-sky-proto/layers';
import { skyOption, skyPrograms, systemBiome } from '../../scripts/sun-sky-proto/skyLayers';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true })!;
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const systems: any[] = (systemsJson as any).systems ?? systemsJson;
const shown = systems.filter((s) => s.centralBody && s.centralBody.type !== 'none');
for (const s of shown) $('system').append(new Option(`${s.name} (${s.centralBody.type})`, s.id));

const sources = sourcesFrom({ sun: sunText, glow: glowText, rays: raysText, central: centralText, quad: quadText }, GLSL_COMMON);
const programSources = { ...sunPrograms(sources, false), ...skyPrograms(false) };

const BLIT_VERT = `#version 300 es
in vec2 aPosition; in vec2 aUV; out vec2 vUV;
void main() { vUV = aUV; gl_Position = vec4(aPosition, 0.0, 1.0); }`;
const BLIT_FRAG = `#version 300 es
precision mediump float; in vec2 vUV; out vec4 fragColor; uniform sampler2D uTex;
void main() { fragColor = texture(uTex, vUV); }`;

function compile(vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vert], [gl.FRAGMENT_SHADER, frag]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'compile failed');
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
  return p;
}
const programs = new Map<string, WebGLProgram>();
const program = (name: string) => {
  let p = programs.get(name);
  if (!p) programs.set(name, p = name === 'blit' ? compile(BLIT_VERT, BLIT_FRAG) : compile(programSources[name].vert, programSources[name].frag));
  return p;
};

function texture(data: Uint8Array, size: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return t;
}
const skySrc = skyNoiseTexture().source as unknown as { resource: Uint8Array; width: number };
/** The baked simplex (A-exact): one float channel, linear, clamped (its shader mirrors the coordinate) */
function floatTexture(data: Float32Array, size: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, size, size, 0, gl.RED, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
/** The plasma star's noise volume: repeat, trilinear with mipmaps */
function volume(data: Uint8Array, size: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
  return t;
}
const textures: Record<string, WebGLTexture> = { sunNoise: texture(sunNoiseData(), SUN_NOISE_SIZE), skyNoise: texture(skySrc.resource, skySrc.width) };
// (made on first use: the simplex bake takes a few hundred ms)
const lazyTextures: Record<string, () => WebGLTexture> = { simplex: () => floatTexture(bakeSimplex(EXACT_SIZE, EXACT_UNITS), EXACT_SIZE) };
const volumes: Record<string, () => WebGLTexture> = { noise3: () => volume(noise3Data(), NOISE3_SIZE) };
const made3: Record<string, WebGLTexture> = {};

/** Render targets by name (the haze's), remade at a new size */
const targets = new Map<string, { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }>();
function target(name: string, w: number, h: number) {
  const t = targets.get(name);
  if (t && t.w === w && t.h === h) return t;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const made = { fb, tex, w, h };
  targets.set(name, made);
  return made;
}

const vbo = gl.createBuffer()!;
const vao = gl.createVertexArray()!;
const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** One layer as the harness draws it */
function draw(layer: Layer & { blit?: string; blitScale?: number }, w: number, h: number): void {
  const size = (s: number) => [Math.max(1, Math.ceil(w * s)), Math.max(1, Math.ceil(h * s))] as const;
  const p = program(layer.blit ? 'blit' : layer.program);
  gl.useProgram(p);
  if (layer.blend === 'none') gl.disable(gl.BLEND);
  else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, layer.blend === 'add' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA); }
  if (layer.target) {
    const t = target(layer.target, ...size(layer.scale ?? 1));
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
    if (layer.clearTarget) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  }
  else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h); }
  const verts = layer.blit ? [-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1] : layer.verts;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STREAM_DRAW);
  for (const [name, offset] of [['aPosition', 0], ['aUV', 8]] as const) {
    const loc = gl.getAttribLocation(p, name);
    if (loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, offset);
  }
  if (layer.blit) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target(layer.blit, ...size(layer.blitScale ?? 1)).tex);
    gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);
  } else {
    for (const m of ['uProjectionMatrix', 'uWorldTransformMatrix', 'uTransformMatrix']) {
      const loc = gl.getUniformLocation(p, m);
      if (loc) gl.uniformMatrix3fv(loc, false, IDENTITY);
    }
    for (const [name, v] of Object.entries(layer.uniforms)) {
      const loc = gl.getUniformLocation(p, name);
      if (!loc) continue;
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (Array.isArray(v[0])) gl.uniform4fv(loc, (v as unknown as number[][]).flat());
      else if (v.length === 2) gl.uniform2fv(loc, v);
      else if (v.length === 3) gl.uniform3fv(loc, v);
      else gl.uniform4fv(loc, v);
    }
    Object.entries(layer.textures ?? {}).forEach(([sampler, name], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      if (volumes[name]) gl.bindTexture(gl.TEXTURE_3D, made3[name] ??= volumes[name]());
      else gl.bindTexture(gl.TEXTURE_2D, textures[name] ??= lazyTextures[name]());
      gl.uniform1i(gl.getUniformLocation(p, sampler), i);
    });
  }
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.instances ?? 1);
}

// The camera: a view preset, then panned and zoomed by hand
let cam: [number, number] = [0, 0], zoom = 0.15, time = 120, held = false;
function preset(): void {
  const s = shown.find((x) => x.id === $<HTMLSelectElement>('system').value)!;
  const cb = s.centralBody, R = cb.detailParams?.radius ?? cb.radius ?? 1000, w = canvas.clientWidth;
  const v = $<HTMLSelectElement>('view').value;
  if (v === 'whole') { cam = [0, 0]; zoom = 0.04; }
  else if (v === 'limb') { zoom = 0.15; cam = [R + (0.1 * w) / zoom, 0]; }
  else if (v === 'close') { zoom = 1; cam = [R * Math.SQRT1_2 - 150, -R * Math.SQRT1_2 + 100]; }
  else if (v === 'disc') { zoom = 0.5; cam = [0.3 * R, 0.1 * R]; }
  else { zoom = 0.3; cam = [1.6 * R, 0]; }
}
for (const id of ['system', 'view']) $(id).addEventListener('change', preset);
let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  cam = [cam[0] - (e.clientX - drag.x) / zoom, cam[1] - (e.clientY - drag.y) / zoom];
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { zoom = Math.max(0.04, Math.min(2, zoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15))); e.preventDefault(); }, { passive: false });
addEventListener('keydown', (e) => { if (e.code === 'Space') { held = true; e.preventDefault(); } });
addEventListener('keyup', (e) => { if (e.code === 'Space') held = false; });

// GPU time of the sky and of the star, each frame (when the browser has timer queries), smoothed
const gpu = { sky: 0, sun: 0 };
const pending: { q: WebGLQuery; key: 'sky' | 'sun' }[] = [];
function timed(key: 'sky' | 'sun', fn: () => void): void {
  if (!timer) return fn();
  const q = gl.createQuery()!;
  gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
  fn();
  gl.endQuery(timer.TIME_ELAPSED_EXT);
  pending.push({ q, key });
}
function collect(): void {
  const disjoint = timer && gl.getParameter(timer.GPU_DISJOINT_EXT);
  while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
    const { q, key } = pending.shift()!;
    if (!disjoint) gpu[key] += (gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 - gpu[key]) * 0.1;
    gl.deleteQuery(q);
  }
}

let last = performance.now(), fps = 60;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  time += dt * Number($<HTMLInputElement>('speed').value);
  const dpr = $<HTMLSelectElement>('dpr').value === 'dpr' ? devicePixelRatio : 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const s = shown.find((x) => x.id === $<HTMLSelectElement>('system').value)!;
  const cb = s.centralBody as CentralBody;
  const v: View = { w: cw, h: ch, dpr, cam, zoom, t: time };
  const lens = cb.type === 'black_hole' ? cb.radius ?? 0 : 0;
  const sunKind = held ? 'cur' : $<HTMLSelectElement>('sun').value;
  const skyKind = held ? 'cur' : $<HTMLSelectElement>('sky').value;
  const biome = systemBiome(s);
  const plain = cb.type === 'sun';
  const R = plain ? cb.detailParams?.radius ?? cb.radius ?? 1000 : 0;
  const sky = skyOption(skyKind, biome, v, lens, R);
  // (black holes, the pulsar and the brown dwarf keep their own shaders in every option)
  const star = plain ? sunVariantLayers(s.id, cb, v, sunKind) : centralLayers(cb, v, false);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  timed('sky', () => sky.forEach((l) => draw(l, w, h)));
  timed('sun', () => star.forEach((l) => draw(l, w, h)));
  collect();
  $('stats').textContent = `${w}×${h}  ${fps.toFixed(0)} fps  zoom ${zoom.toFixed(3)}\n`
    + (timer ? `GPU  sky ${gpu.sky.toFixed(3)} ms   star ${gpu.sun.toFixed(3)} ms` : 'GPU timer queries not available in this browser')
    + `\nshowing  sun: ${plain ? sunKind : 'its own shader'}   sky: ${skyKind}${held ? '  (Space: current)' : ''}`;
  requestAnimationFrame(frame);
}
/**
 * ?compile: how long each program takes to compile and link from cold (a fresh browser profile has no program cache),
 * the game's against the prototypes'; the results in window.compileTimes
 */
if (location.search.includes('compile')) {
  const times: Record<string, { ms: number; chars: number }> = {};
  for (const [name, src] of Object.entries(programSources)) {
    const t0 = performance.now();
    const p = compile(src.vert, src.frag);
    times[name] = { ms: Math.round(performance.now() - t0), chars: src.frag.length };
    gl.deleteProgram(p);
  }
  (window as any).compileTimes = times;
} else {
  preset();
  requestAnimationFrame(frame);
}
