/**
 * Sun and sky prototype lab (sunlab.html, dev server only): the game's sun, sky and central bodies against the
 * prototypes (src/rendering/proto), live, with a graph of what each costs (perf.ts; measured as `measure` says). It
 * draws the same layers as the native harness (scripts/sun-sky-proto/layers.ts and skyLayers.ts) with a small WebGL2
 * runner.
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
import { PerfGraph, type Series } from './perf';
import { centralLayers, sourcesFrom, sunPrograms, sunVariantLayers, type CentralBody, type Layer, type View } from '../../scripts/sun-sky-proto/layers';
import { skyOption, skyPrograms, systemBiome } from '../../scripts/sun-sky-proto/skyLayers';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true })!;
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
/** Uniform and attribute locations by program (looked up once: the draws' CPU cost stays small next to the GPU's) */
const uniformLocs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
const attribLocs = new Map<WebGLProgram, Map<string, number>>();
function uloc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
  let m = uniformLocs.get(p);
  if (!m) uniformLocs.set(p, m = new Map());
  if (!m.has(name)) m.set(name, gl.getUniformLocation(p, name));
  return m.get(name)!;
}
function aloc(p: WebGLProgram, name: string): number {
  let m = attribLocs.get(p);
  if (!m) attribLocs.set(p, m = new Map());
  if (!m.has(name)) m.set(name, gl.getAttribLocation(p, name));
  return m.get(name)!;
}
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

/** Where layers without a target of their own draw: the canvas, or the measuring target */
let outFb: WebGLFramebuffer | null = null;
const vbo = gl.createBuffer()!;
const vao = gl.createVertexArray()!;
const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** A layer's quad already in its own vertex array (measuring draws each layer many times: upload it once) */
const prepared = new Map<Layer, WebGLVertexArrayObject>();

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
  else { gl.bindFramebuffer(gl.FRAMEBUFFER, outFb); gl.viewport(0, 0, w, h); }
  const ready = prepared.get(layer);
  if (ready) gl.bindVertexArray(ready);
  else {
    const verts = layer.blit ? [-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1] : layer.verts;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STREAM_DRAW);
    bindAttribs(p);
  }
  if (layer.blit) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target(layer.blit, ...size(layer.blitScale ?? 1)).tex);
    gl.uniform1i(uloc(p, 'uTex'), 0);
  } else {
    for (const m of ['uProjectionMatrix', 'uWorldTransformMatrix', 'uTransformMatrix']) {
      const loc = uloc(p, m);
      if (loc) gl.uniformMatrix3fv(loc, false, IDENTITY);
    }
    for (const [name, v] of Object.entries(layer.uniforms)) {
      const loc = uloc(p, name);
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
      gl.uniform1i(uloc(p, sampler), i);
    });
  }
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.instances ?? 1);
}

function bindAttribs(p: WebGLProgram): void {
  for (const [name, offset] of [['aPosition', 0], ['aUV', 8]] as const) {
    const loc = aloc(p, name);
    if (loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, offset);
  }
}

/** Give each layer its own vertex array for a measurement (and take them away after) */
function prepare(layers: Layer[]): () => void {
  const made: [WebGLVertexArrayObject, WebGLBuffer][] = [];
  for (const layer of layers as (Layer & { blit?: string })[]) {
    const a = gl.createVertexArray()!, b = gl.createBuffer()!;
    gl.bindVertexArray(a);
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(layer.blit ? [-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1] : layer.verts), gl.STATIC_DRAW);
    bindAttribs(program(layer.blit ? 'blit' : layer.program));
    prepared.set(layer, a);
    made.push([a, b]);
  }
  return () => {
    for (const layer of layers) prepared.delete(layer);
    for (const [a, b] of made) { gl.deleteVertexArray(a); gl.deleteBuffer(b); }
  };
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

// The performance graph: a marker for every change, so the step before and after is plain to see
const graph = new PerfGraph($('graph') as HTMLCanvasElement, $('readout'));
const chosen = (id: string) => { const e = $<HTMLSelectElement>(id); return e.selectedOptions[0]?.text ?? e.value; };
for (const [id, what] of [['sun', 'Sun'], ['sky', 'Sky'], ['system', 'System'], ['view', 'View'], ['dpr', 'Resolution']]) {
  $(id).addEventListener('change', () => graph.mark(`${what}: ${chosen(id)}`));
}
let paused = false;
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? 'Resume measuring' : 'Pause measuring';
  graph.mark(paused ? 'paused' : 'resumed');
});
let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  cam = [cam[0] - (e.clientX - drag.x) / zoom, cam[1] - (e.clientY - drag.y) / zoom];
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => { zoom = Math.max(0.04, Math.min(2, zoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15))); e.preventDefault(); }, { passive: false });
addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  if (!held) graph.mark('Space: current shaders');
  held = true;
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { held = false; graph.mark('Space released'); } });

/**
 * What a set of layers costs, in ms, by the clock and a forced sync, since in a browser neither WebGL timer queries
 * (ANGLE counts the gaps between submissions) nor the frame time (vsync) say it. Read one pixel back so the GPU has
 * finished everything before; time a second read with nothing queued (the sync's own cost); then draw the layers
 * `reps` times into an offscreen target the canvas's size and read a pixel again, which waits for all of them. The cost
 * is the difference over `reps`. It includes the driver's cost of submitting the draws (as the game would pay too),
 * which is a floor of a few hundredths of a ms for the very cheapest options.
 */
function measure(layers: Layer[], w: number, h: number, reps: number): number {
  if (!layers.length) return 0;
  const t = target('measure', w, h);
  const release = prepare(layers);
  outFb = t.fb;
  const px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  sync();
  const t0 = performance.now();
  sync();
  const t1 = performance.now();
  for (let k = 0; k < reps; k++) layers.forEach((l) => draw(l, w, h));
  sync();
  const t2 = performance.now();
  outFb = null;
  release();
  return Math.max(0, (t2 - t1) - (t1 - t0)) / reps;
}

/** Measuring: four times a second, the option shown and (every other time) the current shader, each repeated to about 5 ms */
const MEASURE_EVERY = 250;
const reps: Record<Series, number> = { sun: 4, sunRef: 4, sky: 4, skyRef: 4 };
let lastMeasure = 0, tick = 0;
function sample(series: Series, layers: Layer[], w: number, h: number): void {
  const ms = measure(layers, w, h, reps[series]);
  reps[series] = Math.max(1, Math.min(40, Math.round(5 / Math.max(ms, 0.02))));
  graph.add(series, ms);
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
  // (paused, or the tab hidden: nothing measured, so the GPU idles but for the picture)
  if (!paused && !document.hidden && now - lastMeasure > MEASURE_EVERY) {
    lastMeasure = now;
    if (tick++ % 2 === 0) { sample('sun', star, w, h); sample('sky', sky, w, h); }
    else {
      sample('sunRef', plain ? sunVariantLayers(s.id, cb, v, 'cur') : centralLayers(cb, v, false), w, h);
      sample('skyRef', skyOption('cur', biome, v, lens, R), w, h);
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  sky.forEach((l) => draw(l, w, h));
  star.forEach((l) => draw(l, w, h));
  $('stats').textContent = `${w}×${h}  ${fps.toFixed(0)} fps  zoom ${zoom.toFixed(3)}`;
  graph.draw(held ? 'current (Space held)' : plain ? chosen('sun') : `${chosen('sun')} (this body keeps its own shader)`, held ? 'current (Space held)' : chosen('sky'), paused);
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
