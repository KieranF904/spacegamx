/**
 * @contract client.weapon-fx.mods
 * owns:       the weapon modifiers' visual layers: the registry of one layer set per effect (by name, as tuning
 *             `modifiers.effects`), and the hooks the weapon effects call with a shot's or beam's live effects (`fx`): at the
 *             muzzle, each frame of flight, at a hit, each frame of a beam, and once a frame for what outlives its frame;
 *             which of the server's detonations is a modifier's blast with no shell's hit to draw it (a beam's end, a
 *             piercing shot's way out of a hull), and its drawing
 * needs:      kit (ModCtx, BeamCtx, marks), looks (numbers, budgets), blast, one file per effect; FxField, shotTypes; npm: pixi.js
 * invariants: every effect in tuning `modifiers.effects` has a layer; a layer adds nothing at strength 0 and nothing for
 *             a shot with no effects; a shot's layers together stay inside its particle budget however many it carries —
 *             client/src/rendering/weapons/fx/mods/mods.test.ts
 *             only a gun's detonation with a way out, or no wider than the explosive modifier's widest blast, is drawn
 *             as a modifier's blast; a blast told alone stays inside CAP_BLAST, thinned by quality and load —
 *             client/src/rendering/weapons/fx/mods/blast.test.ts
 * extend:     a new effect is one file exporting a ModLayer, one line in LAYERS and one row in looks.ts LOOK
 */

import type { Graphics } from 'pixi.js';
import type { ImpactAnchor } from '../../impactAnchor';
import type { FxField } from '../FxField';
import { impactScale } from '../particleTypes';
import type { Shot } from '../shotTypes';
import { BeamCtx, ModCtx, stateOf, type ModFx, type ModLayer } from './kit';
import { CAP_FLIGHT, CAP_IMPACT, CAP_MUZZLE, EFFECTS, GUN_KINDS, LOOK, MECH, SOFT_LOAD } from './looks';
import { blast, CAP_BLAST } from './blast';
import { burn } from './burn';
import { chain, strike } from './chain';
import { explosive } from './explosive';
import { heavy } from './heavy';
import { hyper } from './hyper';
import { pierce } from './pierce';
import { rapid } from './rapid';
import { split } from './split';
import { velocity } from './velocity';
import { wave } from './wave';

export type { ModFx, ModLayer } from './kit';

/** Each effect's layers, by its name in tuning `modifiers.effects` */
export const LAYERS: Record<string, ModLayer> = { velocity, rapid, explosive, split, pierce, wave, chain, heavy, burn, hyper };

/** ... and by effect id (the wire order) */
const BY_ID: readonly (ModLayer | undefined)[] = EFFECTS.map((n) => LAYERS[n]);
const LOOKS = EFFECTS.map((n) => LOOK[n]);

/** Stage numbers, for the random stream */
const MUZZLE = 1, FLIGHT = 2, IMPACT = 3;

const C = new ModCtx(), B = new BeamCtx();

/** A shot's budget: the cap for how many effects it carries, x each one's share, x quality and load */
function budget(f: FxField, list: readonly ModFx[], caps: readonly number[]): number {
  const st = stateOf(f);
  let live = 0, share = 1;
  for (const e of list) if (e.k > 0 && BY_ID[e.fx]) { live++; share *= LOOKS[e.fx].n.share ?? 1; }
  C.f = f; C.st = st; C.anc = undefined;
  C.thin = (f.particleKeep ?? 1) * Math.min(1, SOFT_LOAD / Math.max(SOFT_LOAD, st.load)) * share;
  return live ? Math.max(1, Math.round(caps[Math.min(live, caps.length - 1)] * C.thin)) : 0;
}

function each(list: readonly ModFx[], shot: Shot | undefined, stage: number, step: number, per: number, run: (layer: ModLayer, k: number) => void): void {
  for (const e of list) {
    const layer = BY_ID[e.fx];
    if (!layer || !(e.k > 0)) continue;
    const k = Math.min(1, e.k);
    C.look = LOOKS[e.fx]; C.color = C.look.color; C.fx = e.fx; C.left = per;
    C.seed(shot?.id ?? 0, e.fx * 8 + stage, step);
    run(layer, k);
  }
}

/** A shot leaving its barrel at (x, y) along `angle`, its flash `size` across (MuzzleFx.flash) */
export function modMuzzle(f: FxField, shot: Shot, x: number, y: number, angle: number, size: number): void {
  const list = shot.fx;
  if (!list?.length) return;
  const per = budget(f, list, CAP_MUZZLE);
  // (drawn generously: a layer's muzzle moment stands beside the gun's own flash, not inside it)
  C.shot = shot; C.x = x; C.y = y; C.s = Math.max(size * 1.3, 20); C.vs = 1; C.aim(angle);
  each(list, shot, MUZZLE, 0, per, (l, k) => l.muzzle?.(C, k));
}

/** One frame of a flying shell: its head (hx, hy), tail (bx, by), unit direction, length and light (TracerFx.drawShot) */
export function modFlight(f: FxField, shot: Shot, hx: number, hy: number, bx: number, by: number, ux: number, uy: number, dl: number, z: number, alpha: number, clock: number, frames: number): void {
  const list = shot.fx;
  if (!list?.length || shot.ended) return;
  budget(f, list, CAP_MUZZLE);
  const st = shot.style;
  C.shot = shot; C.vs = 1; C.x = hx; C.y = hy; C.bx = bx; C.by = by; C.dl = dl; C.alpha = alpha; C.clock = clock; C.frames = frames;
  C.a = Math.atan2(uy, ux); C.ux = ux; C.uy = uy; C.nx = -uy; C.ny = ux;
  // (its drawn half-width: the tracer's glow, its head or its halo, whichever shows it widest)
  C.s = Math.max(2, st.glowWidth * 0.5, st.headRadius, st.haloRadius * 0.4, st.coreWidth) * z;
  each(list, shot, FLIGHT, Math.floor(clock / 2), CAP_FLIGHT, (l, k) => l.flight?.(C, k));
}

/** A shot's hit at (x, y): thrown along `out` (off a known surface or not), the shot flying along (dx, dy), its scale `size` (ImpactFx.parts) */
export function modImpact(f: FxField, shot: Shot | undefined, x: number, y: number, out: number, surface: boolean, dx: number, dy: number, size: number): void {
  const list = shot?.fx;
  if (!list?.length) return;
  const per = budget(f, list, CAP_IMPACT);
  C.shot = shot; C.x = x; C.y = y; C.s = Math.max(16 * impactScale(size), shot!.splash * 0.4); C.vs = Math.max(1, Math.min(2.6, C.s / 13)); C.out = out; C.surface = surface; C.R = shot!.splash;
  C.aim(dx || dy ? Math.atan2(dy, dx) : out + Math.PI);
  each(list, shot, IMPACT, Math.round(x * 3 + y * 7), per, (l, k) => l.impact?.(C, k));
}

/** How many marks the field has (ImpactFx.grouped, before an impact spawns) */
export function modMarkCount(f: FxField): number {
  return stateOf(f).marks.length;
}

/** Marks made since `from` ride `anc` with the rest of their impact (ImpactFx.grouped) */
export function modBind(f: FxField, from: number, anc: ImpactAnchor): void {
  const marks = stateOf(f).marks;
  for (let i = Math.max(0, from); i < marks.length; i++) { marks[i].anc = anc; anc.hold(marks[i].max - marks[i].life + 2); }
}

/** Once a frame, after the tracers: ages and draws the marks, and lets the budget's load drain (WeaponFx.draw) */
export function modFrame(f: FxField, frames: number): void {
  const st = stateOf(f);
  st.load *= Math.pow(0.9, frames);
  if (!st.marks.length) return;
  C.f = f; C.st = st; C.shot = undefined; C.thin = f.particleKeep ?? 1; C.frames = frames;
  for (let i = st.marks.length - 1; i >= 0; i--) {
    const m = st.marks[i];
    m.life += frames;
    if (m.life >= m.max) { if (m.key !== undefined) st.kept.delete(m.key); st.marks.splice(i, 1); continue; }
    if (m.anc) { m.anc.move(m); m.a += m.anc.turn; }
    if (m.life < 0) continue;
    C.look = m.look; C.color = m.color; C.anc = m.anc; C.vs = 1; C.left = 2; C.x = m.x; C.y = m.y; C.s = m.s; C.aim(m.a);
    C.seed(m.seed, 0, Math.floor(m.life / 2));
    m.draw(C, m, frames);
  }
  C.anc = undefined;
}

/**
 * A chain's jump drawn between two known points (the target it left and the one it reached): the hit layer's own bolt,
 * for whoever knows the chain's targets. `k` is the chain effect's strength; `id` tells jumps apart (the shot's id and the jump's number)
 */
export function chainArc(f: FxField, x0: number, y0: number, x1: number, y1: number, k: number, id = 0): void {
  if (!(k > 0)) return;
  C.f = f; C.st = stateOf(f); C.anc = undefined; C.look = LOOK.chain; C.color = C.look.color; C.vs = 1;
  C.seed(id, 77, 0);
  const a = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0), fa = (C.rnd() < 0.5 ? 1 : -1) * C.range(0.5, 1.1), fr = len * C.range(0.15, 0.3);
  C.mark(strike, x0, y0, a, 8 + 6 * k, Math.min(1, k), 10, [len, 0, C.look.n.forkAt * C.range(0.7, 1.2), Math.cos(fa) * fr, Math.sin(fa) * fr]);
}

/**
 * Is this detonation a weapon modifier's blast? A gun's (not a boss's vent, a drone, an arc with its `from`), and either
 * a way out of a hull (`out` set: only a piercing shot's blast has one) or no wider than the explosive modifier's widest
 * blast: every burst a gun has of its own is wider (the narrowest splash in the data is 60, a burst with none is told as 40)
 */
export function isModBlast(kind: string, radius: number, out?: number, from?: unknown): boolean {
  return !from && GUN_KINDS.has(kind) && radius > 0 && (out !== undefined || radius <= MECH.blast[1] + 0.5);
}

/**
 * A modifier's blast told by the server alone, `radius` wide at (x, y): where an explosive beam ends on a hull, or
 * (`out`, radians) where a piercing shot leaves one. A shell's own hit draws its blast itself (the explosive layer's
 * impact) and the server's word of that one adds nothing: one blast a spot a frame (blast.ts). Its strength is read
 * back off its radius. False: nothing was drawn
 */
export function modBlast(f: FxField, x: number, y: number, radius: number, out?: number): boolean {
  const st = stateOf(f), lo = MECH.blast[0], hi = MECH.blast[1];
  const k = radius > hi ? 1 : Math.max(0.15, Math.min(1, (radius - lo) / Math.max(1, hi - lo)));
  C.f = f; C.st = st; C.anc = undefined; C.shot = undefined; C.look = LOOK.explosive; C.color = C.look.color; C.fx = EFFECTS.indexOf('explosive');
  C.thin = (f.particleKeep ?? 1) * Math.min(1, SOFT_LOAD / Math.max(SOFT_LOAD, st.load));
  C.left = Math.max(1, Math.round(CAP_BLAST * C.thin));
  C.x = x; C.y = y; C.s = radius; C.R = radius; C.vs = 1; C.surface = false; C.out = out ?? 0;
  C.aim(out ?? 0);
  C.seed((x * 31 + y * 17) | 0, 91, st.blasts++);
  return blast(C, k, radius, C.color, out, true);
}

/**
 * One frame of a beam from (x0, y0) to (x1, y1) into `g`, over the beam's own drawing: `wid` its width, `gain` its
 * brightness (0..1), `t` seconds, `seed` its own number, `hit` whether its end is on something. Nothing is kept: every
 * layer is a function of `t` and `seed`
 */
export function modBeam(g: Graphics, list: readonly ModFx[] | undefined, x0: number, y0: number, x1: number, y1: number, wid: number, gain: number, t: number, seed: number, hit: boolean): void {
  if (!list?.length || gain <= 0) return;
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1) return;
  B.g = g; B.x0 = x0; B.y0 = y0; B.x1 = x1; B.y1 = y1; B.len = len; B.ux = (x1 - x0) / len; B.uy = (y1 - y0) / len; B.nx = -B.uy; B.ny = B.ux;
  B.wid = wid; B.gain = Math.min(1, gain); B.t = t; B.hit = hit;
  for (const e of list) {
    const layer = BY_ID[e.fx];
    if (!layer || !(e.k > 0)) continue;
    const k = Math.min(1, e.k);
    B.look = LOOKS[e.fx]; B.color = B.look.color; B.seed = seed + e.fx * 13.7;
    layer.beam?.(B, k);
    layer.beamEnd?.(B, k);
  }
}
