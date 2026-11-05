// Surface ground stills and timings, native (no browser): the game's own ground and cloud shaders, looks and sky
// noise, drawn as SurfaceRenderer draws them (the ground at half size from a texel-snapped camera, stretched over the
// screen; the clouds over it at full size). Run through run.mjs:
//   node scripts/surface-art/run.mjs stills <out dir> [new|classic|both] [view filter]
//   node scripts/surface-art/run.mjs bench  <out dir>
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { groundFrag } from '../../client/src/rendering/surface/groundShader';
import { cloudFrag, groundFragClassic } from '../../client/src/rendering/surface/surfaceShaders';
import { hexRgb, lookOf, lookUniforms } from '../../client/src/rendering/surface/surfaceLooks';
import { SUN_DIR } from '../../client/src/rendering/surface/SurfaceRenderer';
import { skyNoiseTexture } from '../../client/src/rendering/sky/noiseTexture';

const root = process.env.SURFACE_ART_ROOT!;
const [mode = 'stills', outArg = 'surface-stills', which = 'both', filter = ''] = process.argv.slice(2);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const systems = JSON.parse(readFileSync(join(root, 'data/systems.json'), 'utf8'));
const list: any[] = Array.isArray(systems) ? systems : systems.systems ?? Object.values(systems);
const surfaceOf = (id: string) => list.find((s) => s.id === id)?.surface;

/** [name, surface system, camera x, y, zoom] (the live shots' views) */
export const VIEWS: [string, string, number, number, number][] = [
  ['terra-nova-city', 'terra_nova_surface', 0, 0, 0.12],
  ['terra-nova-countryside', 'terra_nova_surface', 9000, -6000, 0.2],
  ['terra-nova-close', 'terra_nova_surface', 14000, 9000, 0.55],
  ['terra-nova-wide', 'terra_nova_surface', -12000, 4000, 0.08],
  ['terra-nova-coast', 'terra_nova_surface', -6500, -9500, 0.35],
  ['glacia-wide', 'glacia_surface', 0, 0, 0.12],
  ['glacia-close', 'glacia_surface', 6000, 5000, 0.45],
  ['selene-bastion', 'selene_siege', 0, 0, 0.15],
  ['selene-close', 'selene_siege', 5000, -4000, 0.5],
  ['ashfall-wide', 'ashfall_surface', 0, 0, 0.12],
  ['ashfall-close', 'ashfall_surface', 4000, 3000, 0.45],
  ['cinderhold-bastion', 'cinderhold_siege', 0, 0, 0.15],
  ['cinderhold-close', 'cinderhold_siege', -5000, 4000, 0.5],
  ['gloam-bastion', 'gloam_siege', 0, 0, 0.15],
  ['gloam-close', 'gloam_siege', 5000, 3000, 0.5],
  ['rimeholt-bastion', 'rimeholt_siege', 0, 0, 0.15],
  ['last-light-bastion', 'lastlight_siege', 0, 0, 0.15],
  ['deep-foundry', 'halcyon_foundry', 0, 2000, 0.2],
];

const noise = skyNoiseTexture().source as unknown as { resource: Uint8Array; width: number };
writeFileSync(join(out, 'skyNoise.rgba'), noise.resource);

function uniforms(id: string, classic: boolean, cx: number, cy: number, zoom: number, w: number, h: number) {
  const s = surfaceOf(id);
  const look = lookOf({ kind: s.kind, id }, classic);
  const seed = s.seed ?? 1;
  const common = {
    uZoom: zoom, uTime: 40, uSeed: [(seed * 0.618) % 1, (seed * 0.382) % 1], uSun: SUN_DIR, uCloud: [look.cloud, 15000, 22, 0.3],
    uNight: 0, uShake: [0, 0, 0],
  };
  // The ground: half size, a few spare texels round it, its camera snapped to them
  const SCALE = 0.5, MARGIN = 3, texel = 1 / (SCALE * zoom);
  const rw = Math.ceil(w * SCALE) + MARGIN * 2, rh = Math.ceil(h * SCALE) + MARGIN * 2;
  const sx = Math.round(cx / texel) * texel, sy = Math.round(cy / texel) * texel;
  const city = s.city;
  const ground = {
    ...common, ...lookUniforms(look), uCamera: [sx, sy], uRes: [rw / SCALE, rh / SCALE], uPx: texel,
    uLand: [look.sea, look.snow, city ? city.radius : 0, s.radius], uCity: city ? [city.x, city.y] : [0, 0], uCave: s.kind === 'cavern' ? 1 : 0,
  };
  const clouds = { ...common, uCamera: [cx, cy], uRes: [w, h], uFade: 1 - 0.78 * Math.max(0, Math.min(1, (zoom - 0.12) / 0.4)), uTint: hexRgb(look.cloudTint) };
  // Where the ground's picture sits on the screen (in screen pixels: its top left)
  const off = [w / 2 - rw / SCALE / 2 + (sx - cx) * zoom, h / 2 - rh / SCALE / 2 + (sy - cy) * zoom];
  return { ground, clouds, rt: [rw, rh], off, cloudsOn: s.kind !== 'cavern' };
}

// (SURFACE_W / SURFACE_H: another screen size, e.g. for timing at 4K)
const W = Number(process.env.SURFACE_W ?? 1280), H = Number(process.env.SURFACE_H ?? 800);
const looks = which === 'both' ? ['classic', 'new'] : [which];
const jobs: any[] = [];
for (const [name, id, cx, cy, zoom] of VIEWS) {
  if (filter && !name.includes(filter)) continue;
  for (const l of looks) {
    const u = uniforms(id, l === 'classic', cx, cy, zoom, W, H);
    jobs.push({ id: `${name}-${l}`, w: W, h: H, program: l, ...u, out: mode === 'stills' ? join(out, `${name}-${l}.png`) : undefined, bench: mode === 'bench' });
  }
}
const scenes = {
  // (SURFACE_DEBUG=<glsl expression>: the new ground's colour replaced by it, to look at one of its fields)
  programs: {
    new: process.env.SURFACE_DEBUG ? groundFrag.replace('fragColor = vec4(outc, 1.0);', `fragColor = vec4(vec3(${process.env.SURFACE_DEBUG}), 1.0);`) : groundFrag,
    classic: groundFragClassic, clouds: cloudFrag,
  },
  noise: { file: join(out, 'skyNoise.rgba'), size: noise.width },
  jobs,
};
writeFileSync(join(out, 'scenes.json'), JSON.stringify(scenes));
const r = spawnSync('python', [join(root, 'scripts/surface-art/harness.py'), join(out, 'scenes.json')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
