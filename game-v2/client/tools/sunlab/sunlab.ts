/**
 * Sun, sky and planet prototype lab (sunlab.html, dev server only): a whole system as the game lays it out (the star
 * and its sky, then every planet and moon at its orbit position, frozen at tick 0, each lit from the system centre as
 * PlanetRenderer lights it), the game's shaders against the prototypes (src/rendering/proto for the star and sky,
 * src/rendering/planet-proto for the planets, moons and the brown dwarf), live, with a graph of what each costs
 * (perf.ts; measured as `measure` and `measurePlanets` say). It draws the same layers as the native harnesses
 * (scripts/sun-sky-proto/layers.ts and skyLayers.ts, scripts/planet-proto/layers.ts) with a small WebGL2 runner.
 *
 * URL params (all optional): ?system=<id>&body=star|<planet id>|<planet id>.moon<i>&look=proto|proto.fine|proto.lite|cur
 * &view=<preset>&sun=<star option>&sky=<sky option>&zoom=<z>, e.g. sunlab.html?system=sol&body=jovan&view=limb. A body alone
 * finds its system (sunlab.html?body=terra_nova); the planet lab's `<system>.dwarf` means that system's star. ?compile
 * times every program's cold compile instead.
 */

import sunText from '../legacy/SunRenderer.ts?raw';
import glowText from '../legacy/GlowRenderer.ts?raw';
import raysText from '../legacy/CoronaRaysRenderer.ts?raw';
import centralText from '../../src/rendering/CentralBodyShaders.ts?raw';
import quadText from '../../src/rendering/shaderQuad.ts?raw';
import planetText from '../../src/rendering/planet-proto/planetClassic.ts?raw';
import { planetCrackCells, planetNoiseData, PLANET_NOISE_SIZE } from '../../src/rendering/planet-proto/planetNoise';
import { moonOffset, planetPosition, type PlanetData } from '@space-game/common';
import { GLSL_COMMON } from '../../src/rendering/shaderQuad';
import { skyNoiseTexture } from '../../src/rendering/sky/noiseTexture';
import { bakeSimplex, noise3Data, NOISE3_SIZE, sunNoiseData, SUN_NOISE_SIZE } from '../../src/rendering/proto/protoNoise';
import { EXACT_SIZE, EXACT_UNITS } from '../../src/rendering/proto/sunProto';
import systemsJson from '../../../data/systems.json';
import { PerfGraph, type Series } from './perf';
import { centralLayers, onScreen, sourcesFrom, sunPrograms, sunVariantLayers, type CentralBody, type Layer, type View } from '../../../scripts/sun-sky-proto/layers';
import { bodiesOf, bodyLayer, lightAmtOf, planetPrograms, sourcesFrom as planetSourcesFrom, type Body, type Variant } from '../../../scripts/planet-proto/layers';
import { skyOption, skyPrograms, systemBiome } from '../../../scripts/sun-sky-proto/skyLayers';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true })!;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const systems: any[] = (systemsJson as any).systems ?? systemsJson;
const shown = systems.filter((s) => s.centralBody && s.centralBody.type !== 'none');
for (const s of shown) $('system').append(new Option(`${s.name} (${s.centralBody.type})`, s.id));

/** The game's tick the orbits are frozen at (the lab's time runs only the shaders' clocks, so a focused body stays put) */
const TICK = 0;
/** A planet or moon where the game puts it, its light toward the system centre (PlanetRenderer.update) */
interface Placed { body: Body; x: number; y: number; light: [number, number] }
/** The brown dwarf lights itself; its light vector is the planet lab's default "sun from" angle (for the prototype's rim) */
const DWARF_LIGHT: [number, number] = [Math.cos((-160 * Math.PI) / 180), Math.sin((-160 * Math.PI) / 180)];
const scenes = new Map<string, { dwarf?: Body; placed: Placed[] }>();
/** A system's bodies: the brown dwarf (drawn as its star), and the planets and moons in PlanetRenderer's draw order
 * (each planet's moons, then the planet) */
function sceneOf(s: any) {
  let scene = scenes.get(s.id);
  if (scene) return scene;
  const all = bodiesOf(s), placed: Placed[] = [];
  const at = (body: Body, x: number, y: number): Placed => { const d = Math.hypot(x, y) || 1; return { body, x, y, light: [-x / d, -y / d] }; };
  for (const p of (s.planets ?? []) as PlanetData[]) {
    const pos = planetPosition(p, TICK);
    (p.moons ?? []).forEach((_, i) => {
      const m = all.find((b) => b.id === `${p.id}.moon${i}`), o = moonOffset(p, i, TICK);
      if (m) placed.push(at(m, pos.x + o.x, pos.y + o.y));
    });
    const b = all.find((x) => x.id === p.id);
    if (b) placed.push(at(b, pos.x, pos.y));
  }
  scenes.set(s.id, scene = { dwarf: all.find((b) => b.dwarf), placed });
  return scene;
}
const system = () => shown.find((x) => x.id === $<HTMLSelectElement>('system').value)!;
/** The focused planet or moon: undefined for the star (or the brown dwarf, which is the star there) */
const focused = (): Placed | undefined => sceneOf(system()).placed.find((p) => p.body.id === $<HTMLSelectElement>('body').value);
function fillBodies(): void {
  const s = system(), sel = $<HTMLSelectElement>('body');
  sel.replaceChildren(new Option(`${s.name.replace(/ System$/, '')}'s ${s.centralBody.type.replace('_', ' ')} (the star)`, 'star'));
  const placed = [...sceneOf(s).placed].sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  for (const p of placed.filter((q) => !q.body.id.includes('.moon'))) {
    const b = p.body;
    sel.append(new Option(`${b.name}: ${b.kind}${b.rings ? ', rings' : ''}`, b.id));
    for (const m of placed.filter((q) => q.body.id.startsWith(`${b.id}.moon`))) sel.append(new Option(`\u00a0\u00a0\u00a0${m.body.name}: moon (${m.body.kind})`, m.body.id));
  }
}

const sources = sourcesFrom({ sun: sunText, glow: glowText, rays: raysText, central: centralText, quad: quadText }, GLSL_COMMON);
const planetSources = planetSourcesFrom({ planet: planetText, central: centralText, quad: quadText }, GLSL_COMMON);
const programSources = { ...sunPrograms(sources, false), ...skyPrograms(false), ...planetPrograms(planetSources, false) };

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

/** The planets' crack candidates (the fine look's): 160 x 40 x 40, nearest, repeating */
function crackVolume(): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 160, 40, 40, 0, gl.RGBA, gl.UNSIGNED_BYTE, planetCrackCells());
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
  return t;
}
const volumes: Record<string, () => WebGLTexture> = { noise3: () => volume(noise3Data(), NOISE3_SIZE), planetNoise: () => volume(planetNoiseData(), PLANET_NOISE_SIZE), planetCrack: crackVolume };
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

// The camera: a view preset, then panned and zoomed by hand. The lab zooms far past the game, both ways
// (GAME_ZOOM is InputManager's flight range), to look at the surface and the limb up close, or the whole system.
const LAB_ZOOM = [0.002, 40] as const;
const GAME_ZOOM = [0.04, 2] as const;
const inGame = (z: number) => z >= GAME_ZOOM[0] * 0.999 && z <= GAME_ZOOM[1] * 1.001;
/** The zoom slider runs 0..1000 on a log scale */
const toSlider = (z: number) => Math.round((Math.log(z / LAB_ZOOM[0]) / Math.log(LAB_ZOOM[1] / LAB_ZOOM[0])) * 1000);
const fromSlider = (v: number) => LAB_ZOOM[0] * Math.pow(LAB_ZOOM[1] / LAB_ZOOM[0], v / 1000);
let cam: [number, number] = [0, 0], zoom = 0.15, time = 120, held = false;
/** The view presets: the star's (as before), and a body's (the planet lab's, about that body, lit from the star) */
const STAR_VIEWS: [string, string][] = [
  ['whole', 'whole (zoom 0.04)'], ['limb', 'limb (zoom 0.15)'], ['close', 'close (zoom 1)'], ['disc', 'over the disc'], ['corona', 'corona'],
  ['surface', 'surface up close (zoom 8, beyond the game)'], ['edge', 'the limb up close (zoom 6, beyond the game)'],
  ['far', 'far out (zoom 0.008, beyond the game)'], ['system', 'the whole system (every orbit)'],
];
const BODY_VIEWS: [string, string][] = [
  ['whole', 'whole'], ['limb', 'lit limb up close'], ['term', 'limb at the terminator'], ['far', 'widest game zoom (0.04)'],
  ['close', 'limb at zoom 1'], ['surface', 'surface at zoom 2 (closest in game)'], ['surface+', 'surface up close (beyond the game)'],
  ['edge+', 'the limb up close (beyond the game)'], ['tiny', 'far out (zoom 0.004, beyond the game)'], ['system', 'the whole system (every orbit)'],
];
/** Does the focus take the body presets? (a planet or moon, or the brown dwarf) */
const bodyViews = () => !!focused() || system().centralBody.type === 'brown_dwarf';
function fillViews(want?: string): void {
  const sel = $<HTMLSelectElement>('view'), list = bodyViews() ? BODY_VIEWS : STAR_VIEWS;
  const keep = want ?? sel.value;
  sel.replaceChildren(...list.map(([v, label]) => new Option(label, v)));
  sel.value = list.some(([v]) => v === keep) ? keep : bodyViews() ? 'whole' : 'limb';
}
function preset(): void {
  const s = system();
  const cb = s.centralBody, R = cb.detailParams?.radius ?? cb.radius ?? 1000, w = canvas.clientWidth, h = canvas.clientHeight;
  const v = $<HTMLSelectElement>('view').value;
  const f = focused(), dwarf = sceneOf(s).dwarf;
  if (v === 'system') {
    const reach = Math.max(R * 1.6, ...sceneOf(s).placed.map((p) => Math.hypot(p.x, p.y) + p.body.radius * p.body.extent));
    cam = [0, 0]; zoom = Math.min(w, h) / (2 * reach * 1.08);
  } else if (f || dwarf) {
    // (the planet lab's presets, about the body, its light toward the star)
    const b = f?.body ?? dwarf!, BR = b.radius, L = f?.light ?? DWARF_LIGHT, o = f ? [f.x, f.y] : [0, 0];
    const rot = (a: number): [number, number] => [L[0] * Math.cos(a) - L[1] * Math.sin(a), L[0] * Math.sin(a) + L[1] * Math.cos(a)];
    const edge = Math.min(w, h) / (0.32 * BR);
    let c: [number, number] = [0, 0];
    if (v === 'whole') { zoom = Math.min(w, h) / (2 * BR * Math.max(b.extent, 1.15) * 1.1); }
    else if (v === 'limb') { const d = rot(0.35); c = [d[0] * BR, d[1] * BR]; zoom = edge; }
    else if (v === 'term') { const d = rot(Math.PI / 2 + 0.05); c = [d[0] * BR, d[1] * BR]; zoom = edge; }
    else if (v === 'far') { zoom = 0.04; }
    else if (v === 'close') { const d = rot(0.3); c = [d[0] * BR * 1.05, d[1] * BR * 1.05]; zoom = 1; }
    else if (v === 'surface') { c = [L[0] * BR * 0.4, L[1] * BR * 0.4]; zoom = 2; }
    else if (v === 'surface+') { c = [L[0] * BR * 0.4, L[1] * BR * 0.4]; zoom = Math.max(8, 4000 / BR); }
    else if (v === 'edge+') { const d = rot(0.35); c = [d[0] * BR, d[1] * BR]; zoom = Math.max(6, 3000 / BR); }
    else if (v === 'tiny') { zoom = 0.004; }
    cam = [o[0] + c[0], o[1] + c[1]];
  }
  else if (v === 'whole') { cam = [0, 0]; zoom = 0.04; }
  else if (v === 'limb') { zoom = 0.15; cam = [R + (0.1 * w) / zoom, 0]; }
  else if (v === 'close') { zoom = 1; cam = [R * Math.SQRT1_2 - 150, -R * Math.SQRT1_2 + 100]; }
  else if (v === 'disc') { zoom = 0.5; cam = [0.3 * R, 0.1 * R]; }
  else if (v === 'surface') { zoom = 8; cam = [0.4 * R, -0.2 * R]; }
  else if (v === 'edge') { zoom = 6; cam = [R - 40, 0]; }
  else if (v === 'far') { zoom = 0.008; cam = [0, 0]; }
  else { zoom = 0.3; cam = [1.6 * R, 0]; }
  zoom = Math.max(LAB_ZOOM[0], Math.min(LAB_ZOOM[1], zoom));
}
$('system').addEventListener('change', () => { fillBodies(); fillViews(); preset(); });
$('body').addEventListener('change', () => { fillViews(); preset(); });
$('view').addEventListener('change', preset);

// The URL's params (and the URL kept up to date as things change, to share a view)
{
  const params = new URLSearchParams(location.search);
  const pick = (id: string, v: string | null) => {
    if (v === null) return;
    const sel = $<HTMLSelectElement>(id), was = sel.value;
    sel.value = v;
    if (sel.value !== v) sel.value = was;
  };
  let sys = params.get('system'), body = params.get('body');
  if (body?.endsWith('.dwarf')) { sys ??= body.slice(0, -'.dwarf'.length); body = 'star'; }
  if (!sys && body && body !== 'star') sys = shown.find((s) => sceneOf(s).placed.some((p) => p.body.id === body))?.id ?? null;
  pick('system', sys);
  fillBodies();
  pick('body', body);
  fillViews(params.get('view') ?? undefined);
  for (const id of ['look', 'sun', 'sky']) pick(id, params.get(id));
}
/** ?zoom=<z>: start at this zoom instead of the preset's (about the same centre) */
const startZoom = Number(new URLSearchParams(location.search).get('zoom')) || 0;
const SHARED = ['system', 'body', 'view', 'look', 'sun', 'sky'];
function share(): void {
  const q = new URLSearchParams();
  for (const id of SHARED) q.set(id, $<HTMLSelectElement>(id).value);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}
for (const id of SHARED) $(id).addEventListener('change', share);

// The performance graph: a marker for every change, so the step before and after is plain to see
const graph = new PerfGraph($('graph') as HTMLCanvasElement, $('readout'));
const chosen = (id: string) => { const e = $<HTMLSelectElement>(id); return e.selectedOptions[0]?.text ?? e.value; };
for (const [id, what] of [['sun', 'Star'], ['sky', 'Sky'], ['look', 'Planets'], ['system', 'System'], ['body', 'Body'], ['view', 'View'], ['dpr', 'Resolution']]) {
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
/** Zoom about the screen's middle; a marker on the graph when it crosses the game's limits */
function setZoom(z: number): void {
  const was = inGame(zoom);
  zoom = Math.max(LAB_ZOOM[0], Math.min(LAB_ZOOM[1], z));
  if (was !== inGame(zoom)) graph.mark(inGame(zoom) ? `Zoom ${zoom.toFixed(3)}: back in the game's range` : `Zoom ${zoom.toFixed(3)}: beyond the game's range`);
}
canvas.addEventListener('wheel', (e) => { setZoom(zoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15)); e.preventDefault(); }, { passive: false });
{
  // The slider's track: the game's range shaded
  const a = toSlider(GAME_ZOOM[0]) / 10, b = toSlider(GAME_ZOOM[1]) / 10;
  $('zoom').style.background = `linear-gradient(90deg, #151b26 ${a}%, #2c4a6e ${a}%, #2c4a6e ${b}%, #151b26 ${b}%)`;
  $('zoom').addEventListener('input', () => setZoom(fromSlider(Number($<HTMLInputElement>('zoom').value))));
  $('zoom').addEventListener('change', () => graph.mark(`Zoom ${zoom.toFixed(3)}`));
}
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

/**
 * What the planets on screen cost, in ms: as the planet lab measures (a forced sync around draws into the offscreen
 * target, as `measure`), but each layer's uniforms set once and only its draw repeated, summed over the layers:
 * re-sending the prototype's 26 uniforms every repeat made ANGLE's CPU-side validation most of the number, which the
 * game doesn't pay (Pixi sets a mesh's uniforms once a frame)
 */
function measurePlanets(layers: Layer[], w: number, h: number, reps: number): number {
  if (!layers.length) return 0;
  const t = target('measure', w, h);
  outFb = t.fb;
  const px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  let total = 0;
  for (const layer of layers) {
    draw(layer, w, h);
    sync();
    const t0 = performance.now();
    sync();
    const t1 = performance.now();
    for (let k = 0; k < reps; k++) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, layer.instances ?? 1);
    sync();
    total += Math.max(0, (performance.now() - t1) - (t1 - t0)) / reps;
  }
  outFb = null;
  return total;
}

/** Measuring: four times a second, the option shown and (every other time) the current shader, each repeated to about 5 ms */
const MEASURE_EVERY = 250;
const reps: Record<Series, number> = { sun: 4, sunRef: 4, sky: 4, skyRef: 4, planet: 4, planetRef: 4 };
let lastMeasure = 0, tick = 0;
function sample(series: Series, layers: Layer[], w: number, h: number): void {
  const ms = (series === 'planet' || series === 'planetRef' ? measurePlanets : measure)(layers, w, h, reps[series]);
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
  const s = system();
  const cb = s.centralBody as CentralBody;
  const v: View = { w: cw, h: ch, dpr, cam, zoom, t: time };
  const lens = cb.type === 'black_hole' ? cb.radius ?? 0 : 0;
  const sunKind = held ? 'cur' : $<HTMLSelectElement>('sun').value;
  const skyKind = held ? 'cur' : $<HTMLSelectElement>('sky').value;
  const look = $<HTMLSelectElement>('look').value as Variant, lookKind: Variant = held ? 'cur' : look;
  const scene = sceneOf(s), lightAmt = lightAmtOf(cb.type);
  // The planets and moons on screen (the game culls the rest), each lit from the star
  const visible = scene.placed.filter((p) => onScreen(v, p.x, p.y, p.body.radius * p.body.extent, p.body.radius * p.body.extent));
  const planetLayers = (k: Variant) => visible.map((p) => bodyLayer(p.body, k, v, { x: p.x, y: p.y, light: p.light, lightAmt }));
  const planets = planetLayers(lookKind);
  // The brown dwarf is the star there, drawn with the planets' look (its prototype is the planet prototype's)
  const dwarf = scene.dwarf;
  const dwarfLayers = (k: Variant) => (dwarf && onScreen(v, 0, 0, dwarf.radius * dwarf.extent, dwarf.radius * dwarf.extent)
    ? [bodyLayer(dwarf, k, v, { x: 0, y: 0, light: DWARF_LIGHT, lightAmt: 1 })] : []);
  const biome = systemBiome(s);
  const plain = cb.type === 'sun';
  const R = plain ? cb.detailParams?.radius ?? cb.radius ?? 1000 : 0;
  const sky = skyOption(skyKind, biome, v, lens, R);
  // (black holes and the pulsar keep their own shaders in every option)
  const starLayers = (sk: string, pk: Variant): Layer[] => (plain ? sunVariantLayers(s.id, cb, v, sk) : dwarf ? dwarfLayers(pk) : centralLayers(cb, v, false));
  const star = starLayers(sunKind, lookKind);
  // (paused, or the tab hidden: nothing measured, so the GPU idles but for the picture)
  if (!paused && !document.hidden && now - lastMeasure > MEASURE_EVERY) {
    lastMeasure = now;
    if (tick++ % 2 === 0) {
      sample('sun', starLayers($<HTMLSelectElement>('sun').value, look), w, h);
      sample('sky', skyOption($<HTMLSelectElement>('sky').value, biome, v, lens, R), w, h);
      sample('planet', planetLayers(look), w, h);
    } else {
      sample('sunRef', starLayers('cur', 'cur'), w, h);
      sample('skyRef', skyOption('cur', biome, v, lens, R), w, h);
      sample('planetRef', planetLayers('cur'), w, h);
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  sky.forEach((l) => draw(l, w, h));
  star.forEach((l) => draw(l, w, h));
  planets.forEach((l) => draw(l, w, h));
  const f = focused();
  const about = f ? `${f.body.name}: radius ${f.body.radius}, ${f.body.kind}${f.body.rings ? `, rings ${f.body.rings.inner}–${f.body.rings.outer}` : ''}\n${Math.round(Math.hypot(f.x, f.y))} from the star; ${(2 * f.body.radius * zoom).toFixed(0)} px across`
    : `${s.name}: ${cb.type.replace('_', ' ')}, radius ${cb.detailParams?.radius ?? cb.radius}`;
  $('stats').textContent = `${w}×${h}  ${fps.toFixed(0)} fps  zoom ${zoom.toFixed(3)}\n${about}\n${visible.length} of ${scene.placed.length} planets and moons on screen`;
  if (document.activeElement !== $('zoom')) $<HTMLInputElement>('zoom').value = String(toSlider(zoom));
  $('zoomval').innerHTML = inGame(zoom) ? `${zoom.toFixed(3)}` : `<span class="beyond">${zoom.toFixed(3)}: beyond the game's range</span>`;
  graph.draw(held ? 'current (Space held)' : plain ? chosen('sun') : dwarf ? `brown dwarf: ${chosen('look')} (the Planets look)` : `${chosen('sun')} (this body keeps its own shader)`,
    held ? 'current (Space held)' : chosen('sky'), `${held ? 'current (Space held)' : chosen('look')}, ${visible.length} on screen`, paused);
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
  if (startZoom > 0) zoom = Math.max(LAB_ZOOM[0], Math.min(LAB_ZOOM[1], startZoom));
  requestAnimationFrame(frame);
}
