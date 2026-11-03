/**
 * Builds the planet harness's jobs (the game's planets against the prototypes), runs harness.py on them and writes
 * what it measured. Run through run.mjs (it bundles this first):
 *
 *   node scripts/planet-proto/run.mjs <set> <out dir>      sets: verify | stills | edges | bench | gif | panels | cracks | crackbench
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { planetCrackCells, planetNoiseData, PLANET_NOISE_SIZE } from '../../client/src/rendering/planet-proto/planetNoise';
import { moonOffset, planetPosition } from '../../common/src/world/planets';
import { lookFor } from '../../client/src/rendering/planet-proto/planetProto';
import { backdropLayer, bodiesOf, bodyLayer, lightAmtOf, planetPrograms, shaderConsts, sourcesFrom, VARIANT_LABEL, type Body, type Layer, type Placement, type Variant, type View } from './layers';

const root = resolve(process.env.PLANET_PROTO_ROOT ?? '.');
const here = join(root, 'scripts/planet-proto');
const set = process.argv[2] ?? 'verify';
const out = resolve(process.argv[3] ?? join(root, '.planet-proto'));
mkdirSync(out, { recursive: true });

const read = (file: string) => readFileSync(join(root, 'client/src/rendering', file), 'utf8');
const quadText = read('shaderQuad.ts');
const sources = sourcesFrom({ planet: read('planet-proto/planetClassic.ts'), central: read('CentralBodyShaders.ts'), quad: quadText }, shaderConsts(quadText).GLSL_COMMON);
const programs = planetPrograms(sources, true);

const systemsJson = JSON.parse(readFileSync(join(root, 'data/systems.json'), 'utf8'));
const systems: any[] = Array.isArray(systemsJson) ? systemsJson : systemsJson.systems;
type Entry = Body & { system: any };
const ALL: Entry[] = systems.flatMap((s) => bodiesOf(s).map((b) => ({ ...b, system: s })));
const byId = (id: string) => ALL.find((b) => b.id === id)!;
const byIdMaybe = (id: string) => ALL.find((b) => b.id === id);

let t0 = Date.now();
writeFileSync(join(out, 'planetNoise.rgba'), planetNoiseData());
const bakeMs = Date.now() - t0;
const N = PLANET_NOISE_SIZE;
writeFileSync(join(out, 'planetCrack.rgba'), planetCrackCells());
const textures = { planetNoise: { w: N, h: N, d: N, file: join(out, 'planetNoise.rgba') }, planetCrack: { w: 160, h: 40, d: 40, nearest: true, file: join(out, 'planetCrack.rgba') } };

interface Job { id: string; w: number; h: number; layers: Layer[]; out?: string; bench?: boolean; reps?: number }
const jobs: Job[] = [];
const composites: any[] = [];
const gifs: any[] = [];
const job = (id: string, v: View, layers: Layer[], opts: Partial<Job> = {}) => jobs.push({ id, w: Math.round(v.w * v.dpr), h: Math.round(v.h * v.dpr), layers, ...opts });

/** The star off to the upper left (a unit vector toward it), the same for every still */
const LIGHT: [number, number] = [-0.94, -0.34];
const place = (b: Entry, light: [number, number] = LIGHT): Placement => ({ x: 0, y: 0, light, lightAmt: lightAmtOf(b.system.centralBody?.type) });
const scene = (b: Entry, variant: Variant, v: View): Layer[] => [backdropLayer(v), bodyLayer(b, variant, v, place(b))];

/**
 * A time when a gas giant's great storm faces the star (so the stills show it): its longitude drifts with its band's
 * jet while the planet spins (the shader's jetAt, mirrored). Other bodies: 300 s.
 */
function showTime(b: Entry, after = 200): number {
  if (b.kind !== 'gas') return 300;
  const look = lookFor(b, b.seed);
  const [F, , speed] = look.bands, [lon0, lat] = look.storm;
  const seedX = b.seed % 97;
  const jet = (Math.sin(lat * F + seedX) * 0.7 + Math.sin(lat * F * 2.3 + 1.3) * 0.3) * (1 - 0.4 * Math.abs(lat));
  const rate = jet * speed - look.spin;            // d(storm's screen longitude)/dt, radians a second
  const target = -0.55;                             // left of centre, toward the star
  let best = Infinity;
  for (let k = -60; k <= 60; k++) {
    const t = (target - lon0 + 2 * Math.PI * k) / rate;
    if (t > after && t < best) best = t;
  }
  return Number.isFinite(best) ? best : 300;
}

/** The views: the whole body; its lit limb and its limb at the terminator up close; a game-zoom view */
function views(b: Entry, t = showTime(b)) {
  const R = b.radius, ext = b.extent;
  const rot = (a: number): [number, number] => [LIGHT[0] * Math.cos(a) - LIGHT[1] * Math.sin(a), LIGHT[0] * Math.sin(a) + LIGHT[1] * Math.cos(a)];
  const lit = rot(0.35), term = rot(Math.PI / 2 + 0.05);
  const ez = 600 / (0.32 * R);
  return {
    whole: { w: 640, h: 640, dpr: 1, cam: [0, 0], zoom: 640 / (2 * R * Math.max(ext, 1.15) * 1.04), t } as View,
    limb: { w: 640, h: 640, dpr: 1, cam: [lit[0] * R, lit[1] * R], zoom: ez, t } as View,
    term: { w: 640, h: 640, dpr: 1, cam: [term[0] * R, term[1] * R], zoom: ez, t } as View,
  };
}

/** One body of every kind, and the brown dwarf (sheets show these; the bench times them all) */
const SHOWN = ['jovan', 'cinderjack', 'boreas_major', 'opaline', 'ember_giant', 'ashfall.dwarf', 'vesta', 'umbra', 'ares', 'kiln', 'nereid', 'thule', 'prism', 'kindle', 'pyre', 'terra_nova', 'halcyon', 'verdance', 'jovan.moon0', 'jovan.moon1'];
const KINDS: Record<string, string[]> = {
  gas: ['jovan', 'cinderjack', 'boreas_major', 'opaline', 'ember_giant'],
  dwarf: ['ashfall.dwarf'],
  rocky: ['vesta', 'umbra', 'greyback'],
  desert: ['ares', 'kiln'],
  ice: ['nereid', 'thule', 'prism', 'glacia'],
  lava: ['kindle', 'pyre', 'ashfall'],
  ocean: ['terra_nova', 'halcyon', 'pelagia'],
  toxic: ['verdance'],
  moons: ['jovan.moon0', 'jovan.moon1', 'terra_nova.moon0'],
};

if (set === 'verify') {
  for (const id of SHOWN) {
    const b = byId(id);
    const vs = views(b);
    const cells = [];
    for (const variant of ['cur', 'proto'] as Variant[]) for (const vn of ['whole', 'limb'] as const) {
      const file = `verify/${id}.${vn}.${variant}.png`;
      job(`${id}.${vn}.${variant}`, vs[vn], scene(b, variant, vs[vn]), { out: file });
      cells.push({ file, label: `${VARIANT_LABEL[variant]} ${vn}` });
    }
    composites.push({ out: `verify-${id}.png`, cols: 4, cells, scale: 0.6, title: `${b.name} (${b.kind})` });
  }
}

if (set === 'stills' || set === 'edges') {
  for (const [kind, ids] of Object.entries(KINDS)) {
    const cells: any[] = [];
    for (const id of ids) {
      const b = byId(id);
      const vs = views(b);
      const cols = set === 'stills' ? (['whole', 'limb', 'term'] as const) : (['limb', 'term'] as const);
      for (const vn of cols) for (const variant of ['cur', 'proto'] as Variant[]) {
        const file = `stills/${id}.${vn}.${variant}.png`;
        job(`${id}.${vn}.${variant}`, vs[vn], scene(b, variant, vs[vn]), { out: file });
        cells.push({ file, label: `${b.name}: ${VARIANT_LABEL[variant]}, ${vn === 'whole' ? 'whole' : vn === 'limb' ? 'lit limb' : 'terminator limb'}` });
      }
    }
    composites.push({ out: `planet-sheet-${kind}.png`, cols: 6, cells, scale: 0.6, title: `${kind}: current, then prototype (whole, lit limb up close, limb at the terminator up close)` });
  }
}

/** The game's views a body is timed in (1080p, or 4K): the widest zoom, whole at a middling zoom, its lit limb at
 * zoom 1, and nothing but surface at the closest zoom */
function benchViews(b: Entry, dpr: number): Record<string, View> {
  const R = b.radius, t = showTime(b);
  const lit: [number, number] = [LIGHT[0] * 0.8, LIGHT[1] * 0.8];
  return {
    far: { w: 1920, h: 1080, dpr, cam: [0, 0], zoom: 0.04, t },
    mid: { w: 1920, h: 1080, dpr, cam: [0, 0], zoom: Math.min(2, 900 / (2 * R * b.extent)), t },
    limb: { w: 1920, h: 1080, dpr, cam: [lit[0] * R * 1.1, lit[1] * R * 1.1], zoom: 1, t },
    surface: { w: 1920, h: 1080, dpr, cam: [lit[0] * R * 0.5, lit[1] * R * 0.5], zoom: 2, t },
  };
}

if (set === 'bench') {
  for (const dpr of [1, 2]) for (const b of ALL) {
    // (4K only for one of each kind)
    if (dpr === 2 && !SHOWN.includes(b.id)) continue;
    for (const [vn, v] of Object.entries(benchViews(b, dpr))) for (const variant of ['cur', 'proto', 'proto.lite'] as Variant[]) {
      job(`${b.id}|${vn}${dpr === 2 ? ' 4K' : ''}|${variant}`, v, scene(b, variant, v), { bench: true, reps: 10 });
    }
  }
}

/**
 * Cracks up close (ice lineae, lava rivers, desert canyons): standard (Medium) against fine (High), at the game's
 * zooms 1 and 2 and past them (6), on the lit face; `crackbench` times the three tiers there at 1080p.
 */
const CRACKED = ['nereid', 'thule', 'prism', 'glacia', 'kindle', 'pyre', 'ashfall', 'ares'];
function crackView(b: Entry, zoom: number, w = 640, h = 640): View {
  return { w, h, dpr: 1, cam: [LIGHT[0] * b.radius * 0.45, LIGHT[1] * b.radius * 0.45], zoom, t: 300 };
}
if (set === 'cracks') {
  for (const id of CRACKED) {
    const b = byId(id);
    const cells: any[] = [];
    for (const zoom of [0.25, 1, 2, 6]) for (const variant of ['proto', 'proto.fine'] as Variant[]) {
      const v = crackView(b, zoom), file = `cracks/${id}.z${zoom}.${variant}.png`;
      job(`${id}.z${zoom}.${variant}`, v, scene(b, variant, v), { out: file });
      cells.push({ file, label: `${b.name}: ${VARIANT_LABEL[variant]}, zoom ${zoom}` });
    }
    composites.push({ out: `cracks-${id}.png`, cols: 2, cells, scale: 0.75, title: `${b.name} (${b.kind}): standard (Medium) left, fine (High) right` });
  }
}
if (set === 'crackbench') {
  for (const id of CRACKED) {
    const b = byId(id);
    for (const zoom of [0.3, 1, 2]) for (const variant of ['proto.lite', 'proto', 'proto.fine'] as Variant[]) {
      const v = crackView(b, zoom, 1920, 1080);
      job(`${id}|z${zoom}|${variant}`, v, scene(b, variant, v), { bench: true, reps: 10 });
    }
  }
}

/**
 * Edges up close (`edgecrops`): the lit limb and the limb at the terminator, at the sign-in screen's size (a radius of
 * 740 px) and the game's zooms 0.04, 0.3, 1 and 2, on the High level. Bodies: EDGE_IDS, or EDGE_IDS=a,b in the env.
 */
const EDGE_IDS = (process.env.EDGE_IDS ?? 'terra_nova.moon0,vesta,greyback,jovan').split(',');
if (set === 'edgecrops') {
  for (const id of EDGE_IDS) {
    const b = byId(id);
    const rot = (a: number): [number, number] => [LIGHT[0] * Math.cos(a) - LIGHT[1] * Math.sin(a), LIGHT[0] * Math.sin(a) + LIGHT[1] * Math.cos(a)];
    const cells: any[] = [];
    for (const [zn, zoom] of [['login', 740 / b.radius], ['z0.04', 0.04], ['z0.3', 0.3], ['z1', 1], ['z2', 2]] as [string, number][]) {
      for (const [ln, dir] of [['lit', rot(0.35)], ['term', rot(Math.PI / 2 + 0.05)]] as [string, [number, number]][]) {
        const far = zoom * b.radius < 160;
        const v: View = { w: 320, h: 320, dpr: 1, cam: far ? [0, 0] : [dir[0] * b.radius, dir[1] * b.radius], zoom, t: showTime(b) };
        const file = `edgecrops/${id}.${zn}.${ln}.png`;
        job(`${id}.${zn}.${ln}`, v, scene(b, 'proto.fine', v), { out: file });
        cells.push({ file, label: `${zn} ${ln}` });
      }
    }
    composites.push({ out: `edgecrops-${id}.png`, cols: 2, cells, scale: 1, title: b.name });
  }
}

/** Animations: current beside the prototype, game time sped up */
if (set === 'gif') {
  const clips: [string, string, number][] = [['jovan', 'whole', 6], ['jovan', 'storm', 3], ['opaline', 'storm', 3], ['terra_nova', 'whole', 8], ['ashfall.dwarf', 'whole', 6], ['kindle', 'limb', 3]];
  for (const [id, vn, step] of clips) {
    const b = byId(id), t0 = showTime(b) - 30 * step / 2;
    const frames: string[] = [];
    for (let f = 0; f < 30; f++) {
      const t = t0 + f * step;
      let v: View;
      if (vn === 'storm') {
        const look = lookFor(b, b.seed);
        v = { w: 480, h: 480, dpr: 1, cam: [Math.sin(-0.55) * Math.cos(look.storm[1]) * b.radius, -Math.sin(look.storm[1]) * b.radius * -1], zoom: 480 / (0.9 * b.radius), t };
      } else {
        const vs = views(b, t);
        v = { ...(vn === 'whole' ? vs.whole : vs.limb), w: 480, h: 480 };
        v.zoom *= 480 / 640;
      }
      const cells = (['cur', 'proto'] as Variant[]).map((variant) => {
        const file = `gif/${id}.${vn}.${variant}.${f}.png`;
        job(`${id}.${vn}.${variant}.${f}`, v, scene(b, variant, v), { out: file });
        return { file, label: VARIANT_LABEL[variant] };
      });
      const frame = `gif/${id}.${vn}.frame${f}.png`;
      composites.push({ out: frame, cols: 2, cells });
      frames.push(frame);
    }
    gifs.push({ out: `planet-anim-${id.replace('.', '-')}-${vn}.gif`, frames, ms: 90 });
  }
}

/**
 * Clean before/after panels (docs/panels): nothing overlaid, identical framing. A topic: [name, body ids, view];
 * several bodies are tiled into one picture.
 */
const PANELS: [string, string[], 'whole' | 'limb' | 'term'][] = [
  ['planets-gas-giant-edge', ['jovan'], 'limb'],
  ['planets-gas-giant-terminator', ['jovan'], 'term'],
  ['planets-gas-giants', ['jovan', 'cinderjack', 'boreas_major', 'opaline', 'ember_giant', 'ashfall.dwarf'], 'whole'],
  ['planets-solid-worlds', ['vesta', 'ares', 'nereid', 'kindle', 'terra_nova', 'verdance'], 'whole'],
  ['planets-atmosphere-edge', ['terra_nova', 'verdance', 'nereid'], 'limb'],
  ['planets-rings', ['nereid', 'prism'], 'whole'],
];
if (set === 'panels') {
  for (const [topic, ids, vn] of PANELS) {
    for (const variant of ['cur', 'proto'] as Variant[]) {
      const cells = ids.map((id) => {
        const b = byId(id), v = views(b)[vn];
        const file = `panels/${topic}.${variant}.${id}.png`;
        job(`${topic}.${variant}.${id}`, v, scene(b, variant, v), { out: file });
        return { file };
      });
      composites.push({ out: `panels/${topic}-${variant === 'cur' ? 'before' : 'after'}.png`, cols: ids.length > 3 ? 3 : ids.length, cells });
    }
  }
}

/**
 * A water world's panels (docs/panels), straight into the panels folder (OUT is the date's category folder):
 *   WATER_ID=pelagia WATER_SYSTEM=borealis node scripts/planet-proto/run.mjs water <out dir>
 * Before: the system without the world (and the world with an ordinary ocean's look: its `sea` field dropped); after:
 * as the data has it. Nothing is drawn on the pictures but the bodies and a plain disc for the star. High level.
 */
if (set === 'water') {
  const id = process.env.WATER_ID ?? 'pelagia', sysId = process.env.WATER_SYSTEM ?? 'borealis', topic = process.env.WATER_TOPIC ?? 'water-world';
  const sys = systems.find((s) => s.id === sysId);
  const frag = `void main() { vec2 p = (vUV - 0.5) * 2.0; float r = length(p); float core = smoothstep(0.42, 0.4, r); float glow = exp(-max(r - 0.4, 0.0) * 7.0) * 0.55 * smoothstep(1.0, 0.8, r); vec3 c = mix(vec3(0.62, 0.82, 1.0), vec3(0.95, 0.98, 1.0), smoothstep(0.4, 0.0, r)); float a = core + glow * (1.0 - core); fragColor = vec4(c * a, a); }`;
  programs['star'] = { vert: programs['backdrop'].vert, frag: `#version 330 core
precision highp float;
in vec2 vUV;
out vec4 fragColor;
${frag}` };
  const bodiesFor = (withIt: boolean): { b: Body; at: Placement }[] => {
    const list: { b: Body; at: Placement }[] = [];
    for (const p of sys.planets) {
      if (!withIt && p.id === id) continue;
      const pos = planetPosition(p, 0), d = Math.hypot(pos.x, pos.y);
      const light: [number, number] = [-pos.x / d, -pos.y / d];
      list.push({ b: byId(p.id), at: { x: pos.x, y: pos.y, light, lightAmt: 1 } });
      (p.moons ?? []).forEach((m: any, i: number) => {
        const o = moonOffset(p, i, 0);
        list.push({ b: byId(`${p.id}.moon${i}`), at: { x: pos.x + o.x, y: pos.y + o.y, light, lightAmt: 1 } });
      });
    }
    return list;
  };
  // (the whole system: the star at the middle, the planets where the data puts them at tick 0)
  const SPAN = 125000, SIZE = 1500;
  const sysView: View = { w: SIZE, h: SIZE, dpr: 1, cam: [0, 0], zoom: SIZE / SPAN, t: 300 };
  const R = sys.centralBody.radius * 2.4;
  const starQuad = [-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, 1, -1, 1, 1].map((v, i) => (i % 4 < 2 ? v * (R * sysView.zoom) / (SIZE / 2) : v));
  for (const [name, withIt] of [['before', false], ['after', true]] as [string, boolean][]) {
    if (withIt && !byIdMaybe(id)) continue;
    const layers: Layer[] = [backdropLayer(sysView), { name: 'star', program: 'star', blend: 'normal', verts: starQuad, uniforms: {} }];
    for (const { b, at } of bodiesFor(withIt)) layers.push(bodyLayer(b, 'proto.fine', sysView, at));
    job(`${topic}-system.${name}`, sysView, layers, { out: `${topic}-system-${name}.png` });
  }
  if (byIdMaybe(id)) composites.push({ out: `${topic}-system.png`, cols: 2, cells: [{ file: `${topic}-system-before.png` }, { file: `${topic}-system-after.png` }] });
  // (the world itself: whole, and its lit limb up close; before with an ordinary ocean's look)
  const w = byIdMaybe(id);
  if (w) {
    // its neighbourhood: the planet and its moon as the game's far zoom shows them (before: the empty orbit)
    const wp = sys.planets.find((p: any) => p.id === id), wpos = planetPosition(wp, 0);
    const near: View = { w: 1000, h: 1000, dpr: 1, cam: [wpos.x, wpos.y], zoom: 1000 / 16000, t: 300 };
    for (const [name, withIt] of [['before', false], ['after', true]] as [string, boolean][]) {
      const layers: Layer[] = [backdropLayer(near)];
      for (const { b, at } of bodiesFor(withIt)) layers.push(bodyLayer(b, 'proto.fine', near, at));
      job(`${topic}-near.${name}`, near, layers, { out: `${topic}-near-${name}.png` });
    }
    composites.push({ out: `${topic}-near.png`, cols: 2, cells: [{ file: `${topic}-near-before.png` }, { file: `${topic}-near-after.png` }] });
    const plain: Entry = { ...w, look: Object.fromEntries(Object.entries(w.look ?? {}).filter(([k]) => k !== 'sea')) as any };
    for (const [vn, v] of Object.entries(views(w, 300))) {
      if (vn === 'term') continue;
      for (const [name, b] of [['before', plain], ['after', w]] as [string, Entry][]) {
        job(`${topic}-${vn}.${name}`, v, scene(b, 'proto.fine', v), { out: `${topic}-${vn === 'whole' ? '' : vn + '-'}${name}.png`.replace('--', '-') });
      }
      composites.push({ out: `${topic}${vn === 'whole' ? '' : '-' + vn}.png`, cols: 2, cells: [{ file: `${topic}-${vn === 'whole' ? '' : vn + '-'}before.png` }, { file: `${topic}-${vn === 'whole' ? '' : vn + '-'}after.png` }] });
    }
  }
}

const harness = spawnSync('python', [join(here, 'harness.py'), writeScenes(), out], { encoding: 'utf8', maxBuffer: 1 << 26 });
if (harness.status !== 0) {
  process.stderr.write(harness.stderr);
  process.exit(1);
}
const lines = harness.stdout.trim().split('\n').map((l: string) => JSON.parse(l));
writeFileSync(join(out, `${set}.json`), JSON.stringify({ bakeMs, lines }, null, 1));
for (const l of lines) if (l.info || l.composite || l.gif || l.done) console.log(JSON.stringify(l));
console.log(`noise bake ${bakeMs} ms; ${jobs.length} jobs`);

function writeScenes(): string {
  const file = join(out, `scenes.${set}.json`);
  writeFileSync(file, JSON.stringify({ programs, textures, jobs, composites, gifs }));
  return file;
}
