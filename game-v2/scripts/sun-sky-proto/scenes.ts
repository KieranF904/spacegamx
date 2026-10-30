/**
 * Builds the harness's jobs (the game's sun and sky against the prototypes, for every star and some skies), runs
 * harness.py on them and writes what it measured. Run through run.mjs (it bundles this first):
 *
 *   node scripts/sun-sky-proto/run.mjs <set> <out dir>      sets: verify | bench | stills | gif
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { bakeSimplex, noise3Data, NOISE3_SIZE, sunNoiseData, SUN_NOISE_SIZE } from '../../client/src/rendering/proto/protoNoise';
import { EXACT_SIZE, EXACT_UNITS } from '../../client/src/rendering/proto/sunProto';
import { skyNoiseTexture } from '../../client/src/rendering/sky/noiseTexture';
import { GLSL_COMMON } from '../../client/src/rendering/shaderQuad';
import { centralLayers, currentSunLayers, sourcesFrom, sunPrograms, sunVariantLayers, type CentralBody, type Layer, type View } from './layers';
import { currentSkyLayers, skyOption, skyPrograms, spriteSkyLayers, systemBiome, SKY_LABEL, SKY_OPTIONS } from './skyLayers';

const root = resolve(process.env.SUN_SKY_ROOT ?? '.');
const here = join(root, 'scripts/sun-sky-proto');
const set = process.argv[2] ?? 'verify';
const out = resolve(process.argv[3] ?? join(root, '.sun-sky-proto'));
mkdirSync(out, { recursive: true });

const read = (file: string) => readFileSync(join(root, 'client/src/rendering', file), 'utf8');
const sources = sourcesFrom({ sun: read('SunRenderer.ts'), glow: read('GlowRenderer.ts'), rays: read('CoronaRaysRenderer.ts'), central: read('CentralBodyShaders.ts'), quad: read('shaderQuad.ts') }, GLSL_COMMON);

const systemsJson = JSON.parse(readFileSync(join(root, 'data/systems.json'), 'utf8'));
const systems: any[] = Array.isArray(systemsJson) ? systemsJson : systemsJson.systems;
const sysOf = (id: string) => systems.find((s) => s.id === id)!;
const PLAIN = systems.filter((s) => s.centralBody?.type === 'sun').map((s) => s.id as string);
const SPECIAL = systems.filter((s) => ['black_hole', 'pulsar', 'brown_dwarf'].includes(s.centralBody?.type)).map((s) => s.id as string);

// Textures
writeFileSync(join(out, 'sunNoise.rgba'), sunNoiseData());
const skySrc = skyNoiseTexture().source as unknown as { resource: Uint8Array; width: number };
writeFileSync(join(out, 'skyNoise.rgba'), skySrc.resource);
writeFileSync(join(out, 'simplex.f32'), bakeSimplex(EXACT_SIZE, EXACT_UNITS));
writeFileSync(join(out, 'noise3.rgba'), noise3Data());
const textures = {
  noise3: { w: NOISE3_SIZE, h: NOISE3_SIZE, d: NOISE3_SIZE, file: join(out, 'noise3.rgba') },
  simplex: { w: EXACT_SIZE, h: EXACT_SIZE, file: join(out, 'simplex.f32'), float: true, mip: false, repeat: false },
  sunNoise: { w: SUN_NOISE_SIZE, h: SUN_NOISE_SIZE, file: join(out, 'sunNoise.rgba'), mip: true, repeat: true },
  skyNoise: { w: skySrc.width, h: skySrc.width, file: join(out, 'skyNoise.rgba'), mip: true, repeat: true },
};

interface Job { id: string; w: number; h: number; layers: Layer[]; out?: string; bench?: boolean; stats?: boolean; reps?: number }
const jobs: Job[] = [];
const composites: any[] = [];
const gifs: any[] = [];
const job = (id: string, v: View, layers: Layer[], opts: Partial<Job> = {}) => jobs.push({ id, w: Math.round(v.w * v.dpr), h: Math.round(v.h * v.dpr), layers, ...opts });

const radiusOf = (cb: CentralBody) => cb.detailParams?.radius ?? cb.radius ?? 1000;
/**
 * A sun variant: a look, then optionally `@scale` to draw it into a render target that size and stretch it (`exact@0.5`).
 * Looks: cur (the game's), port (A), exact (A-exact), photo and lite (B, round 1), plasma and plasma.lite (round 2).
 */
type SunVariant = string;
const SUN_VARIANTS: SunVariant[] = ['cur', 'port', 'photo', 'lite'];
/** Round 2: the faithful options (the current look, cheaper), then the alternatives (new looks) */
const FAITHFUL: SunVariant[] = ['port', 'exact', 'cur@0.5', 'exact@0.5', 'exact@0.33'];
const ALTERNATIVE: SunVariant[] = ['plasma', 'plasma.lite', 'plasma@0.5'];
/** Round 3: the revised plasma, and the multicolour examples */
/** Round 4: the plasma with its limb by viewing angle and its edge into the atmosphere (round 3's half-res plasma for reference) */
const ROUND4: SunVariant[] = ['cur', 'plasma@0.5', 'plasma4', 'plasma4@0.5', 'plasma4.lite', 'plasma4.rainbow@0.5', 'plasma4.aurora@0.5', 'plasma.rainbow@0.5'];
/** Round 5: R4 for reference, then R5 (evolving, ragged edge under the fringe, colour from the structure) and its low tiers */
const ROUND5: SunVariant[] = ['cur', 'plasma4@0.5', 'plasma5', 'plasma5@0.5', 'plasma5@0.33', 'plasma5.low@0.5', 'plasma5.rainbow@0.5', 'plasma5.aurora@0.5'];
const ROUND3: SunVariant[] = ['cur', 'plasma', 'plasma.lite', 'plasma@0.5', 'plasma.rainbow@0.5', 'plasma.aurora@0.5', 'photo2', 'lite2', 'exact@0.5', 'fix@0.5'];
const ROUND2: SunVariant[] = ['cur', ...FAITHFUL, ...ALTERNATIVE];
const LOOK_LABEL: Record<string, string> = {
  cur: 'current', port: 'A port', exact: 'A-exact', fix: 'current (edge fixed)', plasma4: 'plasma R4', plasma5: 'plasma R5', 'plasma5.low': 'plasma R5 low (no bump, spicules, fine octaves)', 'plasma5.lite': 'plasma R5 lite', 'plasma5.rainbow': 'plasma R5 rainbow', 'plasma5.aurora': 'plasma R5 aurora', 'plasma4.lite': 'plasma R4 lite', 'plasma4.rainbow': 'plasma R4 rainbow', 'plasma4.aurora': 'plasma R4 aurora', photo2: 'B2 photosphere, big cells', lite2: 'B2-lite, big cells', 'plasma.rainbow': 'plasma rainbow', 'plasma.aurora': 'plasma aurora', photo: 'B: photosphere', lite: 'B-lite (low tier)',
  plasma: 'plasma', 'plasma.lite': 'plasma lite', current: 'current',
};
function variantLabel(variant: SunVariant): string {
  const [look, scale] = variant.split('@');
  const kind = variant === 'cur' ? '' : look.startsWith('plasma') ? `${look.startsWith('plasma5') ? 'R5 ' : look.startsWith('plasma4') ? 'R4 ' : 'R3 '}${look.includes('rainbow') || look.includes('aurora') ? 'ALT multicolour: ' : 'ALT: '}` : look.startsWith('photo') || look.startsWith('lite') ? 'ALT: ' : 'FAITHFUL: ';
  const res = scale ? ` ${scale === '0.5' ? '½' : scale === '0.33' ? '⅓' : scale} res` : '';
  return `${kind}${LOOK_LABEL[look] ?? look}${res}`;
}
const VARIANT_LABEL = new Proxy({} as Record<string, string>, { get: (_, k: string) => variantLabel(k) });
const sunLayers = (id: string, v: View, variant: SunVariant): Layer[] => sunVariantLayers(id, sysOf(id).centralBody as CentralBody, v, variant);

/** The in-game views a star is timed and shown in (R its radius), CSS px */
function sunViews(R: number, t: number, dpr = 1): Record<string, View> {
  return {
    // The widest flight zoom: (most of) the disc and its corona
    whole: { w: 1920, h: 1080, dpr, cam: [0, 0], zoom: 0.04, t },
    // The limb across the screen at a middling zoom: disc, rim, corona and rays all drawn
    limb: { w: 1920, h: 1080, dpr, cam: [R + 0.1 * 1920 / 0.15, 0], zoom: 0.15, t },
    // Over the disc: nothing but surface
    disc: { w: 1920, h: 1080, dpr, cam: [0.3 * R, 0.1 * R], zoom: 0.5, t },
    // Just off it: corona only
    corona: { w: 1920, h: 1080, dpr, cam: [1.6 * R, 0], zoom: 0.3, t },
  };
}

if (set === 'verify') {
  // Does the glow draw anything? (its inner cut-out against its span, per star)
  for (const id of PLAIN) {
    const cb = sysOf(id).centralBody as CentralBody, R = radiusOf(cb);
    const v: View = { w: 900, h: 900, dpr: 1, cam: [0, 0], zoom: 900 / (2 * 3.3 * R), t: 120 };
    job(`glow-only.${id}`, v, currentSunLayers(id, cb, v).filter((l) => l.name === 'glow'), { stats: true, out: `verify/glow-only.${id}.png` });
    for (const variant of SUN_VARIANTS) job(`full.${id}.${variant}`, v, sunLayers(id, v, variant), { out: `verify/full.${id}.${variant}.png` });
    const limb = sunViews(R, 120).limb;
    for (const variant of SUN_VARIANTS) job(`limb.${id}.${variant}`, limb, sunLayers(id, limb, variant), { out: `verify/limb.${id}.${variant}.png` });
  }
  for (const id of ['sol', 'the_maw', 'glasswater']) {
    const b = systemBiome(sysOf(id));
    const v: View = { w: 1280, h: 720, dpr: 1, cam: [30000, -12000], zoom: 0.3, t: 120 };
    const lens = sysOf(id).centralBody?.type === 'black_hole' ? sysOf(id).centralBody.radius : 0;
    job(`sky.${id}.cur`, v, currentSkyLayers(b, v, lens), { out: `verify/sky.${id}.cur.png` });
    job(`sky.${id}.sprite`, v, spriteSkyLayers(b, v, lens), { out: `verify/sky.${id}.sprite.png` });
    job(`sky.${id}.better`, v, spriteSkyLayers(b, v, lens, { better: true }), { out: `verify/sky.${id}.better.png` });
  }
}

if (set === 'v2') {
  // Round 2 at a glance: every star whole and at the limb, current first, then the faithful options and the alternatives
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const views: Record<string, View> = {
      full: { w: 800, h: 800, dpr: 1, cam: [0, 0], zoom: 800 / (2 * 3.3 * R), t: 120 },
      limb: { w: 960, h: 540, dpr: 1, cam: [R + 0.1 * 960 / 0.15, 0], zoom: 0.15, t: 120 },
    };
    for (const [vn, v] of Object.entries(views)) {
      const cells = ROUND2.map((variant) => {
        const file = `v2/${id}.${vn}.${variant}.png`;
        job(`v2.${id}.${vn}.${variant}`, v, [...(vn === 'full' ? [] : currentSkyLayers(b, v, 0)), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `v2-${id}-${vn}.png`, cols: 4, cells, metric: true, scale: 0.5 });
    }
  }
}

if (set === 'bench') {
  const reps = 10;
  for (const dpr of [1, 2]) {
    for (const id of PLAIN) {
      const cb = sysOf(id).centralBody as CentralBody;
      const views = sunViews(radiusOf(cb), 120, dpr);
      for (const [name, v] of Object.entries(views)) {
        if (dpr === 2 && name === 'corona') continue;
        for (const variant of SUN_VARIANTS) job(`sun|${id}|${name}|${variant}|${dpr}`, v, sunLayers(id, v, variant), { bench: true, reps });
      }
    }
    for (const id of SPECIAL) {
      const cb = sysOf(id).centralBody as CentralBody;
      const r = cb.radius ?? 1000;
      // Close enough that the body fills the screen (the pulsar's beams always do)
      const v: View = { w: 1920, h: 1080, dpr, cam: [r * 0.5, 0], zoom: cb.type === 'pulsar' ? 0.3 : 1080 / (2 * 2.2 * r), t: 120 };
      for (const port of [false, true]) job(`central|${id}|fill|${port ? 'port' : 'cur'}|${dpr}`, v, centralLayers(cb, v, port), { bench: true, reps });
    }
    for (const id of ['sol', 'nebula_prime', 'the_maw', 'glasswater', 'void_sector', 'borealis']) {
      const s = sysOf(id), b = systemBiome(s);
      const lens = s.centralBody?.type === 'black_hole' ? s.centralBody.radius : 0;
      for (const zoom of [0.04, 0.3, 1, 2]) {
        const v: View = { w: 1920, h: 1080, dpr, cam: [30000, -12000], zoom, t: 120 };
        job(`sky|${id}|z${zoom}|cur|${dpr}`, v, currentSkyLayers(b, v, lens), { bench: true, reps });
        job(`sky|${id}|z${zoom}|sprite|${dpr}`, v, spriteSkyLayers(b, v, lens, { haze: 'cached' }), { bench: true, reps });
        job(`sky|${id}|z${zoom}|better|${dpr}`, v, spriteSkyLayers(b, v, lens, { haze: 'cached', better: true }), { bench: true, reps });
      }
    }
  }
}

if (set === 'stills') {
  // Every plain star: whole disc, the limb in game, a close look; current against each prototype
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const views: Record<string, View> = {
      full: { w: 800, h: 800, dpr: 1, cam: [0, 0], zoom: 800 / (2 * 3.3 * R), t: 120 },
      limb: { w: 960, h: 540, dpr: 1, cam: [R + 0.1 * 960 / 0.15, 0], zoom: 0.15, t: 120 },
      close: { w: 960, h: 540, dpr: 1, cam: [R * Math.SQRT1_2 - 150, -R * Math.SQRT1_2 + 100], zoom: 1, t: 120 },
    };
    for (const [vn, v] of Object.entries(views)) {
      const cells = [];
      for (const variant of SUN_VARIANTS) {
        const sky = vn === 'full' ? [] : currentSkyLayers(b, v, 0);
        const file = `stills/${id}.${vn}.${variant}.png`;
        job(`${id}.${vn}.${variant}`, v, [...sky, ...sunLayers(id, v, variant)], { out: file });
        cells.push({ file, label: `${s.name}: ${VARIANT_LABEL[variant]}` });
      }
      composites.push({ out: `compare-sun-${id}-${vn}.png`, cols: 2, cells });
    }
  }
  // Central bodies: current against the texture-noise port
  for (const id of SPECIAL) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, r = cb.radius ?? 1000;
    const v: View = { w: 800, h: 800, dpr: 1, cam: [0, 0], zoom: cb.type === 'pulsar' ? 800 / (2 * Math.max(24000, r * 60)) : 800 / (2 * (cb.type === 'black_hole' ? 6 : 1.6) * r), t: 120 };
    const cells = [false, true].map((port) => {
      const file = `stills/${id}.${port ? 'port' : 'cur'}.png`;
      job(`${id}.${port}`, v, centralLayers(cb, v, port), { out: file });
      return { file, label: `${s.name}: ${port ? 'A: port (texture noise)' : 'current'}` };
    });
    composites.push({ out: `compare-central-${id}.png`, cols: 2, cells });
  }
  // Skies: the game's against the sprite stars (B) and the better stars (C)
  for (const id of ['sol', 'borealis', 'nebula_prime', 'ashfall', 'the_maw', 'void_sector', 'glasswater', 'cinder_reach']) {
    const s = sysOf(id), b = systemBiome(s);
    const lens = s.centralBody?.type === 'black_hole' ? s.centralBody.radius : 0;
    const cam: [number, number] = lens ? [lens * 2.5, -lens * 1.2] : [30000, -12000];
    for (const zoom of [0.3, 1.5]) {
      const v: View = { w: 960, h: 540, dpr: 1, cam, zoom, t: 120 };
      const cells = (['cur', 'sprite', 'better'] as const).map((k) => {
        const file = `stills/sky.${id}.z${zoom}.${k}.png`;
        const layers = k === 'cur' ? currentSkyLayers(b, v, lens) : spriteSkyLayers(b, v, lens, { better: k === 'better' });
        job(`sky.${id}.${zoom}.${k}`, v, layers, { out: file });
        return { file, label: `${s.name} sky (${b.kind}), zoom ${zoom}: ${k === 'cur' ? 'current' : k === 'sprite' ? 'B: sprite stars' : 'C: sprite stars, better look'}` };
      });
      composites.push({ out: `compare-sky-${id}-z${zoom}.png`, cols: 3, cells });
    }
  }
}

if (set === 'parity') {
  // The sprite stars against the game's, a layer at a time (the deep sky and motes left out): they should match
  for (const id of ['borealis', 'sol', 'nebula_prime']) {
    const s = sysOf(id), b = systemBiome(s);
    for (const zoom of [0.3, 1.5]) {
      const v: View = { w: 960, h: 540, dpr: 1, cam: [30000, -12000], zoom, t: 120 };
      for (let i = 0; i < 6; i++) {
        const on = [0, 1, 2, 3, 4, 5].map((k) => k === i);
        const cur = currentSkyLayers(b, v, 0, 0.5, on);
        // (no deep sky or motes in the game's pass either)
        const st = cur[2].uniforms as Record<string, number | number[]>;
        st.uDeep = [1, 1, 0, 0]; st.uMotes = [1, 1, 0, 0];
        job(`parity.${id}.z${zoom}.L${i}.cur`, v, cur, { out: `parity/${id}.z${zoom}.L${i}.cur.png` });
        job(`parity.${id}.z${zoom}.L${i}.sprite`, v, spriteSkyLayers(b, v, 0, { only: i }), { out: `parity/${id}.z${zoom}.L${i}.sprite.png` });
      }
    }
  }
}

// Round 2 (after Kieran's review): the faithful options and the alternatives, each against the game's look, current first
const STAR_VIEWS = (R: number, t: number, dpr = 1): Record<string, View> => ({
  full: { w: 800, h: 800, dpr, cam: [0, 0], zoom: 800 / (2 * 3.3 * R), t },
  limb: { w: 960, h: 540, dpr, cam: [R + 0.1 * 960 / 0.15, 0], zoom: 0.15, t },
  close: { w: 960, h: 540, dpr, cam: [R * Math.SQRT1_2 - 150, -R * Math.SQRT1_2 + 100], zoom: 1, t },
});

if (set === 'stills2') {
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    for (const [vn, v] of Object.entries(STAR_VIEWS(R, 120))) {
      const cells = ROUND2.map((variant) => {
        const file = `stills2/${id}.${vn}.${variant}.png`;
        job(`s2.${id}.${vn}.${variant}`, v, [...(vn === 'full' ? [] : currentSkyLayers(b, v, 0)), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `r2-sun-${id}-${vn}.png`, cols: 4, cells, metric: true, scale: vn === 'full' ? 0.6 : 0.5, title: `${s.name}, ${vn}: current first, then FAITHFUL options (the current look, cheaper), then ALTERNATIVES (new looks). Diff: mean difference from current, 0-255.` });
    }
  }
  // Skies: the game's against each option, with the star in view (the limb) and without (a clear patch of sky)
  for (const id of ['sol', 'borealis', 'nebula_prime', 'cinder_reach', 'glasswater', 'the_maw']) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, b = systemBiome(s);
    const plain = cb.type === 'sun', R = plain ? radiusOf(cb) : 0;
    const lens = cb.type === 'black_hole' ? cb.radius ?? 0 : 0;
    const views: Record<string, View> = plain
      ? { limb: { w: 960, h: 540, dpr: 1, cam: [R + 0.1 * 960 / 0.15, 0], zoom: 0.15, t: 120 }, sky: { w: 960, h: 540, dpr: 1, cam: [30000 + R * 2, -12000], zoom: 1, t: 120 } }
      : { sky: { w: 960, h: 540, dpr: 1, cam: [30000, -12000], zoom: 1, t: 120 } };
    for (const [vn, v] of Object.entries(views)) {
      const cells = SKY_OPTIONS.map((o) => {
        const file = `stills2/sky.${id}.${vn}.${o.replace('+', '_')}.png`;
        const star = plain && vn === 'limb' ? sunLayers(id, v, 'cur') : [];
        job(`s2sky.${id}.${vn}.${o}`, v, [...skyOption(o, b, v, lens, R), ...star], { out: file });
        return { file, label: SKY_LABEL[o].replace(', skipped under the sun', ' +skip').replace('FAITHFUL: ', 'F: ') };
      });
      composites.push({ out: `r2-sky-${id}-${vn}.png`, cols: 3, cells, metric: true, scale: 0.6, title: `${s.name} sky, ${vn === 'limb' ? 'with the star (current) in view' : 'open sky, zoom 1'}: current first. +skip: nothing drawn behind the star's disc.` });
    }
  }
}

if (set === 'bench2') {
  const reps = 10;
  for (const dpr of [1, 2]) {
    for (const id of PLAIN) {
      const cb = sysOf(id).centralBody as CentralBody, R = radiusOf(cb);
      for (const [name, v] of Object.entries(sunViews(R, 120, dpr))) {
        if (name === 'corona') continue;
        for (const variant of ROUND2) job(`sun|${id}|${name}|${variant}|${dpr}`, v, sunLayers(id, v, variant), { bench: true, reps });
      }
    }
    // The sky where the star fills the screen (over its disc), covers half of it (the limb) and none of it (just off it)
    for (const id of ['sol', 'borealis', 'nebula_prime']) {
      const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
      const views = sunViews(R, 120, dpr);
      for (const name of ['disc', 'limb', 'corona']) {
        for (const o of SKY_OPTIONS) job(`sky|${id}|${name}|${o}|${dpr}`, views[name], skyOption(o, b, views[name], 0, R), { bench: true, reps });
      }
    }
    // Skies with no star in view, and the black hole's
    for (const id of ['sol', 'the_maw', 'glasswater']) {
      const s = sysOf(id), cb = s.centralBody as CentralBody, b = systemBiome(s);
      const lens = cb.type === 'black_hole' ? cb.radius ?? 0 : 0;
      const v: View = { w: 1920, h: 1080, dpr, cam: [30000 + (cb.type === 'sun' ? radiusOf(cb) * 3 : 0), -12000], zoom: 1, t: 120 };
      for (const o of SKY_OPTIONS) job(`sky|${id}|open|${o}|${dpr}`, v, skyOption(o, b, v, lens, cb.type === 'sun' ? radiusOf(cb) : 0), { bench: true, reps });
    }
  }
}

if (set === 'gif2') {
  // Each sun's limb animating: current, the closest faithful options and the alternatives; 15 s of game time at 3x
  const panels = ['cur', 'exact', 'cur@0.5', 'exact@0.5', 'plasma', 'plasma.lite'];
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const frames: string[] = [];
    for (let f = 0; f < 30; f++) {
      const t = 120 + f * 0.5;
      const v: View = { w: 480, h: 300, dpr: 1, cam: [R + 0.1 * 480 / 0.3, 0], zoom: 0.3, t };
      const cells = panels.map((variant) => {
        const file = `gif2/${id}.${variant}.${f}.png`;
        job(`gif2.${id}.${variant}.${f}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      const sheet = `gif2/${id}.sheet.${f}.png`;
      composites.push({ out: sheet, cols: 3, cells });
      frames.push(sheet);
    }
    gifs.push({ out: `r2-anim-sun-${id}.gif`, frames, ms: 167, scale: 0.75 });
  }
}

if (set === 'stills3' || set === 'v3') {
  // Round 3: current first, then the revised plasma (full, lite, half res), the multicolour examples, and the two
  // closest faithful options (with the edge fix)
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const views = STAR_VIEWS(R, 120);
    for (const [vn, v] of Object.entries(set === 'v3' ? { full: views.full, limb: views.limb } : views)) {
      const cells = ROUND3.map((variant) => {
        const file = `${set}/${id}.${vn}.${variant}.png`;
        job(`${set}.${id}.${vn}.${variant}`, v, [...(vn === 'full' ? [] : currentSkyLayers(b, v, 0)), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `r3-sun-${id}-${vn}.png`, cols: 4, cells, metric: true, scale: vn === 'full' ? 0.6 : 0.5, title: `${s.name}, ${vn}: current first, then the plasma alternative (round 3), its multicolour examples, and the closest faithful options. Diff: mean difference from current.` });
    }
  }
}

if (set === 'stills4' || set === 'v4') {
  // Round 4: current first, round 3's plasma for reference, then round 4's
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const views = STAR_VIEWS(R, 120);
    for (const [vn, v] of Object.entries(set === 'v4' ? { full: views.full, limb: views.limb } : views)) {
      const cells = ROUND4.map((variant) => {
        const file = `${set}/${id}.${vn}.${variant}.png`;
        job(`${set}.${id}.${vn}.${variant}`, v, [...(vn === 'full' ? [] : currentSkyLayers(b, v, 0)), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `r4-sun-${id}-${vn}.png`, cols: 4, cells, metric: true, scale: vn === 'full' ? 0.6 : 0.5, title: `${s.name}, ${vn}: current first, round 3's plasma for reference, then round 4 (limb by viewing angle, chromosphere, haze, spicules, bump).` });
    }
    // The edge up close: the limb at zoom 0.3 and 1, crops of current, round 3 and round 4
    const crops = ['cur', 'plasma@0.5', 'plasma4@0.5', 'plasma4.lite'];
    for (const zoom of [0.3, 1]) {
      const v: View = { w: 640, h: 400, dpr: 1, cam: [R + (zoom === 1 ? 60 : 200), 0], zoom, t: 120 };
      const cells = crops.map((variant) => {
        const file = `${set}/edge.${id}.z${zoom}.${variant}.png`;
        job(`${set}.edge.${id}.${zoom}.${variant}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `r4-edge-${id}-z${zoom}.png`, cols: 4, cells, title: `${s.name}: the limb up close at zoom ${zoom} (current, round 3, round 4, round 4 lite)` });
    }
  }
}

if (set === 'stills5' || set === 'v5') {
  // Round 5: current first, round 4 for reference, then round 5 and its low tiers and multicolour
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const views = STAR_VIEWS(R, 120);
    for (const [vn, v] of Object.entries(set === 'v5' ? { full: views.full, limb: views.limb } : views)) {
      const cells = ROUND5.map((variant) => {
        const file = `${set}/${id}.${vn}.${variant}.png`;
        job(`${set}.${id}.${vn}.${variant}`, v, [...(vn === 'full' ? [] : currentSkyLayers(b, v, 0)), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `r5-sun-${id}-${vn}.png`, cols: 4, cells, metric: true, scale: vn === 'full' ? 0.6 : 0.5, title: `${s.name}, ${vn}: current first, round 4 for reference, then round 5 (evolving, ragged edge under the fringe, colour from the structure) and its low tiers.` });
    }
    const crops = ['cur', 'plasma4@0.5', 'plasma5@0.5', 'plasma5.low@0.5'];
    for (const zoom of [0.3, 1]) {
      const v: View = { w: 640, h: 400, dpr: 1, cam: [R + (zoom === 1 ? 60 : 200), 0], zoom, t: 120 };
      const cells = crops.map((variant) => {
        const file = `${set}/edge.${id}.z${zoom}.${variant}.png`;
        job(`${set}.edge.${id}.${zoom}.${variant}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      composites.push({ out: `r5-edge-${id}-z${zoom}.png`, cols: 4, cells, title: `${s.name}: the limb up close at zoom ${zoom} (current, round 4, round 5, round 5 low)` });
    }
  }
}

/** The Sol panels' tiles: the original first, round 4 for reference, then every round 5 option (lite kept, labelled) */
const PANEL5: [SunVariant, string][] = [
  ['cur', 'Current (original)'], ['plasma4@0.5', 'R4 plasma, ½ res (reference)'], ['plasma5', 'R5 plasma, full res'],
  ['plasma5@0.5', 'R5 plasma, ½ res'], ['plasma5@0.33', 'R5 plasma, ⅓ res (proposed Low)'], ['plasma5.low@0.5', 'R5 low, ½ res (proposed Low)'],
  ['plasma5.rainbow@0.5', 'R5 rainbow, ½ res'], ['plasma5.aurora@0.5', 'R5 aurora, ½ res'], ['plasma5.lite', 'R5 lite (kept, not a candidate)'],
];

if (set === 'panel5') {
  // Sol whole (disc and corona in the tile), the same framing and exposure for every tile; and that framing timed at
  // 1080p and 4K (the perf panel is made from these numbers by panel5perf.py)
  const s = sysOf('sol'), R = radiusOf(s.centralBody as CentralBody);
  const cells = PANEL5.map(([variant, label]) => {
    const v: View = { w: 600, h: 600, dpr: 1, cam: [0, 0], zoom: 600 / (2 * 3.3 * R), t: 120 };
    const file = `panel5/sol.${variant}.png`;
    job(`panel5.${variant}`, v, sunLayers('sol', v, variant), { out: file });
    for (const dpr of [1, 2]) {
      const vb: View = { w: 1920, h: 1080, dpr, cam: [0, 0], zoom: 1080 / (2 * 3.3 * R), t: 120 };
      job(`panel|${variant}|${dpr}`, vb, sunLayers('sol', vb, variant), { bench: true, reps: 10 });
    }
    return { file, label };
  });
  composites.push({ out: 'r5-panel-sol.png', cols: 3, cells, title: 'Sol, the whole sun: the original first, then round 5 (and round 4 for reference). Same framing and exposure in every tile.' });
}

if (set === 'panels5') {
  // Clean before/after panels for docs/panels (nothing overlaid): each star whole, the game's sun and round 5's best
  for (const id of PLAIN) {
    const R = radiusOf(sysOf(id).centralBody as CentralBody);
    const v: View = { w: 900, h: 900, dpr: 1, cam: [0, 0], zoom: 900 / (2 * 3.3 * R), t: 120 };
    const topic = `${id.replace(/_/g, '-')}-sun-r5`;
    job(`panels5.${id}.before`, v, sunLayers(id, v, 'cur'), { out: `panels5/${topic}-before.png` });
    job(`panels5.${id}.after`, v, sunLayers(id, v, 'plasma5@0.5'), { out: `panels5/${topic}-after.png` });
  }
}

if (set === 'gif5') {
  // A minute of game time at about 6x (60 frames a second apart): round 4 against round 5, to see the pattern evolve
  const panels = ['cur', 'plasma4@0.5', 'plasma5@0.5', 'plasma5.rainbow@0.5'];
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const frames: string[] = [];
    for (let f = 0; f < 60; f++) {
      const t = 120 + f;
      const v: View = { w: 420, h: 280, dpr: 1, cam: [R * 0.75, 0], zoom: 0.15 * 21000 / R, t };
      const cells = panels.map((variant) => {
        const file = `gif5/${id}.${variant}.${f}.png`;
        job(`gif5.${id}.${variant}.${f}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      const sheet = `gif5/${id}.sheet.${f}.png`;
      composites.push({ out: sheet, cols: 2, cells });
      frames.push(sheet);
    }
    gifs.push({ out: `r5-anim-sun-${id}.gif`, frames, ms: 167, scale: 0.8 });
  }
}

if (set === 'bench5') {
  const reps = 10;
  for (const dpr of [1, 2]) {
    for (const id of PLAIN) {
      const cb = sysOf(id).centralBody as CentralBody, R = radiusOf(cb);
      for (const [name, v] of Object.entries(sunViews(R, 120, dpr))) {
        if (name === 'corona') continue;
        for (const variant of ['cur', 'plasma4@0.5', 'plasma5', 'plasma5@0.5', 'plasma5@0.33', 'plasma5.low@0.5', 'plasma5.rainbow@0.5']) job(`sun|${id}|${name}|${variant}|${dpr}`, v, sunLayers(id, v, variant), { bench: true, reps });
      }
    }
  }
}

if (set === 'gif4') {
  const panels = ['cur', 'plasma@0.5', 'plasma4@0.5', 'plasma4.lite', 'plasma4.rainbow@0.5', 'plasma4.aurora@0.5'];
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const frames: string[] = [];
    for (let f = 0; f < 30; f++) {
      const t = 120 + f * 0.5;
      const v: View = { w: 480, h: 300, dpr: 1, cam: [R + 0.1 * 480 / 0.3, 0], zoom: 0.3, t };
      const cells = panels.map((variant) => {
        const file = `gif4/${id}.${variant}.${f}.png`;
        job(`gif4.${id}.${variant}.${f}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      const sheet = `gif4/${id}.sheet.${f}.png`;
      composites.push({ out: sheet, cols: 3, cells });
      frames.push(sheet);
    }
    gifs.push({ out: `r4-anim-sun-${id}.gif`, frames, ms: 167, scale: 0.75 });
  }
}

if (set === 'bench4') {
  const reps = 10;
  for (const dpr of [1, 2]) {
    for (const id of PLAIN) {
      const cb = sysOf(id).centralBody as CentralBody, R = radiusOf(cb);
      for (const [name, v] of Object.entries(sunViews(R, 120, dpr))) {
        if (name === 'corona') continue;
        for (const variant of ['cur', 'plasma@0.5', 'plasma4', 'plasma4@0.5', 'plasma4.lite', 'plasma4.rainbow@0.5']) job(`sun|${id}|${name}|${variant}|${dpr}`, v, sunLayers(id, v, variant), { bench: true, reps });
      }
    }
  }
}

if (set === 'gif3') {
  const panels = ['cur', 'plasma@0.5', 'plasma.lite', 'plasma.rainbow@0.5', 'plasma.aurora@0.5', 'exact@0.5'];
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const frames: string[] = [];
    for (let f = 0; f < 30; f++) {
      const t = 120 + f * 0.5;
      const v: View = { w: 480, h: 300, dpr: 1, cam: [R + 0.1 * 480 / 0.3, 0], zoom: 0.3, t };
      const cells = panels.map((variant) => {
        const file = `gif3/${id}.${variant}.${f}.png`;
        job(`gif3.${id}.${variant}.${f}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: variantLabel(variant) };
      });
      const sheet = `gif3/${id}.sheet.${f}.png`;
      composites.push({ out: sheet, cols: 3, cells });
      frames.push(sheet);
    }
    gifs.push({ out: `r3-anim-sun-${id}.gif`, frames, ms: 167, scale: 0.75 });
  }
}

if (set === 'bench3') {
  const reps = 10;
  for (const dpr of [1, 2]) {
    for (const id of PLAIN) {
      const cb = sysOf(id).centralBody as CentralBody, R = radiusOf(cb);
      for (const [name, v] of Object.entries(sunViews(R, 120, dpr))) {
        if (name === 'corona') continue;
        for (const variant of ROUND3) job(`sun|${id}|${name}|${variant}|${dpr}`, v, sunLayers(id, v, variant), { bench: true, reps });
      }
    }
  }
}

if (set === 'edge') {
  // The limb at the lab's view (1600 x 900, zoom 0.15): is a stair-step the half-res target's, or the shader's own?
  const s = sysOf('sol'), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
  const v: View = { w: 1600, h: 900, dpr: 1, cam: [R + 0.1 * 1600 / 0.15, 0], zoom: 0.15, t: 120 };
  for (const only of ['disc', 'rays']) job(`edge.only.${only}`, v, sunLayers('sol', v, 'cur').filter((l) => l.name === only), { out: `edge/sol.only.${only}.png` });
  for (const variant of ['cur', 'cur@0.5', 'fix@0.5', 'exact@0.5', 'plasma@0.5']) job(`edge.${variant}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers('sol', v, variant)], { out: `edge/sol.${variant}.png` });
}

if (set === 'gif') {
  // The limb of each sun animating, the game's and both prototypes side by side: 15 s of game time at 3x speed
  for (const id of PLAIN) {
    const s = sysOf(id), cb = s.centralBody as CentralBody, R = radiusOf(cb), b = systemBiome(s);
    const frames: string[] = [];
    for (let f = 0; f < 30; f++) {
      const t = 120 + f * 0.5;
      const v: View = { w: 640, h: 400, dpr: 1, cam: [R + 0.1 * 640 / 0.3, 0], zoom: 0.3, t };
      const cells = (['cur', 'port', 'photo'] as SunVariant[]).map((variant) => {
        const file = `gif/${id}.${variant}.${f}.png`;
        job(`gif.${id}.${variant}.${f}`, v, [...currentSkyLayers(b, v, 0), ...sunLayers(id, v, variant)], { out: file });
        return { file, label: VARIANT_LABEL[variant] };
      });
      const sheet = `gif/${id}.sheet.${f}.png`;
      composites.push({ out: sheet, cols: 3, cells });
      frames.push(sheet);
    }
    gifs.push({ out: `anim-sun-${id}.gif`, frames, ms: 167, scale: 0.6 });
  }
}

const programs = { ...sunPrograms(sources), ...skyPrograms() };
const scenesFile = join(out, `${set}.json`);
writeFileSync(scenesFile, JSON.stringify({ programs, textures, jobs, composites, gifs }));
console.log(`${jobs.length} jobs -> ${scenesFile}`);

const py = spawnSync('python', [join(here, 'harness.py'), scenesFile, out], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
const lines = (py.stdout ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
writeFileSync(join(out, `${set}.results.json`), JSON.stringify(lines, null, 1));
for (const l of lines) {
  if (l.stats) console.log(l.id, JSON.stringify(l.stats));
  else if (l.ms) console.log(l.id.padEnd(44), String(l.total).padStart(8), JSON.stringify(l.ms));
  else if (l.info || l.done) console.log(JSON.stringify(l));
}
if (py.status !== 0) { console.error(`harness exited ${py.status}`); process.exit(1); }
