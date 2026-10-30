/**
 * Planet prototype lab (planetlab.html, dev server only): the game's planets, moons and the brown dwarf against the
 * prototypes (src/rendering/planet-proto), live, with a graph of what each costs (perf.ts; measured as `measure`
 * says). It draws the same layers as the native harness (scripts/planet-proto/layers.ts) with a small WebGL2 runner,
 * as the sun lab does. Docs: docs/rendering/planet-prototypes.md.
 *
 * URL params: ?body=<id>&view=<preset>&look=proto|proto.lite (e.g. planetlab.html?body=jovan&view=limb).
 */

import planetText from '../src/rendering/PlanetRenderer.ts?raw';
import centralText from '../src/rendering/CentralBodyShaders.ts?raw';
import quadText from '../src/rendering/shaderQuad.ts?raw';
import { GLSL_COMMON } from '../src/rendering/shaderQuad';
import { planetNoiseData, PLANET_NOISE_SIZE } from '../src/rendering/planet-proto/planetNoise';
import systemsJson from '../../data/systems.json';
import { PerfGraph } from './perf';
import { backdropLayer, bodiesOf, bodyLayer, lightAmtOf, planetPrograms, sourcesFrom, type Body, type Layer, type Placement, type Variant, type View } from '../../scripts/planet-proto/layers';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true })!;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const systems: any[] = (systemsJson as any).systems ?? systemsJson;
type Entry = Body & { system: any };
const ALL: Entry[] = systems.flatMap((s) => bodiesOf(s).map((b) => ({ ...b, system: s })));
{
  const sel = $<HTMLSelectElement>('body');
  for (const s of systems) {
    const bodies = ALL.filter((b) => b.system === s);
    if (!bodies.length) continue;
    const g = document.createElement('optgroup');
    g.label = `${s.name} (${s.centralBody?.type ?? 'none'})`;
    for (const b of bodies) g.append(new Option(`${b.name}: ${b.dwarf ? 'brown dwarf' : b.id.includes('.moon') ? `moon (${b.kind})` : b.kind}${b.rings ? ', rings' : ''}`, b.id));
    sel.append(g);
  }
}

const sources = sourcesFrom({ planet: planetText, central: centralText, quad: quadText }, GLSL_COMMON);
const programSources = planetPrograms(sources, false);

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
  if (!p) programs.set(name, p = compile(programSources[name].vert, programSources[name].frag));
  return p;
};
const ulocs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
function uloc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
  let m = ulocs.get(p);
  if (!m) ulocs.set(p, m = new Map());
  if (!m.has(name)) m.set(name, gl.getUniformLocation(p, name));
  return m.get(name)!;
}

/** The noise volume: repeat, trilinear with mipmaps (as the game would upload it) */
const noise = (() => {
  const t = gl.createTexture()!, N = PLANET_NOISE_SIZE;
  gl.bindTexture(gl.TEXTURE_3D, t);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, planetNoiseData());
  gl.generateMipmap(gl.TEXTURE_3D);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
  return t;
})();

let outFb: WebGLFramebuffer | null = null;
const vbo = gl.createBuffer()!;
const vao = gl.createVertexArray()!;
const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function draw(layer: Layer, w: number, h: number): void {
  const p = program(layer.program);
  gl.useProgram(p);
  if (layer.blend === 'none') gl.disable(gl.BLEND);
  else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, layer.blend === 'add' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, outFb);
  gl.viewport(0, 0, w, h);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(layer.verts), gl.STREAM_DRAW);
  for (const [name, offset] of [['aPosition', 0], ['aUV', 8]] as const) {
    const loc = gl.getAttribLocation(p, name);
    if (loc < 0) continue;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 16, offset);
  }
  for (const m of ['uProjectionMatrix', 'uWorldTransformMatrix', 'uTransformMatrix']) {
    const loc = uloc(p, m);
    if (loc) gl.uniformMatrix3fv(loc, false, IDENTITY);
  }
  for (const [name, v] of Object.entries(layer.uniforms)) {
    const loc = uloc(p, name);
    if (!loc) continue;
    if (typeof v === 'number') gl.uniform1f(loc, v);
    else if (v.length === 2) gl.uniform2fv(loc, v);
    else gl.uniform3fv(loc, v);
  }
  if (layer.textures?.uNoise) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, noise);
    gl.uniform1i(uloc(p, 'uNoise'), 0);
  }
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// The camera: a view preset, then panned and zoomed by hand, far past the game's flight zoom both ways
const LAB_ZOOM = [0.002, 40] as const;
const GAME_ZOOM = [0.04, 2] as const;
const inGame = (z: number) => z >= GAME_ZOOM[0] * 0.999 && z <= GAME_ZOOM[1] * 1.001;
const toSlider = (z: number) => Math.round((Math.log(z / LAB_ZOOM[0]) / Math.log(LAB_ZOOM[1] / LAB_ZOOM[0])) * 1000);
const fromSlider = (v: number) => LAB_ZOOM[0] * Math.pow(LAB_ZOOM[1] / LAB_ZOOM[0], v / 1000);
let cam: [number, number] = [0, 0], zoom = 0.1, time = 300, held = false;
const body = () => ALL.find((b) => b.id === $<HTMLSelectElement>('body').value)!;
const lightDir = (): [number, number] => {
  const a = (Number($<HTMLInputElement>('light').value) * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a)];
};
function preset(): void {
  const b = body(), R = b.radius, w = canvas.clientWidth, h = canvas.clientHeight;
  const L = lightDir();
  const rot = (a: number): [number, number] => [L[0] * Math.cos(a) - L[1] * Math.sin(a), L[0] * Math.sin(a) + L[1] * Math.cos(a)];
  const v = $<HTMLSelectElement>('view').value;
  const edge = Math.min(w, h) / (0.32 * R);
  if (v === 'whole') { cam = [0, 0]; zoom = Math.min(w, h) / (2 * R * Math.max(b.extent, 1.15) * 1.1); }
  else if (v === 'limb') { const d = rot(0.35); cam = [d[0] * R, d[1] * R]; zoom = edge; }
  else if (v === 'term') { const d = rot(Math.PI / 2 + 0.05); cam = [d[0] * R, d[1] * R]; zoom = edge; }
  else if (v === 'far') { cam = [0, 0]; zoom = 0.04; }
  else if (v === 'close') { const d = rot(0.3); cam = [d[0] * R * 1.05, d[1] * R * 1.05]; zoom = 1; }
  else if (v === 'surface') { cam = [L[0] * R * 0.4, L[1] * R * 0.4]; zoom = 2; }
  else if (v === 'surface+') { cam = [L[0] * R * 0.4, L[1] * R * 0.4]; zoom = Math.max(8, 4000 / R); }
  else if (v === 'edge+') { const d = rot(0.35); cam = [d[0] * R, d[1] * R]; zoom = Math.max(6, 3000 / R); }
  else if (v === 'tiny') { cam = [0, 0]; zoom = 0.004; }
  zoom = Math.max(LAB_ZOOM[0], Math.min(LAB_ZOOM[1], zoom));
}
const params = new URLSearchParams(location.search);
if (params.get('body') && ALL.some((b) => b.id === params.get('body'))) $<HTMLSelectElement>('body').value = params.get('body')!;
if (params.get('view')) $<HTMLSelectElement>('view').value = params.get('view')!;
if (params.get('look')) $<HTMLSelectElement>('look').value = params.get('look')!;
for (const id of ['body', 'view', 'light']) $(id).addEventListener('change', preset);

const graph = new PerfGraph($('graph') as HTMLCanvasElement, $('readout'));
const chosen = (id: string) => { const e = $<HTMLSelectElement>(id); return e.selectedOptions[0]?.text ?? e.value; };
for (const [id, what] of [['look', 'Look'], ['body', 'Body'], ['view', 'View'], ['dpr', 'Resolution']]) $(id).addEventListener('change', () => graph.mark(`${what}: ${chosen(id)}`));
$('light').addEventListener('change', () => graph.mark(`Sun at ${$<HTMLInputElement>('light').value}°`));
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
function setZoom(z: number): void {
  const was = inGame(zoom);
  zoom = Math.max(LAB_ZOOM[0], Math.min(LAB_ZOOM[1], z));
  if (was !== inGame(zoom)) graph.mark(inGame(zoom) ? `Zoom ${zoom.toFixed(3)}: back in the game's range` : `Zoom ${zoom.toFixed(3)}: beyond the game's range`);
}
canvas.addEventListener('wheel', (e) => { setZoom(zoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15)); e.preventDefault(); }, { passive: false });
{
  const a = toSlider(GAME_ZOOM[0]) / 10, b = toSlider(GAME_ZOOM[1]) / 10;
  $('zoom').style.background = `linear-gradient(90deg, #151b26 ${a}%, #2c4a6e ${a}%, #2c4a6e ${b}%, #151b26 ${b}%)`;
  $('zoom').addEventListener('input', () => setZoom(fromSlider(Number($<HTMLInputElement>('zoom').value))));
  $('zoom').addEventListener('change', () => graph.mark(`Zoom ${zoom.toFixed(3)}`));
}
addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  if (!held) graph.mark('Space: current shader');
  held = true;
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { held = false; graph.mark('Space released'); } });

/** The measuring target */
let mt: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;
function measureTarget(w: number, h: number) {
  if (mt && mt.w === w && mt.h === h) return mt;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return (mt = { fb, tex, w, h });
}

/**
 * What a layer costs, in ms: as the sun lab measures (a forced sync by reading a pixel, the sync's own cost taken
 * off, the layer drawn `reps` times offscreen at the canvas's size between), except that its uniforms are set once and
 * only the draw is repeated: re-sending the prototype's 26 uniforms every repeat made ANGLE's CPU-side validation the
 * biggest part of the number (about 0.1 ms a draw), which the game doesn't pay (Pixi sets a mesh's uniforms once a frame).
 */
function measure(layer: Layer, w: number, h: number, reps: number): number {
  const t = measureTarget(w, h);
  outFb = t.fb;
  const px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  // (set up once, as the game does a mesh a frame, then the same draw again: the GPU's cost, not the uniforms' upload)
  draw(layer, w, h);
  sync();
  const t0 = performance.now();
  sync();
  const t1 = performance.now();
  for (let k = 0; k < reps; k++) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  sync();
  const t2 = performance.now();
  outFb = null;
  return Math.max(0, (t2 - t1) - (t1 - t0)) / reps;
}
const reps = { planet: 4, planetRef: 4 };
let lastMeasure = 0, tick = 0;

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
  const b = body();
  const v: View = { w: cw, h: ch, dpr, cam, zoom, t: time };
  const at: Placement = { x: 0, y: 0, light: lightDir(), lightAmt: lightAmtOf(b.system.centralBody?.type) };
  const look = $<HTMLSelectElement>('look').value as Variant;
  const shown = bodyLayer(b, held ? 'cur' : look, v, at);
  if (!paused && !document.hidden && now - lastMeasure > 250) {
    lastMeasure = now;
    const series = tick++ % 2 === 0 ? 'planet' : 'planetRef';
    const layer = series === 'planet' ? bodyLayer(b, look, v, at) : bodyLayer(b, 'cur', v, at);
    const ms = measure(layer, w, h, reps[series]);
    reps[series] = Math.max(1, Math.min(40, Math.round(5 / Math.max(ms, 0.02))));
    graph.add(series, ms);
  }
  outFb = null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  draw(backdropLayer(v), w, h);
  draw(shown, w, h);
  $('stats').textContent = `${w}×${h}  ${fps.toFixed(0)} fps  zoom ${zoom.toFixed(3)}\n${b.name}: radius ${b.radius}, ${b.kind}${b.rings ? `, rings ${b.rings.inner}–${b.rings.outer}` : ''}\non screen ${(2 * b.radius * zoom).toFixed(0)} px across`;
  if (document.activeElement !== $('zoom')) $<HTMLInputElement>('zoom').value = String(toSlider(zoom));
  $('zoomval').innerHTML = inGame(zoom) ? `${zoom.toFixed(3)}` : `<span class="beyond">${zoom.toFixed(3)}: beyond the game's range</span>`;
  graph.draw(held ? 'current (Space held)' : chosen('look'), paused);
  requestAnimationFrame(frame);
}
preset();
requestAnimationFrame(frame);
