/**
 * Dev only: weapon firing effects on a fixed stage, for before/after strips and frame-time numbers
 * (scripts/fx-shots/strips.mjs loads this in a render daemon tab). A gun is the hangar's GunPreview (the game's own
 * WeaponFx and DamageParticles, no server) stepped a frame at a time with seeded randomness, at one zoom for every gun,
 * its muzzle at the left; a flak burst is the game's `detonate` on the same stage. Nothing in the game imports this.
 */

import { Graphics } from 'pixi.js';
import { FX_STEPS, gunDef, partGrade, rapidRate, type GunFx } from '@space-game/common';
import { GunPreview } from '../ships/gunPreview/GunPreview';
import { gunPlan, type GunPlan } from '../ships/gunPreview/gunPlan';
import { gunArt } from '../ships/gunPreview/gunArt';
import { loadViewerData } from '../viewer/catalog';
import { settings } from '../settings/Settings';
import { DamageCtx } from '../ships/damage/context';
import { detonate } from '../ships/damage/detonations';
import { ChargeFx } from '../ships/ChargeFx';
import '../ships/energyLooks';

const W = 400, H = 220, RES = 2;
const FRAME_MS = 1000 / 60;
/* eslint-disable @typescript-eslint/no-explicit-any */

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let data: ReturnType<typeof loadViewerData> | null = null;

/** Modifier effects the next gun opened is shown with (`mods`) */
let modFx: { fx: number; k: number }[] | undefined;

/**
 * A gun's plan as it fires with the stage's modifier effects live: the real modified shot (common fxDef, through
 * launch.ts gunDef as the game's shells and beams are built), so a split is its three shells, a velocity or hyper
 * round its real speed, a wave its real width, an explosive its real blast
 */
function modPlan(plan: GunPlan, fn: any, list: { fx: number; k: number }[]): GunPlan {
  const gunFx: GunFx[] = list.map((e) => ({ fx: e.fx, q: Math.max(1, Math.min(FX_STEPS, Math.round(e.k * FX_STEPS))) }));
  if (!gunFx.length || plan.support) return plan;
  const cat = data!.catalog, tuning = data!.tuning;
  const grade = partGrade(cat, { fn: fn.id, material: fn.model && fn.material ? fn.material : 'alloy' } as any);
  const own = gunDef(tuning, fn.weapon, { grade, size: 1, model: fn.weaponMods });
  const def = gunDef(tuning, fn.weapon, { grade, size: 1, model: fn.weaponMods, gunFx, fx: (1 << gunFx.length) - 1 });
  if (def === own) return plan;
  const beam = plan.beam, maxSpeed = def.maxSpeed ?? def.speed ?? 0, mt = (tuning as any).modifiers;
  // (its beat: the gun's own fire spec, rapid's rate times as quick)
  const rapid = gunFx.find((g) => mt.effects[g.fx] === 'rapid'), quick = rapid ? rapidRate(mt, rapid.q) : 1;
  const fire = quick !== 1 && plan.fire.interval ? { ...plan.fire, interval: Math.max(1, Math.round(plan.fire.interval / quick)) } : plan.fire;
  return {
    ...plan, fire,
    speed: def.speed ?? 0, accel: def.accel ?? 0, maxSpeed, life: def.life ?? 0, size: def.size ?? 1, spread: def.spread ?? 0, damage: def.damage ?? 0,
    splash: def.splash?.radius ?? 0, splashDamage: def.splash?.damage ?? 0,
    range: beam ? def.range ?? 0 : maxSpeed * (def.life ?? 0),
    burst: Math.max(1, def.burst ?? 1), width: def.width ?? plan.width, beamFan: def.beamFan,
    chain: def.chain ? { count: def.chain.count, radius: def.chain.radius, falloff: def.chain.falloff } : null,
    perTick: beam && own.dps && def.dps ? plan.perTick * (def.dps / own.dps) : beam && own.damage && def.damage ? plan.perTick * (def.damage / own.damage) : plan.perTick,
  };
}

async function open(fnId: string): Promise<any> {
  data ??= loadViewerData();
  settings.data.display.quality = 'high';
  const fn = data.catalog.functions.get(fnId);
  if (!fn) throw new Error(`no model ${fnId}`);
  const plan0 = gunPlan(data.catalog, data.tuning, fn);
  if (!plan0) throw new Error(`${fnId} has no gun plan`);
  const plan = modFx?.length ? modPlan(plan0, fn, modFx) : plan0;
  const host = document.createElement('div');
  host.style.cssText = `position:fixed; left:0; top:0; width:${W}px; height:${H}px;`;
  document.body.appendChild(host);
  const pv = new GunPreview(host) as any;
  pv.modFx = modFx;
  pv.show(plan, gunArt(data.catalog, fn, data.tuning.cellSize), data.catalog);
  for (let i = 0; i < 400 && !pv.app; i++) await new Promise((r) => setTimeout(r, 10));
  if (!pv.app) throw new Error('the preview never started');
  pv.app.ticker.stop();
  pv.app.renderer.resize(W, H, RES);
  pv.app.stage.addChildAt(new Graphics().rect(0, 0, W, H).fill(0x070a12), 0);
  pv.rangeG.visible = false;
  pv.host = host;
  pv.plan0 = plan;
  return pv;
}

function close(pv: any): void {
  pv.destroy();
  pv.host.remove();
}

function sprites(pv: any): number {
  const f = pv.fx.f;
  return f.glow.used + f.smokeG.used + f.extraG.used + f.hitG.used + f.shockG.used;
}

function strip(pv: any, frames: number, draw: (i: number) => void): string {
  const out = document.createElement('canvas');
  out.width = W * RES * frames; out.height = H * RES;
  const ctx = out.getContext('2d')!;
  for (let i = 0; i < frames; i++) {
    draw(i);
    pv.app.render();
    ctx.drawImage(pv.app.canvas, i * W * RES, 0);
  }
  return out.toDataURL('image/png');
}

/** A gun's first shot at the frames `at` after its muzzle flash (zoom: screen px a world unit; `wall`: its target wall stood that far off, in view) */
export async function gun(fnId: string, at: number[] = [0, 2, 5, 11], zoom = 1.2, seed = 7, wall = 0): Promise<string> {
  const real = Math.random;
  Math.random = seeded(seed);
  const pv = await open(fnId);
  try {
    // (a wall stood `wall` from the muzzle, whatever the gun's reach: its muzzle, flight and hit in one frame)
    if (wall > 0) {
      const fr = pv.fr;
      fr.dist = wall; fr.farX = wall + fr.depth; fr.aimX = wall + fr.block * 0.5;
      pv.blocks.layout(fr.dist, fr.block, 1);
      pv.poses = pv.blocks.blocks.map((b: any) => ({ renderX: b.x, renderY: b.y, renderAngle: 0 }));
      pv.blockArt.sync(pv.blocks);
    }
    pv.world.scale.set(zoom);
    pv.world.position.set(W * (wall > 0 ? 0.14 : 0.27), H / 2);
    let fired = false;
    const kick = pv.fx.onMuzzle;
    pv.fx.onMuzzle = (...a: unknown[]) => { fired = true; kick(...a); };
    // (a beam never flashes: it is shown from when it lights)
    for (let i = 0; i < 900 && !fired && !pv.plan0.beam; i++) pv.frame(FRAME_MS);
    let done = 0;
    return strip(pv, at.length, (i) => { for (; done <= at[i]; done++) if (done > 0 || pv.plan0.beam) pv.frame(FRAME_MS); });
  } finally {
    close(pv);
    Math.random = real;
  }
}

/**
 * A gun's first shot with weapon modifier effects on it (fx/mods): `spec` is effect names with strengths, as
 * 'velocity:1,burn:0.3' (a bare name is strength 1; '' or 'none' is the gun alone)
 */
export async function mods(fnId: string, spec: string, at: number[] = [0, 2, 5, 11], zoom = 1.5, seed = 7, wall = 150): Promise<string> {
  data ??= loadViewerData();
  const names = (data.tuning as any).modifiers.effects as string[];
  modFx = spec.split(',').map((s) => s.trim()).filter((s) => s && s !== 'none').map((s) => {
    const [name, k] = s.split(':'), fx = names.indexOf(name);
    if (fx < 0) throw new Error(`no modifier effect ${name}`);
    return { fx, k: k === undefined ? 1 : Number(k) };
  });
  try {
    return await gun(fnId, at, zoom, seed, wall);
  } finally {
    modFx = undefined;
  }
}

/** Several `mods` strips of one gun stacked into a sheet, a row per entry of `specs` (to compare effects and strengths) */
export async function modSheet(fnId: string, specs: string[], at: number[] = [0, 2, 5, 11], zoom = 1.5, seed = 7, wall = 150): Promise<string> {
  const out = document.createElement('canvas');
  out.width = W * RES * at.length; out.height = H * RES * specs.length;
  const ctx = out.getContext('2d')!;
  for (let i = 0; i < specs.length; i++) {
    const img = new Image();
    img.src = await mods(fnId, specs[i], at, zoom, seed, wall);
    await img.decode();
    ctx.drawImage(img, 0, i * H * RES);
  }
  return out.toDataURL('image/png');
}

/** A flak model's burst at the frames `at` after it goes off, the view fitted to its damage radius */
export async function flak(fnId: string, at: number[] = [1, 6, 14, 34], seed = 7): Promise<string> {
  return blast(fnId, 'flak', 0, at, seed);
}

/** A detonation of `kind` on a model's stage at the frames `at` after it goes off (`radius` 0: the model's own splash), the view fitted to `view` or its radius */
export async function blast(fnId: string, kind: string, radius = 0, at: number[] = [1, 6, 14, 34], seed = 7, view = 0): Promise<string> {
  const real = Math.random;
  Math.random = seeded(seed);
  const pv = await open(fnId);
  try {
    radius = radius || pv.plan0.splash;
    pv.gun.visible = false;
    pv.blockArt.root.visible = false;
    pv.world.scale.set(H / 2 / ((view || radius) * 1.3));
    pv.world.position.set(W / 2, H / 2);
    const ctx = new DamageCtx(pv.parts, { bodies: new Map(), tuning: data!.tuning, catalog: data!.catalog } as any, pv.state, () => {}, 0);
    detonate(ctx, kind, 0, 0, radius);
    let done = 0;
    return strip(pv, at.length, (i) => {
      for (; done < at[i]; done++) {
        ctx.time += 1 / 60;
        ctx.runPending();
        pv.parts.begin(); pv.parts.draw(1); pv.parts.end();
      }
    });
  } finally {
    close(pv);
    Math.random = real;
  }
}

/** A charge tell (ChargeFx: 'dot', 'sight' or 'blackout') on its gun's muzzle at the charge fractions `at` */
export async function charge(look: 'dot' | 'sight' | 'blackout', at: number[] = [0.15, 0.45, 0.8, 0.99], zoom = 2.4): Promise<string> {
  const pv = await open({ dot: 'utility_demolition_launcher', sight: 'cannon_longbarrel', blackout: 'emp_blackout' }[look]);
  try {
    pv.world.scale.set(zoom);
    pv.world.position.set(W * 0.27, H / 2);
    const fx = new ChargeFx(pv.world, { get: () => undefined, bodies: new Map() } as any, { playerId: -1 } as any, data!.tuning, new Map()) as any;
    return strip(pv, at.length, (i) => {
      fx.t = 0.37 + i * 0.21;
      fx.dark.clear(); fx.glow.clear();
      fx.tell(look, 0, 0, 0, at[i], 60, 900, data!.tuning.cellSize);
    });
  } finally {
    close(pv);
  }
}

/**
 * Frame time of a gun firing for `frames` frames: the average and worst `frame()` (ms), and the most sprites drawn in
 * one. `hits` false lets the rounds fly on through the wall, so only the firing effects are made
 */
export async function bench(fnId: string, hits = true, frames = 900, seed = 7): Promise<{ avg: number; max: number; sprites: number }> {
  const real = Math.random;
  Math.random = seeded(seed);
  const pv = await open(fnId);
  try {
    if (!hits) pv.fx.castHit = null;
    for (let i = 0; i < 120; i++) pv.frame(FRAME_MS);
    let sum = 0, max = 0, most = 0;
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      pv.frame(FRAME_MS);
      const dt = performance.now() - t0;
      sum += dt; max = Math.max(max, dt); most = Math.max(most, sprites(pv));
    }
    return { avg: sum / frames, max, sprites: most };
  } finally {
    close(pv);
    Math.random = real;
  }
}

/** `count` flak bursts going off together: the average and worst particle frame (ms) over their life, and the most particles live */
export async function benchFlak(fnId: string, count = 12, seed = 7): Promise<{ avg: number; max: number; live: number }> {
  const real = Math.random;
  Math.random = seeded(seed);
  const pv = await open(fnId);
  try {
    const radius = pv.plan0.splash;
    const ctx = new DamageCtx(pv.parts, { bodies: new Map(), tuning: data!.tuning, catalog: data!.catalog } as any, pv.state, () => {}, 0);
    pv.parts.setQuality(1, 2500);
    let sum = 0, max = 0, live = 0;
    const frames = 180;
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      if (i % 60 === 0) for (let k = 0; k < count; k++) detonate(ctx, 'flak', k * 40, 0, radius);
      ctx.time += 1 / 60;
      ctx.runPending();
      pv.parts.begin(); pv.parts.draw(1); pv.parts.end();
      const dt = performance.now() - t0;
      sum += dt; max = Math.max(max, dt); live = Math.max(live, pv.parts.ps.length);
    }
    return { avg: sum / frames, max, live };
  } finally {
    close(pv);
    Math.random = real;
  }
}
